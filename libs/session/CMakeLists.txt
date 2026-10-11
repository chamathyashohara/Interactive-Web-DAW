# rr_session: Qt-free session/link state types and their user-facing labels
# (docs/architecture/SESSION_STATE_MACHINE.md). Stage 3 contains the state *definitions*
# and the initial snapshot only; the transition tables arrive with increment I-3.

add_library(rr_session STATIC
    src/states.cpp
    include/rr/session/states.hpp)

target_include_directories(rr_session PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/include")
target_link_libraries(rr_session PUBLIC rr_shared)
rr_set_compiler_options(rr_session)
