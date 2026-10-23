#pragma once

#include <memory>
#include <string>

#include <QPointer>
#include <QString>
#include <QWidget>

#include "rr/control/RecorderPort.h"
#include "rr/control/SessionController.h"
#include "rr/session/States.h"
#include "rr/shared/Config.h"
#include "rr/shared/Log.h"

class QCheckBox;
class QComboBox;
class QLabel;
class QLineEdit;
class QPlainTextEdit;
class QPushButton;
class QSpinBox;
class QTimer;
class QVBoxLayout;

class AudioPanel;

/**
 * What the live audio panel needs from the session (Stage 7). Media is set up only from an
 * established session: the session id, the producer's selected interface and the performer's
 * control-connection address. No other address is ever used for live audio.
 */
struct LiveContext
{
    bool connected = false;          // control link Connected (live keeps running through LinkLost)
    bool sessionOpen = false;       // a session exists (created/joined and not ended)
    std::string sessionId;
    std::string localAddress;       // producer: the selected interface
    std::string peerAddress;        // producer: the performer; performer: the producer host
    uint16_t controlPort = 0;
    /**
     * For the separate status rows (Stage 8): the control link and the local recording come from
     * the session, never from the live streams.
     */
    std::string linkState;          // "Connected", "LinkLost", ...
    std::string peerName;
    double controlRttMs = 0.0;
    std::string recordingStatus;    // e.g. "RECORDING take 2" / "take 1 complete, 480000 frames" / "idle"
};

/**
 * Producer/performer session control (Stage 6) on top of SessionController.
 *
 * The panel only renders the controller's snapshot (20 Hz timer on the UI thread) and forwards
 * button presses; it keeps no session state of its own. The controller and its recorder port are
 * created when a session is created/joined, using the AudioPanel's engine, so the session's
 * takes are recorded by the same input device the user opened there.
 *
 * Producer: explicit interface selection, port, Create/End session, session id, pairing code,
 * the address to give the performer, firewall guidance, Record/Stop gated by readiness and a
 * per-step view of the performer's own confirmations.
 * Performer: host, port, pairing code, Join/Leave, consent, Stop & save.
 */
class SessionPanel final : public QWidget
{
    Q_OBJECT

public:
    SessionPanel(Role role, const AppConfig& config, AudioPanel& audio, Logger& logger,
                 QWidget* parent = nullptr);
    ~SessionPanel() override;

    /** What the main window's status box shows. */
    SessionSnapshot statusSnapshot() const;
    bool takeActive() const;
    /** App closing: ends the session (SESSION_CLOSED) and hands the recorder back to the AudioPanel. */
    void shutDown();
    QString diagnosticsText() const;
    LiveContext liveContext() const;

    /**
     * Stage 10: hooks for the guided "Start here" view. They drive THIS panel's own widgets and
     * slots, never the controller directly, so both views always show the same state.
     */
    ControllerSnapshot uiSnapshot() const;
    bool uiSessionActive() const;
    /** The tick boxes, which hold the user's choice even before a session exists. */
    bool uiConsent() const;
    bool uiDeliveryConsent() const;
    bool uiAutoCopy() const;
    void uiSetConsent(bool on);
    void uiSetDeliveryConsent(bool on);
    void uiSetAutoCopy(bool on);
    void uiSetConnection(const QString& host, const QString& code);  // performer
    void uiCreateOrEnd();
    void uiNewPairingCode();
    void uiJoinOrLeave();
    void uiRecord();
    void uiStop();
    void uiStopAndSave();
    void uiRequestCopy();

signals:
    void statusChanged();

private:
    void buildProducerUi(QVBoxLayout* layout);
    void buildPerformerUi(QVBoxLayout* layout);
    void refreshInterfaces();
    void ensureController();
    void createOrEndSession();
    void joinOrLeave();
    void record();
    void stop();
    void stopAndSave();
    void tick();
    void render(const ControllerSnapshot& s);
    void setSessionControl(bool active);
    QString confirmationsText(const ControllerSnapshot& s) const;
    QString checksHtml(const ControllerSnapshot& s) const;
    QString pcsText(const ControllerSnapshot& s) const;
    QString transfersHtml(const ControllerSnapshot& s) const;  // Stage 11
    void requestCopy();                                                       // Stage 11 (producer)
    void cancelCopy();                                                        // Stage 11 (producer)
    void showError(const QString& text);

    Role role;
    AppConfig config;
    QPointer<AudioPanel> audio;  // destroyed before this panel when the window closes
    Logger& logger;
    std::unique_ptr<AudioRecorderPort> port;
    std::unique_ptr<SessionController> controller;
    bool sessionControl = false;
    size_t shownHistory = 0;
    std::string shownHistoryLast;

    /** both */
    QLabel* stateLabel = nullptr;
    QLabel* reasonsLabel = nullptr;
    QCheckBox* consentCheck = nullptr;
    QLabel* errorLabel = nullptr;
    QLabel* statsLabel = nullptr;
    QPlainTextEdit* historyView = nullptr;
    QSpinBox* portSpin = nullptr;
    QTimer* timer = nullptr;
    QLabel* checksLabel = nullptr;      // Stage 9: both readiness checklists
    QLabel* pcsLabel = nullptr;         // Stage 9: per-PC take state
    QLabel* transfersLabel = nullptr;   // Stage 11: take copies and their states
    /** producer */
    QComboBox* interfaceCombo = nullptr;
    QPushButton* interfacesButton = nullptr;
    QPushButton* createButton = nullptr;
    QLabel* sessionIdLabel = nullptr;
    QLabel* codeLabel = nullptr;
    QPushButton* newCodeButton = nullptr;
    QLabel* addressLabel = nullptr;
    QPushButton* recordButton = nullptr;
    QPushButton* stopButton = nullptr;
    QLabel* confirmationsLabel = nullptr;
    QSpinBox* leadSpin = nullptr;       // Stage 9: scheduling lead
    QCheckBox* autoLeadCheck = nullptr;  // Stage 12: size the lead for the measured link
    QLabel* leadHint = nullptr;           // Stage 12: what the link actually needs
    QPushButton* copyButton = nullptr;          // Stage 11: get a verified copy of the last take
    QPushButton* cancelCopyButton = nullptr;   // Stage 11
    QCheckBox* autoCopyCheck = nullptr;        // Stage 11: automatically after each take
    /** performer */
    QLineEdit* hostEdit = nullptr;
    QLineEdit* codeEdit = nullptr;
    QPushButton* joinButton = nullptr;
    QPushButton* stopSaveButton = nullptr;
    QLabel* takeLabel = nullptr;
    QLabel* controllerLabel = nullptr;  // Stage 9: who controls the session
    QCheckBox* deliveryCheck = nullptr; // Stage 11: performer allows copies to be sent (XFER-05)
};

