#include "main_window.hpp"

#include <utility>

#include <QAction>
#include <QCloseEvent>
#include <QCoreApplication>
#include <QFont>
#include <QFontDatabase>
#include <QFormLayout>
#include <QGroupBox>
#include <QLabel>
#include <QMenu>
#include <QMenuBar>
#include <QMessageBox>
#include <QPlainTextEdit>
#include <QScrollArea>
#include <QScrollBar>
#include <QStringList>
#include <QTabWidget>
#include <QTimer>
#include <QVBoxLayout>

#include "audio_panel.hpp"
#include "rr/shared/build_info.hpp"

namespace rr::ui {
namespace {

QString qs(std::string_view text) {
    return QString::fromUtf8(text.data(), static_cast<qsizetype>(text.size()));
}

const char* const kSecurityNotice =
    "LAN prototype: audio and control are not encrypted. Use only on a trusted private "
    "network (ADR-012).";

const char* const kStageNotice =
    "Stage 4 build: the input device, meters and LOCAL recording work. Networking, live "
    "talkback and producer-controlled sessions are not implemented yet: nothing is sent or "
    "received, and the connection/session status above stays 'Not connected / Not ready'.";

}  // namespace

MainWindow::MainWindow(DiagnosticsSources sources, rr::log::Logger& logger, QWidget* parent)
    : QMainWindow(parent),
      sources_(std::move(sources)),
      logger_(logger),
      snapshot_(rr::session::initial_snapshot(sources_.role)) {
    const QString role_name = qs(rr::role_display_name(sources_.role));
    setWindowTitle(QStringLiteral("%1 - Remote Recording %2").arg(role_name, QString::fromStdString(rr::build_info().version)));
    setMinimumSize(720, 480);

    tabs_ = new QTabWidget(this);
    tabs_->addTab(build_session_tab(), tr("Session"));
    tabs_->addTab(build_diagnostics_tab(), tr("Diagnostics"));
    setCentralWidget(tabs_);
    build_menus();

    render_snapshot();
    refresh_diagnostics();

    // The diagnostics text is rebuilt once a second while that tab is visible.
    diagnostics_timer_ = new QTimer(this);
    diagnostics_timer_->setInterval(1000);
    connect(diagnostics_timer_, &QTimer::timeout, this, [this] {
        if (tabs_->currentWidget() == diagnostics_view_->parentWidget()) {
            refresh_diagnostics();
        }
    });
    diagnostics_timer_->start();

    logger_.log(rr::log::Level::Info, "ui", "main_window_created", "main window created",
                {{"role", std::string(rr::role_id(sources_.role))},
                 {"link", std::string(rr::session::link_state_name(snapshot_.link))},
                 {"session", std::string(rr::session::session_state_name(snapshot_.session))}});
}

QWidget* MainWindow::build_session_tab() {
    auto* scroll = new QScrollArea;
    scroll->setWidgetResizable(true);
    auto* page = new QWidget;
    scroll->setWidget(page);
    auto* layout = new QVBoxLayout(page);

    role_banner_ = new QLabel(qs(rr::role_display_name(sources_.role)));
    QFont banner_font = role_banner_->font();
    banner_font.setPointSize(banner_font.pointSize() + 10);
    banner_font.setBold(true);
    role_banner_->setFont(banner_font);
    role_banner_->setObjectName(QStringLiteral("roleBanner"));
    layout->addWidget(role_banner_);

    auto* summary = new QLabel(qs(rr::role_summary(sources_.role)));
    summary->setWordWrap(true);
    layout->addWidget(summary);

    auto* status_box = new QGroupBox(tr("Status"));
    auto* form = new QFormLayout(status_box);
    link_value_ = new QLabel;
    link_value_->setObjectName(QStringLiteral("linkStatus"));
    session_value_ = new QLabel;
    session_value_->setObjectName(QStringLiteral("sessionStatus"));
    session_value_->setWordWrap(true);
    form->addRow(tr("Connection:"), link_value_);
    form->addRow(tr("Session:"), session_value_);
    layout->addWidget(status_box);

    audio_panel_ = new AudioPanel(sources_.role, *sources_.config, logger_);
    layout->addWidget(audio_panel_);

    auto* stage = new QLabel(QString::fromUtf8(kStageNotice));
    stage->setWordWrap(true);
    layout->addWidget(stage);

    auto* security = new QLabel(QString::fromUtf8(kSecurityNotice));
    security->setWordWrap(true);
    security->setObjectName(QStringLiteral("securityNotice"));
    layout->addWidget(security);

    layout->addStretch(1);
    return scroll;
}

QWidget* MainWindow::build_diagnostics_tab() {
    auto* page = new QWidget;
    auto* layout = new QVBoxLayout(page);
    diagnostics_view_ = new QPlainTextEdit;
    diagnostics_view_->setReadOnly(true);
    diagnostics_view_->setLineWrapMode(QPlainTextEdit::NoWrap);
    diagnostics_view_->setFont(QFontDatabase::systemFont(QFontDatabase::FixedFont));
    layout->addWidget(diagnostics_view_);
    return page;
}

void MainWindow::build_menus() {
    QMenu* file_menu = menuBar()->addMenu(tr("&File"));
    QAction* quit_action = file_menu->addAction(tr("E&xit"));
    connect(quit_action, &QAction::triggered, this, &QWidget::close);

    QMenu* help_menu = menuBar()->addMenu(tr("&Help"));
    QAction* about_action = help_menu->addAction(tr("&About"));
    connect(about_action, &QAction::triggered, this, &MainWindow::show_about);
    QAction* about_qt_action = help_menu->addAction(tr("About &Qt"));
    connect(about_qt_action, &QAction::triggered, this, [this] { QMessageBox::aboutQt(this); });
}

void MainWindow::render_snapshot() {
    link_value_->setText(qs(rr::session::link_state_label(snapshot_.link)));
    session_value_->setText(QString::fromStdString(rr::session::session_status_text(snapshot_)));
}

void MainWindow::refresh_diagnostics() {
    QScrollBar* bar = diagnostics_view_->verticalScrollBar();
    const int position = bar->value();
    diagnostics_view_->setPlainText(diagnostics_text(sources_) + QLatin1Char('
') +
                                    (audio_panel_ ? audio_panel_->diagnostics_text() : QString()));
    bar->setValue(position);
}

void MainWindow::show_about() {
    const rr::BuildInfo build = rr::build_info();
    const QString text =
        tr("<h3>%1</h3>"
           "<p>Remote Recording %2 (commit %3, %4)<br>Protocol %5</p>"
           "<p>SLIIT IT4010 Research Project J26-IM-303, Component 04: "
           "Interactive Remote Recording &amp; Communication.</p>"
           "<p><b>%6</b></p>"
           "<p>This program uses Qt %7, dynamically linked, under the GNU Lesser General Public "
           "License v3. You may replace the Qt libraries with your own build. Qt source code: "
           "https://download.qt.io/archive/qt/ . Licence texts are in the LICENSES folder of the "
           "distribution.</p>")
            .arg(qs(rr::role_display_name(sources_.role)), QString::fromStdString(build.version),
                 QString::fromStdString(build.git_commit), QString::fromStdString(build.build_config),
                 QString::fromStdString(build.protocol_version), QString::fromUtf8(kSecurityNotice),
                 QString::fromLatin1(qVersion()));
    QMessageBox::about(this, tr("About %1").arg(qs(rr::role_display_name(sources_.role))), text);
}

MainWindow::SelfCheck MainWindow::run_self_check() const {
    SelfCheck result;
    const QString role_name = qs(rr::role_display_name(sources_.role));
    QStringList failures;
    if (!windowTitle().contains(role_name)) {
        failures << QStringLiteral("window title does not name the role");
    }
    if (role_banner_->text() != role_name) {
        failures << QStringLiteral("role banner does not show the role name");
    }
    if (snapshot_.link != rr::session::LinkState::Disconnected ||
        link_value_->text() != qs(rr::session::link_state_label(rr::session::LinkState::Disconnected))) {
        failures << QStringLiteral("connection status is not 'Not connected'");
    }
    if (rr::session::is_take_active(snapshot_.session) ||
        !session_value_->text().startsWith(QStringLiteral("Not ready"))) {
        failures << QStringLiteral("session status is not 'Not ready'");
    }
    result.passed = failures.isEmpty();
    result.detail = result.passed
        ? QStringLiteral("role '%1' shown; link '%2'; session '%3'")
              .arg(role_name, link_value_->text(), session_value_->text())
        : failures.join(QStringLiteral("; "));
    return result;
}

void MainWindow::closeEvent(QCloseEvent* event) {
    // ERR-05a: closing during a take asks first; confirming finalises the take properly.
    if (audio_panel_ && audio_panel_->recording_active()) {
        const auto answer = QMessageBox::question(
            this, tr("Recording in progress"),
            tr("A take is being recorded. Stop the recording, save it and quit?"),
            QMessageBox::Yes | QMessageBox::No, QMessageBox::No);
        if (answer != QMessageBox::Yes) {
            event->ignore();
            return;
        }
    }
    if (audio_panel_) {
        audio_panel_->shut_down_audio();
    }
    logger_.log(rr::log::Level::Info, "ui", "main_window_close", "main window closing");
    event->accept();
}

}  // namespace rr::ui
