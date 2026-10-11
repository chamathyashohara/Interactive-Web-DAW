# rr_session_probe: scriptable CLI producer/performer (two-instance and two-PC control tests
# without Qt). Uses the same rr_control code as the apps. Not shipped to end users.
add_executable(rr_session_probe main.cpp)
target_link_libraries(rr_session_probe PRIVATE rr_control)
rr_set_compiler_options(rr_session_probe)
