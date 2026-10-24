# Toolchain checks (ADR-002). Each failure says what was found, what is
# required, and where the fix is documented.

set(_rr_doc "docs/build/WINDOWS_BUILD.md")

if(NOT CMAKE_SIZEOF_VOID_P EQUAL 8)
    message(FATAL_ERROR
        "RemoteRecording builds for 64-bit (x64) only, but this configuration is "
        "${CMAKE_SIZEOF_VOID_P}-byte pointers. Use the msvc-x64 preset "
        "(Visual Studio generator with -A x64). See ${_rr_doc}.")
endif()

if(MSVC)
    # MSVC_VERSION 1930-1949 = toolset v143 (Visual Studio 2022). 1950+ = v145 (VS 2026).
    if(MSVC_VERSION LESS 1930 OR MSVC_VERSION GREATER_EQUAL 1950)
        set(_rr_msg
            "MSVC_VERSION ${MSVC_VERSION} (toolset '${CMAKE_VS_PLATFORM_TOOLSET}') is not the pinned "
            "toolchain. The project pins MSVC v143 from Visual Studio 2022 (MSVC_VERSION 1930-1949), "
            "see ADR-002 and ${_rr_doc}. Install 'Build Tools for Visual Studio 2022' (VCTools "
            "workload) or configure with -DRR_ALLOW_UNPINNED_MSVC=ON to accept the deviation.")
        if(RR_ALLOW_UNPINNED_MSVC)
            message(WARNING "${_rr_msg}")
            set(RR_TOOLCHAIN_DEVIATION "unpinned-msvc-${MSVC_VERSION}")
        else()
            message(FATAL_ERROR "${_rr_msg}")
        endif()
    endif()
else()
    if(NOT RR_ALLOW_NON_MSVC)
        message(FATAL_ERROR
            "Product builds require MSVC v143 (Visual Studio 2022) on Windows x64, but the C++ "
            "compiler is ${CMAKE_CXX_COMPILER_ID} ${CMAKE_CXX_COMPILER_VERSION} "
            "(${CMAKE_CXX_COMPILER}).\n"
            "  - To build the product: install the VS 2022 Build Tools and use "
            "'cmake --preset msvc-x64' (see ${_rr_doc}).\n"
            "  - For a Qt-free portability check of the core libraries only: "
            "'cmake --preset core-check-gcc' (sets RR_ALLOW_NON_MSVC=ON, RR_BUILD_APPS=OFF).")
    endif()
    if(RR_BUILD_APPS)
        message(FATAL_ERROR
            "RR_ALLOW_NON_MSVC=ON is only for checking the Qt-free libraries. The GUI apps are "
            "supported only with MSVC v143 and Qt msvc2022_64. Add -DRR_BUILD_APPS=OFF, or use "
            "the msvc-x64 preset. See ${_rr_doc}.")
    endif()
    set(RR_TOOLCHAIN_DEVIATION "non-msvc-core-check")
endif()

if(NOT DEFINED RR_TOOLCHAIN_DEVIATION)
    set(RR_TOOLCHAIN_DEVIATION "none")
endif()
