# rr_transfer: Qt-free post-session take transfer (Stage 11, ADR-020).
# RRXF wire format, SHA-256 via Windows CNG (ADR-014: no custom cryptography), the producer's
# receiver and the performer's sender, each on its own TCP connection and thread.
add_library(rr_transfer STATIC
    include/rr/transfer/sha256.hpp
    include/rr/transfer/take_receiver.hpp
    include/rr/transfer/take_sender.hpp
    include/rr/transfer/transfer_files.hpp
    include/rr/transfer/transfer_protocol.hpp
    include/rr/transfer/transfer_types.hpp
    src/sha256.cpp
    src/take_receiver.cpp
    src/take_sender.cpp
    src/transfer_files.cpp
    src/transfer_protocol.cpp
    src/xconn.cpp
    src/xconn.hpp)
target_include_directories(rr_transfer PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/include")
target_link_libraries(rr_transfer PUBLIC rr_shared rr_network rr_audio)
if(WIN32)
    target_link_libraries(rr_transfer PUBLIC bcrypt)
endif()
rr_set_compiler_options(rr_transfer)
