# rr_session: Qt-free session/link state types and their user-facing labels
# (docs/architecture/SESSION_STATE_MACHINE.md): state definitions, the initial snapshot
# (Stage 3) and the explicit transition tables for both roles (Stage 6).

add_library(rr_session STATIC
    src/session_machine.cpp
    src/states.cpp
    include/rr/session/session_machine.hpp
    include/rr/session/states.hpp)

target_include_directories(rr_session PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/include")
target_link_libraries(rr_session PUBLIC rr_shared)
rr_set_compiler_options(rr_session)
