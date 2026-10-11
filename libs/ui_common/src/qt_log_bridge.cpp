#include "qt_log_bridge.hpp"

#include <atomic>
#include <string>

#include <QString>

namespace rr::ui {
namespace {

std::atomic<rr::log::Logger*> g_logger{nullptr};
std::atomic<QtMessageHandler> g_previous{nullptr};

rr::log::Level to_level(QtMsgType type) {
    switch (type) {
    case QtDebugMsg: return rr::log::Level::Debug;
    case QtInfoMsg: return rr::log::Level::Info;
    case QtWarningMsg: return rr::log::Level::Warn;
    case QtCriticalMsg:
    case QtFatalMsg: return rr::log::Level::Error;
    }
    return rr::log::Level::Warn;
}

void handle_qt_message(QtMsgType type, const QMessageLogContext& context, const QString& text) {
    if (rr::log::Logger* logger = g_logger.load()) {
        const std::string category = context.category ? context.category : "";
        const std::string where = context.file
            ? std::string(context.file) + ":" + std::to_string(context.line)
            : std::string();
        logger->log(to_level(type), "qt", "qt_message", text.toStdString(),
                    {{"category", category}, {"source", where}});
    }
    // Keep Qt's normal behaviour as well (debugger output; abort on QtFatalMsg).
    if (QtMessageHandler previous = g_previous.load()) {
        previous(type, context, text);
    }
}

}  // namespace

QtLogBridge::QtLogBridge(rr::log::Logger& logger) {
    rr::log::Logger* expected = nullptr;
    if (g_logger.compare_exchange_strong(expected, &logger)) {
        g_previous.store(qInstallMessageHandler(&handle_qt_message));
        installed_ = true;
    }
}

QtLogBridge::~QtLogBridge() {
    uninstall();
}

void QtLogBridge::uninstall() {
    if (!installed_) {
        return;
    }
    qInstallMessageHandler(g_previous.load());
    g_previous.store(nullptr);
    g_logger.store(nullptr);
    installed_ = false;
}

}  // namespace rr::ui
