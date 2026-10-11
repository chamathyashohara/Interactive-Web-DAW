#pragma once

#include <cstdint>
#include <memory>
#include <string>

#include <QPointer>
#include <QString>
#include <QWidget>

#include "rr/media/live_receiver.hpp"
#include "rr/media/live_sender.hpp"
#include "rr/shared/config.hpp"
#include "rr/shared/log.hpp"

class QCheckBox;
class QComboBox;
class QLabel;
class QSlider;
class QSpinBox;
class QTimer;

namespace rr::ui {

class AudioPanel;
class SessionPanel;

// One-way live audio, producer -> performer (Stage 7, ADR-017), on top of rr::media.
//
// Starts with the session (it needs the session id and the peer address) and stops when the
// session ends. Off by default on both sides: the producer must tick "Send my microphone live"
// and the performer "Hear the producer". The live stream is separate from both local master
// recordings; concealment of lost packets affects only what the performer hears.
// Producer: on/off, frame size, bitrate, Opus mode; own counters and the performer's reports.
// Performer: on/off, output gain (-60..0 dB), jitter-buffer depth, headphones advice, counters.
class LivePanel final : public QWidget {
    Q_OBJECT

public:
    LivePanel(Role role, const AppConfig& config, AudioPanel& audio, SessionPanel& session, rr::log::Logger& logger,
              QWidget* parent = nullptr);
    ~LivePanel() override;

    // App closing: stops live audio and detaches from the output BEFORE the audio engine goes.
    void shut_down();
    QString diagnostics_text() const;

private:
    void tick();
    void start_if_possible();
    void stop_live();
    void apply_codec_change();
    void render_producer();
    void render_performer();
    rr::media::LiveCodecSettings codec_from_ui() const;

    Role role_;
    AppConfig config_;
    QPointer<AudioPanel> audio_;
    QPointer<SessionPanel> session_;
    rr::log::Logger& logger_;
    std::unique_ptr<rr::media::LiveSender> sender_;
    std::unique_ptr<rr::media::LiveReceiver> receiver_;
    std::string running_session_;  // session id the live objects were started for
    std::string last_error_;
    bool attached_ = false;
    QTimer* timer_ = nullptr;

    // producer
    QCheckBox* send_check_ = nullptr;
    QComboBox* frame_combo_ = nullptr;
    QSpinBox* bitrate_spin_ = nullptr;
    QComboBox* mode_combo_ = nullptr;
    // performer
    QCheckBox* hear_check_ = nullptr;
    QSlider* gain_slider_ = nullptr;
    QLabel* gain_label_ = nullptr;
    QSpinBox* jitter_spin_ = nullptr;
    QLabel* jitter_label_ = nullptr;
    // both
    QLabel* state_label_ = nullptr;
    QLabel* stats_label_ = nullptr;
    QLabel* peer_stats_label_ = nullptr;
};

}  // namespace rr::ui
