# rr_network: Qt-free control-channel transport (ADR-016, Stage 6).
# Control protocol codec, TCP socket layer, IPv4 interface list, clock-offset estimator, control link.
add_library(rr_network STATIC
    include/rr/network/ClockOffset.h
    include/rr/network/ControlLink.h
    include/rr/network/ControlProtocol.h
    include/rr/network/Socket.h
    src/ClockOffset.cpp
    src/ControlLink.cpp
    src/ControlProtocol.cpp
    src/Socket.cpp)
target_include_directories(rr_network PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/include")
target_link_libraries(rr_network PUBLIC rr_shared rr_session)
if(WIN32)
    target_link_libraries(rr_network PUBLIC ws2_32 iphlpapi)
endif()
rr_set_compiler_options(rr_network)
