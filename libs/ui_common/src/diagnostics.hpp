#pragma once

#include <memory>

#include <QString>

#include "rr/shared/config.hpp"
#include "rr/shared/log.hpp"
#include "rr/shared/log_sinks.hpp"

namespace rr::ui {

// Everything the diagnostics tab and the startup log need to describe this process.
struct DiagnosticsSources {
    Role role = Role::Producer;
    const AppConfig* config = nullptr;
    const rr::log::Logger* logger = nullptr;
    std::shared_ptr<rr::log::MemorySink> recent;
    std::shared_ptr<rr::log::JsonLinesFileSink> file;
    QString log_file_path;
};

// Multi-section plain-text report: build, Qt, system, logging, configuration, recent log.
QString diagnostics_text(const DiagnosticsSources& sources);

// Short platform description for the startup log ("Windows 11 Version 24H2 (x86_64)").
QString platform_description();

}  // namespace rr::ui
