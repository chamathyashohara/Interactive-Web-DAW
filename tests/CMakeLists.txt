# Unit tests for the Qt-free libraries (ADR-015: Catch2 v3.16.0, test-only, never shipped).
#
# Catch2 is downloaded at configure time and checked against a pinned SHA-256. For offline
# builds, unpack the same archive and pass -DFETCHCONTENT_SOURCE_DIR_CATCH2=<path>.

include(FetchContent)
# Extracted files get the extraction time as timestamp (CMake >= 3.24 policy; older CMake
# versions do not know the policy and already behave this way).
if(POLICY CMP0135)
    cmake_policy(SET CMP0135 NEW)
endif()
FetchContent_Declare(Catch2
    URL https://github.com/catchorg/Catch2/archive/refs/tags/v3.16.0.tar.gz
    URL_HASH SHA256=0957cae5821b17ce07f0833aaa52b5137643a8382203221f363a8303c109af34)
FetchContent_MakeAvailable(Catch2)

add_executable(rr_unit_tests
    audio/test_capture_levels.cpp
    audio/test_monitor_bus.cpp
    audio/test_recorder_pipeline.cpp
    audio/test_recorder_schedule.cpp
    audio/test_spsc_ring.cpp
    audio/test_take_naming.cpp
    audio/test_wav_format.cpp
    audio/test_wav_inspect.cpp
    audio/test_wav_writer.cpp
    control/test_session_controller.cpp
    media/test_jitter_buffer.cpp
    media/test_live_duplex.cpp
    media/test_live_loopback.cpp
    media/test_live_tap.cpp
    media/test_media_packet.cpp
    media/test_opus_codec.cpp
    network/test_clock_offset.cpp
    network/test_control_link.cpp
    network/test_control_protocol.cpp
    session/test_session_machine.cpp
    shared/test_build_info.cpp
    shared/test_clock.cpp
    shared/test_config.cpp
    shared/test_error_codes.cpp
    shared/test_json_escape.cpp
    shared/test_logger.cpp
    shared/test_role.cpp
    session/test_states.cpp)

target_link_libraries(rr_unit_tests PRIVATE rr_shared rr_session rr_audio rr_network rr_control rr_media Catch2::Catch2WithMain)
target_include_directories(rr_unit_tests PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/audio")
rr_set_compiler_options(rr_unit_tests)

list(APPEND CMAKE_MODULE_PATH "${catch2_SOURCE_DIR}/extras")
include(Catch)
catch_discover_tests(rr_unit_tests DISCOVERY_MODE PRE_TEST)

# Lexical check of all sources for literals broken across lines (guards the Qt code, which
# cannot be compiled where Qt is missing). Needs Python 3; skipped otherwise.
find_package(Python3 COMPONENTS Interpreter QUIET)
if(Python3_Interpreter_FOUND)
    add_test(NAME sources_have_no_broken_literals
        COMMAND Python3::Interpreter -I "${PROJECT_SOURCE_DIR}/tools/check_sources.py"
                "${PROJECT_SOURCE_DIR}/libs" "${PROJECT_SOURCE_DIR}/apps"
                "${PROJECT_SOURCE_DIR}/tools" "${PROJECT_SOURCE_DIR}/tests")
endif()

# ADR-001 boundary check: the Qt-free libraries must not include Qt headers.
add_test(NAME core_has_no_qt_includes
    COMMAND "${CMAKE_COMMAND}"
            "-DRR_SCAN_DIRS=${PROJECT_SOURCE_DIR}/libs/shared;${PROJECT_SOURCE_DIR}/libs/session;${PROJECT_SOURCE_DIR}/libs/audio;${PROJECT_SOURCE_DIR}/libs/network;${PROJECT_SOURCE_DIR}/libs/control;${PROJECT_SOURCE_DIR}/libs/media"
            -P "${CMAKE_CURRENT_SOURCE_DIR}/check_no_qt_includes.cmake")
