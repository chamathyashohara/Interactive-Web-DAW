# Helpers to drive the Qt apps through Windows UI Automation, so the GUI itself is tested
# (not just the libraries underneath it).
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes

function Get-Root([int]$procId) {
    for ($i = 0; $i -lt 40; $i++) {
        $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
        if ($p -and $p.MainWindowHandle -ne 0) {
            $r = [System.Windows.Automation.AutomationElement]::FromHandle($p.MainWindowHandle)
            if ($r) { return $r }
        }
        Start-Sleep -Milliseconds 500
    }
    throw "no window for pid $procId"
}

function Find-ByName($root, [string]$name, [int]$timeoutMs = 8000) {
    $deadline = (Get-Date).AddMilliseconds($timeoutMs)
    do {
        $c = New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::NameProperty, $name)
        $e = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $c)
        if ($e) { return $e }
        Start-Sleep -Milliseconds 250
    } while ((Get-Date) -lt $deadline)
    return $null
}

function Find-Like($root, [string]$pattern) {
    $c = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::IsControlElementProperty, $true)
    foreach ($e in $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $c)) {
        if ($e.Current.Name -match $pattern) { return $e }
    }
    return $null
}

function Invoke-Click($element) {
    $p = $null
    if ($element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$p)) {
        $p.Invoke(); return $true
    }
    if ($element.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$p)) {
        $p.Toggle(); return $true
    }
    return $false
}

function Set-Text($element, [string]$text) {
    $p = $null
    if ($element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$p)) {
        $p.SetValue($text); return $true
    }
    return $false
}

function Get-Toggle($element) {
    $p = $null
    if ($element.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$p)) {
        return $p.Current.ToggleState
    }
    return 'none'
}

function Dump-Tree($root, [int]$max = 200) {
    $c = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::IsControlElementProperty, $true)
    $out = @()
    foreach ($e in $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $c)) {
        $t = $e.Current.ControlType.ProgrammaticName -replace 'ControlType\.', ''
        $n = $e.Current.Name
        if ($n) { $out += "$t | $n" }
        if ($out.Count -ge $max) { break }
    }
    return $out
}
