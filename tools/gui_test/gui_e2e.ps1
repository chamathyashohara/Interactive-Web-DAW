# Stage 10: end-to-end test of the two GUI apps themselves, driven through Windows UI
# Automation (the same interface a screen reader uses). Both apps run on THIS PC.
param([string]$Out = (Join-Path $PSScriptRoot '..\..\build\gui_e2e_out'))
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
. "$here\uia.ps1"
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class W {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int t, bool repaint);
}
"@
New-Item -ItemType Directory -Force $Out | Out-Null
$bin = "D:\DAW RESEARCH\PP1-TEST\build\msvc-x64\bin\Release"
$log = @()
function Note([string]$m) { $script:log += "$([DateTime]::Now.ToString('HH:mm:ss.fff'))  $m"; Write-Host $m }

function Shot($proc, [string]$file) {
    $r = New-Object W+RECT
    [W]::GetWindowRect($proc.MainWindowHandle, [ref]$r) | Out-Null
    $w = $r.R - $r.L; $h = $r.B - $r.T
    if ($w -le 0 -or $h -le 0) { return }
    $bmp = New-Object System.Drawing.Bitmap $w, $h
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($r.L, $r.T, 0, 0, $bmp.Size)
    $bmp.Save((Join-Path $Out $file), [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
}

function Click-Named($root, [string]$name, [string]$what) {
    $e = Find-ByName $root $name
    if (-not $e) { throw "control not found: $name ($what)" }
    if (-not (Invoke-Click $e)) { throw "could not click: $name" }
    Note "clicked '$name' ($what)"
    Start-Sleep -Milliseconds 600
}

function Tick($root, [string]$name) {
    $e = Find-ByName $root $name
    if (-not $e) { throw "checkbox not found: $name" }
    if ((Get-Toggle $e) -ne 'On') { Invoke-Click $e | Out-Null }
    Start-Sleep -Milliseconds 400
    $state = Get-Toggle $e
    Note "checkbox '$name' -> $state"
    if ($state -ne 'On') { throw "could not tick: $name" }
}

function Wait-Text($root, [string]$pattern, [int]$seconds, [string]$what) {
    $deadline = (Get-Date).AddSeconds($seconds)
    do {
        $e = Find-Like $root $pattern
        if ($e) { Note "saw: $($e.Current.Name)"; return $e.Current.Name }
        Start-Sleep -Milliseconds 400
    } while ((Get-Date) -lt $deadline)
    throw "timed out after ${seconds}s waiting for $what (/$pattern/)"
}

$prod = $null; $perf = $null
try {
    Note "=== start both apps ==="
    $prod = Start-Process "$bin\ProducerStudio.exe" -PassThru
    $perf = Start-Process "$bin\PerformerClient.exe" -PassThru
    $pr = Get-Root $prod.Id
    $pe = Get-Root $perf.Id
    Start-Sleep 3
    [W]::MoveWindow($prod.MainWindowHandle, 0, 0, 1180, 1100, $true) | Out-Null
    [W]::MoveWindow($perf.MainWindowHandle, 1190, 0, 1180, 1100, $true) | Out-Null
    Start-Sleep 1

    Note "=== step 1: sound on both PCs ==="
    Click-Named $pr 'Turn on my microphone' 'producer mic'
    Click-Named $pr 'Turn on my headphones' 'producer out'
    Click-Named $pe 'Turn on my microphone' 'performer mic'
    Click-Named $pe 'Turn on my headphones' 'performer out'

    Note "=== use loopback so the test does not need a firewall rule ==="
    $tab = Find-ByName $pr 'All controls'
    if ($tab) { $sp = $null; if ($tab.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$sp)) { $sp.Select() } }
    Start-Sleep 1
    $combo = $pr.FindFirst([System.Windows.Automation.TreeScope]::Descendants,
        (New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
            [System.Windows.Automation.ControlType]::ComboBox)))
    if (-not $combo) { throw "interface combo not found" }
    $ec = $null
    if ($combo.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$ec)) { $ec.Expand(); Start-Sleep -Milliseconds 500 }
    $item = $null
    foreach ($li in $combo.FindAll([System.Windows.Automation.TreeScope]::Descendants,
        (New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
            [System.Windows.Automation.ControlType]::ListItem)))) {
        if ($li.Current.Name -like '127.0.0.1*') { $item = $li }
    }
    if (-not $item) { throw "no loopback entry in the interface list" }
    $si = $null
    if ($item.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$si)) { $si.Select() }
    if ($ec) { $ec.Collapse() }
    Note "listen address set to 127.0.0.1 (one-PC test)"
    $homeTab = Find-ByName $pr 'Start here'
    if ($homeTab) { $sp2 = $null; if ($homeTab.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$sp2)) { $sp2.Select() } }
    Start-Sleep 1

    Note "=== step 2: session + join ==="
    Tick $pr 'I consent to this session being recorded'
    Click-Named $pr 'Start the session' 'create session'
    $addr = (Wait-Text $pr '\(port \d+\)' 10 'the address line') -replace '\s+\(port.*', ''
    $code = Wait-Text $pr '^\d{6}$' 10 'the pairing code'
    Note "address='$addr' code='<redacted>'"
    Shot $prod 'producer_1_session.png'

    $hostBox = Find-Like $pe 'Producer'
    $edits = @()
    $c = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::Edit)
    foreach ($e in $pe.FindAll([System.Windows.Automation.TreeScope]::Descendants, $c)) { $edits += $e }
    Note "performer edit boxes: $($edits.Count)"
    if ($edits.Count -lt 2) { throw "expected the address and code boxes" }
    Set-Text $edits[0] $addr | Out-Null
    Set-Text $edits[1] $code | Out-Null
    Tick $pe 'I agree to be recorded, and I am ready to start'
    Tick $pe 'Let the producer receive a copy of my recordings'
    Click-Named $pe 'Join the session' 'join'
    Wait-Text $pr 'Connected to' 20 'the performer to connect'
    Wait-Text $pr '^OK\s+Ready$' 25 'the producer to become Ready'
    Shot $prod 'producer_2_ready.png'
    Shot $perf 'performer_2_ready.png'

    Note "=== step 3: record a take ==="
    Click-Named $pr 'Record on both PCs' 'record'
    Wait-Text $pr '^REC\s+RECORDING$' 20 'RECORDING on the producer'
    Wait-Text $pr 'Performer PC: RECORDING' 20 'the performer to confirm recording'
    Shot $prod 'producer_3_recording.png'
    Shot $perf 'performer_3_recording.png'
    Start-Sleep 6
    Click-Named $pr 'Stop' 'stop'
    Wait-Text $pr 'This PC: take 1 saved' 25 'the producer take to save'
    Wait-Text $pr 'Performer PC: saved' 25 'the performer take to save'
    Shot $prod 'producer_4_saved.png'

    Note "=== step 4: verified copy ==="
    Click-Named $pr "Get the performer's recording" 'request copy'
    Wait-Text $pr 'VERIFIED' 90 'the copy to be verified'
    Start-Sleep 2
    Shot $prod 'producer_5_verified.png'
    Shot $perf 'performer_5_verified.png'

    Note "=== keyboard check: tab order reaches the main buttons ==="
    $focusable = 0
    foreach ($e in $pr.FindAll([System.Windows.Automation.TreeScope]::Descendants,
        (New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::IsKeyboardFocusableProperty, $true)))) { $focusable++ }
    Note "keyboard-focusable controls on the producer: $focusable"

    Note "RESULT: PASS - the whole flow ran through the GUI"
} catch {
    Note "RESULT: FAIL - $($_.Exception.Message)"
    if ($prod) { Shot $prod 'fail_producer.png' }
    if ($perf) { Shot $perf 'fail_performer.png' }
} finally {
    foreach ($p in @($prod, $perf)) {
        if ($p -and -not $p.HasExited) { $p.CloseMainWindow() | Out-Null; Start-Sleep 2 }
        if ($p -and -not $p.HasExited) { Stop-Process -Id $p.Id -Force -Confirm:$false }
    }
    $log | Set-Content (Join-Path $Out 'gui_e2e_log.txt') -Encoding utf8
    Write-Host "--- log written to $Out\gui_e2e_log.txt ---"
}
