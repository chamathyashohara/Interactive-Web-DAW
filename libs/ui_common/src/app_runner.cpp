#include "rr/ui/app_runner.hpp"

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

#include "diagnostics.hpp"
#include "main_window.hpp"
#include "theme.hpp"
#include "qt_log_bridge.hpp"
#include "rr/shared/build_info.hpp"
#include "rr/shared/config.hpp"
#include "rr/shared/log.hpp"
#include "rr/shared/log_sinks.hpp"

namespace rr::ui {
namespace {

QString qs(std::string_view text) {
    return QString::fromUtf8(text.data(), static_cast<qsizetype>(text.size()));
}

std::filesystem::path to_path(const QString& path) {
#ifdef _WIN32
    return std::filesystem::path(QDir::toNativeSeparators(path).toStdWString());
#else
    return std::filesystem::path(path.toStdString());
#endif
}

}  // namespace

int run_application(Role role, int argc, char* argv[]) {
    QApplication app(argc, argv);
    QCoreApplication::setOrganizationName(QStringLiteral("SLIIT-J26-IM-303"));
    QCoreApplication::setApplicationName(qs(role_executable_name(role)));
    QCoreApplication::setApplicationVersion(QString::fromStdString(build_info().version));
    {   // Stage 10: the app font is set here, not in the style sheet: a QWidget style-sheet rule
        // would also match every QCheckBox and replace its native tick with a blank square.
        QFont ui_font(QStringLiteral("Segoe UI"), 10);
        ui_font.setStyleHint(QFont::SansSerif);
        app.setFont(ui_font);
    }
    app.setStyleSheet(theme_style_sheet());  // Stage 10: one visual language for both apps

    QCommandLineParser parser;
    parser.setApplicationDescription(qs(role_display_name(role)) + QStringLiteral(" - ") +
                                     qs(role_summary(role)));
    parser.addHelpOption();
    parser.addVersionOption();
    const QCommandLineOption smoke_option(
        QStringList{QStringLiteral("smoke-test")},
        QStringLiteral("Show the window, check that it identifies its role and shows no false "
                       "connected/recording state, then exit (0 = pass, 1 = fail)."));
    const QCommandLineOption log_dir_option(
        QStringList{QStringLiteral("log-dir")},
        QStringLiteral("Folder for the JSON Lines log file."), QStringLiteral("path"));
    parser.addOption(smoke_option);
    parser.addOption(log_dir_option);
    parser.process(app);  // handles --help/--version and exits on bad options

    // --- logging -------------------------------------------------------------------------
    const QString log_dir = parser.isSet(log_dir_option)
        ? parser.value(log_dir_option)
        : QStandardPaths::writableLocation(QStandardPaths::AppLocalDataLocation) + QStringLiteral("/logs");
    QDir().mkpath(log_dir);
    const QString log_file = QDir(log_dir).filePath(
        QStringLiteral("%1_%2_%3.jsonl")
            .arg(qs(role_executable_name(role)),
                 QDateTime::currentDateTimeUtc().toString(QStringLiteral("yyyyMMdd-HHmmss")),
                 QString::number(QCoreApplication::applicationPid())));

    auto file_sink = std::make_shared<rr::log::JsonLinesFileSink>(to_path(log_file));
    auto recent_sink = std::make_shared<rr::log::MemorySink>(200);
    rr::log::Logger logger;
    logger.add_sink(file_sink);
    logger.add_sink(recent_sink);
    logger.start();
    QtLogBridge qt_bridge(logger);

    const AppConfig config = AppConfig::defaults_for(role);
    const BuildInfo build = build_info();
    logger.log(rr::log::Level::Info, "app", "startup", "application starting",
               {{"role", std::string(role_id(role))},
                {"version", build.version},
                {"commit", build.git_commit},
                {"protocol", build.protocol_version},
                {"build_config", build.build_config},
                {"compiler", build.compiler},
                {"toolchain_deviation", build.toolchain_deviation},
                {"qt_runtime", qVersion()},
                {"platform", platform_description().toStdString()},
                {"log_file", log_file.toStdString()},
                {"log_file_ok", file_sink->ok() ? "true" : "false"},
                {"smoke_test", parser.isSet(smoke_option) ? "true" : "false"}});
    for (const std::string& problem : validate(config)) {
        logger.log(rr::log::Level::Error, "app", "config_invalid", problem);
    }

    // --- window and event loop ----------------------------------------------------------
    int exit_code = 0;
    {
        DiagnosticsSources sources;
        sources.role = role;
        sources.config = &config;
        sources.logger = &logger;
        sources.recent = recent_sink;
        sources.file = file_sink;
        sources.log_file_path = log_file;

        MainWindow window(sources, logger);
        window.show();

        if (parser.isSet(smoke_option)) {
            // Let the window finish showing, check it, then leave the event loop.
            QTimer::singleShot(300, &window, [&window, &logger] {
                const MainWindow::SelfCheck check = window.run_self_check();
                logger.log(check.passed ? rr::log::Level::Info : rr::log::Level::Error, "app",
                           check.passed ? "smoke_test_passed" : "smoke_test_failed",
                           check.detail.toStdString());
                QCoreApplication::exit(check.passed ? 0 : 1);
            });
        }
        exit_code = app.exec();
    }

    // --- orderly shutdown: bridge first, then drain and flush the logger ------------------
    logger.log(rr::log::Level::Info, "app", "shutdown", "application stopping",
               {{"exit_code", std::to_string(exit_code)}});
    qt_bridge.uninstall();
    logger.stop();
    return exit_code;
}

}  // namespace rr::ui
