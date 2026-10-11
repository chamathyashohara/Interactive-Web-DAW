# Generates rr/version_info.hpp from the project version and the git commit.
# The commit is read at *configure* time; reconfigure after committing to refresh it.

set(RR_GIT_COMMIT "unknown")
set(RR_GIT_DIRTY_SUFFIX "")
find_package(Git QUIET)
if(GIT_FOUND AND EXISTS "${PROJECT_SOURCE_DIR}/.git")
    execute_process(
        COMMAND "${GIT_EXECUTABLE}" rev-parse --short=12 HEAD
        WORKING_DIRECTORY "${PROJECT_SOURCE_DIR}"
        OUTPUT_VARIABLE _rr_commit OUTPUT_STRIP_TRAILING_WHITESPACE
        RESULT_VARIABLE _rr_rc ERROR_QUIET)
    if(_rr_rc EQUAL 0 AND _rr_commit)
        set(RR_GIT_COMMIT "${_rr_commit}")
        execute_process(
            COMMAND "${GIT_EXECUTABLE}" status --porcelain --untracked-files=no
            WORKING_DIRECTORY "${PROJECT_SOURCE_DIR}"
            OUTPUT_VARIABLE _rr_status OUTPUT_STRIP_TRAILING_WHITESPACE ERROR_QUIET)
        if(_rr_status)
            set(RR_GIT_DIRTY_SUFFIX "-dirty")
        endif()
    endif()
endif()

set(RR_GENERATED_INCLUDE_DIR "${PROJECT_BINARY_DIR}/generated/include")
configure_file(
    "${PROJECT_SOURCE_DIR}/cmake/version_info.hpp.in"
    "${RR_GENERATED_INCLUDE_DIR}/rr/version_info.hpp"
    @ONLY)
