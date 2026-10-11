#pragma once

#include <cstdint>
#include <memory>
#include <string>

#include <QPointer>
#include <QString>
#include <QWidget>

#include "rr/media/live_endpoint.hpp"
#include "rr/shared/config.hpp"
#include "rr/shared/log.hpp"

class QCheckBox;
class QComboBox;
class QLabel;
class QPushButton;
class QSlider;
class QSpinBox;
class QTimer;

namespace rr::ui {

class AudioPanel;
class SessionPanel;

// Two-way live audio (Stage 8, ADR-018; one-way since Stage 7, ADR-017) on top of
// rr::media::LiveEndpoint: this PC sends its microphone (producer stream 1 / performer stream 2)
// and plays the other side's.
//
// Starts with the session and stops when it ends. Everything is OFF by default. Controls, each
// independent and none of them touching local recording:
//  - Send my microphone live (stream on/off)
//  - Mute my microphone (talkback mute: the stream keeps running as flagged silence, so the
//    other side sees "muted", not a failure; the local recording continues unchanged)
//  - Hear the other side (receive mute), its volume (-60..0 dB) and jitter-buffer depth
// Five separate status rows: local capture, local recording, outgoing stream, incoming stream,
// remote participant. "Export live report" writes the one-page diagnostics of both directions.
// No echo cancellation is implemented: the panel tells both people to use headphones.
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
    void apply_switches();
    void render();
    void export_report();
    rr::media::LiveCodecSettings codec_from_ui() const;
    std::string local_capture_status() const;
    std::string local_recording_status() const;
    std::string remote_status() const;

    Role role_;
    AppConfig config_;
    QPointer<AudioPanel> audio_;
    QPointer<SessionPanel> session_;
    rr::log::Logger& logger_;
    std::unique_ptr<rr::media::LiveEndpoint> endpoint_;
    std::string running_session_;  // session id the endpoint was started for
    std::string last_error_;
    bool attached_ = false;
    QTimer* timer_ = nullptr;

    // outgoing
    QCheckBox* send_check_ = nullptr;
    QPushButton* mute_button_ = nullptr;
    QComboBox* frame_combo_ = nullptr;
    QSpinBox* bitrate_spin_ = nullptr;
    QComboBox* mode_combo_ = nullptr;
    // incoming
    QCheckBox* hear_check_ = nullptr;
    QSlider* gain_slider_ = nullptr;
    QLabel* gain_label_ = nullptr;
    QSpinBox* jitter_spin_ = nullptr;
    QLabel* jitter_label_ = nullptr;
    // status rows
    QLabel* capture_row_ = nullptr;
    QLabel* recording_row_ = nullptr;
    QLabel* outgoing_row_ = nullptr;
    QLabel* incoming_row_ = nullptr;
    QLabel* remote_row_ = nullptr;
    QLabel* out_stats_label_ = nullptr;
    QLabel* in_stats_label_ = nullptr;
    QPushButton* report_button_ = nullptr;
};

}  // namespace rr::ui
