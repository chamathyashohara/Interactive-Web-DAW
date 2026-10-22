# rr_ui: Qt Widgets code shared by both applications (ADR-001 "rr_app" layer).
# Start-up/shutdown, logging bridge, main window with role banner, honest status display,
# diagnostics tab, About box (Stage 3) and the audio panel: devices, meters, local recording
# (Stage 4), the session panel: producer/performer session control over a LAN (Stage 6), and the
# live panel: one-way live audio producer -> performer (Stage 7).

qt_add_library(rr_ui STATIC
    include/rr/ui/AppRunner.h
    src/AppRunner.cpp
    src/AudioPanel.cpp
    src/AudioPanel.h
    src/Diagnostics.cpp
    src/Diagnostics.h
    src/LivePanel.cpp
    src/LivePanel.h
    src/MainWindow.cpp
    src/MainWindow.h
    src/QtLogBridge.cpp
    src/QtLogBridge.h
    src/SessionPanel.cpp
    src/SessionPanel.h
    src/SimplePanel.cpp
    src/SimplePanel.h
    src/Theme.cpp
    src/Theme.h)

# Check-box indicators are shipped as images: a style-sheet indicator with no image would be a
# blank square, and "ticked" must stay unmistakable (ADR-021).
qt_add_resources(rr_ui "rr_theme"
    PREFIX "/rr"
    BASE "resources"
    FILES
        resources/check_off.svg
        resources/check_on.svg
        resources/check_off_disabled.svg)

target_include_directories(rr_ui
    PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/include"
    PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/src")

target_link_libraries(rr_ui
    PUBLIC rr_shared rr_session rr_audio rr_network rr_control rr_media
    PRIVATE Qt6::Core Qt6::Gui Qt6::Widgets)

rr_enable_qt_codegen(rr_ui)
rr_set_compiler_options(rr_ui)
