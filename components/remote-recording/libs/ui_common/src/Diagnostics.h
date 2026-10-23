#pragma once

#include <memory>

#include <QString>

#include "rr/shared/Config.h"
#include "rr/shared/Log.h"
#include "rr/shared/LogSinks.h"

/** Everything the diagnostics tab and the startup log need to describe this process. */
struct DiagnosticsSources
{
    Role role = Role::Producer;
    const AppConfig* config = nullptr;
    const Logger* logger = nullptr;
    std::shared_ptr<MemorySink> recent;
    std::shared_ptr<JsonLinesFileSink> file;
    QString logFilePath;
};

/** Multi-section plain-text report: build, Qt, system, logging, configuration, recent log. */
QString diagnosticsText(const DiagnosticsSources& sources);

/** Short platform description for the startup log ("Windows 11 Version 24H2 (x86_64)"). */
QString platformDescription();

/**
 * Exportable diagnostic report (schema "rr.diagnostics.v1"): build, platform, configuration,
 * logger statistics, the audio engine snapshot (`audioJson`, an object) and recent log records.
 */
QString diagnosticsReportJson(const DiagnosticsSources& sources, const std::string& audioJson);

