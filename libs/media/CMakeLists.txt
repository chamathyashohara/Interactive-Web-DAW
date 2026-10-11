# rr_media: Qt-free live audio path (Stage 7, ADR-017): media packet format (ADR-008 header v1),
# Opus 1.6.1 encoder/decoder wrappers, jitter buffer (ADR-011), arrival statistics, the producer's
# live sender and the performer's live receiver (Stage 7), and since Stage 8 the symmetric
# LiveEndpoint with one outgoing and one incoming stream (both directions, ADR-018).
add_library(rr_media STATIC
    include/rr/media/arrival_stats.hpp
    include/rr/media/incoming_stream.hpp
    include/rr/media/jitter_buffer.hpp
    include/rr/media/live_endpoint.hpp
    include/rr/media/live_receiver.hpp
    include/rr/media/live_report.hpp
    include/rr/media/live_sender.hpp
    include/rr/media/live_settings.hpp
    include/rr/media/media_packet.hpp
    include/rr/media/net_impairment.hpp
    include/rr/media/opus_codec.hpp
    include/rr/media/outgoing_stream.hpp
    src/arrival_stats.cpp
    src/incoming_stream.cpp
    src/jitter_buffer.cpp
    src/live_endpoint.cpp
    src/live_receiver.cpp
    src/live_report.cpp
    src/live_sender.cpp
    src/media_packet.cpp
    src/opus_codec.cpp
    src/outgoing_stream.cpp)
target_include_directories(rr_media PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/include")
# libopus is a private detail: only opus_codec.cpp includes opus.h.
target_link_libraries(rr_media PUBLIC rr_shared rr_audio rr_network PRIVATE Opus::opus)
if(WIN32)
    target_link_libraries(rr_media PRIVATE winmm)  # timeBeginPeriod for the media-send thread
endif()
rr_set_compiler_options(rr_media)
