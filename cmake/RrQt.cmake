# Finds Qt for the GUI apps (ADR-004: Qt 6.11.3, msvc2022_64, Core/Gui/Widgets only at this
# stage; Network is added when the control transport is built).

set(RR_QT_PINNED_VERSION 6.11.3)
set(RR_QT_MIN_VERSION 6.11)

find_package(Qt6 ${RR_QT_MIN_VERSION} QUIET COMPONENTS Core Gui Widgets)

if(NOT Qt6_FOUND)
    message(FATAL_ERROR
        "Qt ${RR_QT_MIN_VERSION} or newer (package msvc2022_64, modules Core/Gui/Widgets) was not found.\n"
        "  1. Install Qt ${RR_QT_PINNED_VERSION} for MSVC 2022 64-bit (see docs/build/WINDOWS_BUILD.md).\n"
        "  2. Point CMake at it, e.g. set the environment variable used by the presets:\n"
        "       setx RR_QT_DIR C:\\Qt\\${RR_QT_PINNED_VERSION}\\msvc2022_64\n"
        "     or pass -DCMAKE_PREFIX_PATH=C:/Qt/${RR_QT_PINNED_VERSION}/msvc2022_64\n"
        "  Current CMAKE_PREFIX_PATH: '${CMAKE_PREFIX_PATH}'\n"
        "  To build only the Qt-free libraries and tests: -DRR_BUILD_APPS=OFF")
endif()

if(NOT Qt6_VERSION VERSION_EQUAL RR_QT_PINNED_VERSION)
    message(WARNING "Qt ${Qt6_VERSION} found; the pinned version is ${RR_QT_PINNED_VERSION} (ADR-004). "
                    "Builds made with a different Qt are not the reference build.")
endif()
message(STATUS "Qt ${Qt6_VERSION} found: ${Qt6_DIR}")

# AUTOMOC is enabled per Qt target (rr_enable_qt_codegen) rather than globally with
# qt_standard_project_setup(), so the Qt-free libraries and the tests never run moc.
function(rr_enable_qt_codegen target)
    set_target_properties(${target} PROPERTIES AUTOMOC ON)
endfunction()

# Copies the Qt runtime next to an app after each build so it starts from bin/<Config>.
# Packaging for other PCs (licences, vc_redist) is a separate step, see WINDOWS_BUILD.md.
function(rr_deploy_qt_runtime target)
    if(NOT WIN32 OR NOT RR_RUN_WINDEPLOYQT)
        return()
    endif()
    if(TARGET Qt6::windeployqt)
        set(_rr_windeployqt "$<TARGET_FILE:Qt6::windeployqt>")
    else()
        find_program(RR_WINDEPLOYQT_EXECUTABLE windeployqt
            HINTS "${Qt6_DIR}/../../../bin" NO_DEFAULT_PATH)
        if(NOT RR_WINDEPLOYQT_EXECUTABLE)
            message(WARNING "windeployqt not found next to Qt (${Qt6_DIR}/../../../bin); "
                            "${target} will need Qt's bin folder on PATH to start.")
            return()
        endif()
        set(_rr_windeployqt "${RR_WINDEPLOYQT_EXECUTABLE}")
    endif()
    add_custom_command(TARGET ${target} POST_BUILD
        COMMAND "${_rr_windeployqt}" --no-translations --no-compiler-runtime
                "$<TARGET_FILE:${target}>"
        COMMENT "windeployqt: copying the Qt runtime next to ${target}"
        VERBATIM)
endfunction()
