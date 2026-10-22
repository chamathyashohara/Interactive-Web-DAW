# ProducerStudio.exe: the session authority (APP-01). Role wiring only; shared code lives in
# libs/ui_common and the Qt-free libraries.

qt_add_executable(ProducerStudio WIN32 Main.cpp)
target_link_libraries(ProducerStudio PRIVATE rr_ui)
rr_set_compiler_options(ProducerStudio)
rr_deploy_qt_runtime(ProducerStudio)

if(RR_BUILD_TESTS)
    add_test(NAME producer_smoke
        COMMAND ProducerStudio --smoke-test --log-dir "${PROJECT_BINARY_DIR}/test-logs")
endif()
