#include "live_panel.hpp"

#include <algorithm>
#include <cmath>
#include <cstdio>

#include <QCheckBox>
#include <QComboBox>
#include <QDateTime>
#include <QDir>
#include <QFile>
#include <QFileDialog>
#include <QFormLayout>
#include <QGroupBox>
#include <QHBoxLayout>
#include <QLabel>
#include <QMessageBox>
#include <QPushButton>
#include <QSettings>
#include <QSlider>
#include <QSpinBox>
#include <QStandardPaths>
#include <QTimer>
#include <QVBoxLayout>

#include "audio_panel.hpp"
#include "rr/media/live_report.hpp"
#include "rr/media/media_packet.hpp"
#include "rr/shared/build_info.hpp"
#include "rr/shared/clock.hpp"
#include "session_panel.hpp"

namespace rr::ui {
namespace {

QString qs(const std::string& s) {
    return QString::fromUtf8(s.data(), static_cast<qsizetype>(s.size()));
}

constexpr const char* kSettingsFrame = "live/frame_samples";
constexpr const char* kSettingsBitrate = "live/bitrate_kbps";
constexpr const char* kSettingsMode = "live/application";
constexpr const char* kSettingsGain = "live/gain_db";
constexpr const char* kSettingsJitter = "live/jitter_frames";

const char* const kHeadphones =
    "Use headphones on BOTH PCs. This app has no echo cancellation: sound from speakers reaches the "
    "microphone, is sent back (the other person hears themselves) and ends up in your own master "
    "recording.";

const char* const kConcealmentNote =
    "Live audio is a monitor only. Lost or late packets are filled in by Opus concealment for "
    "listening; this never repairs or changes any recording. Each PC records its own microphone "
    "locally; received live audio is never written to a recording.";

const char* const kTradeOff =
    "Jitter buffer: fewer frames = less delay but more dropouts when packets arrive unevenly; "
    "more frames = steadier but later (each frame adds one frame of delay in this direction).";

}  // namespace

LivePanel::LivePanel(Role role, const AppConfig& config, AudioPanel& audio, SessionPanel& session,
                     rr::log::Logger& logger, QWidget* parent)
    : QWidget(parent), role_(role), config_(config), audio_(&audio), session_(&session), logger_(logger) {
    const QString other = role_ == Role::Producer ? tr("the performer") : tr("the producer");
    auto* outer = new QVBoxLayout(this);
    outer->setContentsMargins(0, 0, 0, 0);
    auto* box = new QGroupBox(tr("Live audio (talkback, both directions)"));
    outer->addWidget(box);
    auto* form = new QFormLayout(box);
    QSettings settings;

    // ---- outgoing ----
    auto* send_row = new QHBoxLayout;
    send_check_ = new QCheckBox(tr("Send my microphone live to %1").arg(other));
    send_check_->setChecked(false);
    mute_button_ = new QPushButton(tr("Mute my microphone"));
    mute_button_->setCheckable(true);
    mute_button_->setToolTip(tr("Talkback mute: %1 hears silence; your own recording is NOT affected.").arg(other));
    send_row->addWidget(send_check_, 1);
    send_row->addWidget(mute_button_);
    form->addRow(send_row);
    frame_combo_ = new QComboBox;
    for (const std::uint32_t f : {120u, 240u, 480u, 960u}) {
        frame_combo_->addItem(tr("%1 ms").arg(rr::media::frame_ms(f), 0, 'g', 3), static_cast<int>(f));
    }
    const int default_frame = static_cast<int>(config_.audio.live_frame_us * 48 / 1000);
    frame_combo_->setCurrentIndex(
        std::max(0, frame_combo_->findData(settings.value(QString::fromLatin1(kSettingsFrame), default_frame).toInt())));
    form->addRow(tr("Frame size:"), frame_combo_);
    bitrate_spin_ = new QSpinBox;
    bitrate_spin_->setRange(static_cast<int>(rr::media::kMinBitrate / 1000), static_cast<int>(rr::media::kMaxBitrate / 1000));
    bitrate_spin_->setSuffix(tr(" kbit/s"));
    bitrate_spin_->setValue(settings.value(QString::fromLatin1(kSettingsBitrate), 64).toInt());
    form->addRow(tr("Bitrate (constant):"), bitrate_spin_);
    mode_combo_ = new QComboBox;
    mode_combo_->addItem(tr("Lowest delay (Opus RESTRICTED_LOWDELAY)"), 0);
    mode_combo_->addItem(tr("Music / mixed (Opus AUDIO, more codec delay)"), 1);
    mode_combo_->setCurrentIndex(settings.value(QString::fromLatin1(kSettingsMode), 0).toInt() == 1 ? 1 : 0);
    form->addRow(tr("Codec mode:"), mode_combo_);
    for (QComboBox* c : {frame_combo_, mode_combo_}) {
        connect(c, qOverload<int>(&QComboBox::currentIndexChanged), this, [this] { apply_codec_change(); });
    }
    connect(bitrate_spin_, qOverload<int>(&QSpinBox::valueChanged), this, [this] { apply_codec_change(); });
    connect(send_check_, &QCheckBox::toggled, this, [this] { apply_switches(); });
    connect(mute_button_, &QPushButton::toggled, this, [this] { apply_switches(); });

    // ---- incoming ----
    hear_check_ = new QCheckBox(tr("Hear %1").arg(other));
    hear_check_->setChecked(false);
    form->addRow(hear_check_);
    connect(hear_check_, &QCheckBox::toggled, this, [this] { apply_switches(); });
    auto* gain_row = new QHBoxLayout;
    gain_slider_ = new QSlider(Qt::Horizontal);
    gain_slider_->setRange(static_cast<int>(rr::media::kMinGainDb), static_cast<int>(rr::media::kMaxGainDb));
    gain_slider_->setValue(settings.value(QString::fromLatin1(kSettingsGain), -12).toInt());
    gain_label_ = new QLabel;
    gain_row->addWidget(gain_slider_, 1);
    gain_row->addWidget(gain_label_);
    form->addRow(tr("Volume of %1:").arg(other), gain_row);
    auto* jitter_row = new QHBoxLayout;
    jitter_spin_ = new QSpinBox;
    jitter_spin_->setRange(static_cast<int>(rr::media::kMinTargetFrames), static_cast<int>(rr::media::kMaxTargetFrames));
    jitter_spin_->setSuffix(tr(" frames"));
    jitter_spin_->setValue(
        settings.value(QString::fromLatin1(kSettingsJitter), static_cast<int>(config_.audio.jitter_depth_frames)).toInt());
    jitter_label_ = new QLabel;
    jitter_row->addWidget(jitter_spin_);
    jitter_row->addWidget(jitter_label_, 1);
    form->addRow(tr("Jitter buffer:"), jitter_row);
    auto* tradeoff = new QLabel(tr(kTradeOff));
    tradeoff->setWordWrap(true);
    form->addRow(tradeoff);
    auto* headphones = new QLabel(tr(kHeadphones));
    headphones->setWordWrap(true);
    headphones->setObjectName(QStringLiteral("headphonesNotice"));
    form->addRow(headphones);
    connect(gain_slider_, &QSlider::valueChanged, this, [this](int v) {
        QSettings().setValue(QString::fromLatin1(kSettingsGain), v);
        if (endpoint_ && endpoint_->incoming()) {
            endpoint_->incoming()->set_gain_db(static_cast<float>(v));
        }
        render();
    });
    connect(jitter_spin_, qOverload<int>(&QSpinBox::valueChanged), this, [this](int v) {
        QSettings().setValue(QString::fromLatin1(kSettingsJitter), v);
        if (endpoint_ && endpoint_->incoming()) {
            endpoint_->incoming()->set_target_frames(static_cast<std::uint32_t>(v));  // applies at the next refill
        }
        render();
    });

    // ---- five separate status rows ----
    auto make_row = [form](const QString& name) {
        auto* label = new QLabel;
        label->setWordWrap(true);
        label->setTextInteractionFlags(Qt::TextSelectableByMouse);
        form->addRow(name, label);
        return label;
    };
    capture_row_ = make_row(tr("Local capture:"));
    recording_row_ = make_row(tr("Local recording:"));
    outgoing_row_ = make_row(tr("Outgoing stream:"));
    out_stats_label_ = make_row(QString());
    incoming_row_ = make_row(tr("Incoming stream:"));
    in_stats_label_ = make_row(QString());
    remote_row_ = make_row(tr("Remote participant:"));
    auto* note = new QLabel(tr(kConcealmentNote));
    note->setWordWrap(true);
    form->addRow(note);
    report_button_ = new QPushButton(tr("Export live report (one page)..."));
    connect(report_button_, &QPushButton::clicked, this, [this] { export_report(); });
    form->addRow(report_button_);

    timer_ = new QTimer(this);
    timer_->setInterval(200);
    connect(timer_, &QTimer::timeout, this, [this] { tick(); });
    timer_->start();
    tick();
}

LivePanel::~LivePanel() {
    shut_down();
}

rr::media::LiveCodecSettings LivePanel::codec_from_ui() const {
    rr::media::LiveCodecSettings c;
    c.frame_samples = static_cast<std::uint32_t>(frame_combo_->currentData().toInt());
    c.bitrate_bps = static_cast<std::uint32_t>(bitrate_spin_->value()) * 1000u;
    c.application = mode_combo_->currentData().toInt() == 1 ? rr::media::OpusApplication::Audio
                                                            : rr::media::OpusApplication::RestrictedLowDelay;
    return c;
}

void LivePanel::apply_codec_change() {
    QSettings settings;
    settings.setValue(QString::fromLatin1(kSettingsFrame), frame_combo_->currentData().toInt());
    settings.setValue(QString::fromLatin1(kSettingsBitrate), bitrate_spin_->value());
    settings.setValue(QString::fromLatin1(kSettingsMode), mode_combo_->currentData().toInt());
    // The encoder is configured at start: restart the endpoint (both directions resume at once).
    if (endpoint_ && endpoint_->running()) {
        stop_live();
        start_if_possible();
    }
}

void LivePanel::apply_switches() {
    if (!endpoint_) {
        return;
    }
    if (auto* out = endpoint_->outgoing()) {
        out->set_enabled(send_check_->isChecked());
        out->set_muted(mute_button_->isChecked());
    }
    if (auto* in = endpoint_->incoming()) {
        in->set_output_enabled(hear_check_->isChecked());
    }
    mute_button_->setText(mute_button_->isChecked() ? tr("MUTED - click to unmute") : tr("Mute my microphone"));
}

void LivePanel::start_if_possible() {
    if (!session_ || !audio_) {
        return;
    }
    const LiveContext ctx = session_->live_context();
    std::uint32_t media_session = 0;
    if (!ctx.connected || !rr::media::session_id_to_u32(ctx.session_id, media_session) || ctx.control_port == 0 ||
        ctx.control_port == 65535) {
        return;
    }
    const bool producer = role_ == Role::Producer;
    rr::media::LiveEndpointConfig c;
    c.bind_mode = producer;
    c.local_address = ctx.local_address;
    c.peer_address = ctx.peer_address;
    // Both sides derive the media port the same way: control port + 1 (ADR-017; 52001 by default).
    c.media_port = static_cast<std::uint16_t>(ctx.control_port + 1);
    c.session_id = media_session;
    c.has_outgoing = true;
    c.outgoing.stream_id = producer ? rr::media::kStreamProducerMic : rr::media::kStreamPerformerMic;
    c.outgoing.codec = codec_from_ui();
    c.has_incoming = true;
    c.incoming.stream_id = producer ? rr::media::kStreamPerformerMic : rr::media::kStreamProducerMic;
    c.incoming.playout.gain_db = static_cast<float>(gain_slider_->value());
    c.incoming.playout.target_frames = static_cast<std::uint32_t>(jitter_spin_->value());
    endpoint_ = std::make_unique<rr::media::LiveEndpoint>(&logger_);
    std::string error;
    if (!endpoint_->start(c, &audio_->engine().live_tap(), error)) {
        last_error_ = "live audio could not start: " + error;
        endpoint_.reset();
    } else {
        apply_switches();
        audio_->engine().attach_playback_contributor(endpoint_->incoming());
        attached_ = true;
        last_error_.clear();
    }
    running_session_ = ctx.session_id;
}

void LivePanel::stop_live() {
    if (attached_ && audio_) {
        audio_->engine().detach_playback_contributor();  // the callback can no longer touch the stream
    }
    attached_ = false;
    if (endpoint_) {
        endpoint_->stop();
        endpoint_.reset();
    }
    running_session_.clear();
}

void LivePanel::tick() {
    if (!session_ || !audio_) {
        stop_live();
        return;
    }
    const LiveContext ctx = session_->live_context();
    if (!ctx.session_open) {
        stop_live();
    } else if (ctx.connected && ctx.session_id != running_session_) {
        stop_live();
        start_if_possible();
    }
    if (endpoint_) {
        // While the control link is up, a silent media direction does not stop the other (ADR-018).
        endpoint_->set_control_link_up(ctx.connected);
    }
    render();
}

std::string LivePanel::local_capture_status() const {
    if (!audio_) {
        return "-";
    }
    rr::audio::AudioEngine& engine = audio_->engine();
    if (!engine.capture_open()) {
        return "no input device open (open one in the audio panel)";
    }
    const auto& d = engine.capture_description();
    std::string s = "running: " + d.device_name + ", " + std::to_string(d.sample_rate) + " Hz, " +
                    std::to_string(d.channels) + " ch";
    if (engine.capture_fault() != rr::audio::DeviceFault::None) {
        s += " - DEVICE FAULT (stopped or unplugged)";
    }
    return s;
}

std::string LivePanel::local_recording_status() const {
    if (audio_ && audio_->recording_active()) {
        return "RECORDING (local take, no session)";
    }
    if (!session_) {
        return "-";
    }
    const LiveContext ctx = session_->live_context();
    return ctx.recording_status.empty() ? std::string("idle") : ctx.recording_status;
}

std::string LivePanel::remote_status() const {
    if (!session_) {
        return "-";
    }
    const LiveContext ctx = session_->live_context();
    if (!ctx.session_open) {
        return "no session";
    }
    char rtt[32];
    std::snprintf(rtt, sizeof rtt, "%.1f", ctx.control_rtt_ms);
    return "'" + ctx.peer_name + "' at " + ctx.peer_address + ", control link " + ctx.link_state + ", control RTT " + rtt +
           " ms";
}

void LivePanel::render() {
    gain_label_->setText(tr("%1 dB").arg(gain_slider_->value()));
    capture_row_->setText(qs(local_capture_status()));
    recording_row_->setText(qs(local_recording_status()));
    remote_row_->setText(qs(remote_status()));
    if (!endpoint_) {
        const QString idle = last_error_.empty() ? tr("starts when the session is connected") : qs(last_error_);
        outgoing_row_->setText(idle);
        incoming_row_->setText(idle);
        out_stats_label_->clear();
        in_stats_label_->clear();
        jitter_label_->setText(tr("(= frames x the other side's frame size)"));
        return;
    }
    const rr::media::EndpointStats e = endpoint_->stats();
    if (const auto* out = endpoint_->outgoing()) {
        const auto o = out->stats();
        outgoing_row_->setText(qs(rr::media::outgoing_status_text(o, e)));
        QString remote = tr("no report from the other side yet");
        if (e.has_remote_report) {
            const auto& r = e.remote_report;
            remote = tr("they received %1, lost (est.) %2, late %3, jitter %4 ms, underruns %5, concealed %6")
                         .arg(r.received)
                         .arg(r.lost_estimate)
                         .arg(r.late)
                         .arg(r.jitter_us / 1000.0, 0, 'f', 2)
                         .arg(r.underruns)
                         .arg(r.concealed);
        }
        out_stats_label_->setText(tr("sent %1 packets (%2 muted frames), send errors %3, capture gaps %4 frames, "
                                     "backlog trimmed %5 frames, codec delay %6 ms; %7")
                                      .arg(o.packets_sent)
                                      .arg(o.muted_frames)
                                      .arg(o.send_errors)
                                      .arg(o.tap_gap_frames)
                                      .arg(o.backlog_trim_frames)
                                      .arg(o.lookahead_samples / 48.0, 0, 'f', 2)
                                      .arg(remote));
    }
    if (const auto* in = endpoint_->incoming()) {
        const auto i = in->stats();
        incoming_row_->setText(qs(rr::media::incoming_status_text(i, e)));
        in_stats_label_->setText(tr("received %1, lost (est.) %2, late %3, duplicates %4, reordered %5, jitter %6 ms "
                                    "(max gap %7 ms), buffer %8/%9 (max %10), underruns %11, concealed %12, refills %13, "
                                    "catch-up %14, queue full %15, decode errors %16")
                                     .arg(i.arrival.received)
                                     .arg(i.arrival.lost_estimate)
                                     .arg(i.jb.late)
                                     .arg(i.arrival.duplicates)
                                     .arg(i.arrival.reordered)
                                     .arg(i.arrival.jitter_ms, 0, 'f', 2)
                                     .arg(i.arrival.max_gap_ms, 0, 'f', 1)
                                     .arg(i.jb_held)
                                     .arg(i.jb_target)
                                     .arg(i.jb_max_held)
                                     .arg(i.jb.underruns)
                                     .arg(i.concealed)
                                     .arg(i.jb.rebuffers)
                                     .arg(i.jb.catchup_frames)
                                     .arg(i.queue_full_drops)
                                     .arg(i.decode_errors));
        jitter_label_->setText(i.last_frame_samples != 0
                                   ? tr("= %1 ms at the other side's %2 ms frames")
                                         .arg(rr::media::frame_ms(i.last_frame_samples) * jitter_spin_->value(), 0, 'g', 3)
                                         .arg(rr::media::frame_ms(i.last_frame_samples), 0, 'g', 3)
                                   : tr("(= frames x the other side's frame size)"));
    }
}

void LivePanel::export_report() {
    if (!endpoint_) {
        QMessageBox::information(this, tr("Live report"), tr("Live audio is not running (no connected session)."));
        return;
    }
    const QString suggested =
        QDir(QStandardPaths::writableLocation(QStandardPaths::DocumentsLocation))
            .filePath(QStringLiteral("rr_live_report_%1_%2.txt")
                          .arg(role_ == Role::Producer ? QStringLiteral("producer") : QStringLiteral("performer"),
                               QDateTime::currentDateTimeUtc().toString(QStringLiteral("yyyyMMdd-HHmmss"))));
    const QString path = QFileDialog::getSaveFileName(this, tr("Export live report"), suggested, tr("Text (*.txt)"));
    if (path.isEmpty()) {
        return;
    }
    rr::media::LiveReportConditions c;
    c.generated_utc = rr::time::format_utc_iso8601_ms(rr::time::utc_now_ms());
    c.role = role_ == Role::Producer ? "Producer Studio" : "Performer Client";
    c.app_version = rr::build_info().version;
    c.session_id = session_ ? session_->live_context().session_id : std::string();
    rr::audio::AudioEngine& engine = audio_->engine();
    c.capture_device = engine.capture_open() ? engine.capture_description().device_name : "(none)";
    c.capture_rate = engine.capture_open() ? engine.capture_description().sample_rate : 0;
    c.output_device = engine.playback_open() ? engine.playback_description().device_name : "(none)";
    c.output_rate = engine.playback_rate();
    c.local_capture_status = local_capture_status();
    c.local_recording_status = local_recording_status();
    c.remote_participant_status = remote_status();
    c.test_conditions = "app run (fill in the network and set-up in the test record)";
    const auto answer = QMessageBox::question(this, tr("Live report"), tr("Are both people wearing headphones?"),
                                              QMessageBox::Yes | QMessageBox::No, QMessageBox::No);
    c.headphones = answer == QMessageBox::Yes ? "confirmed by the user" : "NOT confirmed";
    const QByteArray data = QString::fromStdString(rr::media::live_report_text(c, *endpoint_)).toUtf8();
    QFile file(path);
    if (!file.open(QIODevice::WriteOnly | QIODevice::Truncate) || file.write(data) != data.size()) {
        QMessageBox::warning(this, tr("Export failed"), tr("Could not write %1: %2").arg(path, file.errorString()));
        return;
    }
    logger_.log(rr::log::Level::Info, "ui", "live_report_exported", "live report written", {{"path", path.toStdString()}});
}

void LivePanel::shut_down() {
    if (timer_) {
        timer_->stop();
    }
    stop_live();
}

QString LivePanel::diagnostics_text() const {
    QString out = QStringLiteral("=== Live audio (both directions) ===\n");
    if (!endpoint_) {
        return out + QStringLiteral("not running (needs a connected session)\n");
    }
    rr::media::LiveReportConditions c;
    c.role = role_ == Role::Producer ? "Producer Studio" : "Performer Client";
    c.app_version = rr::build_info().version;
    c.local_capture_status = local_capture_status();
    c.local_recording_status = local_recording_status();
    c.remote_participant_status = remote_status();
    c.test_conditions = "live view";
    c.headphones = "not asked (diagnostics view)";
    return out + QString::fromStdString(rr::media::live_report_text(c, *endpoint_));
}

}  // namespace rr::ui
