#include "MainWindow.h"

#include <utility>

#include <QAction>
#include <QCloseEvent>
#include <QCoreApplication>
#include <QDateTime>
#include <QDir>
#include <QFile>
#include <QFileDialog>
#include <QPushButton>
#include <QStandardPaths>
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

#include "AudioPanel.h"
#include "SimplePanel.h"
#include "LivePanel.h"
#include "SessionPanel.h"
#include "rr/shared/BuildInfo.h"

namespace
{

QString qs(std::string_view text)
{
    return QString::fromUtf8(text.data(), static_cast<qsizetype>(text.size()));
}

const char* const kSecurityNotice =
    "LAN-only prototype: audio and control are not encrypted. Use only on a trusted private "
    "network (ADR-012, ADR-016). Not designed or tested for use across the internet.";

const char* const kStageNotice =
    "Stage 8 build: devices, meters, local monitoring, local recording, producer-controlled sessions "
    "over a LAN, and TWO-WAY live talkback (Opus over UDP). The live streams are a monitor only: "
    "each PC records its own microphone locally, and the recordings never contain received live "
    "audio. There is no echo cancellation: both people must use headphones.";

}  // namespace

MainWindow::MainWindow(DiagnosticsSources sources, Logger& logger, QWidget* parent)
    : QMainWindow(parent),
      sources(std::move(sources)),
      logger(logger),
      snapshot(initialSnapshot(sources.role))
      {
    const QString roleName = qs(roleDisplayName(this->sources.role));
    setWindowTitle(QStringLiteral("%1 - Remote Recording %2").arg(roleName, QString::fromStdString(buildInfo().version)));
    setMinimumSize(720, 480);

    tabs = new QTabWidget(this);
    // The guided view is first and selected, but it is built from the same widgets as the
    // advanced tab, which keeps every control, meter and counter (Stage 10, ADR-021).
    QWidget* advanced = buildSessionTab();
    auto* simpleScroll = new QScrollArea;
    simpleScroll->setWidgetResizable(true);
    simplePanel = new SimplePanel(this->sources.role, *this->sources.config, *audioPanel, *sessionPanel);
    simpleScroll->setWidget(simplePanel);
    connect(simplePanel, &SimplePanel::advancedRequested, this, [this] { tabs->setCurrentIndex(1); });
    tabs->addTab(simpleScroll, tr("Start here"));
    tabs->addTab(advanced, tr("All controls"));
    tabs->addTab(buildDiagnosticsTab(), tr("Diagnostics"));
    setCentralWidget(tabs);
    buildMenus();

    renderSnapshot();
    refreshDiagnostics();

    // The diagnostics text is rebuilt once a second while that tab is visible.
    diagnosticsTimer = new QTimer(this);
    diagnosticsTimer->setInterval(1000);
    connect(diagnosticsTimer, &QTimer::timeout, this, [this] {
        if (tabs->currentWidget() == diagnosticsView->parentWidget())
        {
            refreshDiagnostics();
        }
    });
    diagnosticsTimer->start();

    this->logger.log(Level::Info, "ui", "main_window_created", "main window created",
                {{"role", std::string(roleId(this->sources.role))},
                 {"link", std::string(linkStateName(snapshot.link))},
                 {"session", std::string(sessionStateName(snapshot.session))}});
}

