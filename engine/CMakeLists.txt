cmake_minimum_required(VERSION 3.22)
project(DawEngine VERSION 0.1.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# VST3 instrument hosting is optional and OFF by default: the normal build, the self-test, the benchmark and the app
# never pull in juce_audio_processors or the VST3 SDK. Turn it on with -DDAW_ENABLE_VST3=ON for a build that can host plugins.
option(DAW_ENABLE_VST3 "Host VST3 instrument plugins (adds juce_audio_processors + the bundled VST3 SDK)" OFF)

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

juce_add_console_app(daw_engine
  PRODUCT_NAME "daw_engine"
  VERSION 0.1.0)

target_sources(daw_engine PRIVATE
  src/Main.cpp
  src/Sequencer.cpp
  src/Export.cpp
  src/Samples.cpp
  src/SelfTest.cpp)

target_compile_definitions(daw_engine PRIVATE
  JUCE_WEB_BROWSER=0
  JUCE_USE_CURL=0
  JUCE_ASIO=0
  JUCE_MODAL_LOOPS_PERMITTED=0)

if(DAW_ENABLE_VST3)
  target_sources(daw_engine PRIVATE src/PluginHost.cpp)
  # These must be set where juce_audio_processors is compiled (it reads them to enable the VST3 host and addDefaultFormats()).
  target_compile_definitions(daw_engine PRIVATE JUCE_PLUGINHOST_VST3=1 DAW_ENABLE_VST3=1)
  message(STATUS "daw_engine: VST3 instrument hosting ENABLED")
endif()

target_link_libraries(daw_engine PRIVATE
  juce::juce_core
  juce::juce_events
  juce::juce_audio_basics
  juce::juce_audio_formats
  juce::juce_audio_devices
  $<$<BOOL:${DAW_ENABLE_VST3}>:juce::juce_audio_processors>
  signalsmith-stretch
  juce::juce_recommended_config_flags)

target_include_directories(daw_engine PRIVATE ${signalsmith-stretch_SOURCE_DIR})
