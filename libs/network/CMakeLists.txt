# rr_network: Qt-free control-channel transport (ADR-016, Stage 6 - IN PROGRESS).
# So far: control protocol codec, TCP socket layer, IPv4 interface list, clock-offset estimator.
add_library(rr_network STATIC
    include/rr/network/clock_offset.hpp
    include/rr/network/control_protocol.hpp
    include/rr/network/socket.hpp
    src/clock_offset.cpp
    src/control_protocol.cpp
    src/socket.cpp)
target_include_directories(rr_network PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/include")
target_link_libraries(rr_network PUBLIC rr_shared rr_session)
if(WIN32)
    target_link_libraries(rr_network PUBLIC ws2_32 iphlpapi)
endif()
rr_set_compiler_options(rr_network)
