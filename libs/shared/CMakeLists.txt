# rr_shared: Qt-free common types, configuration, version/build info, clock and logging.
# Part of the "core" family in ADR-001 (must never include Qt headers).

add_library(rr_shared STATIC
    src/BuildInfo.cpp
    src/Clock.cpp
    src/Config.cpp
    src/ErrorCodes.cpp
    src/JsonEscape.cpp
    src/Logger.cpp
    src/LogRecord.cpp
    src/LogSinks.cpp
    src/RealtimeGuard.cpp
    src/Role.cpp
    include/rr/shared/BuildInfo.h
    include/rr/shared/Clock.h
    include/rr/shared/Config.h
    include/rr/shared/ErrorCodes.h
    include/rr/shared/JsonEscape.h
    include/rr/shared/Log.h
    include/rr/shared/LogSinks.h
    include/rr/shared/RealtimeGuard.h
    include/rr/shared/Role.h)

target_include_directories(rr_shared
    PUBLIC
        "${CMAKE_CURRENT_SOURCE_DIR}/include"
        "${RR_GENERATED_INCLUDE_DIR}")

find_package(Threads REQUIRED)
target_link_libraries(rr_shared PUBLIC Threads::Threads)

# Name of the build configuration (Debug/Release) baked into build_info().
target_compile_definitions(rr_shared PRIVATE "RR_BUILD_CONFIG=\"$<CONFIG>\"")

rr_set_compiler_options(rr_shared)
