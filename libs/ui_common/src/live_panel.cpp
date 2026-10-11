#include "live_panel.hpp"

#include <algorithm>
#include <cmath>

#include <QCheckBox>
#include <QComboBox>
#include <QFormLayout>
#include <QGroupBox>
#include <QHBoxLayout>
#include <QLabel>
#include <QSettings>
#include <QSlider>
#include <QSpinBox>
#include <QTimer>
#include <QVBoxLayout>

#include "audio_panel.hpp"
#include "rr/media/media_packet.hpp"
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
    "Use headphones. Live audio from speakers is picked up by this PC's microphone and ends up in "
    "your own master recording (and can feed back).";

const char* const kConcealmentNote =
    "Live audio is a monitor only. Lost or late packets are filled in by Opus concealment for "
    "listening; this never repairs or changes any recording. Each PC records its own input locally.";

const char* const kTradeOff =
    "Jitter buffer: fewer frames = less delay but more dropouts when packets arrive unevenly; "
    "more frames = steadier but later. Audio arrives in device blocks of about 10 ms, so keep at "
    "least about 20 ms with 2.5 or 5 ms frames.";

}  // namespace

LivePanel::LivePanel(Role role, const AppConfig& config, AudioPanel& audio, SessionPanel& session,
                     rr::log::Logger& logger, QWidget* parent)
    : QWidget(parent), role_(role), config_(config), audio_(&audio), session_(&session), logger_(logger) {
    auto* outer = new QVBoxLayout(this);
    outer->setContentsMargins(0, 0, 0, 0);
    auto* box = new QGroupBox(role_ == Role::Producer ? tr("Live audio to the performer (one way, Stage 7)")
                                                       : tr("Live audio from the producer (one way, Stage 7)"));
    outer->addWidget(box);
    auto* form = new QFormLayout(box);
    QSettings settings;

    if (role_ == Role::Producer) {
        send_check_ = new QCheckBox(tr("Send my microphone live to the performer"));
        send_check_->setChecked(false);
        form->addRow(send_check_);
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
    } else {
        hear_check_ = new QCheckBox(tr("Hear the producer"));
        hear_check_->setChecked(false);
        form->addRow(hear_check_);
        auto* gain_row = new QHBoxLayout;
        gain_slider_ = new QSlider(Qt::Horizontal);
        gain_slider_->setRange(static_cast<int>(rr::media::kMinGainDb), static_cast<int>(rr::media::kMaxGainDb));
        gain_slider_->setValue(settings.value(QString::fromLatin1(kSettingsGain), -12).toInt());
        gain_label_ = new QLabel;
        gain_row->addWidget(gain_slider_, 1);
        gain_row->addWidget(gain_label_);
        form->addRow(tr("Live volume:"), gain_row);
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
            if (receiver_) {
                receiver_->set_gain_db(static_cast<float>(v));
            }
            render_performer();
        });
        connect(jitter_spin_, qOverload<int>(&QSpinBox::valueChanged), this, [this](int v) {
            QSettings().setValue(QString::fromLatin1(kSettingsJitter), v);
            if (receiver_) {
                receiver_->set_target_frames(static_cast<std::uint32_t>(v));  // applies at the next refill
            }
            render_performer();
        });
    }
    state_label_ = new QLabel;
    state_label_->setWordWrap(true);
    form->addRow(tr("Live:"), state_label_);
    stats_label_ = new QLabel;
    stats_label_->setWordWrap(true);
    stats_label_->setTextInteractionFlags(Qt::TextSelectableByMouse);
    form->addRow(role_ == Role::Producer ? tr("Sent:") : tr("Received:"), stats_label_);
    if (role_ == Role::Producer) {
        peer_stats_label_ = new QLabel;
        peer_stats_label_->setWordWrap(true);
        peer_stats_label_->setTextInteractionFlags(Qt::TextSelectableByMouse);
        form->addRow(tr("Performer reports:"), peer_stats_label_);
    }
    auto* note = new QLabel(tr(kConcealmentNote));
    note->setWordWrap(true);
    form->addRow(note);

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
    if (frame_combo_ != nullptr) {
        c.frame_samples = static_cast<std::uint32_t>(frame_combo_->currentData().toInt());
        c.bitrate_bps = static_cast<std::uint32_t>(bitrate_spin_->value()) * 1000u;
        c.application = mode_combo_->currentData().toInt() == 1 ? rr::media::OpusApplication::Audio
                                                                : rr::media::OpusApplication::RestrictedLowDelay;
    }
    return c;
}

