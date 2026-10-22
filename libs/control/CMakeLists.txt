# rr_control: Qt-free producer/performer session control (Stage 6): the session controller
# (state machine + control link + local recorder) and the recorder ports.
add_library(rr_control STATIC
    include/rr/control/Readiness.h
    include/rr/control/RecorderPort.h
    include/rr/control/SessionController.h
    src/Readiness.cpp
    src/RecorderPort.cpp
    src/SessionController.cpp)
target_include_directories(rr_control PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/include")
target_link_libraries(rr_control PUBLIC rr_shared rr_session rr_network rr_audio rr_transfer)
rr_set_compiler_options(rr_control)
