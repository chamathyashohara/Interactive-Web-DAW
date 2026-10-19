cmake_minimum_required(VERSION 3.22)
project(DawEngine VERSION 0.1.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

include(FetchContent)
FetchContent_Declare(JUCE
  GIT_REPOSITORY https://github.com/juce-framework/JUCE.git
  GIT_TAG 8.0.15
  GIT_SHALLOW TRUE)
FetchContent_MakeAvailable(JUCE)

juce_add_console_app(daw_engine
  PRODUCT_NAME "daw_engine"
  VERSION 0.1.0)

target_sources(daw_engine PRIVATE
  src/Main.cpp
  src/Sequencer.cpp
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
  juce::juce_audio_devices
  juce::juce_recommended_config_flags)
