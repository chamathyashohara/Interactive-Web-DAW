#pragma once

#include <memory>
#include <string>

#include <QPointer>
#include <QString>
#include <QWidget>

#include "rr/control/recorder_port.hpp"
#include "rr/control/session_controller.hpp"
#include "rr/session/states.hpp"
#include "rr/shared/config.hpp"
#include "rr/shared/log.hpp"

class QCheckBox;
class QComboBox;
class QLabel;
class QLineEdit;
class QPlainTextEdit;
class QPushButton;
class QSpinBox;
class QTimer;
class QVBoxLayout;

namespace rr::ui {

class AudioPanel;

// What the live audio panel needs from the session (Stage 7). Media is set up only from an
// established session: the session id, the producer's selected interface and the performer's
// control-connection address. No other address is ever used for live audio.
struct LiveContext {
    bool connected = false;          // control link Connected (live keeps running through LinkLost)
    bool session_open = false;       // a session exists (created/joined and not ended)
    std::string session_id;
    std::string local_address;       // producer: the selected interface
    std::string peer_address;        // producer: the performer; performer: the producer host
    std::uint16_t control_port = 0;
};

// Producer/performer session control (Stage 6) on top of rr::control::SessionController.
//
// The panel only renders the controller's snapshot (20 Hz timer on the UI thread) and forwards
// button presses; it keeps no session state of its own. The controller and its recorder port are
// created when a session is created/joined, using the AudioPanel's engine, so the session's
// takes are recorded by the same input device the user opened there.
//
// Producer: explicit interface selection, port, Create/End session, session id, pairing code,
// the address to give the performer, firewall guidance, Record/Stop gated by readiness and a
// per-step view of the performer's own confirmations.
// Performer: host, port, pairing code, Join/Leave, consent, Stop & save.
class SessionPanel final : public QWidget {
    Q_OBJECT

public:
    SessionPanel(Role role, const AppConfig& config, AudioPanel& audio, rr::log::Logger& logger,
                 QWidget* parent = nullptr);
    ~SessionPanel() override;

    // What the main window's status box shows.
    rr::session::SessionSnapshot status_snapshot() const;
    bool take_active() const;
    // App closing: ends the session (SESSION_CLOSED) and hands the recorder back to the AudioPanel.
    void shut_down();
    QString diagnostics_text() const;
    LiveContext live_context() const;

signals:
    void statusChanged();

private:
    void build_producer_ui(QVBoxLayout* layout);
    void build_performer_ui(QVBoxLayout* layout);
    void refresh_interfaces();
    void ensure_controller();
    void create_or_end_session();
    void join_or_leave();
    void record();
    void stop();
    void stop_and_save();
    void tick();
    void render(const rr::control::ControllerSnapshot& s);
    void set_session_control(bool active);
    QString confirmations_text(const rr::control::ControllerSnapshot& s) const;
    void show_error(const QString& text);

    Role role_;
    AppConfig config_;
    QPointer<AudioPanel> audio_;  // destroyed before this panel when the window closes
    rr::log::Logger& logger_;
    std::unique_ptr<rr::control::AudioRecorderPort> port_;
    std::unique_ptr<rr::control::SessionController> controller_;
    bool session_control_ = false;
    std::size_t shown_history_ = 0;
    std::string shown_history_last_;

    // both
    QLabel* state_label_ = nullptr;
    QLabel* reasons_label_ = nullptr;
    QCheckBox* consent_check_ = nullptr;
    QLabel* error_label_ = nullptr;
    QLabel* stats_label_ = nullptr;
    QPlainTextEdit* history_view_ = nullptr;
    QSpinBox* port_spin_ = nullptr;
    QTimer* timer_ = nullptr;
    // producer
    QComboBox* interface_combo_ = nullptr;
    QPushButton* interfaces_button_ = nullptr;
    QPushButton* create_button_ = nullptr;
    QLabel* session_id_label_ = nullptr;
    QLabel* code_label_ = nullptr;
    QPushButton* new_code_button_ = nullptr;
    QLabel* address_label_ = nullptr;
    QPushButton* record_button_ = nullptr;
    QPushButton* stop_button_ = nullptr;
    QLabel* confirmations_label_ = nullptr;
    // performer
    QLineEdit* host_edit_ = nullptr;
    QLineEdit* code_edit_ = nullptr;
    QPushButton* join_button_ = nullptr;
    QPushButton* stop_save_button_ = nullptr;
    QLabel* take_label_ = nullptr;
};

}  // namespace rr::ui
