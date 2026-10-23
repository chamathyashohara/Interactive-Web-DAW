#include "QtLogBridge.h"

#include <atomic>
#include <string>

#include <QString>

namespace
{

std::atomic<Logger*> gLogger{nullptr};
std::atomic<QtMessageHandler> gPrevious{nullptr};

Level toLevel(QtMsgType type)
{
    switch (type)
    {
    case QtDebugMsg: return Level::Debug;
    case QtInfoMsg: return Level::Info;
    case QtWarningMsg: return Level::Warn;
    case QtCriticalMsg:
    case QtFatalMsg: return Level::Error;
    }
    return Level::Warn;
}

void handleQtMessage(QtMsgType type, const QMessageLogContext& context, const QString& text)
{
    if (Logger* logger = gLogger.load())
    {
        const std::string category = context.category ? context.category : "";
        const std::string where = context.file
            ? std::string(context.file) + ":" + std::to_string(context.line)
            : std::string();
        logger->log(toLevel(type), "qt", "qt_message", text.toStdString(),
                    {{"category", category}, {"source", where}});
    }
    // Keep Qt's normal behaviour as well (debugger output; abort on QtFatalMsg).
    if (QtMessageHandler previous = gPrevious.load())
    {
        previous(type, context, text);
    }
}

}  // namespace

QtLogBridge::QtLogBridge(Logger& logger)
{
    Logger* expected = nullptr;
    if (gLogger.compare_exchange_strong(expected, &logger))
    {
        gPrevious.store(qInstallMessageHandler(&handleQtMessage));
        installed = true;
    }
}

QtLogBridge::~QtLogBridge()
{
    uninstall();
}

void QtLogBridge::uninstall()
{
    if (!installed)
    {
        return;
    }
    qInstallMessageHandler(gPrevious.load());
    gPrevious.store(nullptr);
    gLogger.store(nullptr);
    installed = false;
}

