#pragma once

// Stage 10: the "Start here" view (ADR-021).
//
// A guided, four-step version of the same session, for people who have not used the app before.
// It owns NO state and NO engine code: every button drives the widgets of the existing
// AudioPanel / SessionPanel, and everything it shows is read from the session controller's
// snapshot on a timer. So the simple view and the advanced tab can never disagree, and the
// recording path is untouched.
//
// Rules it keeps (Stage 10 brief): status is never colour alone (symbol + word + text); the
// recording state is on screen, never behind a menu; destructive actions confirm; every disabled
// button says why in its tooltip and in the step line.

#include <QWidget>

#include "rr/shared/Config.h"
#include "rr/shared/Role.h"

class QCheckBox;
class QFrame;
class QLabel;
class QLineEdit;
class QProgressBar;
class QPushButton;
class QTimer;

class AudioPanel;
class SessionPanel;

class SimplePanel final : public QWidget
{
    Q_OBJECT

public:
    SimplePanel(Role role, const AppConfig& config, AudioPanel& audio, SessionPanel& session,
                QWidget* parent = nullptr);

signals:
    /** "Show all controls": the main window switches to the advanced tab. */
    void advancedRequested();

private:
    struct Step
    {
        QFrame* card = nullptr;
        QLabel* badge = nullptr;
        QLabel* title = nullptr;
        QLabel* status = nullptr;
    };

    Step addStep(QWidget* parent, int number, const QString& title, QWidget* body);
    void build();
    void refresh();
    void setStep(const Step& step, int number, bool done, bool enabled, const QString& status);

    Role role;
    AppConfig config;
    AudioPanel& audio;
    SessionPanel& session;
    QTimer* timer = nullptr;

    QLabel* statusPill = nullptr;
    QLabel* peerLabel = nullptr;

    Step stepSound;
    QLabel* micLabel = nullptr;
    QPushButton* micButton = nullptr;
    QProgressBar* level = nullptr;
    QLabel* levelText = nullptr;
    QLabel* outLabel = nullptr;
    QPushButton* outButton = nullptr;

    Step stepConnect;
    QPushButton* sessionButton = nullptr;   // producer: start/end session
    QFrame* inviteCard = nullptr;           // producer: address + pairing code
    QLabel* addressValue = nullptr;
    QLabel* codeValue = nullptr;
    QPushButton* newCodeButton = nullptr;
    QLineEdit* hostEdit = nullptr;          // performer
    QLineEdit* codeEdit = nullptr;
    QPushButton* joinButton = nullptr;

    Step stepRecord;
    QPushButton* recordButton = nullptr;    // producer
    QPushButton* stopButton = nullptr;      // producer
    QPushButton* stopSaveButton = nullptr; // performer
    QLabel* thisPc = nullptr;
    QLabel* otherPc = nullptr;

    Step stepCopy;
    QPushButton* copyButton = nullptr;      // producer
    QCheckBox* autoCopy = nullptr;          // producer
    QCheckBox* allowCopy = nullptr;         // performer
    QLabel* copyStatus = nullptr;

    QCheckBox* consent = nullptr;
    QLabel* reasons = nullptr;
    QLabel* error = nullptr;
};

