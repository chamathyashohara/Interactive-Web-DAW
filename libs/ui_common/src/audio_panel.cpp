#include "audio_panel.hpp"

#include <algorithm>
#include <cmath>
#include <system_error>

#include <QColor>
#include <QComboBox>
#include <QFont>
#include <QDesktopServices>
#include <QDir>
#include <QFileDialog>
#include <QFormLayout>
#include <QGridLayout>
#include <QGroupBox>
#include <QHBoxLayout>
#include <QLabel>
#include <QListWidget>
#include <QProgressBar>
#include <QPushButton>
#include <QSettings>
#include <QStandardPaths>
#include <QTimer>
#include <QUrl>
#include <QVBoxLayout>

#include "rr/audio/file_io.hpp"
#include "rr/audio/take_naming.hpp"
#include "rr/audio/wav_inspect.hpp"
#include "rr/shared/build_info.hpp"
#include "rr/shared/clock.hpp"

namespace rr::ui {
namespace {

using rr::audio::path_to_utf8;

QString qs(const std::string& s) {
    return QString::fromStdString(s);
}

QString qpath(const std::filesystem::path& p) {
    return QDir::toNativeSeparators(QString::fromStdString(path_to_utf8(p)));
}

std::filesystem::path to_path(const QString& s) {
#ifdef _WIN32
    return std::filesystem::path(s.toStdWString());
#else
    return std::filesystem::path(s.toStdString());
#endif
}

double to_dbfs(float peak) {
    return peak > 1e-6f ? 20.0 * std::log10(static_cast<double>(peak)) : -120.0;
}

constexpr int kMeterMin = -60;  // dBFS at the left end of a meter
constexpr std::int64_t kNoSignalNs = 3'000'000'000LL;  // DEV-04: 3 s (prov.)
constexpr float kSignalThreshold = 1e-5f;              // -100 dBFS

const char* const kSettingsInput = "audio/input_device";
const char* const kSettingsOutput = "audio/output_device";
const char* const kSettingsFolder = "audio/recordings_dir";

}  // namespace

AudioPanel::AudioPanel(Role role, const AppConfig& config, rr::log::Logger& logger, QWidget* parent)
    : QWidget(parent), role_(role), config_(config), logger_(logger),
      engine_(std::make_unique<rr::audio::AudioEngine>()) {
    QSettings settings;
    recordings_dir_ = settings
                          .value(QString::fromLatin1(kSettingsFolder),
                                 QStandardPaths::writableLocation(QStandardPaths::MusicLocation) +
                                     QStringLiteral("/RemoteRecording"))
                          .toString();
    build_ui();

    std::string error;
    if (!engine_->initialise(error)) {
        show_error(tr("Audio system unavailable: %1").arg(qs(error)));
        logger_.log(rr::log::Level::Error, "audio", "init_failed", error);
    } else {
        logger_.log(rr::log::Level::Info, "audio", "init", "audio system ready", {{"backend", engine_->backend_name()}});
        refresh_devices();
    }
    scan_incomplete_files();

    timer_ = new QTimer(this);
    timer_->setInterval(50);  // 20 Hz UI telemetry
    connect(timer_, &QTimer::timeout, this, &AudioPanel::tick);
    timer_->start();
    update_controls();
}

AudioPanel::~AudioPanel() {
    shut_down_audio();
}

void AudioPanel::build_ui() {
    auto* root = new QVBoxLayout(this);

    // --- devices -------------------------------------------------------------------------
    auto* devices = new QGroupBox(tr("Audio devices"));
    auto* form = new QFormLayout(devices);
    input_combo_ = new QComboBox;
    output_combo_ = new QComboBox;
    refresh_button_ = new QPushButton(tr("Refresh"));
    input_button_ = new QPushButton(tr("Open input"));
    auto* input_row = new QHBoxLayout;
    input_row->addWidget(input_combo_, 1);
    input_row->addWidget(input_button_);
    input_row->addWidget(refresh_button_);
    form->addRow(tr("Input (microphone):"), input_row);
    form->addRow(tr("Output (headphones):"), output_combo_);
    auto* output_note = new QLabel(tr("The output is only selected here; it is used once live talkback exists. "
                                      "Use headphones to avoid feedback."));
    output_note->setWordWrap(true);
    form->addRow(QString(), output_note);
    format_label_ = new QLabel(tr("Input closed."));
    format_label_->setWordWrap(true);
    form->addRow(tr("Format:"), format_label_);
    root->addWidget(devices);

    // --- meters --------------------------------------------------------------------------
    auto* meters = new QGroupBox(tr("Input level (peak, dBFS)"));
    auto* grid = new QGridLayout(meters);
    for (std::uint32_t c = 0; c < rr::audio::kMaxChannels; ++c) {
        auto* bar = new QProgressBar;
        bar->setRange(kMeterMin * 10, 0);
        bar->setValue(kMeterMin * 10);
        bar->setTextVisible(false);
        auto* label = new QLabel(QStringLiteral("ch%1  -inf").arg(c + 1));
        grid->addWidget(label, static_cast<int>(c), 0);
        grid->addWidget(bar, static_cast<int>(c), 1);
        bar->setVisible(false);
        label->setVisible(false);
        meters_.push_back(bar);
        meter_labels_.push_back(label);
    }
    signal_warning_ = new QLabel(
        tr("No input signal: the microphone is delivering digital silence. Check the mute key and "
           "Windows Sound settings (Recording > device > Levels), and Settings > Privacy & security > "
           "Microphone."));
    signal_warning_->setWordWrap(true);
    signal_warning_->setStyleSheet(QStringLiteral("color: #b00020; font-weight: bold;"));
    signal_warning_->setVisible(false);
    grid->addWidget(signal_warning_, static_cast<int>(rr::audio::kMaxChannels), 0, 1, 2);
    counters_label_ = new QLabel;
    counters_label_->setWordWrap(true);
    grid->addWidget(counters_label_, static_cast<int>(rr::audio::kMaxChannels) + 1, 0, 1, 2);
    root->addWidget(meters);

    // --- recording -----------------------------------------------------------------------
    auto* rec = new QGroupBox(role_ == Role::Producer ? tr("Local recording")
                                                      : tr("Local recording (test mode)"));
    auto* rec_layout = new QVBoxLayout(rec);
    auto* folder_row = new QHBoxLayout;
    folder_label_ = new QLabel;
    folder_label_->setWordWrap(true);
    folder_label_->setTextInteractionFlags(Qt::TextSelectableByMouse);
    folder_button_ = new QPushButton(tr("Change folder..."));
    open_folder_button_ = new QPushButton(tr("Open folder"));
    folder_row->addWidget(folder_label_, 1);
    folder_row->addWidget(folder_button_);
    folder_row->addWidget(open_folder_button_);
    rec_layout->addLayout(folder_row);
    if (role_ == Role::Performer) {
        auto* note = new QLabel(tr("Stage 4 test mode: you can start a local take here to check recording. "
                                   "In the session stages only the producer starts takes (SES-08)."));
        note->setWordWrap(true);
        rec_layout->addWidget(note);
    }
    auto* control_row = new QHBoxLayout;
    record_button_ = new QPushButton(tr("Record"));
    rec_label_ = new QLabel(tr("Not recording"));
    QFont rec_font = rec_label_->font();
    rec_font.setBold(true);
    rec_font.setPointSize(rec_font.pointSize() + 4);
    rec_label_->setFont(rec_font);
    control_row->addWidget(record_button_);
    control_row->addWidget(rec_label_, 1);
    rec_layout->addLayout(control_row);
    result_label_ = new QLabel;
    result_label_->setWordWrap(true);
    result_label_->setTextInteractionFlags(Qt::TextSelectableByMouse);
    rec_layout->addWidget(result_label_);
    takes_list_ = new QListWidget;
    takes_list_->setMaximumHeight(110);
    rec_layout->addWidget(new QLabel(tr("Takes this session:")));
    rec_layout->addWidget(takes_list_);
    root->addWidget(rec);

    // --- incomplete files (ERR-05b) ------------------------------------------------------
    auto* incomplete = new QGroupBox(tr("Incomplete recordings found (.wav.partial)"));
    auto* inc_layout = new QVBoxLayout(incomplete);
    incomplete_list_ = new QListWidget;
    incomplete_list_->setMaximumHeight(80);
    recover_button_ = new QPushButton(tr("Recover selected (writes a new .recovered.wav, keeps the original)"));
    inc_layout->addWidget(incomplete_list_);
    inc_layout->addWidget(recover_button_);
    root->addWidget(incomplete);

    connect(refresh_button_, &QPushButton::clicked, this, &AudioPanel::refresh_devices);
    connect(input_button_, &QPushButton::clicked, this, &AudioPanel::toggle_input);
    connect(folder_button_, &QPushButton::clicked, this, &AudioPanel::choose_folder);
    connect(open_folder_button_, &QPushButton::clicked, this, &AudioPanel::open_folder);
    connect(record_button_, &QPushButton::clicked, this, [this] {
        if (recording_active()) {
            stop_take();
        } else {
            start_take();
        }
    });
    connect(recover_button_, &QPushButton::clicked, this, &AudioPanel::recover_selected);
    connect(output_combo_, &QComboBox::currentTextChanged, this, [](const QString& name) {
        QSettings().setValue(QString::fromLatin1(kSettingsOutput), name);
    });
    folder_label_->setText(QDir::toNativeSeparators(recordings_dir_));
}

std::filesystem::path AudioPanel::recordings_root() const {
    return to_path(recordings_dir_);
}

void AudioPanel::refresh_devices() {
    if (engine_->capture_open()) {
        return;  // indices would no longer match the open device
    }
    std::string error;
    const auto inputs = engine_->capture_devices(error);
    const auto outputs = engine_->playback_devices(error);
    if (!error.empty()) {
        show_error(tr("Device list failed: %1").arg(qs(error)));
    }
    QSettings settings;
    const QString saved_in = settings.value(QString::fromLatin1(kSettingsInput)).toString();
    const QString saved_out = settings.value(QString::fromLatin1(kSettingsOutput)).toString();

    input_combo_->clear();
    int select = -1;
    for (const auto& d : inputs) {
        const QString name = qs(d.name);
        input_combo_->addItem(name + (d.is_default ? tr("  [Windows default]") : QString()),
                              static_cast<qulonglong>(d.index));
        if (name == saved_in || (select < 0 && d.is_default)) {
            select = input_combo_->count() - 1;
        }
    }
    if (select >= 0) {
        input_combo_->setCurrentIndex(select);
    }
    output_combo_->clear();
    for (const auto& d : outputs) {
        output_combo_->addItem(qs(d.name));
        if (qs(d.name) == saved_out || (saved_out.isEmpty() && d.is_default)) {
            output_combo_->setCurrentIndex(output_combo_->count() - 1);
        }
    }
    if (inputs.empty()) {
        show_error(tr("No input device found. Connect a microphone and press Refresh."));
    }
    logger_.log(rr::log::Level::Info, "audio", "devices_enumerated", "device list refreshed",
                {{"inputs", std::to_string(inputs.size())}, {"outputs", std::to_string(outputs.size())}});
    update_controls();
}

void AudioPanel::toggle_input() {
    if (engine_->capture_open()) {
        if (recording_active()) {
            show_error(tr("Stop the recording before closing the input."));
            return;
        }
        close_input(QStringLiteral("user"));
    } else {
        open_selected_input();
    }
}

bool AudioPanel::open_selected_input() {
    if (input_combo_->currentIndex() < 0) {
        show_error(tr("Choose an input device first."));
        return false;
    }
    const auto index = static_cast<std::size_t>(input_combo_->currentData().toULongLong());
    rr::audio::CaptureOptions options;
    options.required_sample_rate = config_.audio.required_sample_rate_hz;
    options.period_ms = config_.audio.device_period_ms;
    options.ring_seconds = config_.audio.record_ring_seconds;
    std::string error;
    if (!engine_->open_capture(index, options, rr::audio::RecorderOptions{}, error)) {
        show_error(tr("Not ready: %1").arg(qs(error)));
        logger_.log(rr::log::Level::Error, "audio", "input_open_failed", error,
                    {{"device", input_combo_->currentText().toStdString()}});
        update_controls();
        return false;
    }
    const auto& d = engine_->capture_description();
    QSettings().setValue(QString::fromLatin1(kSettingsInput), qs(d.device_name));
    QString notes;
    for (const auto& n : d.conversion_notes) {
        notes += QStringLiteral("\n- ") + qs(n);
    }
    format_label_->setText(tr("Recording format: WAV float32, %1 Hz, %2 channel(s), native rate and channels. "
                              "Device stream: %3, %4 Hz, %5 ch, period %6 frames x %7.%8")
                               .arg(d.sample_rate).arg(d.channels).arg(qs(d.device_internal_format))
                               .arg(d.device_internal_rate).arg(d.device_internal_channels)
                               .arg(d.device_period_frames).arg(d.device_periods).arg(notes));
    peak_hold_.assign(d.channels, 0.0f);
    for (std::size_t c = 0; c < meters_.size(); ++c) {
        meters_[c]->setVisible(c < d.channels);
        meter_labels_[c]->setVisible(c < d.channels);
    }
    input_opened_ns_ = rr::time::monotonic_ns();
    last_signal_ns_ = 0;
    show_info(tr("Input open: %1").arg(qs(d.device_name)));
    logger_.log(rr::log::Level::Info, "audio", "input_opened", "input device opened",
                {{"device", d.device_name}, {"backend", d.backend},
                 {"rate", std::to_string(d.sample_rate)}, {"channels", std::to_string(d.channels)},
                 {"internal_format", d.device_internal_format},
                 {"period_frames", std::to_string(d.device_period_frames)}});
    update_controls();
    return true;
}

void AudioPanel::close_input(const QString& reason) {
    if (!engine_->capture_open()) {
        return;
    }
    engine_->close_capture();
    format_label_->setText(tr("Input closed."));
    for (std::size_t c = 0; c < meters_.size(); ++c) {
        meters_[c]->setVisible(false);
        meter_labels_[c]->setVisible(false);
    }
    signal_warning_->setVisible(false);
    logger_.log(rr::log::Level::Info, "audio", "input_closed", "input device closed",
                {{"reason", reason.toStdString()}});
    update_controls();
}

void AudioPanel::choose_folder() {
    if (recording_active()) {
        return;
    }
    const QString dir = QFileDialog::getExistingDirectory(this, tr("Recordings folder"), recordings_dir_);
    if (dir.isEmpty()) {
        return;
    }
    recordings_dir_ = dir;
    QSettings().setValue(QString::fromLatin1(kSettingsFolder), dir);
    folder_label_->setText(QDir::toNativeSeparators(dir));
    session_id_.clear();  // the next take starts a new session folder under the new root
    session_dir_.clear();
    scan_incomplete_files();
    logger_.log(rr::log::Level::Info, "audio", "folder_changed", "recordings folder changed",
                {{"folder", dir.toStdString()}});
}

void AudioPanel::open_folder() {
    const std::filesystem::path p = last_take_dir_.empty() ? recordings_root() : last_take_dir_;
    std::error_code ec;
    std::filesystem::create_directories(p, ec);
    QDesktopServices::openUrl(QUrl::fromLocalFile(QString::fromStdString(path_to_utf8(p))));
}

void AudioPanel::start_take() {
    auto* recorder = engine_->recorder();
    if (!engine_->capture_open() || recorder == nullptr) {
        show_error(tr("Open an input device first."));
        return;
    }
    if (session_id_.empty()) {
        session_id_ = rr::audio::make_session_id();
        session_dir_ = recordings_root() / rr::audio::session_folder_name(rr::time::utc_now_ms(), session_id_);
    }
    std::error_code ec;
    std::filesystem::create_directories(session_dir_, ec);
    if (ec) {
        show_error(tr("Cannot create the recordings folder %1: %2").arg(qpath(session_dir_), qs(ec.message())));
        return;
    }
    // REC-09: enough room for a take of the planned maximum length.
    const auto& d = engine_->capture_description();
    const std::uint64_t needed = static_cast<std::uint64_t>(config_.timing.max_take_seconds) * d.sample_rate *
                                     d.channels * 4ULL + (1ULL << 20);
    const std::uint64_t free_bytes = rr::audio::available_disk_bytes(session_dir_);
    if (free_bytes < needed) {
        show_error(tr("Not ready: not enough disk space. %1 MB free, %2 MB needed for a %3-minute take.")
                       .arg(free_bytes >> 20).arg(needed >> 20).arg(config_.timing.max_take_seconds / 60));
        logger_.log(rr::log::Level::Error, "audio", "disk_space_low", "not enough disk space",
                    {{"free_bytes", std::to_string(free_bytes)}, {"needed_bytes", std::to_string(needed)}});
        return;
    }
    rr::audio::TakeRequest request;
    request.session_dir = session_dir_;
    request.take_number = rr::audio::next_free_take_number(session_dir_, role_, session_id_);
    request.role = role_;
    request.session_id = session_id_;
    request.app_version = rr::build_info().version + " (" + rr::build_info().git_commit + ")";
    request.max_take_seconds = config_.timing.max_take_seconds;
    request.capture = d;
    if (request.take_number == 0) {
        show_error(tr("No free take number left in this session folder."));
        return;
    }
    std::string error;
    if (!recorder->begin_take(request, error)) {
        show_error(tr("Recording did not start: %1").arg(qs(error)));
        logger_.log(rr::log::Level::Error, "audio", "take_start_failed", error);
        return;
    }
    last_take_dir_ = session_dir_;
    result_label_->clear();
    logger_.log(rr::log::Level::Info, "audio", "take_started", "take started",
                {{"take", std::to_string(request.take_number)}, {"session", session_id_},
                 {"folder", path_to_utf8(session_dir_)}});
    update_controls();
}

void AudioPanel::stop_take() {
    if (auto* recorder = engine_->recorder()) {
        recorder->end_take(rr::audio::StopReason::User);
        logger_.log(rr::log::Level::Info, "audio", "take_stop_requested", "stop requested");
    }
}

bool AudioPanel::recording_active() const {
    auto* recorder = engine_ ? engine_->recorder() : nullptr;
    return recorder != nullptr && recorder->status().state != rr::audio::RecorderState::Idle;
}

void AudioPanel::shut_down_audio() {
    if (!engine_) {
        return;
    }
    rr::audio::TakeRecorder* recorder = engine_->recorder();
    if (recorder != nullptr) {
        recorder->stop();  // finalises an active take as complete_shutdown (ERR-05a)
        for (const auto& meta : recorder->take_finished()) {
            handle_result(meta);
        }
    }
    close_input(QStringLiteral("shutdown"));
}

void AudioPanel::tick() {
    rr::audio::CaptureIngest* ingest = engine_->ingest();
    if (ingest == nullptr) {
        return;
    }
    const std::int64_t now = rr::time::monotonic_ns();
    float block_max = 0.0f;
    for (std::uint32_t c = 0; c < ingest->channels() && c < meters_.size(); ++c) {
        const float peak = ingest->take_peak(c);
        block_max = std::max(block_max, peak);
        // Simple peak hold with release so short peaks stay visible.
        peak_hold_[c] = std::max(peak, peak_hold_[c] * 0.85f);
        const double db = to_dbfs(peak_hold_[c]);
        meters_[c]->setValue(static_cast<int>(std::max(db, static_cast<double>(kMeterMin)) * 10.0));
        meter_labels_[c]->setText(db <= -119.0 ? QStringLiteral("ch%1  -inf").arg(c + 1)
                                               : QStringLiteral("ch%1 %2").arg(c + 1).arg(db, 0, 'f', 1));
    }
    if (block_max > kSignalThreshold) {
        last_signal_ns_ = now;
    }
    const std::int64_t since = last_signal_ns_ != 0 ? last_signal_ns_ : input_opened_ns_;
    signal_warning_->setVisible(now - since > kNoSignalNs);

    const rr::audio::IngestStats st = ingest->stats();
    counters_label_->setText(tr("Callbacks %1 | ring overruns %2 (%3 frames) | timing anomalies %4 | clipped samples %5 | "
                                "longest callback %6 us")
                                 .arg(st.callbacks).arg(st.overrun_events).arg(st.overrun_frames)
                                 .arg(st.timing_anomalies).arg(st.clipped_samples)
                                 .arg(static_cast<double>(st.max_callback_ns) / 1000.0, 0, 'f', 0));

    // Collect finished takes first: closing the input below destroys the recorder.
    if (auto* recorder = engine_->recorder()) {
        for (const auto& meta : recorder->take_finished()) {
            handle_result(meta);
        }
    }
    if (ingest->device_fault() != rr::audio::DeviceFault::None && !recording_active()) {
        const QString previous = result_label_->text();
        close_input(QStringLiteral("device_fault"));
        refresh_devices();
        show_error(previous + (previous.isEmpty() ? QString() : QStringLiteral("
")) +
                   tr("The input device stopped (unplugged, disabled or failed). Press Refresh, then Open input."));
        return;
    }

    if (auto* recorder = engine_->recorder()) {
        const rr::audio::RecorderStatus rs = recorder->status();
        const double seconds = ingest->sample_rate() ? static_cast<double>(rs.frames_written) / ingest->sample_rate() : 0.0;
        switch (rs.state) {
        case rr::audio::RecorderState::Idle:
            rec_label_->setText(tr("Not recording"));
            rec_label_->setStyleSheet(QString());
            break;
        case rr::audio::RecorderState::Starting:
            rec_label_->setText(tr("Starting take %1...").arg(rs.take_number));
            break;
        case rr::audio::RecorderState::Recording:
            rec_label_->setText(tr("● REC take %1   %2:%3%4")
                                    .arg(rs.take_number, 2, 10, QLatin1Char('0'))
                                    .arg(static_cast<int>(seconds) / 60)
                                    .arg(std::fmod(seconds, 60.0), 4, 'f', 1, QLatin1Char('0'))
                                    .arg(rs.has_gaps ? tr("   (GAPS: audio was lost and filled with silence)") : QString()));
            rec_label_->setStyleSheet(QStringLiteral("color: #b00020;"));
            break;
        case rr::audio::RecorderState::Finalising:
            rec_label_->setText(tr("Saving take %1...").arg(rs.take_number));
            rec_label_->setStyleSheet(QString());
            break;
        }
    }
    update_controls();
}

void AudioPanel::handle_result(const rr::audio::TakeMetadata& m) {
    const std::filesystem::path dir = last_take_dir_.empty() ? session_dir_ : last_take_dir_;
    const bool saved = rr::take_status_is_complete(m.status) && m.finalised;
    const QString status = qs(std::string(rr::take_status_name(m.status)));
    QString line;
    if (saved) {
        line = tr("Saved take %1: %2 | %3 s, %4 Hz, %5 ch, float32 WAV")
                   .arg(m.take_number).arg(qpath(dir / m.file_name))
                   .arg(m.duration_seconds(), 0, 'f', 2).arg(m.sample_rate).arg(m.channels);
        if (m.has_gaps) {
            line += tr(" | WARNING: %1 gap(s) where audio was lost were filled with silence%2")
                        .arg(m.gaps.size())
                        .arg(m.gap_positions_complete ? QString() : tr(" (positions incomplete)"));
        }
        result_label_->setStyleSheet(m.has_gaps ? QStringLiteral("color: #8a5a00;") : QStringLiteral("color: #1b5e20;"));
    } else {
        const std::string file = m.finalised ? m.file_name : m.partial_file_name;
        line = tr("INCOMPLETE take %1 (%2): %3 | file kept as %4 | %5 s")
                   .arg(m.take_number).arg(status, qs(m.error), qpath(dir / file))
                   .arg(m.duration_seconds(), 0, 'f', 2);
        result_label_->setStyleSheet(QStringLiteral("color: #b00020; font-weight: bold;"));
    }
    result_label_->setText(line);
    auto* item = new QListWidgetItem(line);
    if (!saved) {
        item->setForeground(QColor(0xb0, 0x00, 0x20));
    }
    takes_list_->addItem(item);
    logger_.log(saved ? rr::log::Level::Info : rr::log::Level::Error, "audio", "take_finished", line.toStdString(),
                {{"take", std::to_string(m.take_number)}, {"status", status.toStdString()},
                 {"finalised", m.finalised ? "true" : "false"}, {"frames", std::to_string(m.frames)},
                 {"has_gaps", m.has_gaps ? "true" : "false"}, {"stop_reason", m.stop_reason}});
    if (!saved) {
        scan_incomplete_files();
    }
}

void AudioPanel::scan_incomplete_files() {
    incomplete_list_->clear();
    for (const auto& p : rr::audio::find_partial_files(recordings_root())) {
        // A file the recorder is writing right now is not "incomplete".
        if (recording_active() && p.parent_path() == session_dir_) {
            continue;
        }
        auto* item = new QListWidgetItem(qpath(p));
        item->setData(Qt::UserRole, QString::fromStdString(path_to_utf8(p)));
        incomplete_list_->addItem(item);
    }
    if (incomplete_list_->count() > 0) {
        logger_.log(rr::log::Level::Warn, "audio", "incomplete_files_found", "incomplete recordings present",
                    {{"count", std::to_string(incomplete_list_->count())}});
    }
    update_controls();
}

void AudioPanel::recover_selected() {
    QListWidgetItem* item = incomplete_list_->currentItem();
    if (item == nullptr) {
        return;
    }
    const std::filesystem::path partial = to_path(item->data(Qt::UserRole).toString());
    const rr::audio::RecoveryResult r = rr::audio::recover_partial(partial);
    if (r.ok) {
        show_info(tr("Recovered %1 frames into %2 (original .partial kept).")
                      .arg(r.frames).arg(qpath(r.recovered_path)));
        logger_.log(rr::log::Level::Info, "audio", "partial_recovered", path_to_utf8(r.recovered_path),
                    {{"frames", std::to_string(r.frames)}});
    } else {
        show_error(tr("Recovery failed: %1").arg(qs(r.error)));
        logger_.log(rr::log::Level::Error, "audio", "partial_recovery_failed", r.error);
    }
}

void AudioPanel::show_error(const QString& text) {
    result_label_->setStyleSheet(QStringLiteral("color: #b00020; font-weight: bold;"));
    result_label_->setText(text);
}

void AudioPanel::show_info(const QString& text) {
    result_label_->setStyleSheet(QString());
    result_label_->setText(text);
}

void AudioPanel::update_controls() {
    const bool open = engine_->capture_open();
    const bool recording = recording_active();
    input_button_->setText(open ? tr("Close input") : tr("Open input"));
    input_button_->setEnabled(!recording && (open || input_combo_->count() > 0));
    input_combo_->setEnabled(!open);
    refresh_button_->setEnabled(!open);
    folder_button_->setEnabled(!recording);
    record_button_->setEnabled(open);
    const QString start_text = role_ == Role::Producer ? tr("Record") : tr("Record (local test)");
    record_button_->setText(recording ? tr("Stop") : start_text);
    recover_button_->setEnabled(incomplete_list_->count() > 0);
}

QString AudioPanel::diagnostics_text() const {
    QString out = QStringLiteral("=== Audio ===\n");
    out += QStringLiteral("backend: %1\n").arg(qs(engine_->backend_name()));
    out += QStringLiteral("recordings folder: %1\n").arg(QDir::toNativeSeparators(recordings_dir_));
    out += QStringLiteral("session: %1  folder: %2\n")
               .arg(session_id_.empty() ? QStringLiteral("(none yet)") : qs(session_id_), qpath(session_dir_));
    if (!engine_->capture_open()) {
        out += QStringLiteral("input: closed\n");
        return out;
    }
    const auto& d = engine_->capture_description();
    out += QStringLiteral("input: %1\n").arg(qs(d.device_name));
    out += QStringLiteral("written format: float32, %1 Hz, %2 ch\n").arg(d.sample_rate).arg(d.channels);
    out += QStringLiteral("device stream: %1, %2 Hz, %3 ch, period %4 x %5\n")
               .arg(qs(d.device_internal_format)).arg(d.device_internal_rate).arg(d.device_internal_channels)
               .arg(d.device_period_frames).arg(d.device_periods);
    for (const auto& n : d.conversion_notes) {
        out += QStringLiteral("note: %1\n").arg(qs(n));
    }
    if (auto* ingest = const_cast<rr::audio::AudioEngine&>(*engine_).ingest()) {
        const auto st = ingest->stats();
        out += QStringLiteral("frames captured %1, callbacks %2, overruns %3 (%4 frames), lost gap events %5, "
                              "timing anomalies %6, max callback %7 us, device fault %8\n")
                   .arg(st.frames_captured).arg(st.callbacks).arg(st.overrun_events).arg(st.overrun_frames)
                   .arg(st.gap_events_lost).arg(st.timing_anomalies)
                   .arg(static_cast<double>(st.max_callback_ns) / 1000.0, 0, 'f', 1)
                   .arg(static_cast<int>(ingest->device_fault()));
    }
    return out;
}

}  // namespace rr::ui
