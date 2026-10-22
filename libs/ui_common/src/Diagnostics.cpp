#include "Diagnostics.h"

#include <QSysInfo>
#include <QtGlobal>

#include "rr/shared/BuildInfo.h"
#include "rr/shared/Clock.h"
#include "rr/shared/JsonEscape.h"

namespace
{

QString qs(const std::string& text)
{
    return QString::fromStdString(text);
}

QString qs(std::string_view text)
{
    return QString::fromUtf8(text.data(), static_cast<qsizetype>(text.size()));
}

}  // namespace

QString platformDescription()
{
    return QSysInfo::prettyProductName() + QStringLiteral(" (") +
           QSysInfo::currentCpuArchitecture() + QStringLiteral(")");
}

QString diagnosticsReportJson(const DiagnosticsSources& s, const std::string& audioJson)
{
    const BuildInfo build = buildInfo();
    auto q = [](const std::string& text) { return "\"" + jsonEscape(text) + "\""; };
    std::string out = "{\n";
    out += "  \"schema\": \"rr.diagnostics.v1\",\n";
    out += "  \"generated_utc\": " + q(formatUtcIso8601Ms(utcNowMs())) + ",\n";
    out += "  \"role\": " + q(std::string(roleId(s.role))) + ",\n";
    out += "  \"build\": {\"version\": " + q(build.version) + ", \"commit\": " + q(build.gitCommit) +
           ", \"protocol\": " + q(build.protocolVersion) + ", \"compiler\": " + q(build.compiler) +
           ", \"config\": " + q(build.buildConfig) + ", \"toolchain_deviation\": " + q(build.toolchainDeviation) +
           ", \"qt_compiled\": " + q(QT_VERSION_STR) + ", \"qt_runtime\": " + q(qVersion()) + "},\n";
    out += "  \"platform\": " + q(platformDescription().toStdString()) + ",\n";
    out += "  \"configuration\": " + q(s.config ? describe(*s.config) : std::string()) + ",\n";
    if (s.logger)
    {
        const LoggerStats st = s.logger->getStats();
        out += "  \"logger\": {\"accepted\": " + std::to_string(st.accepted) + ", \"written\": " +
               std::to_string(st.written) + ", \"dropped_queue_full\": " + std::to_string(st.droppedQueueFull) +
               ", \"rejected_realtime\": " + std::to_string(st.rejectedRealtime) +
               ", \"sink_errors\": " + std::to_string(st.sinkErrors) + ", \"log_file\": " +
               q(s.logFilePath.toStdString()) + "},\n";
    }
    out += "  \"audio\": " + (audioJson.empty() ? std::string("null") : audioJson) + ",\n";
    out += "  \"recent_log\": [";
    if (s.recent)
    {
        bool first = true;
        for (const Record& r : s.recent->snapshot())
        {
            out += first ? "\n    " : ",\n    ";
            out += toJsonLine(r);
            first = false;
        }
    }
    out += "\n  ]\n}\n";
    return QString::fromStdString(out);
}

QString diagnosticsText(const DiagnosticsSources& s)
{
    const BuildInfo build = buildInfo();
    QString out;
    out += QStringLiteral("=== Application ===\n");
    out += QStringLiteral("role: %1 (%2)\n").arg(qs(roleDisplayName(s.role)), qs(roleId(s.role)));
    out += QStringLiteral("version: %1\n").arg(qs(build.version));
    out += QStringLiteral("git commit (at configure): %1\n").arg(qs(build.gitCommit));
    out += QStringLiteral("protocol: %1\n").arg(qs(build.protocolVersion));
    out += QStringLiteral("build configuration: %1\n").arg(qs(build.buildConfig));
    out += QStringLiteral("compiler: %1\n").arg(qs(build.compiler));
    out += QStringLiteral("__cplusplus: %1\n").arg(qs(build.cxxStandard));
    out += QStringLiteral("toolchain deviation: %1\n").arg(qs(build.toolchainDeviation));
    out += QStringLiteral("Qt (compiled against): %1\n").arg(QStringLiteral(QT_VERSION_STR));
    out += QStringLiteral("Qt (runtime): %1\n").arg(QString::fromLatin1(qVersion()));
    out += QStringLiteral("implemented in this build: start-up/shutdown, logging, diagnostics.\n");
    out += QStringLiteral("NOT implemented in this build: audio devices, recording, networking.\n\n");

    out += QStringLiteral("=== System ===\n");
    out += QStringLiteral("os: %1\n").arg(platformDescription());
    out += QStringLiteral("kernel: %1 %2\n").arg(QSysInfo::kernelType(), QSysInfo::kernelVersion());
    out += QStringLiteral("utc now: %1\n\n").arg(qs(formatUtcIso8601Ms(utcNowMs())));

    out += QStringLiteral("=== Logging ===\n");
    out += QStringLiteral("log file: %1\n").arg(s.logFilePath);
    out += QStringLiteral("log file writable: %1\n")
               .arg(s.file && s.file->isOk() ? QStringLiteral("yes") : QStringLiteral("NO - see path above"));
    if (s.logger)
    {
        const LoggerStats st = s.logger->getStats();
        out += QStringLiteral("records accepted %1, written %2, dropped (queue full) %3, "
                              "rejected (real-time thread) %4, sink errors %5\n")
                   .arg(st.accepted).arg(st.written).arg(st.droppedQueueFull)
                   .arg(st.rejectedRealtime).arg(st.sinkErrors);
    }
    out += QStringLiteral("\n=== Configuration (provisional defaults, not tuned) ===\n");
    if (s.config)
    {
        out += qs(describe(*s.config));
        const auto problems = validate(*s.config);
        out += problems.empty() ? QStringLiteral("validation: OK\n")
                                : QStringLiteral("validation: %1 problem(s)\n").arg(problems.size());
        for (const auto& p : problems)
        {
            out += QStringLiteral("  - %1\n").arg(qs(p));
        }
    }

    out += QStringLiteral("\n=== Recent log records (newest last) ===\n");
    if (s.recent)
    {
        for (const Record& r : s.recent->snapshot())
        {
            out += qs(toJsonLine(r));
            out += QLatin1Char('\n');
        }
    }
    return out;
}

