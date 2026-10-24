# rr_transfer: Qt-free post-session take transfer (Stage 11, ADR-020).
# RRXF wire format, SHA-256 via Windows CNG (ADR-014: no custom cryptography), the producer's
# receiver and the performer's sender, each on its own TCP connection and thread.
add_library(rr_transfer STATIC
    include/rr/transfer/Sha256.h
    include/rr/transfer/TakeReceiver.h
    include/rr/transfer/TakeSender.h
    include/rr/transfer/TransferFiles.h
    include/rr/transfer/TransferProtocol.h
    include/rr/transfer/TransferTypes.h
    src/Sha256.cpp
    src/TakeReceiver.cpp
    src/TakeSender.cpp
    src/TransferFiles.cpp
    src/TransferProtocol.cpp
    src/XConn.cpp
    src/XConn.h)
target_include_directories(rr_transfer PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/include")
target_link_libraries(rr_transfer PUBLIC rr_shared rr_network rr_audio)
if(WIN32)
    target_link_libraries(rr_transfer PUBLIC bcrypt)
endif()
rr_set_compiler_options(rr_transfer)
