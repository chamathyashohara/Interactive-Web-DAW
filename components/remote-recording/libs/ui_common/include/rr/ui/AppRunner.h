#pragma once

#include "rr/shared/Role.h"

/**
 * Complete application lifecycle shared by both executables:
 * QApplication -> command line -> logger (JSON Lines file + recent records) ->
 * Qt message bridge -> main window -> event loop -> orderly shutdown.
 *
 * Command line:
 * --log-dir <path>   folder for the log file
 * (default: %LOCALAPPDATA%/<organisation>/<app>/logs)
 * --smoke-test       show the window, check that it identifies its role and shows no false
 * connected/recording state, then exit (0 = pass, 1 = fail)
 * --help, --version
 *
 * Returns the process exit code.
 */
int runApplication(Role role, int argc, char* argv[]);

