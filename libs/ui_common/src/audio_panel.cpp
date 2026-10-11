#include "audio_panel.hpp"

#include <algorithm>
#include <cmath>
#include <system_error>

#include <QCheckBox>
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
#include <QSlider>
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
const char* const kSettingsMonitorGain = "audio/monitor_gain_db";

constexpr std::int64_t kClipHoldNs = 2'000'000'000LL;     // CLIP indicator stays lit 2 s
constexpr std::int64_t kProblemLogIntervalNs = 1'000'000'000LL;

const char* fault_text(rr::audio::DeviceFault fault) {
    switch (fault) {
    case rr::audio::DeviceFault::None: return "none";
    case rr::audio::DeviceFault::StoppedUnexpectedly: return "stopped unexpectedly (unplugged, disabled or failed)";
    case rr::audio::DeviceFault::Rerouted: return "moved to another device";
    }
    return "unknown";
}

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
    format_label_ = new QLabel(tr("Input closed."));
    format_label_->setWordWrap(true);
    form->addRow(tr("Input format:"), format_label_);
    output_button_ = new QPushButton(tr("Open output"));
    auto* output_row = new QHBoxLayout;
    output_row->addWidget(output_combo_, 1);
    output_row->addWidget(output_button_);
    form->addRow(tr("Output (headphones):"), output_row);
    output_format_label_ = new QLabel(tr("Output closed."));
    output_format_label_->setWordWrap(true);
    form->addRow(tr("Output format:"), output_format_label_);
    root->addWidget(devices);

    // --- monitoring (explicit setting, off by default) -------------------------------------
    auto* monitoring = new QGroupBox(tr("Local monitoring (hear your own microphone)"));
    auto* mon_layout = new QVBoxLayout(monitoring);
    auto* warning = new QLabel(
        tr("Warning: monitoring through loudspeakers can cause loud howling feedback. Use headphones, "
           "especially during live two-way communication. Monitoring changes only what you hear; "
           "the recording is never processed."));
    warning->setWordWrap(true);
    warning->setStyleSheet(QStringLiteral("color: #8a5a00; font-weight: bold;"));
    mon_layout->addWidget(warning);
    auto* mon_row = new QHBoxLayout;
    monitor_check_ = new QCheckBox(tr("Monitor my input"));
    monitor_gain_ = new QSlider(Qt::Horizontal);
    monitor_gain_->setRange(-40, 6);
    monitor_gain_->setValue(QSettings().value(QString::fromLatin1(kSettingsMonitorGain), 0).toInt());
    monitor_gain_label_ = new QLabel;
    tone_button_ = new QPushButton(tr("Test output (1 s tone, 440 Hz, -20 dBFS)"));
    mon_row->addWidget(monitor_check_);
    mon_row->addWidget(new QLabel(tr("Monitor gain:")));
    mon_row->addWidget(monitor_gain_, 1);
    mon_row->addWidget(monitor_gain_label_);
    mon_layout->addLayout(mon_row);
    mon_layout->addWidget(tone_button_);
    processing_label_ = new QLabel;
    processing_label_->setWordWrap(true);
    mon_layout->addWidget(processing_label_);
    root->addWidget(monitoring);

    // --- meters --------------------------------------------------------------------------
    auto* meters = new QGroupBox(tr("Input level (bar: peak with hold; text: peak / RMS over 50 ms, dBFS)"));
    auto* grid = new QGridLayout(meters);
    for (std::uint32_t c = 0; c < rr::audio::kMaxChannels; ++c) {
        auto* bar = new QProgressBar;
        bar->setRange(kMeterMin * 10, 0);
        bar->setValue(kMeterMin * 10);
        bar->setTextVisible(false);
        auto* label = new QLabel(QStringLiteral("ch%1  -inf").arg(c + 1));
        auto* clip = new QLabel(tr("CLIP"));
        clip->setStyleSheet(QStringLiteral("color: white; background: #b00020; padding: 0 4px; font-weight: bold;"));
        grid->addWidget(label, static_cast<int>(c), 0);
        grid->addWidget(bar, static_cast<int>(c), 1);
        grid->addWidget(clip, static_cast<int>(c), 2);
        bar->setVisible(false);
        label->setVisible(false);
        clip->setVisible(false);
        meters_.push_back(bar);
        meter_labels_.push_back(label);
        clip_labels_.push_back(clip);
        clip_until_ns_.push_back(0);
    }
    signal_warning_ = new QLabel(
        tr("No input signal: the microphone is delivering digital silence. Check the mute key and "
           "Windows Sound settings (Recording > device > Levels), and Settings > Privacy & security > "
           "Microphone."));
    signal_warning_->setWordWrap(true);
    signal_warning_->setStyleSheet(QStringLiteral("color: #b00020; font-weight: bold;"));
    signal_warning_->setVisible(false);
    grid->addWidget(signal_warning_, static_cast<int>(rr::audio::kMaxChannels), 0, 1, 3);
    counters_label_ = new QLabel;
    counters_label_->setWordWrap(true);
    grid->addWidget(counters_label_, static_cast<int>(rr::audio::kMaxChannels) + 1, 0, 1, 3);
    buffers_label_ = new QLabel;
    buffers_label_->setWordWrap(true);
    grid->addWidget(buffers_label_, static_cast<int>(rr::audio::kMaxChannels) + 2, 0, 1, 3);
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
        if (session_controlled_) {
            return;  // a session take is controlled by the session panel (SES-08)
        }
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
    connect(output_button_, &QPushButton::clicked, this, &AudioPanel::toggle_output);
    connect(monitor_check_, &QCheckBox::toggled, this, &AudioPanel::set_monitoring);
    connect(monitor_gain_, &QSlider::valueChanged, this, [this](int db) {
        engine_->monitor().set_gain_db(static_cast<float>(db));
        QSettings().setValue(QString::fromLatin1(kSettingsMonitorGain), db);
        update_monitor_description();
    });
    connect(tone_button_, &QPushButton::clicked, this, [this] {
        engine_->monitor().start_test_tone(440.0f, -20.0f, 1.0f);
        logger_.log(rr::log::Level::Info, "audio", "test_tone", "1 s test tone on the output");
    });
    engine_->monitor().set_gain_db(static_cast<float>(monitor_gain_->value()));
    folder_label_->setText(QDir::toNativeSeparators(recordings_dir_));
}

