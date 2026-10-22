# PerformerClient.exe: joins the producer's session (APP-01). Role wiring only.

qt_add_executable(PerformerClient WIN32 Main.cpp)
target_link_libraries(PerformerClient PRIVATE rr_ui)
rr_set_compiler_options(PerformerClient)
rr_deploy_qt_runtime(PerformerClient)

if(RR_BUILD_TESTS)
    add_test(NAME performer_smoke
        COMMAND PerformerClient --smoke-test --log-dir "${PROJECT_BINARY_DIR}/test-logs")
endif()