void LivePanel::apply_codec_change() {
    QSettings settings;
    settings.setValue(QString::fromLatin1(kSettingsFrame), frame_combo_->currentData().toInt());
    settings.setValue(QString::fromLatin1(kSettingsBitrate), bitrate_spin_->value());
    settings.setValue(QString::fromLatin1(kSettingsMode), mode_combo_->currentData().toInt());
    // The encoder is configured at start: restart the sender (the performer sees a new stream).
    if (sender_ && sender_->running()) {
        stop_live();
        start_if_possible();
    }
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
    // Both sides derive the media port the same way: control port + 1 (ADR-017; 52001 by default).
    const auto media_port = static_cast<std::uint16_t>(ctx.control_port + 1);
    std::string error;
    if (role_ == Role::Producer) {
        rr::media::LiveSenderConfig sc;
        sc.bind_address = ctx.local_address;
        sc.media_port = media_port;
        sc.session_id = media_session;
        sc.expected_peer_address = ctx.peer_address;
        sc.codec = codec_from_ui();
        sender_ = std::make_unique<rr::media::LiveSender>(&logger_);
        if (!sender_->start(sc, audio_->engine().live_tap(), error)) {
            last_error_ = "live sender could not start: " + error;
            sender_.reset();
        } else {
            last_error_.clear();
        }
    } else {
        rr::media::LiveReceiverConfig rc;
        rc.producer_host = ctx.peer_address;
        rc.media_port = media_port;
        rc.session_id = media_session;
        rc.playout.gain_db = static_cast<float>(gain_slider_->value());
        rc.playout.target_frames = static_cast<std::uint32_t>(jitter_spin_->value());
        receiver_ = std::make_unique<rr::media::LiveReceiver>(&logger_);
        if (!receiver_->start(rc, error)) {
            last_error_ = "live receiver could not start: " + error;
            receiver_.reset();
        } else {
            receiver_->set_output_enabled(hear_check_->isChecked());
            audio_->engine().attach_playback_contributor(receiver_.get());
            attached_ = true;
            last_error_.clear();
        }
    }
    running_session_ = ctx.session_id;
}

