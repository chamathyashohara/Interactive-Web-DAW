#pragma once

#include <cstdint>
#include <memory>
#include <string>

#include <QPointer>
#include <QString>
#include <QWidget>

#include "rr/media/LiveEndpoint.h"
#include "rr/shared/Config.h"
#include "rr/shared/Log.h"

class QCheckBox;
class QComboBox;
class QLabel;
class QPushButton;
class QSlider;
class QSpinBox;
class QTimer;

class AudioPanel;
class SessionPanel;

/**
 * Two-way live audio (Stage 8, ADR-018; one-way since Stage 7, ADR-017) on top of
 * LiveEndpoint: this PC sends its microphone (producer stream 1 / performer stream 2)
 * and plays the other side's.
 *
 * Starts with the session and stops when it ends. Everything is OFF by default. Controls, each
 * independent and none of them touching local recording:
 * - Send my microphone live (stream on/off)
 * - Mute my microphone (talkback mute: the stream keeps running as flagged silence, so the
 * other side sees "muted", not a failure; the local recording continues unchanged)
 * - Hear the other side (receive mute), its volume (-60..0 dB) and jitter-buffer depth
 * Five separate status rows: local capture, local recording, outgoing stream, incoming stream,
 * remote participant. "Export live report" writes the one-page diagnostics of both directions.
 * No echo cancellation is implemented: the panel tells both people to use headphones.
 */
class LivePanel final : public QWidget
{
    Q_OBJECT

public:
    LivePanel(Role role, const AppConfig& config, AudioPanel& audio, SessionPanel& session, Logger& logger,
              QWidget* parent = nullptr);
    ~LivePanel() override;

    /** App closing: stops live audio and detaches from the output BEFORE the audio engine goes. */
    void shutDown();
    QString diagnosticsText() const;

private:
    void tick();
    void startIfPossible();
    void stopLive();
    void applyCodecChange();
    void applySwitches();
    void render();
    void exportReport();
    LiveCodecSettings codecFromUi() const;
    std::string localCaptureStatus() const;
    std::string localRecordingStatus() const;
    std::string remoteStatus() const;

    Role role;
    AppConfig config;
    QPointer<AudioPanel> audio;
    QPointer<SessionPanel> session;
    Logger& logger;
    std::unique_ptr<LiveEndpoint> endpoint;
    std::string runningSession;  // session id the endpoint was started for
    std::string lastError;
    bool attached = false;
    QTimer* timer = nullptr;

    /** outgoing */
    QCheckBox* sendCheck = nullptr;
    QPushButton* muteButton = nullptr;
    QComboBox* frameCombo = nullptr;
    QSpinBox* bitrateSpin = nullptr;
    QComboBox* modeCombo = nullptr;
    /** incoming */
    QCheckBox* hearCheck = nullptr;
    QSlider* gainSlider = nullptr;
    QLabel* gainLabel = nullptr;
    QSpinBox* jitterSpin = nullptr;
    QLabel* jitterLabel = nullptr;
    /** status rows */
    QLabel* captureRow = nullptr;
    QLabel* recordingRow = nullptr;
    QLabel* outgoingRow = nullptr;
    QLabel* incomingRow = nullptr;
    QLabel* remoteRow = nullptr;
    QLabel* outStatsLabel = nullptr;
    QLabel* inStatsLabel = nullptr;
    QPushButton* reportButton = nullptr;
};

