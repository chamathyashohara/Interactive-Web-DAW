# rr_audio_probe: Qt-free CLI that exercises the real capture + recording path (manual device
# test protocol, docs/testing/AUDIO_DEVICE_TEST_PROTOCOL.md). Not shipped to end users.
add_executable(rr_audio_probe main.cpp)
target_link_libraries(rr_audio_probe PRIVATE rr_audio)
rr_set_compiler_options(rr_audio_probe)
