# rr_audio: Qt-free audio capture and local recording (ADR-003, ADR-007).
# Device I/O uses miniaudio 0.11.25, vendored unmodified in third_party/miniaudio.

# miniaudio implementation, compiled once, without the project's warning flags (third-party code).
add_library(rr_miniaudio STATIC src/MiniaudioImpl.c)
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
    include/rr/audio/AudioEngine.h
    include/rr/audio/CaptureIngest.h
    include/rr/audio/FileIo.h
    include/rr/audio/LiveTap.h
    include/rr/audio/MonitorBus.h
    include/rr/audio/SpscRing.h
    include/rr/audio/TakeMetadata.h
    include/rr/audio/TakeNaming.h
    include/rr/audio/TakeRecorder.h
    include/rr/audio/WavFormat.h
    include/rr/audio/WavInspect.h
    include/rr/audio/WavWriter.h
    src/AudioEngine.cpp
    src/CaptureIngest.cpp
    src/EngineReport.cpp
    src/FileIo.cpp
    src/LiveTap.cpp
    src/MonitorBus.cpp
    src/TakeMetadata.cpp
    src/TakeNaming.cpp
    src/TakeRecorder.cpp
    src/WavFormat.cpp
    src/WavInspect.cpp
    src/WavWriter.cpp)

target_include_directories(rr_audio PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/include")
# miniaudio is a private detail: only AudioEngine.cpp includes it.
target_link_libraries(rr_audio PUBLIC rr_shared PRIVATE rr_miniaudio)
rr_set_compiler_options(rr_audio)
