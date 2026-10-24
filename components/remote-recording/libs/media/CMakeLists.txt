# rr_media: Qt-free live audio path (Stage 7, ADR-017): media packet format (ADR-008 header v1),
# Opus 1.6.1 encoder/decoder wrappers, jitter buffer (ADR-011), arrival statistics, the producer's
# live sender and the performer's live receiver (Stage 7), and since Stage 8 the symmetric
# LiveEndpoint with one outgoing and one incoming stream (both directions, ADR-018).
add_library(rr_media STATIC
    include/rr/media/ArrivalStats.h
    include/rr/media/IncomingStream.h
    include/rr/media/JitterBuffer.h
    include/rr/media/LiveEndpoint.h
    include/rr/media/LiveReceiver.h
    include/rr/media/LiveReport.h
    include/rr/media/LiveSender.h
    include/rr/media/LiveSettings.h
    include/rr/media/MediaPacket.h
    include/rr/media/NetImpairment.h
    include/rr/media/OpusCodec.h
    include/rr/media/OutgoingStream.h
    src/ArrivalStats.cpp
    src/IncomingStream.cpp
    src/JitterBuffer.cpp
    src/LiveEndpoint.cpp
    src/LiveReceiver.cpp
    src/LiveReport.cpp
    src/LiveSender.cpp
    src/MediaPacket.cpp
    src/OpusCodec.cpp
    src/OutgoingStream.cpp)
target_include_directories(rr_media PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/include")
# libopus is a private detail: only OpusCodec.cpp includes opus.h.
target_link_libraries(rr_media PUBLIC rr_shared rr_audio rr_network PRIVATE Opus::opus)
if(WIN32)
    target_link_libraries(rr_media PRIVATE winmm)  # timeBeginPeriod for the media-send thread
endif()
rr_set_compiler_options(rr_media)
