# rr_ui: Qt Widgets code shared by both applications (ADR-001 "rr_app" layer).
# Start-up/shutdown, logging bridge, main window with role banner, honest status display,
# diagnostics tab, About box (Stage 3) and the audio panel: devices, meters, local recording
# (Stage 4). No networking.

qt_add_library(rr_ui STATIC
    include/rr/ui/app_runner.hpp
    src/app_runner.cpp
    src/audio_panel.cpp
    src/audio_panel.hpp
    src/diagnostics.cpp
    src/diagnostics.hpp
    src/main_window.cpp
    src/main_window.hpp
    src/qt_log_bridge.cpp
    src/qt_log_bridge.hpp)

target_include_directories(rr_ui
    PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/include"
    PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/src")

target_link_libraries(rr_ui
    PUBLIC rr_shared rr_session rr_audio
    PRIVATE Qt6::Core Qt6::Gui Qt6::Widgets)

rr_enable_qt_codegen(rr_ui)
rr_set_compiler_options(rr_ui)
