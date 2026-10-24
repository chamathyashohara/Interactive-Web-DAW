<#
.SYNOPSIS
  Configure, build and test Remote Recording on Windows with the pinned toolchain.

.DESCRIPTION
  Wraps the CMake presets in CMakePresets.json (docs/build/WINDOWS_BUILD.md).
  Stops at the first failing step and returns its exit code.

.PARAMETER Config
  Debug (default) or Release.

.PARAMETER CoreOnly
  Build only the Qt-free libraries and their tests (preset msvc-x64-core). Qt not needed.

.EXAMPLE
  $env:RR_QT_DIR = "C:\Qt\6.11.3\msvc2022_64"
  .\scripts\build-windows.ps1 -Config Release
#>
param(
    [ValidateSet("Debug", "Release")] [string] $Config = "Debug",
    [switch] $CoreOnly
)

$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)

if (-not (Get-Command cmake -ErrorAction SilentlyContinue)) {
    Write-Host "ERROR: cmake not found on PATH. Install the VS 2022 Build Tools (includes CMake) - see docs/build/WINDOWS_BUILD.md"
    exit 1
}

if ($CoreOnly) {
    $configure = "msvc-x64-core"
    $build = "msvc-x64-core-debug"
    $test = "msvc-x64-core-debug"
    if ($Config -eq "Release") { Write-Warning "-CoreOnly has a Debug preset only; building Debug." }
} else {
    if (-not $env:RR_QT_DIR) {
        Write-Host "ERROR: RR_QT_DIR is not set. Example: `$env:RR_QT_DIR = 'C:\Qt\6.11.3\msvc2022_64'  (or use -CoreOnly)"
        exit 1
    }
    $configure = "msvc-x64"
    $suffix = $Config.ToLower()
    $build = "msvc-x64-$suffix"
    $test = "msvc-x64-$suffix"
}

function Invoke-Step([string] $title, [string[]] $arguments) {
    Write-Host "==> $title : cmake/ctest $($arguments -join ' ')"
    & $arguments[0] $arguments[1..($arguments.Length - 1)]
    if ($LASTEXITCODE -ne 0) {
        Write-Host "FAILED: $title (exit code $LASTEXITCODE)"
        exit $LASTEXITCODE
    }
}

Invoke-Step "configure" @("cmake", "--preset", $configure)
Invoke-Step "build" @("cmake", "--build", "--preset", $build)
Invoke-Step "test" @("ctest", "--preset", $test)
Write-Host "OK: configure, build and tests passed ($configure, $Config)."
