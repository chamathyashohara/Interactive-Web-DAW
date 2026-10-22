#pragma once

#include <QtGlobal>

#include "rr/shared/Log.h"

/**
 * Routes Qt's own messages (qDebug/qWarning/qCritical, including Qt's internal warnings)
 * into the structured logger as component "qt". Only one bridge may be installed at a time.
 * The previous handler is restored by uninstall() or the destructor, which must run before
 * the logger is stopped.
 */
class QtLogBridge
{
public:
    explicit QtLogBridge(Logger& logger);
    ~QtLogBridge();
    QtLogBridge(const QtLogBridge&) = delete;
    QtLogBridge& operator=(const QtLogBridge&) = delete;

    void uninstall();

private:
    bool installed = false;
};