QWidget* MainWindow::buildSessionTab()
{
    auto* scroll = new QScrollArea;
    scroll->setWidgetResizable(true);
    auto* page = new QWidget;
    page->setObjectName(QStringLiteral("pageAdvanced"));
    scroll->setWidget(page);
    auto* layout = new QVBoxLayout(page);

    roleBanner = new QLabel(qs(roleDisplayName(sources.role)));
    QFont bannerFont = roleBanner->font();
    bannerFont.setPointSize(bannerFont.pointSize() + 10);
    bannerFont.setBold(true);
    roleBanner->setFont(bannerFont);
    roleBanner->setObjectName(QStringLiteral("roleBanner"));
    layout->addWidget(roleBanner);

    auto* summary = new QLabel(qs(roleSummary(sources.role)));
    summary->setWordWrap(true);
    layout->addWidget(summary);

    auto* statusBox = new QGroupBox(tr("Status"));
    auto* form = new QFormLayout(statusBox);
    linkValue = new QLabel;
    linkValue->setObjectName(QStringLiteral("linkStatus"));
    sessionValue = new QLabel;
    sessionValue->setObjectName(QStringLiteral("sessionStatus"));
    sessionValue->setWordWrap(true);
    form->addRow(tr("Connection:"), linkValue);
    form->addRow(tr("Session:"), sessionValue);
    layout->addWidget(statusBox);

    audioPanel = new AudioPanel(sources.role, *sources.config, logger);
    sessionPanel = new SessionPanel(sources.role, *sources.config, *audioPanel, logger);
    connect(sessionPanel, &SessionPanel::statusChanged, this, [this] {
        snapshot = sessionPanel->statusSnapshot();
        renderSnapshot();
    });
    livePanel = new LivePanel(sources.role, *sources.config, *audioPanel, *sessionPanel, logger);
    layout->addWidget(sessionPanel);
    layout->addWidget(livePanel);
    layout->addWidget(audioPanel);

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

QWidget* MainWindow::buildDiagnosticsTab()
{
    auto* page = new QWidget;
    page->setObjectName(QStringLiteral("pageDiagnostics"));
    auto* layout = new QVBoxLayout(page);
    auto* exportButton = new QPushButton(tr("Export diagnostic report (JSON)..."));
    connect(exportButton, &QPushButton::clicked, this, &MainWindow::exportReport);
    layout->addWidget(exportButton, 0, Qt::AlignLeft);
    diagnosticsView = new QPlainTextEdit;
    diagnosticsView->setReadOnly(true);
    diagnosticsView->setLineWrapMode(QPlainTextEdit::NoWrap);
    diagnosticsView->setFont(QFontDatabase::systemFont(QFontDatabase::FixedFont));
    layout->addWidget(diagnosticsView);
    return page;
}

void MainWindow::buildMenus()
{
    QMenu* fileMenu = menuBar()->addMenu(tr("&File"));
    QAction* quitAction = fileMenu->addAction(tr("E&xit"));
    connect(quitAction, &QAction::triggered, this, &QWidget::close);

    QMenu* helpMenu = menuBar()->addMenu(tr("&Help"));
    QAction* aboutAction = helpMenu->addAction(tr("&About"));
    connect(aboutAction, &QAction::triggered, this, &MainWindow::showAbout);
    QAction* aboutQtAction = helpMenu->addAction(tr("About &Qt"));
    connect(aboutQtAction, &QAction::triggered, this, [this] { QMessageBox::aboutQt(this); });
}

void MainWindow::renderSnapshot()
{
    linkValue->setText(qs(linkStateLabel(snapshot.link)));
    sessionValue->setText(QString::fromStdString(sessionStatusText(snapshot)));
}

void MainWindow::refreshDiagnostics()
{
    QScrollBar* bar = diagnosticsView->verticalScrollBar();
    const int position = bar->value();
    diagnosticsView->setPlainText(diagnosticsText(sources) + QLatin1Char('\n') +
                                    (sessionPanel ? sessionPanel->diagnosticsText() + QLatin1Char('\n') : QString()) +
                                    (livePanel ? livePanel->diagnosticsText() + QLatin1Char('\n') : QString()) +
                                    (audioPanel ? audioPanel->diagnosticsText() : QString()));
    bar->setValue(position);
}

void MainWindow::exportReport()
{
    const QString suggested =
        QDir(QStandardPaths::writableLocation(QStandardPaths::DocumentsLocation))
            .filePath(QStringLiteral("rr_diagnostics_%1_%2.json")
                          .arg(qs(roleId(sources.role)),
                               QDateTime::currentDateTimeUtc().toString(QStringLiteral("yyyyMMdd-HHmmss"))));
    const QString path = QFileDialog::getSaveFileName(this, tr("Export diagnostic report"), suggested,
                                                      tr("JSON (*.json)"));
    if (path.isEmpty())
    {
        return;
    }
    const std::string audio = audioPanel ? audioPanel->reportJson() : std::string();
    const QByteArray bytes = diagnosticsReportJson(sources, audio).toUtf8();
    QFile file(path);
    if (!file.open(QIODevice::WriteOnly | QIODevice::Truncate) || file.write(bytes) != bytes.size())
    {
        QMessageBox::warning(this, tr("Export failed"), tr("Could not write %1: %2").arg(path, file.errorString()));
        logger.log(Level::Error, "ui", "report_export_failed", file.errorString().toStdString(),
                    {{"path", path.toStdString()}});
        return;
    }
    file.close();
    logger.log(Level::Info, "ui", "report_exported", "diagnostic report written",
                {{"path", path.toStdString()}, {"bytes", std::to_string(bytes.size())}});
    QMessageBox::information(this, tr("Report exported"), tr("Diagnostic report written to\n%1").arg(path));
}

void MainWindow::showAbout()
{
    const BuildInfo build = buildInfo();
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
            .arg(qs(roleDisplayName(sources.role)), QString::fromStdString(build.version),
                 QString::fromStdString(build.gitCommit), QString::fromStdString(build.buildConfig),
                 QString::fromStdString(build.protocolVersion), QString::fromUtf8(kSecurityNotice),
                 QString::fromLatin1(qVersion()));
    QMessageBox::about(this, tr("About %1").arg(qs(roleDisplayName(sources.role))), text);
}

MainWindow::SelfCheck MainWindow::runSelfCheck() const
{
    SelfCheck result;
    const QString roleName = qs(roleDisplayName(sources.role));
    QStringList failures;
    if (!windowTitle().contains(roleName))
    {
        failures << QStringLiteral("window title does not name the role");
    }
    if (roleBanner->text() != roleName)
    {
        failures << QStringLiteral("role banner does not show the role name");
    }
    if (snapshot.link != LinkState::Disconnected ||
        linkValue->text() != qs(linkStateLabel(LinkState::Disconnected)))
        {
        failures << QStringLiteral("connection status is not 'Not connected'");
    }
    if (isTakeActive(snapshot.session) ||
        !sessionValue->text().startsWith(QStringLiteral("Not ready"))) {
        failures << QStringLiteral("session status is not 'Not ready'");
    }
    result.passed = failures.isEmpty();
    result.detail = result.passed
        ? QStringLiteral("role '%1' shown; link '%2'; session '%3'")
              .arg(roleName, linkValue->text(), sessionValue->text())
        : failures.join(QStringLiteral("; "));
    return result;
}

void MainWindow::closeEvent(QCloseEvent* event)
{
    // ERR-05a: closing during a take asks first; confirming finalises the take properly.
    if ((audioPanel && audioPanel->recordingActive()) || (sessionPanel && sessionPanel->takeActive()))
    {
        const auto answer = QMessageBox::question(
            this, tr("Recording in progress"),
            tr("A take is being recorded. Stop the recording, save it and quit?"),
            QMessageBox::Yes | QMessageBox::No, QMessageBox::No);
        if (answer != QMessageBox::Yes)
        {
            event->ignore();
            return;
        }
    }
    if (livePanel)
    {
        livePanel->shutDown();  // live audio stops and detaches from the output before the engine goes
    }
    if (sessionPanel)
    {
        sessionPanel->shutDown();  // SESSION_CLOSED to the other side; recorder back to the audio panel
    }
    if (audioPanel)
    {
        audioPanel->shutDownAudio();
    }
    logger.log(Level::Info, "ui", "main_window_close", "main window closing");
    event->accept();
}