std::filesystem::path AudioPanel::recordings_root() const {
    return to_path(recordings_dir_);
}

void AudioPanel::refresh_devices() {
    if (engine_->capture_open() || engine_->playback_open()) {
        return;  // indices would no longer match the open devices
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
        output_combo_->addItem(qs(d.name), static_cast<qulonglong>(d.index));
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
        clip_labels_[c]->setVisible(false);
        clip_until_ns_[c] = 0;
    }
    input_opened_ns_ = rr::time::monotonic_ns();
    last_signal_ns_ = 0;
    if (error.empty()) {
        show_info(tr("Input open: %1").arg(qs(d.device_name)));
    } else {
        show_error(tr("Input open: %1. %2").arg(qs(d.device_name), qs(error)));  // output re-open failed
    }
    update_monitor_description();
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
        clip_labels_[c]->setVisible(false);
    }
    signal_warning_->setVisible(false);
    logger_.log(rr::log::Level::Info, "audio", "input_closed", "input device closed",
                {{"reason", reason.toStdString()}});
    update_monitor_description();
    update_controls();
}

void AudioPanel::toggle_output() {
    if (engine_->playback_open()) {
        close_output(QStringLiteral("user"));
    } else {
        open_selected_output();
    }
}

bool AudioPanel::open_selected_output() {
    if (output_combo_->currentIndex() < 0) {
        show_error(tr("Choose an output device first."));
        return false;
    }
    const auto index = static_cast<std::size_t>(output_combo_->currentData().toULongLong());
    rr::audio::PlaybackOptions options;
    options.period_ms = config_.audio.device_period_ms;
    std::string error;
    if (!engine_->open_playback(index, options, error)) {
        show_error(tr("Output not open: %1").arg(qs(error)));
        logger_.log(rr::log::Level::Error, "audio", "output_open_failed", error,
                    {{"device", output_combo_->currentText().toStdString()}});
        update_controls();
        return false;
    }
    const auto& p = engine_->playback_description();
    logger_.log(rr::log::Level::Info, "audio", "output_opened", "output device opened",
                {{"device", p.device_name}, {"rate", std::to_string(p.sample_rate)},
                 {"channels", std::to_string(p.channels)}, {"internal_rate", std::to_string(p.device_internal_rate)}});
    show_info(tr("Output open: %1").arg(qs(p.device_name)));
    update_monitor_description();
    update_controls();
    return true;
}

