#include "rr/ui/AppRunner.h"

#include <filesystem>
#include <memory>
#include <string>

#include <QApplication>
#include <QCommandLineOption>
#include <QCommandLineParser>
#include <QDateTime>
#include <QDir>
#include <QFont>
#include <QStandardPaths>
#include <QTimer>

#include "Diagnostics.h"
#include "MainWindow.h"
#include "Theme.h"
#include "QtLogBridge.h"
#include "rr/shared/BuildInfo.h"
#include "rr/shared/Config.h"
#include "rr/shared/Log.h"
#include "rr/shared/LogSinks.h"

namespace
{

QString qs(std::string_view text)
{
    return QString::fromUtf8(text.data(), static_cast<qsizetype>(text.size()));
}

std::filesystem::path toPath(const QString& path)
{
#ifdef _WIN32
    return std::filesystem::path(QDir::toNativeSeparators(path).toStdWString());
#else
    return std::filesystem::path(path.toStdString());
#endif
}

}  // namespace

int runApplication(Role role, int argc, char* argv[])
{
    QApplication app(argc, argv);
    QCoreApplication::setOrganizationName(QStringLiteral("SLIIT-J26-IM-303"));
    QCoreApplication::setApplicationName(qs(roleExecutableName(role)));
    QCoreApplication::setApplicationVersion(QString::fromStdString(buildInfo().version));
    {   // Stage 10: the app font is set here, not in the style sheet: a QWidget style-sheet rule
        // would also match every QCheckBox and replace its native tick with a blank square.
        QFont uiFont(QStringLiteral("Segoe UI"), 10);
        uiFont.setStyleHint(QFont::SansSerif);
        app.setFont(uiFont);
    }
    applyTheme(app);  // Stage 10: light palette + Fusion + the style sheet (ADR-021)

    QCommandLineParser parser;
    parser.setApplicationDescription(qs(roleDisplayName(role)) + QStringLiteral(" - ") +
                                     qs(roleSummary(role)));
    parser.addHelpOption();
    parser.addVersionOption();
    const QCommandLineOption smokeOption(
        QStringList{QStringLiteral("smoke-test")},
        QStringLiteral("Show the window, check that it identifies its role and shows no false "
                       "connected/recording state, then exit (0 = pass, 1 = fail)."));
    const QCommandLineOption logDirOption(
        QStringList{QStringLiteral("log-dir")},
        QStringLiteral("Folder for the JSON Lines log file."), QStringLiteral("path"));
    parser.addOption(smokeOption);
    parser.addOption(logDirOption);
    parser.process(app);  // handles --help/--version and exits on bad options

    // --- logging -------------------------------------------------------------------------
    const QString logDir = parser.isSet(logDirOption)
        ? parser.value(logDirOption)
        : QStandardPaths::writableLocation(QStandardPaths::AppLocalDataLocation) + QStringLiteral("/logs");
    QDir().mkpath(logDir);
    const QString logFile = QDir(logDir).filePath(
        QStringLiteral("%1_%2_%3.jsonl")
            .arg(qs(roleExecutableName(role)),
                 QDateTime::currentDateTimeUtc().toString(QStringLiteral("yyyyMMdd-HHmmss")),
                 QString::number(QCoreApplication::applicationPid())));

    auto fileSink = std::make_shared<JsonLinesFileSink>(toPath(logFile));
    auto recentSink = std::make_shared<MemorySink>(200);
    Logger logger;
    logger.addSink(fileSink);
    logger.addSink(recentSink);
    logger.start();
    QtLogBridge qtBridge(logger);

    const AppConfig config = AppConfig::defaultsFor(role);
    const BuildInfo build = buildInfo();
    logger.log(Level::Info, "app", "startup", "application starting",
               {{"role", std::string(roleId(role))},
                {"version", build.version},
                {"commit", build.gitCommit},
                {"protocol", build.protocolVersion},
                {"build_config", build.buildConfig},
                {"compiler", build.compiler},
                {"toolchain_deviation", build.toolchainDeviation},
                {"qt_runtime", qVersion()},
                {"platform", platformDescription().toStdString()},
                {"log_file", logFile.toStdString()},
                {"log_file_ok", fileSink->isOk() ? "true" : "false"},
                {"smoke_test", parser.isSet(smokeOption) ? "true" : "false"}});
    for (const std::string& problem : validate(config))
    {
        logger.log(Level::Error, "app", "config_invalid", problem);
    }

    // --- window and event loop ----------------------------------------------------------
    int exitCode = 0;
    {
        DiagnosticsSources sources;
        sources.role = role;
        sources.config = &config;
        sources.logger = &logger;
        sources.recent = recentSink;
        sources.file = fileSink;
        sources.logFilePath = logFile;

        MainWindow window(sources, logger);
        window.show();

        if (parser.isSet(smokeOption))
        {
            // Let the window finish showing, check it, then leave the event loop.
            QTimer::singleShot(300, &window, [&window, &logger] {
                const MainWindow::SelfCheck check = window.runSelfCheck();
                logger.log(check.passed ? Level::Info : Level::Error, "app",
                           check.passed ? "smoke_test_passed" : "smoke_test_failed",
                           check.detail.toStdString());
                QCoreApplication::exit(check.passed ? 0 : 1);
            });
        }
        exitCode = app.exec();
    }

    // --- orderly shutdown: bridge first, then drain and flush the logger ------------------
    logger.log(Level::Info, "app", "shutdown", "application stopping",
               {{"exit_code", std::to_string(exitCode)}});
    qtBridge.uninstall();
    logger.stop();
    return exitCode;
}

