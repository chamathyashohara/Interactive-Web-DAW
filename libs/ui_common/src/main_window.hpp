#pragma once

#include <QMainWindow>
#include <QString>

#include "diagnostics.hpp"
#include "rr/session/states.hpp"

class QLabel;
namespace rr::ui { class AudioPanel; class LivePanel; class SessionPanel; }
class QPlainTextEdit;
class QTabWidget;
class QTimer;

namespace rr::ui {

// Main window used by both apps. It renders a SessionSnapshot and never keeps its own
// state flags (SESSION_STATE_MACHINE.md §1). Until a session is created/joined the snapshot is
// the honest initial one (not connected, not ready); from Stage 6 it comes from the session
// controller through the SessionPanel.
class MainWindow final : public QMainWindow {
    Q_OBJECT

public:
    MainWindow(DiagnosticsSources sources, rr::log::Logger& logger, QWidget* parent = nullptr);

    struct SelfCheck {
        bool passed = false;
        QString detail;
    };
    // Used by --smoke-test: role identified, no false connected/recording state.
    SelfCheck run_self_check() const;

protected:
    void closeEvent(QCloseEvent* event) override;

private:
    QWidget* build_session_tab();
    QWidget* build_diagnostics_tab();
    void build_menus();
    void render_snapshot();
    void refresh_diagnostics();
    void export_report();
    void show_about();

    DiagnosticsSources sources_;
    rr::log::Logger& logger_;
    rr::session::SessionSnapshot snapshot_;

    QTabWidget* tabs_ = nullptr;
    QLabel* role_banner_ = nullptr;
    QLabel* link_value_ = nullptr;
    QLabel* session_value_ = nullptr;
    QPlainTextEdit* diagnostics_view_ = nullptr;
    QTimer* diagnostics_timer_ = nullptr;
    AudioPanel* audio_panel_ = nullptr;
    SessionPanel* session_panel_ = nullptr;
    LivePanel* live_panel_ = nullptr;
};

}  // namespace rr::ui
