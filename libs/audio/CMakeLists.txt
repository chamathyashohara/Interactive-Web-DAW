# rr_audio: Qt-free audio capture and local recording (ADR-003, ADR-007).
# Device I/O uses miniaudio 0.11.25, vendored unmodified in third_party/miniaudio.

# miniaudio implementation, compiled once, without the project's warning flags (third-party code).
add_library(rr_miniaudio STATIC src/miniaudio_impl.c)
target_include_directories(rr_miniaudio SYSTEM PUBLIC "${PROJECT_SOURCE_DIR}/third_party/miniaudio")
# Only what we use: device I/O. No decoders/encoders/engine/node graph.
target_compile_definitions(rr_miniaudio PUBLIC
    MA_NO_DECODING MA_NO_ENCODING MA_NO_GENERATION MA_NO_RESOURCE_MANAGER MA_NO_NODE_GRAPH MA_NO_ENGINE)
if(WIN32)
    target_compile_definitions(rr_miniaudio PUBLIC MA_ENABLE_ONLY_SPECIFIC_BACKENDS MA_ENABLE_WASAPI)
endif()
find_package(Threads REQUIRED)
target_link_libraries(rr_miniaudio PUBLIC Threads::Threads)
if(UNIX AND NOT APPLE)
    target_link_libraries(rr_miniaudio PUBLIC ${CMAKE_DL_LIBS} m)
endif()

add_library(rr_audio STATIC
    include/rr/audio/audio_engine.hpp
    include/rr/audio/capture_ingest.hpp
    include/rr/audio/file_io.hpp
    include/rr/audio/spsc_ring.hpp
    include/rr/audio/take_metadata.hpp
    include/rr/audio/take_naming.hpp
    include/rr/audio/take_recorder.hpp
    include/rr/audio/wav_format.hpp
    include/rr/audio/wav_inspect.hpp
    include/rr/audio/wav_writer.hpp
    src/audio_engine.cpp
    src/capture_ingest.cpp
    src/file_io.cpp
    src/take_metadata.cpp
    src/take_naming.cpp
    src/take_recorder.cpp
    src/wav_format.cpp
    src/wav_inspect.cpp
    src/wav_writer.cpp)

target_include_directories(rr_audio PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/include")
# miniaudio is a private detail: only audio_engine.cpp includes it.
target_link_libraries(rr_audio PUBLIC rr_shared PRIVATE rr_miniaudio)
rr_set_compiler_options(rr_audio)