void AudioPanel::close_output(const QString& reason) {
    if (!engine_->playback_open()) {
        return;
    }
    engine_->close_playback();
    logger_.log(rr::log::Level::Info, "audio", "output_closed", "output device closed",
                {{"reason", reason.toStdString()}});
    update_monitor_description();
    update_controls();
}

void AudioPanel::set_monitoring(bool enabled) {
    engine_->monitor().set_enabled(enabled);
    logger_.log(rr::log::Level::Info, "audio", enabled ? "monitoring_on" : "monitoring_off",
                enabled ? "local monitoring enabled" : "local monitoring disabled",
                {{"gain_db", std::to_string(monitor_gain_->value())}});
    update_monitor_description();
}

// States exactly what differs between what is heard and what is saved (MONITOR_PATH.md §3).
void AudioPanel::update_monitor_description() {
    monitor_gain_label_->setText(tr("%1 dB").arg(monitor_gain_->value()));
    if (!engine_->playback_open()) {
        output_format_label_->setText(tr("Output closed."));
    } else {
        const auto& p = engine_->playback_description();
        QString notes;
        for (const auto& n : p.notes) {
            notes += QStringLiteral("\n- ") + qs(n);
        }
        output_format_label_->setText(tr("%1: renders %2 Hz, %3 ch. Device stream: %4, %5 Hz, %6 ch, period %7 x %8.%9")
                                          .arg(qs(p.device_name)).arg(p.sample_rate).arg(p.channels)
                                          .arg(qs(p.device_internal_format)).arg(p.device_internal_rate)
                                          .arg(p.device_internal_channels).arg(p.device_period_frames)
                                          .arg(p.device_periods).arg(notes));
    }
    QString text = tr("Saved master: unprocessed (no gain, no resampling, no noise suppression, no AGC, "
                      "no compression).\nWhat you hear when monitoring: ");
    if (!monitor_check_->isChecked()) {
        text += tr("monitoring is OFF.");
    } else {
        text += tr("channel map to stereo/output, monitor gain %1 dB").arg(monitor_gain_->value());
        if (engine_->playback_open() &&
            engine_->playback_description().device_internal_rate != engine_->playback_description().sample_rate) {
            text += tr(", resampled to %1 Hz by miniaudio").arg(engine_->playback_description().device_internal_rate);
        }
        text += tr(", silence on underruns, latency trims. Added delay: about %1 ms buffer plus both device "
                   "buffers (estimate, not measured).")
                    .arg(1000.0 * engine_->monitor().stats().target_frames / engine_->monitor().sample_rate(), 0, 'f', 0);
        if (!engine_->capture_open() || !engine_->playback_open()) {
            text += tr(" (Open both input and output to hear anything.)");
        }
    }
    processing_label_->setText(text);
}

// Logs new buffer/device problems at most once per second (not from the audio thread).
void AudioPanel::log_problem_deltas() {
    const std::int64_t now = rr::time::monotonic_ns();
    if (now - last_problem_log_ns_ < kProblemLogIntervalNs) {
        return;
    }
    last_problem_log_ns_ = now;
    auto report = [this](const char* event, std::uint64_t value, std::uint64_t& logged, const char* what) {
        if (value > logged) {
            logger_.log(rr::log::Level::Warn, "audio", event, what,
                        {{"new", std::to_string(value - logged)}, {"total", std::to_string(value)}});
            logged = value;
        }
    };
    if (const rr::audio::CaptureIngest* ingest = engine_->ingest()) {
        const auto s = ingest->stats();
        report("record_ring_overrun", s.overrun_events, logged_rec_overruns_,
               "record ring overrun: captured audio dropped (gap filled with silence if recording)");
        report("capture_timing_anomaly", s.timing_anomalies, logged_timing_anomalies_,
               "capture callback arrived late (possible device/OS stall)");
    }
    const auto m = engine_->monitor().stats();
    report("monitor_underrun", m.underrun_events, logged_mon_underruns_, "monitor buffer ran dry (silence heard)");
    report("monitor_overflow", m.overflow_events, logged_mon_overflows_, "monitor buffer full (block not heard)");
    report("monitor_drift_trim", m.drift_trim_events, logged_mon_trims_, "excess monitor latency trimmed");
    const auto e = engine_->device_events();
    report("capture_device_fault", e.capture_faults, logged_capture_faults_, "input device fault");
    report("playback_device_fault", e.playback_faults, logged_playback_faults_, "output device fault");
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
        collect_take_reports();
    }
    close_input(QStringLiteral("shutdown"));
    close_output(QStringLiteral("shutdown"));
}

