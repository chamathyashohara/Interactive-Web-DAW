#include "diagnostics.hpp"

#include <QSysInfo>
#include <QtGlobal>

#include "rr/shared/build_info.hpp"
#include "rr/shared/clock.hpp"

namespace rr::ui {
namespace {

QString qs(const std::string& text) {
    return QString::fromStdString(text);
}

QString qs(std::string_view text) {
    return QString::fromUtf8(text.data(), static_cast<qsizetype>(text.size()));
}

}  // namespace

QString platform_description() {
    return QSysInfo::prettyProductName() + QStringLiteral(" (") +
           QSysInfo::currentCpuArchitecture() + QStringLiteral(")");
}

QString diagnostics_text(const DiagnosticsSources& s) {
    const rr::BuildInfo build = rr::build_info();
    QString out;
    out += QStringLiteral("=== Application ===\n");
    out += QStringLiteral("role: %1 (%2)\n").arg(qs(rr::role_display_name(s.role)), qs(rr::role_id(s.role)));
    out += QStringLiteral("version: %1\n").arg(qs(build.version));
    out += QStringLiteral("git commit (at configure): %1\n").arg(qs(build.git_commit));
    out += QStringLiteral("protocol: %1\n").arg(qs(build.protocol_version));
    out += QStringLiteral("build configuration: %1\n").arg(qs(build.build_config));
    out += QStringLiteral("compiler: %1\n").arg(qs(build.compiler));
    out += QStringLiteral("__cplusplus: %1\n").arg(qs(build.cxx_standard));
    out += QStringLiteral("toolchain deviation: %1\n").arg(qs(build.toolchain_deviation));
    out += QStringLiteral("Qt (compiled against): %1\n").arg(QStringLiteral(QT_VERSION_STR));
    out += QStringLiteral("Qt (runtime): %1\n").arg(QString::fromLatin1(qVersion()));
    out += QStringLiteral("implemented in this build: start-up/shutdown, logging, diagnostics.\n");
    out += QStringLiteral("NOT implemented in this build: audio devices, recording, networking.\n\n");

    out += QStringLiteral("=== System ===\n");
    out += QStringLiteral("os: %1\n").arg(platform_description());
    out += QStringLiteral("kernel: %1 %2\n").arg(QSysInfo::kernelType(), QSysInfo::kernelVersion());
    out += QStringLiteral("utc now: %1\n\n").arg(qs(rr::time::format_utc_iso8601_ms(rr::time::utc_now_ms())));

    out += QStringLiteral("=== Logging ===\n");
    out += QStringLiteral("log file: %1\n").arg(s.log_file_path);
    out += QStringLiteral("log file writable: %1\n")
               .arg(s.file && s.file->ok() ? QStringLiteral("yes") : QStringLiteral("NO - see path above"));
    if (s.logger) {
        const rr::log::LoggerStats st = s.logger->stats();
        out += QStringLiteral("records accepted %1, written %2, dropped (queue full) %3, "
                              "rejected (real-time thread) %4, sink errors %5\n")
                   .arg(st.accepted).arg(st.written).arg(st.dropped_queue_full)
                   .arg(st.rejected_realtime).arg(st.sink_errors);
    }
    out += QStringLiteral("\n=== Configuration (provisional defaults, not tuned) ===\n");
    if (s.config) {
        out += qs(rr::describe(*s.config));
        const auto problems = rr::validate(*s.config);
        out += problems.empty() ? QStringLiteral("validation: OK\n")
                                : QStringLiteral("validation: %1 problem(s)\n").arg(problems.size());
        for (const auto& p : problems) {
            out += QStringLiteral("  - %1\n").arg(qs(p));
        }
    }

    out += QStringLiteral("\n=== Recent log records (newest last) ===\n");
    if (s.recent) {
        for (const rr::log::Record& r : s.recent->snapshot()) {
            out += qs(rr::log::to_json_line(r));
            out += QLatin1Char('\n');
        }
    }
    return out;
}

}  // namespace rr::ui
