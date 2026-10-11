# Remote Recording (Component 04): Producer Studio and Performer Client.
# Build instructions: docs/build/WINDOWS_BUILD.md
# Architecture-to-code map: docs/architecture/CODE_MAP.md

# Lowest CMake that has presets version 3 (ADR-002). VS 2022 ships a newer one.
cmake_minimum_required(VERSION 3.21)

project(RemoteRecording
    VERSION 0.1.0
    DESCRIPTION "Two-PC remote recording with local masters and live talkback (SLIIT IT4010, Component 04)"
    LANGUAGES C CXX)

if(PROJECT_SOURCE_DIR STREQUAL PROJECT_BINARY_DIR)
    message(FATAL_ERROR
        "In-source builds are not supported. Use a preset, e.g.\n"
        "  cmake --preset msvc-x64\n"
        "See docs/build/WINDOWS_BUILD.md")
endif()

option(RR_BUILD_APPS "Build the two Qt GUI applications" ON)
option(RR_BUILD_TESTS "Build the unit tests (fetches Catch2 v3.16.0)" ON)
option(RR_ALLOW_NON_MSVC
    "Allow a non-MSVC compiler for a Qt-free portability check of the core libraries (not a product build)" OFF)
option(RR_ALLOW_UNPINNED_MSVC
    "Allow an MSVC toolset other than v143 (VS 2022); the deviation is printed and recorded in build info" OFF)
option(RR_WARNINGS_AS_ERRORS "Treat compiler warnings as errors" OFF)
option(RR_RUN_WINDEPLOYQT "Run windeployqt after building each app so it starts from the build folder" ON)

list(APPEND CMAKE_MODULE_PATH "${PROJECT_SOURCE_DIR}/cmake")
include(RrToolchainChecks)   # stops with a clear message if the toolchain is wrong
include(RrCompilerOptions)
include(RrVersion)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# Put every executable in one folder (bin/<Config> with multi-config generators) so the
# apps, the tests and the Qt DLLs deployed by windeployqt sit next to each other.
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY "${PROJECT_BINARY_DIR}/bin")

# Enabled before the subdirectories so tests declared in them (app smoke tests) register.
if(RR_BUILD_TESTS)
    enable_testing()
endif()

# Qt-free libraries (ADR-001: these must never include Qt headers; see the
# core_has_no_qt_includes test).
add_subdirectory(libs/shared)
add_subdirectory(libs/session)
add_subdirectory(libs/audio)
add_subdirectory(libs/network)
add_subdirectory(libs/transfer)   # Stage 11: verified take transfer
add_subdirectory(libs/control)
include(RrOpus)              # libopus 1.6.1, pinned by SHA-256 (ADR-006, ADR-017)
add_subdirectory(libs/media)

add_subdirectory(tools/rr_audio_probe)
add_subdirectory(tools/rr_session_probe)

if(RR_BUILD_APPS)
    include(RrQt)            # stops with a clear message if Qt is missing
    add_subdirectory(libs/ui_common)
    add_subdirectory(apps/producer)
    add_subdirectory(apps/performer)
endif()

if(RR_BUILD_TESTS)
    add_subdirectory(tests)
endif()

message(STATUS "RemoteRecording ${PROJECT_VERSION} (commit ${RR_GIT_COMMIT}${RR_GIT_DIRTY_SUFFIX}): "
               "apps=${RR_BUILD_APPS} tests=${RR_BUILD_TESTS} compiler=${CMAKE_CXX_COMPILER_ID} ${CMAKE_CXX_COMPILER_VERSION}")
