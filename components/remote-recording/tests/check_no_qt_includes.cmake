# Fails if any C/C++ file under RR_SCAN_DIRS includes a Qt header (ADR-001).
# Usage: cmake -DRR_SCAN_DIRS=dir1;dir2 -P check_no_qt_includes.cmake

set(_violations "")
set(_scanned 0)
foreach(_dir IN LISTS RR_SCAN_DIRS)
    if(NOT EXISTS "${_dir}")
        continue()
    endif()
    file(GLOB_RECURSE _files "${_dir}/*.h" "${_dir}/*.hpp" "${_dir}/*.cpp" "${_dir}/*.c")
    foreach(_file IN LISTS _files)
        math(EXPR _scanned "${_scanned} + 1")
        file(STRINGS "${_file}" _hits REGEX "^[ \t]*#[ \t]*include[ \t]*[<\"](Q[A-Za-z]+|Qt[A-Za-z]*/)")
        if(_hits)
            string(APPEND _violations "\n  ${_file}: ${_hits}")
        endif()
    endforeach()
endforeach()

if(_violations)
    message(FATAL_ERROR "Qt includes found in Qt-free libraries (ADR-001):${_violations}")
endif()
message(STATUS "No Qt includes in ${_scanned} files of the Qt-free libraries.")
