# rr_shared: Qt-free common types, configuration, version/build info, clock and logging.
# Part of the "core" family in ADR-001 (must never include Qt headers).

add_library(rr_shared STATIC
    src/build_info.cpp
    src/clock.cpp
    src/config.cpp
    src/error_codes.cpp
    src/json_escape.cpp
    src/logger.cpp
    src/log_record.cpp
    src/log_sinks.cpp
    src/realtime_guard.cpp
    src/role.cpp
    include/rr/shared/build_info.hpp
    include/rr/shared/clock.hpp
    include/rr/shared/config.hpp
    include/rr/shared/error_codes.hpp
    include/rr/shared/json_escape.hpp
    include/rr/shared/log.hpp
    include/rr/shared/log_sinks.hpp
    include/rr/shared/realtime_guard.hpp
    include/rr/shared/role.hpp)

target_include_directories(rr_shared
    PUBLIC
        "${CMAKE_CURRENT_SOURCE_DIR}/include"
        "${RR_GENERATED_INCLUDE_DIR}")

find_package(Threads REQUIRED)
target_link_libraries(rr_shared PUBLIC Threads::Threads)

# Name of the build configuration (Debug/Release) baked into build_info().
target_compile_definitions(rr_shared PRIVATE "RR_BUILD_CONFIG=\"$<CONFIG>\"")

rr_set_compiler_options(rr_shared)
