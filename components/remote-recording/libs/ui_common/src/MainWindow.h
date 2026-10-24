#pragma once

#include <QMainWindow>
#include <QString>

#include "Diagnostics.h"
#include "rr/session/States.h"

class QLabel;
class AudioPanel;
class LivePanel;
class SessionPanel;
class SimplePanel;
class QPlainTextEdit;
class QTabWidget;
class QTimer;

/**
 * Main window used by both apps. It renders a SessionSnapshot and never keeps its own
 * state flags (SESSION_STATE_MACHINE.md §1). Until a session is created/joined the snapshot is
 * the honest initial one (not connected, not ready); from Stage 6 it comes from the session
 * controller through the SessionPanel.
 */
class MainWindow final : public QMainWindow
{
    Q_OBJECT

public:
    MainWindow(DiagnosticsSources sources, Logger& logger, QWidget* parent = nullptr);

    struct SelfCheck
    {
        bool passed = false;
        QString detail;
    };
    /** Used by --smoke-test: role identified, no false connected/recording state. */
    SelfCheck runSelfCheck() const;

protected:
    void closeEvent(QCloseEvent* event) override;

private:
    QWidget* buildSessionTab();
    QWidget* buildDiagnosticsTab();
    void buildMenus();
    void renderSnapshot();
    void refreshDiagnostics();
    void exportReport();
    void showAbout();

    DiagnosticsSources sources;
    Logger& logger;
    SessionSnapshot snapshot;

    QTabWidget* tabs = nullptr;
    QLabel* roleBanner = nullptr;
    QLabel* linkValue = nullptr;
    QLabel* sessionValue = nullptr;
    QPlainTextEdit* diagnosticsView = nullptr;
    QTimer* diagnosticsTimer = nullptr;
    SimplePanel* simplePanel = nullptr;
    AudioPanel* audioPanel = nullptr;
    SessionPanel* sessionPanel = nullptr;
    LivePanel* livePanel = nullptr;
};

