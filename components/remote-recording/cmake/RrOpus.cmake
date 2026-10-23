# libopus 1.6.1 for the live audio path (ADR-006, ADR-017). BSD-3-Clause, statically linked.
#
# Downloaded at configure time from the official Xiph release server and checked against the
# SHA-256 published in https://downloads.xiph.org/releases/opus/SHA256SUMS.txt (verified on
# 11 Oct 2026). For offline builds, unpack the same archive and pass
# -DFETCHCONTENT_SOURCE_DIR_OPUS=<path>.
#
# Only the library is built: no tests, programs, DNN extensions (DRED/OSCE off by default in
# 1.6.1), shared library or install rules.

include(FetchContent)
if(POLICY CMP0135)
    cmake_policy(SET CMP0135 NEW)
endif()

set(OPUS_BUILD_SHARED_LIBRARY OFF CACHE BOOL "" FORCE)
set(OPUS_BUILD_TESTING OFF CACHE BOOL "" FORCE)
set(OPUS_BUILD_PROGRAMS OFF CACHE BOOL "" FORCE)
set(OPUS_DRED OFF CACHE BOOL "" FORCE)
set(OPUS_OSCE OFF CACHE BOOL "" FORCE)
set(OPUS_INSTALL_PKG_CONFIG_MODULE OFF CACHE BOOL "" FORCE)
set(OPUS_INSTALL_CMAKE_CONFIG_MODULE OFF CACHE BOOL "" FORCE)

FetchContent_Declare(opus
    URL https://downloads.xiph.org/releases/opus/opus-1.6.1.tar.gz
    URL_HASH SHA256=6ffcb593207be92584df15b32466ed64bbec99109f007c82205f0194572411a1)
FetchContent_MakeAvailable(opus)

# The live receiver decodes on the playback callback (ADR-011), which is only allowed if libopus
# uses stack scratch (C99 VLAs or alloca). Its third mode, a global "pseudostack", is neither
# thread-safe nor allocation-free: refuse it.
if(OPUS_NONTHREADSAFE_PSEUDOSTACK)
    message(FATAL_ERROR "libopus selected NONTHREADSAFE_PSEUDOSTACK; the live path needs OPUS_VAR_ARRAYS or OPUS_USE_ALLOCA")
endif()
message(STATUS "libopus 1.6.1: stack scratch via VAR_ARRAYS=${OPUS_VAR_ARRAYS} USE_ALLOCA=${OPUS_USE_ALLOCA}")

if(NOT TARGET Opus::opus)
    add_library(Opus::opus ALIAS opus)
endif()
