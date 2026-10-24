cmake_minimum_required(VERSION 3.22)
project(DawEngine VERSION 0.1.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Third-party instrument plugins run in a SEPARATE program, daw_pluginhost, so a plugin that crashes or hangs cannot take the
# audio engine down. The engine itself never links the plugin-hosting code; it only talks to the host through shared memory.
#   DAW_ENABLE_PLUGINHOST  build daw_pluginhost (VST3). ON by default.
#   DAW_VST2_SDK_DIR       folder that contains Steinberg's VST2 headers (pluginterfaces/vst2.x/aeffect.h). Optional: when set, the
#                          host can also open VST2 (.dll) plugins. The VST2 SDK is withdrawn and cannot be downloaded or bundled, so
#                          you have to supply it yourself (see docs/plugin-hosting.md).
option(DAW_ENABLE_PLUGINHOST "Build daw_pluginhost, the out-of-process plugin host (VST3)" ON)
set(DAW_VST2_SDK_DIR "" CACHE PATH "Folder with the Steinberg VST2 headers (optional; enables VST2 plugins in the host)")

include(FetchContent)
FetchContent_Declare(JUCE
  GIT_REPOSITORY https://github.com/juce-framework/JUCE.git
  GIT_TAG 8.0.15
  GIT_SHALLOW TRUE)
FetchContent_MakeAvailable(JUCE)

# Time-stretching of loops to the project tempo (MIT licence, header only; it brings its own small FFT dependency).
FetchContent_Declare(signalsmith-stretch
  GIT_REPOSITORY https://github.com/Signalsmith-Audio/signalsmith-stretch.git
  GIT_TAG 1.4.0
  GIT_SHALLOW TRUE)
FetchContent_MakeAvailable(signalsmith-stretch)

# ------------------------------------------------------------------------------------------------------------- the engine
juce_add_console_app(daw_engine
  PRODUCT_NAME "daw_engine"
  VERSION 0.1.0)

target_sources(daw_engine PRIVATE
  src/Main.cpp
  src/Sequencer.cpp
  src/Export.cpp
  src/Samples.cpp
  src/PluginClient.cpp
  src/PluginTest.cpp
  src/SelfTest.cpp)

target_compile_definitions(daw_engine PRIVATE
  JUCE_WEB_BROWSER=0
  JUCE_USE_CURL=0
  JUCE_ASIO=0
  JUCE_MODAL_LOOPS_PERMITTED=0)

target_link_libraries(daw_engine PRIVATE
  juce::juce_core
  juce::juce_events
  juce::juce_audio_basics
  juce::juce_audio_formats
  juce::juce_audio_devices
  signalsmith-stretch
  juce::juce_recommended_config_flags)

target_include_directories(daw_engine PRIVATE ${signalsmith-stretch_SOURCE_DIR})

# -------------------------------------------------------------------------------------------------------- the plugin host
if(DAW_ENABLE_PLUGINHOST)
  juce_add_console_app(daw_pluginhost
    PRODUCT_NAME "daw_pluginhost"
    VERSION 0.1.0)

  target_sources(daw_pluginhost PRIVATE
    src/PluginHostMain.cpp
    src/PluginHost.cpp)

  target_compile_definitions(daw_pluginhost PRIVATE
    JUCE_WEB_BROWSER=0
    JUCE_USE_CURL=0
    JUCE_MODAL_LOOPS_PERMITTED=1   # the host pumps the message loop itself (runDispatchLoopUntil) so plugin timers run
    JUCE_PLUGINHOST_VST3=1)

  if(DAW_VST2_SDK_DIR)
    target_compile_definitions(daw_pluginhost PRIVATE JUCE_PLUGINHOST_VST=1)
    target_include_directories(daw_pluginhost PRIVATE ${DAW_VST2_SDK_DIR})
    message(STATUS "daw_pluginhost: VST2 hosting ENABLED (SDK headers from ${DAW_VST2_SDK_DIR})")
  else()
    message(STATUS "daw_pluginhost: VST3 only (set DAW_VST2_SDK_DIR to also open VST2 .dll plugins)")
  endif()

  target_link_libraries(daw_pluginhost PRIVATE
    juce::juce_core
    juce::juce_events
    juce::juce_audio_basics
    juce::juce_audio_processors
    juce::juce_recommended_config_flags)
endif()
