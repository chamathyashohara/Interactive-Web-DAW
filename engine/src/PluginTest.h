#pragma once
#include <string>

/**
 * CLI test of the out-of-process plugin path (`daw_engine --plugintest <path>`): launches the host, plays a note through the
 * real-time shared-memory link and reports whether audio came back. With `crash` the host is killed mid-note, to prove the engine
 * survives a plugin crash (stays alive, goes silent, reports the plugin as crashed).
 */
int runPluginTest(const std::string& pluginPath, bool crash);