void AudioPanel::tick() {
    const std::int64_t now = rr::time::monotonic_ns();

    // ---- output / monitor (independent of the input; never touches recording) ----
    const rr::audio::MonitorStats ms = engine_->monitor().stats();
    const double mon_rate = engine_->monitor().sample_rate();
    QString buffers;
    if (engine_->playback_open()) {
        if (engine_->playback_fault() != rr::audio::DeviceFault::None) {
            const QString what = QString::fromLatin1(fault_text(engine_->playback_fault()));
            close_output(QStringLiteral("device_fault"));
            show_error(tr("The output device %1. Monitoring stopped; recording is not affected. "
                          "Choose an output and press Open output.").arg(what));
        } else {
            buffers = tr("Monitor buffer %1 ms (target %2, max %3) | underruns %4 | overflows %5 | latency trims %6 | "
                         "output callbacks %7 | longest output callback %8 us")
                          .arg(1000.0 * ms.fill_frames / mon_rate, 0, 'f', 1)
                          .arg(1000.0 * ms.target_frames / mon_rate, 0, 'f', 0)
                          .arg(1000.0 * ms.max_fill_frames / mon_rate, 0, 'f', 1)
                          .arg(ms.underrun_events).arg(ms.overflow_events).arg(ms.drift_trim_events)
                          .arg(ms.render_callbacks).arg(static_cast<double>(ms.max_render_ns) / 1000.0, 0, 'f', 0);
        }
    }
    const rr::audio::DeviceEventCounts ev = engine_->device_events();
    buffers += (buffers.isEmpty() ? QString() : QStringLiteral("\n")) +
               tr("Device opens: input %1, output %2 | device faults: input %3, output %4")
                   .arg(ev.capture_opens).arg(ev.playback_opens).arg(ev.capture_faults).arg(ev.playback_faults);
    log_problem_deltas();

    rr::audio::CaptureIngest* ingest = engine_->ingest();
    if (ingest == nullptr) {
        buffers_label_->setText(buffers);
        update_controls();
        return;
    }
    float block_max = 0.0f;
    for (std::uint32_t c = 0; c < ingest->channels() && c < meters_.size(); ++c) {
        const rr::audio::ChannelLevels lv = ingest->take_levels(c);
        block_max = std::max(block_max, lv.peak);
        // Bar: peak with hold and release so short peaks stay visible.
        peak_hold_[c] = std::max(lv.peak, peak_hold_[c] * 0.85f);
        const double hold_db = to_dbfs(peak_hold_[c]);
        meters_[c]->setValue(static_cast<int>(std::max(hold_db, static_cast<double>(kMeterMin)) * 10.0));
        const double peak_db = to_dbfs(lv.peak);
        const double rms_db = to_dbfs(lv.rms);
        meter_labels_[c]->setText(peak_db <= -119.0
                                      ? QStringLiteral("ch%1  -inf").arg(c + 1)
                                      : QStringLiteral("ch%1 %2 / %3").arg(c + 1).arg(peak_db, 0, 'f', 1).arg(rms_db, 0, 'f', 1));
        if (lv.clipped > 0) {
            clip_until_ns_[c] = now + kClipHoldNs;
        }
        clip_labels_[c]->setVisible(now < clip_until_ns_[c]);
    }
    if (block_max > kSignalThreshold) {
        last_signal_ns_ = now;
    }
    const std::int64_t since = last_signal_ns_ != 0 ? last_signal_ns_ : input_opened_ns_;
    signal_warning_->setVisible(now - since > kNoSignalNs);

    const rr::audio::IngestStats st = ingest->stats();
    const double in_rate = ingest->sample_rate();
    counters_label_->setText(tr("Input: %1 Hz, %2 ch | callbacks %3, frames %4 | record ring %5 ms (max %6 of %7 ms) | "
                                "ring overruns %8 (%9 frames)")
                                 .arg(ingest->sample_rate()).arg(ingest->channels()).arg(st.callbacks)
                                 .arg(st.frames_captured)
                                 .arg(1000.0 * st.ring_fill_frames / in_rate, 0, 'f', 0)
                                 .arg(1000.0 * st.ring_max_fill_frames / in_rate, 0, 'f', 0)
                                 .arg(1000.0 * st.ring_capacity_frames / in_rate, 0, 'f', 0)
                                 .arg(st.overrun_events).arg(st.overrun_frames) +
                             tr(" | timing anomalies %1 | clipped samples %2 | longest input callback %3 us")
                                 .arg(st.timing_anomalies).arg(st.clipped_samples)
                                 .arg(static_cast<double>(st.max_callback_ns) / 1000.0, 0, 'f', 0));
    buffers_label_->setText(buffers);

    // Collect finished takes first: closing the input below destroys the recorder.
    collect_take_reports();
    if (ingest->device_fault() != rr::audio::DeviceFault::None && !recording_active()) {
        const QString previous = result_label_->text();
        close_input(QStringLiteral("device_fault"));
        refresh_devices();
        show_error(previous + (previous.isEmpty() ? QString() : QStringLiteral("\n")) +
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

void AudioPanel::set_session_control(bool active, std::function<void()> flush) {
    if (!active) {
        collect_take_reports();  // last reports go to the session before control is released
    }
    session_controlled_ = active;
    session_flush_ = active ? std::move(flush) : std::function<void()>();
    logger_.log(rr::log::Level::Info, "audio", "session_control", active ? "recorder controlled by the session"
                                                                          : "recorder back under local control");
    update_controls();
}

void AudioPanel::collect_take_reports() {
    if (session_controlled_) {
        if (session_flush_) {
            session_flush_();  // the session controller collects them through its recorder port
        }
        return;
    }
    if (auto* recorder = engine_->recorder()) {
        for (const auto& meta : recorder->take_finished()) {
            handle_result(meta);
        }
        recorder->take_started();  // start reports matter only to session takes; discard
    }
}

void AudioPanel::update_controls() {
    const bool open = engine_->capture_open();
    const bool out_open = engine_->playback_open();
    const bool recording = recording_active();
    input_button_->setText(open ? tr("Close input") : tr("Open input"));
    input_button_->setEnabled(!recording && (open || input_combo_->count() > 0));
    input_combo_->setEnabled(!open);
    output_button_->setText(out_open ? tr("Close output") : tr("Open output"));
    output_button_->setEnabled(out_open || output_combo_->count() > 0);
    output_combo_->setEnabled(!out_open);
    refresh_button_->setEnabled(!open && !out_open);
    tone_button_->setEnabled(out_open && !engine_->monitor().test_tone_active());
    folder_button_->setEnabled(!recording);
    record_button_->setEnabled(open && !session_controlled_);
    record_button_->setToolTip(session_controlled_
                                   ? tr("A session is active: takes are started and stopped in the Session panel.")
                                   : QString());
    const QString start_text = role_ == Role::Producer ? tr("Record") : tr("Record (local test)");
    record_button_->setText(recording && !session_controlled_ ? tr("Stop") : start_text);
    recover_button_->setEnabled(incomplete_list_->count() > 0);
}

std::string AudioPanel::report_json() const {
    return rr::audio::engine_report_json(*engine_);
}

QString AudioPanel::diagnostics_text() const {
    // Human-readable view of the same snapshot that the exported report contains.
    QString out = QStringLiteral("=== Audio ===\n");
    out += QStringLiteral("recordings folder: %1\n").arg(QDir::toNativeSeparators(recordings_dir_));
    out += QStringLiteral("session: %1  folder: %2\n")
               .arg(session_id_.empty() ? QStringLiteral("(none yet)") : qs(session_id_), qpath(session_dir_));
    out += QStringLiteral("monitoring: %1, gain %2 dB\n")
               .arg(engine_->monitor().enabled() ? QStringLiteral("ON") : QStringLiteral("off"))
               .arg(engine_->monitor().gain_db(), 0, 'f', 1);
    out += QString::fromStdString(report_json());
    out += QLatin1Char('\n');
    return out;
}

}  // namespace rr::ui