void LivePanel::stop_live() {
    if (attached_ && audio_) {
        audio_->engine().detach_playback_contributor();  // the callback can no longer touch the receiver
    }
    attached_ = false;
    if (receiver_) {
        receiver_->stop();
        receiver_.reset();
    }
    if (sender_) {
        sender_->stop();
        sender_.reset();
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
    if (sender_) {
        sender_->set_sending(send_check_->isChecked());
    }
    if (receiver_) {
        receiver_->set_output_enabled(hear_check_->isChecked());
    }
    if (role_ == Role::Producer) {
        render_producer();
    } else {
        render_performer();
    }
}

void LivePanel::render_producer() {
    if (!sender_) {
        state_label_->setText(last_error_.empty() ? tr("starts when a performer has joined the session")
                                                  : qs(last_error_));
        stats_label_->setText(QStringLiteral("-"));
        peer_stats_label_->setText(QStringLiteral("-"));
        return;
    }
    const rr::media::LiveSenderStats s = sender_->stats();
    QString state;
    if (s.streaming) {
        state = tr("SENDING to %1").arg(qs(s.peer_endpoint));
    } else if (!s.sending_enabled) {
        state = tr("off (tick the box to send)");
    } else if (!s.peer_known) {
        state = tr("waiting for the performer to listen");
    } else {
        state = tr("starting");
    }
    if (s.tap.source_rate != 0 && s.tap.source_rate != rr::audio::LiveTap::kRequiredRate) {
        state += tr(" - input runs at %1 Hz; live audio needs 48000 Hz").arg(s.tap.source_rate);
    } else if (s.tap.source_rate == 0 && s.sending_enabled) {
        state += tr(" - open an input device in the audio panel");
    }
    state += tr("\nUDP %1 (allow inbound UDP on this port for the Private profile only).").arg(qs(s.local_endpoint));
    state_label_->setText(state);
    stats_label_->setText(
        tr("%1 packets (%2 kB), %3 send errors, %4 encode errors; capture gaps %5 frames, backlog trimmed %6 frames; "
           "%7, %8 ms frames, %9 kbit/s CBR, codec delay %10 ms (lookahead read from libopus), max encode %11 ms")
            .arg(s.packets_sent)
            .arg(s.bytes_sent / 1000)
            .arg(s.send_errors)
            .arg(s.encode_errors)
            .arg(s.tap_gap_frames)
            .arg(s.backlog_trim_frames)
            .arg(qs(s.opus_version))
            .arg(rr::media::frame_ms(s.frame_samples), 0, 'g', 3)
            .arg(s.bitrate_bps / 1000)
            .arg(s.lookahead_samples / 48.0, 0, 'f', 2)
            .arg(static_cast<double>(s.max_encode_ns) / 1e6, 0, 'f', 3));
    if (!s.has_report) {
        peer_stats_label_->setText(tr("no report yet"));
        return;
    }
    const rr::media::ReceiverReport& r = s.last_report;
    peer_stats_label_->setText(
        tr("%1 (%2 ms ago): received %3, lost (estimate) %4, late %5, duplicates %6, reordered %7, jitter %8 ms, "
           "buffer %9/%10 frames, underruns %11, concealed %12, decode errors %13, invalid %14")
            .arg((r.flags & rr::media::ReceiverReport::kFlagPlaying) != 0 ? tr("listening") : tr("not listening"))
            .arg(s.last_report_age_ms, 0, 'f', 0)
            .arg(r.received)
            .arg(r.lost_estimate)
            .arg(r.late)
            .arg(r.duplicates)
            .arg(r.reordered)
            .arg(r.jitter_us / 1000.0, 0, 'f', 2)
            .arg(r.jb_fill)
            .arg(r.jb_target)
            .arg(r.underruns)
            .arg(r.concealed)
            .arg(r.decode_errors)
            .arg(r.invalid_packets));
}

void LivePanel::render_performer() {
    gain_label_->setText(tr("%1 dB").arg(gain_slider_->value()));
    const std::uint32_t frame = receiver_ ? receiver_->stats().last_frame_samples : 0u;
    jitter_label_->setText(frame != 0 ? tr("= %1 ms at the producer's %2 ms frames")
                                            .arg(rr::media::frame_ms(frame) * jitter_spin_->value(), 0, 'g', 3)
                                            .arg(rr::media::frame_ms(frame), 0, 'g', 3)
                                      : tr("(= frames x the producer's frame size)"));
    if (!receiver_) {
        state_label_->setText(last_error_.empty() ? tr("starts when you have joined a session") : qs(last_error_));
        stats_label_->setText(QStringLiteral("-"));
        return;
    }
    const rr::media::LiveReceiverStats r = receiver_->stats();
    QString state;
    if (!r.output_enabled) {
        state = tr("off (tick the box to hear the producer)");
    } else if (r.last_render_age_ms < 0.0 || r.last_render_age_ms > 1000.0) {
        state = tr("no output device is playing: open an output in the audio panel");
    } else if (r.wrong_rate_callbacks > 0 && audio_ && audio_->engine().playback_rate() != rr::media::kLiveSampleRate) {
        state = tr("output runs at %1 Hz; live audio needs 48000 Hz").arg(audio_->engine().playback_rate());
    } else if (r.last_packet_age_ms < 0.0) {
        state = tr("waiting for the producer to send");
    } else if (r.last_packet_age_ms > 1000.0) {
        state = tr("no live packets for %1 s (producer not sending, or the network/firewall blocks UDP)")
                    .arg(r.last_packet_age_ms / 1000.0, 0, 'f', 1);
    } else {
        state = r.jb_playing ? tr("PLAYING (peak %1 dBFS)").arg(static_cast<double>(r.output_peak_dbfs), 0, 'f', 1)
                             : tr("buffering");
    }
    state_label_->setText(state + tr("\nfrom %1").arg(qs(r.producer_endpoint)));
    stats_label_->setText(
        tr("%1 packets, lost (estimate) %2, late %3, duplicates %4, reordered %5, jitter %6 ms (max gap %7 ms), "
           "buffer %8/%9 frames (max %10), underruns %11, concealed %12, refills %13, decode errors %14, invalid %15, "
           "max decode+mix %16 ms")
            .arg(r.arrival.received)
            .arg(r.arrival.lost_estimate)
            .arg(r.jb.late)
            .arg(r.arrival.duplicates)
            .arg(r.arrival.reordered)
            .arg(r.arrival.jitter_ms, 0, 'f', 2)
            .arg(r.arrival.max_gap_ms, 0, 'f', 1)
            .arg(r.jb_held)
            .arg(r.jb_target)
            .arg(r.jb_max_held)
            .arg(r.jb.underruns)
            .arg(r.concealed)
            .arg(r.jb.rebuffers)
            .arg(r.decode_errors)
            .arg(r.invalid.total())
            .arg(static_cast<double>(r.max_render_ns) / 1e6, 0, 'f', 3));
}

void LivePanel::shut_down() {
    if (timer_) {
        timer_->stop();
    }
    stop_live();
}

QString LivePanel::diagnostics_text() const {
    QString out = QStringLiteral("=== Live audio (one way, producer -> performer) ===\n");
    if (sender_) {
        const auto s = sender_->stats();
        out += QStringLiteral("sender: %1, local %2, peer %3, packets %4, bytes %5, send errors %6, encode errors %7, "
                              "tap gaps %8, backlog trims %9, reports %10, peer timeouts %11, invalid in %12\n"
                              "codec: %13, %14, frame %15 samples, %16 bit/s CBR, complexity %17, lookahead %18 samples\n")
                   .arg(s.streaming ? QStringLiteral("streaming") : QStringLiteral("not streaming"), qs(s.local_endpoint),
                        s.peer_known ? qs(s.peer_endpoint) : QStringLiteral("-"))
                   .arg(s.packets_sent)
                   .arg(s.bytes_sent)
                   .arg(s.send_errors)
                   .arg(s.encode_errors)
                   .arg(s.tap_gap_frames)
                   .arg(s.backlog_trim_frames)
                   .arg(s.reports_received)
                   .arg(s.peer_timeouts)
                   .arg(s.invalid.total())
                   .arg(qs(s.opus_version), qs(s.application))
                   .arg(s.frame_samples)
                   .arg(s.bitrate_bps)
                   .arg(s.complexity)
                   .arg(s.lookahead_samples);
    }
    if (receiver_) {
        const auto r = receiver_->stats();
        out += QStringLiteral("receiver: from %1, received %2, lost est %3, dup %4, reordered %5, late %6, jitter %7 ms, "
                              "max gap %8 ms, buffer %9/%10, underruns %11, concealed %12, refills %13, drift skips %14, "
                              "decode errors %15, queue-full %16, wrong-rate callbacks %17, max render %18 ms\n"
                              "invalid: src %19, oversized %20, length %21, version %22, type %23, crc %24, session %25, "
                              "payload %26\n")
                   .arg(qs(r.producer_endpoint))
                   .arg(r.arrival.received)
                   .arg(r.arrival.lost_estimate)
                   .arg(r.arrival.duplicates)
                   .arg(r.arrival.reordered)
                   .arg(r.jb.late)
                   .arg(r.arrival.jitter_ms, 0, 'f', 3)
                   .arg(r.arrival.max_gap_ms, 0, 'f', 1)
                   .arg(r.jb_held)
                   .arg(r.jb_target)
                   .arg(r.jb.underruns)
                   .arg(r.concealed)
                   .arg(r.jb.rebuffers)
                   .arg(r.jb.drift_skips)
                   .arg(r.decode_errors)
                   .arg(r.queue_full_drops)
                   .arg(r.wrong_rate_callbacks)
                   .arg(static_cast<double>(r.max_render_ns) / 1e6, 0, 'f', 3)
                   .arg(r.invalid.src_rejected)
                   .arg(r.invalid.oversized)
                   .arg(r.invalid.bad_length)
                   .arg(r.invalid.bad_version)
                   .arg(r.invalid.bad_type)
                   .arg(r.invalid.bad_crc)
                   .arg(r.invalid.bad_session)
                   .arg(r.invalid.bad_payload);
    }
    if (!sender_ && !receiver_) {
        out += QStringLiteral("not running (needs a connected session)\n");
    }
    return out;
}

}  // namespace rr::ui
