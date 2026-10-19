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

#include "rr/shared/config.hpp"
#include "rr/shared/role.hpp"

class QCheckBox;
class QFrame;
class QLabel;
class QLineEdit;
class QProgressBar;
class QPushButton;
class QTimer;

namespace rr::ui {

class AudioPanel;
class SessionPanel;

class SimplePanel final : public QWidget {
    Q_OBJECT

public:
    SimplePanel(Role role, const AppConfig& config, AudioPanel& audio, SessionPanel& session,
                QWidget* parent = nullptr);

signals:
    // "Show all controls": the main window switches to the advanced tab.
    void advancedRequested();

private:
    struct Step {
        QFrame* card = nullptr;
        QLabel* badge = nullptr;
        QLabel* title = nullptr;
        QLabel* status = nullptr;
    };

    Step add_step(QWidget* parent, int number, const QString& title, QWidget* body);
    void build();
    void refresh();
    void set_step(const Step& step, int number, bool done, bool enabled, const QString& status);

    Role role_;
    AppConfig config_;
    AudioPanel& audio_;
    SessionPanel& session_;
    QTimer* timer_ = nullptr;

    QLabel* status_pill_ = nullptr;
    QLabel* peer_label_ = nullptr;

    Step step_sound_;
    QLabel* mic_label_ = nullptr;
    QPushButton* mic_button_ = nullptr;
    QProgressBar* level_ = nullptr;
    QLabel* level_text_ = nullptr;
    QLabel* out_label_ = nullptr;
    QPushButton* out_button_ = nullptr;

    Step step_connect_;
    QPushButton* session_button_ = nullptr;   // producer: start/end session
    QFrame* invite_card_ = nullptr;           // producer: address + pairing code
    QLabel* address_value_ = nullptr;
    QLabel* code_value_ = nullptr;
    QPushButton* new_code_button_ = nullptr;
    QLineEdit* host_edit_ = nullptr;          // performer
    QLineEdit* code_edit_ = nullptr;
    QPushButton* join_button_ = nullptr;

    Step step_record_;
    QPushButton* record_button_ = nullptr;    // producer
    QPushButton* stop_button_ = nullptr;      // producer
    QPushButton* stop_save_button_ = nullptr; // performer
    QLabel* this_pc_ = nullptr;
    QLabel* other_pc_ = nullptr;

    Step step_copy_;
    QPushButton* copy_button_ = nullptr;      // producer
    QCheckBox* auto_copy_ = nullptr;          // producer
    QCheckBox* allow_copy_ = nullptr;         // performer
    QLabel* copy_status_ = nullptr;

    QCheckBox* consent_ = nullptr;
    QLabel* reasons_ = nullptr;
    QLabel* error_ = nullptr;
};

}  // namespace rr::ui
