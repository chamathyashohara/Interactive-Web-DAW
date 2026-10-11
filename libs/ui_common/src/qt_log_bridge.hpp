#pragma once

#include <QtGlobal>

#include "rr/shared/log.hpp"

namespace rr::ui {

// Routes Qt's own messages (qDebug/qWarning/qCritical, including Qt's internal warnings)
// into the structured logger as component "qt". Only one bridge may be installed at a time.
// The previous handler is restored by uninstall() or the destructor, which must run before
// the logger is stopped.
class QtLogBridge {
public:
    explicit QtLogBridge(rr::log::Logger& logger);
    ~QtLogBridge();
    QtLogBridge(const QtLogBridge&) = delete;
    QtLogBridge& operator=(const QtLogBridge&) = delete;

    void uninstall();

private:
    bool installed_ = false;
};

}  // namespace rr::ui
