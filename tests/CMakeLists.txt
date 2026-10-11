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
    shared/test_build_info.cpp
    shared/test_clock.cpp
    shared/test_config.cpp
    shared/test_error_codes.cpp
    shared/test_json_escape.cpp
    shared/test_logger.cpp
    shared/test_role.cpp
    session/test_states.cpp)

target_link_libraries(rr_unit_tests PRIVATE rr_shared rr_session Catch2::Catch2WithMain)
rr_set_compiler_options(rr_unit_tests)

list(APPEND CMAKE_MODULE_PATH "${catch2_SOURCE_DIR}/extras")
include(Catch)
catch_discover_tests(rr_unit_tests DISCOVERY_MODE PRE_TEST)

# ADR-001 boundary check: the Qt-free libraries must not include Qt headers.
add_test(NAME core_has_no_qt_includes
    COMMAND "${CMAKE_COMMAND}"
            "-DRR_SCAN_DIRS=${PROJECT_SOURCE_DIR}/libs/shared;${PROJECT_SOURCE_DIR}/libs/session;${PROJECT_SOURCE_DIR}/libs/audio;${PROJECT_SOURCE_DIR}/libs/network"
            -P "${CMAKE_CURRENT_SOURCE_DIR}/check_no_qt_includes.cmake")
