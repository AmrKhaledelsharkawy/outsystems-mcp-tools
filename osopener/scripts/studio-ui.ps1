<#
.SYNOPSIS
  osopener desktop helper (Windows PowerShell 5.1, .NET System.Windows.Automation).

  One sub-command per invocation; prints exactly ONE JSON line on stdout.
  Node spawns it as:
    powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File studio-ui.ps1 <cmd> [options]

  Sub-commands (all read-only unless marked):
    find-window                      Service Studio process + main window (pid, hwnd, title, exePath, fileVersion, minimized)
    launch [-ExePath p]              (writes) start ServiceStudio.exe, wait for its main window
    focus                            (writes) restore if minimized + SetForegroundWindow on the Studio main window
    foreground-title                 title/class/pid of the current foreground window
    uia-dump [-Depth n] [-Hwnd h] [-AsText] UIA tree of the Studio main window (or -Hwnd); JSON array or -AsText lines
    uia-find -Name re | -AutomationId re [-ControlType t] [-Hwnd h] [-Depth n]
                                     elements whose Name / AutomationId match the regex (no click)
    uia-click (-Name re | -AutomationId re) [-ControlType t] [-Hwnd h] [-Depth n]
                                     (writes) Invoke / Expand / Toggle / Select pattern, else click centre of bounding rect
    uia-settext -Text t (-Name re | -AutomationId re | -First Edit) [-Hwnd h]
                                     (writes) ValuePattern.SetValue on an Edit; falls back to focus + type
    send-keys -Keys k                (writes) System.Windows.Forms.SendKeys.SendWait (never Alt+F4)
    tab-list                         list module tabs (label, offscreen, hasClose)
    tab-close -Name <regex>          close the module tab whose label matches (never answers a save prompt)
    screenshot -Out path             capture primary screen to PNG
    file-version -ExePath p          FileVersion of an exe

  SAFETY (OSG-014 §6): uia-click refuses any element whose Name matches /close|discard|don't save|don.t save|delete/i;
  send-keys refuses any sequence containing %{F4}. The helper never kills or closes Studio.
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0, Mandatory = $true)][string]$Command,
  [string]$Name,
  [string]$AutomationId,
  [string]$ControlType,
  [string]$Text,
  [string]$Keys,
  [string]$Out,
  [string]$ExePath,
  [long]$Hwnd = 0,
  [int]$Depth = 6,
  [int]$MaxNodes = 4000,
  [int]$TimeoutMs = 60000,
  [switch]$First,
  [switch]$AsText
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

if (-not ([System.Management.Automation.PSTypeName]'OsOpener.Native').Type) {
Add-Type -Namespace OsOpener -Name Native -MemberDefinition @"
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int count);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, System.Text.StringBuilder text, int count);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
[DllImport("user32.dll")] public static extern bool AllowSetForegroundWindow(int dwProcessId);
[DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
"@
}

# Safety deny-lists (OSG-014 §6 + audit item 2). Name: anything that could close, save, publish or confirm.
$FORBIDDEN_CLICK_NAME = '(?i)close|discard|don.?t save|delete|save|publish|\byes\b|\bok\b'
$FORBIDDEN_CLICK_ID = '(?i)close'
$PROCESS_NAME = "ServiceStudio"

function Out-Json($obj) {
  # Single line, no pretty printing. Depth large enough for the UIA dump.
  $json = $obj | ConvertTo-Json -Compress -Depth 12
  [Console]::Out.Write($json + "`n")
}

function Fail($code, $message, $extra = @{}) {
  $o = @{ ok = $false; error = @{ code = $code; message = $message } }
  foreach ($k in $extra.Keys) { $o[$k] = $extra[$k] }
  Out-Json $o
  exit 0
}

function Get-StudioProcess {
  Get-Process -Name $PROCESS_NAME -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
}

function Get-WindowTitle([IntPtr]$h) {
  $sb = New-Object System.Text.StringBuilder 1024
  [void][OsOpener.Native]::GetWindowText($h, $sb, 1024)
  $sb.ToString()
}
function Get-WindowClass([IntPtr]$h) {
  $sb = New-Object System.Text.StringBuilder 256
  [void][OsOpener.Native]::GetClassName($h, $sb, 256)
  $sb.ToString()
}

function Get-StudioInfo {
  $p = Get-StudioProcess
  if (-not $p) {
    # Process may exist without a main window yet (splash). Report that too.
    $any = Get-Process -Name $PROCESS_NAME -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($any) {
      return @{ running = $true; hasMainWindow = $false; pid = $any.Id; exePath = $any.Path }
    }
    return @{ running = $false; hasMainWindow = $false }
  }
  $h = $p.MainWindowHandle
  $ver = $null
  try { $ver = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($p.Path).FileVersion } catch {}
  $fg = [OsOpener.Native]::GetForegroundWindow()
  return @{
    running = $true; hasMainWindow = $true; pid = $p.Id; hwnd = [int64]$h
    title = (Get-WindowTitle $h); className = (Get-WindowClass $h)
    exePath = $p.Path; fileVersion = $ver
    minimized = [OsOpener.Native]::IsIconic($h)
    foreground = ($fg -eq $h)
  }
}

function Resolve-Hwnd {
  if ($Hwnd -ne 0) { return [IntPtr]$Hwnd }
  $p = Get-StudioProcess
  if (-not $p) { Fail "STUDIO_NOT_FOUND" "ServiceStudio.exe is not running or has no main window." }
  return $p.MainWindowHandle
}

function Get-RootElement([IntPtr]$h) {
  $el = [System.Windows.Automation.AutomationElement]::FromHandle($h)
  if (-not $el) { Fail "UIA_ELEMENT_NOT_FOUND" "UIA could not wrap window handle $h." }
  $el
}

function Get-Rect($el) {
  try {
    $r = $el.Current.BoundingRectangle
    if ([double]::IsInfinity($r.X) -or [double]::IsInfinity($r.Width)) { return $null }
    return @{ x = [int]$r.X; y = [int]$r.Y; w = [int]$r.Width; h = [int]$r.Height }
  } catch { return $null }
}

function Describe-Element($el, $depth, $path) {
  $c = $el.Current
  @{
    depth = $depth; path = $path
    controlType = $c.ControlType.ProgrammaticName -replace '^ControlType\.', ''
    name = $c.Name; automationId = $c.AutomationId; className = $c.ClassName
    rect = (Get-Rect $el)
    offscreen = $c.IsOffscreen; enabled = $c.IsEnabled; nativeHwnd = [int64]$c.NativeWindowHandle
    patterns = @(($el.GetSupportedPatterns() | ForEach-Object { $_.ProgrammaticName -replace 'PatternIdentifiers\.Pattern$', '' }))
  }
}

# Breadth-limited DFS over the raw view (control view hides some WPF items; raw shows everything).
function Walk-Tree($root, $maxDepth, $visitor) {
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $script:nodeCount = 0
  function Recurse($el, $depth, $path) {
    if ($script:nodeCount -ge $MaxNodes) { return }
    $script:nodeCount++
    $stop = & $visitor $el $depth $path
    if ($stop -eq $true) { return $true }
    if ($depth -ge $maxDepth) { return }
    $child = $null
    try { $child = $walker.GetFirstChild($el) } catch { return }
    $i = 0
    while ($child) {
      $r = Recurse $child ($depth + 1) "$path/$i"
      if ($r -eq $true) { return $true }
      $i++
      try { $child = $walker.GetNextSibling($child) } catch { break }
    }
  }
  Recurse $root 0 "0" | Out-Null
}

function Find-Elements($root, $maxDepth) {
  $found = New-Object System.Collections.ArrayList
  $nameRe = $Name; $idRe = $AutomationId; $ct = $ControlType
  Walk-Tree $root $maxDepth {
    param($el, $depth, $path)
    $c = $el.Current
    $ok = $true
    if ($nameRe) { if (-not ($c.Name -match $nameRe)) { $ok = $false } }
    if ($idRe) { if (-not ($c.AutomationId -match $idRe)) { $ok = $false } }
    if ($ct) { if (($c.ControlType.ProgrammaticName -replace '^ControlType\.', '') -ne $ct) { $ok = $false } }
    if ($ok -and ($nameRe -or $idRe -or $ct)) { [void]$found.Add(@{ el = $el; depth = $depth; path = $path }) }
    return $false
  }
  return $found
}


# --- Module tabs (open -> stage -> close loop, 2026-10-30) ------------------------------------
# A module tab is a TabItem whose visible label is a descendant TextBlock, e.g.
# "myapp (MyApp_Portal_UI)". Its close (x) is a Button child of the TabItem, which
# Assert-ClickAllowed deliberately refuses for every other command; `tab-close` is the one caller
# allowed to click it, and only after the save-prompt guards have passed.
function Get-TabLabel($el) {
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $label = ''
  $child = $null
  try { $child = $walker.GetFirstChild($el) } catch { return $label }
  while ($child) {
    $c = $child.Current
    if (($c.ControlType.ProgrammaticName -replace '^ControlType\.', '') -eq 'Text' -and $c.Name) { $label = $c.Name; break }
    try { $child = $walker.GetNextSibling($child) } catch { break }
  }
  return $label
}

function Get-TabCloseButton($el) {
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $child = $null
  try { $child = $walker.GetFirstChild($el) } catch { return $null }
  while ($child) {
    $c = $child.Current
    if (($c.ControlType.ProgrammaticName -replace '^ControlType\.', '') -eq 'Button') { return $child }
    try { $child = $walker.GetNextSibling($child) } catch { break }
  }
  return $null
}

function Find-TabItems($root, $maxDepth) {
  $tabs = New-Object System.Collections.ArrayList
  Walk-Tree $root $maxDepth {
    param($el, $depth, $path)
    $c = $el.Current
    if (($c.ControlType.ProgrammaticName -replace '^ControlType\.', '') -eq 'TabItem') {
      [void]$tabs.Add(@{ el = $el; depth = $depth; path = $path; label = (Get-TabLabel $el) })
    }
    return $false
  }
  return $tabs
}

function Assert-NoUnsavedDialog {
  $fg = [OsOpener.Native]::GetForegroundWindow()
  $t = Get-WindowTitle $fg
  if ($t -match '(?i)save|unsaved') {
    Fail "UNSAVED_CHANGES_DIALOG" "Foreground window title matches /save|unsaved/i; refusing to send input." @{ foregroundTitle = $t }
  }
}

# Audit item 3: every input-sending path requires the foreground window to belong to the Studio process.
function Assert-StudioForeground {
  $fg = [OsOpener.Native]::GetForegroundWindow()
  $fgPid = 0
  [void][OsOpener.Native]::GetWindowThreadProcessId($fg, [ref]$fgPid)
  $studio = Get-Process -Name $PROCESS_NAME -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $studio -or $fgPid -ne $studio.Id) {
    Fail "STUDIO_NOT_FOREGROUND" "Foreground window belongs to pid $fgPid, not Service Studio; refusing to send input." @{ foregroundTitle = (Get-WindowTitle $fg) }
  }
}

# Audit item 2: a Button inside a TabItem is a tab's close (x); never click it.
function Test-TabItemDescendant($el) {
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $p = $null
  try { $p = $walker.GetParent($el) } catch { return $false }
  $hops = 0
  while ($p -and $hops -lt 12) {
    try {
      if ($p.Current.ControlType.ProgrammaticName -eq 'ControlType.TabItem') { return $true }
      $p = $walker.GetParent($p)
    } catch { return $false }
    $hops++
  }
  return $false
}

function Assert-ClickAllowed($el, $d) {
  if ($d.name -match $FORBIDDEN_CLICK_NAME) { Fail "FORBIDDEN_CONTROL" "Refusing to click element named '$($d.name)' (name deny-list)." @{ element = $d } }
  if ($d.automationId -match $FORBIDDEN_CLICK_ID) { Fail "FORBIDDEN_CONTROL" "Refusing to click element with AutomationId '$($d.automationId)' (id deny-list)." @{ element = $d } }
  if ($d.controlType -eq 'Button' -and (Test-TabItemDescendant $el)) { Fail "FORBIDDEN_CONTROL" "Refusing to click a Button inside a TabItem (tab close)." @{ element = $d } }
}

# Audit item 7: send-keys allow-list. Only ^o, {ENTER}, {ESC}, or a literal whose only special chars are brace-escaped.
function Test-KeysAllowed([string]$k) {
  if ($k -eq '^o' -or $k -eq '{ENTER}' -or $k -eq '{ESC}') { return $true }
  $stripped = $k -replace '\{[^{}]+\}', ''
  return ($stripped -notmatch '[%^+~(){}]')
}

function Click-Centre($rect) {
  if (-not $rect) { return $false }
  $x = $rect.x + [int]($rect.w / 2); $y = $rect.y + [int]($rect.h / 2)
  [void][OsOpener.Native]::SetCursorPos($x, $y)
  Start-Sleep -Milliseconds 40
  [OsOpener.Native]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)  # LEFTDOWN
  [OsOpener.Native]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)  # LEFTUP
  return $true
}

function Invoke-Element($el) {
  $used = $null
  $pats = @($el.GetSupportedPatterns() | ForEach-Object { $_.ProgrammaticName })
  try {
    if ($pats -contains 'InvokePatternIdentifiers.Pattern') {
      $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke(); $used = 'Invoke'
    } elseif ($pats -contains 'ExpandCollapsePatternIdentifiers.Pattern') {
      $el.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern).Expand(); $used = 'ExpandCollapse'
    } elseif ($pats -contains 'TogglePatternIdentifiers.Pattern') {
      $el.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern).Toggle(); $used = 'Toggle'
    } elseif ($pats -contains 'SelectionItemPatternIdentifiers.Pattern') {
      $el.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select(); $used = 'SelectionItem'
    }
  } catch { $used = $null }
  if (-not $used) {
    if (Click-Centre (Get-Rect $el)) { $used = 'MouseClick' }
  }
  return $used
}

$sw = [System.Diagnostics.Stopwatch]::StartNew()

switch ($Command) {

  "find-window" {
    $info = Get-StudioInfo
    $info.ok = $true
    Out-Json $info
  }

  "file-version" {
    if (-not $ExePath) { Fail "BAD_ARGS" "-ExePath required" }
    if (-not (Test-Path $ExePath)) { Fail "STUDIO_NOT_FOUND" "No file at $ExePath" }
    Out-Json @{ ok = $true; exePath = $ExePath; fileVersion = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($ExePath).FileVersion }
  }

  "launch" {
    $existing = Get-StudioInfo
    if ($existing.running -and $existing.hasMainWindow) { $existing.ok = $true; $existing.launched = $false; Out-Json $existing; exit 0 }
    if (-not $ExePath) { Fail "BAD_ARGS" "-ExePath required when Studio is not running" }
    if (-not (Test-Path $ExePath)) { Fail "STUDIO_NOT_FOUND" "No file at $ExePath" }
    if (-not $existing.running) { [void](Start-Process -FilePath $ExePath -PassThru) }
    $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
    while ([DateTime]::UtcNow -lt $deadline) {
      $info = Get-StudioInfo
      if ($info.running -and $info.hasMainWindow -and $info.title) { $info.ok = $true; $info.launched = $true; $info.ms = $sw.ElapsedMilliseconds; Out-Json $info; exit 0 }
      Start-Sleep -Milliseconds 500
    }
    Fail "OPEN_TIMEOUT" "Studio main window did not appear within $TimeoutMs ms."
  }

  "focus" {
    $h = Resolve-Hwnd
    if ([OsOpener.Native]::IsIconic($h)) { [void][OsOpener.Native]::ShowWindow($h, 9) }  # SW_RESTORE
    # Attach to the foreground thread so SetForegroundWindow is allowed from a background process.
    $fg = [OsOpener.Native]::GetForegroundWindow()
    $fgPid = 0
    $fgTid = [OsOpener.Native]::GetWindowThreadProcessId($fg, [ref]$fgPid)
    $me = [OsOpener.Native]::GetCurrentThreadId()
    $attached = $false
    if ($fgTid -ne 0 -and $fgTid -ne $me) { $attached = [OsOpener.Native]::AttachThreadInput($me, $fgTid, $true) }
    [void][OsOpener.Native]::SetForegroundWindow($h)
    if ($attached) { [void][OsOpener.Native]::AttachThreadInput($me, $fgTid, $false) }
    Start-Sleep -Milliseconds 150
    $info = Get-StudioInfo
    $info.ok = $true
    $info.ms = $sw.ElapsedMilliseconds
    Out-Json $info
  }

  "enum-windows" {
    # Every top-level window owned by the Studio process (popups/dialogs are separate Avalonia windows).
    $studio = Get-Process -Name $PROCESS_NAME -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $studio) { Fail "STUDIO_NOT_FOUND" "ServiceStudio.exe is not running." }
    $desktop = [System.Windows.Automation.AutomationElement]::RootElement
    $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, [int]$studio.Id)
    $wins = $desktop.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)
    $winList = New-Object System.Collections.ArrayList
    foreach ($w in $wins) {
      $d = Describe-Element $w 0 "top"
      $d.isMain = ($d.nativeHwnd -eq [int64]$studio.MainWindowHandle)
      [void]$winList.Add($d)
    }
    Out-Json @{ ok = $true; pid = $studio.Id; count = $winList.Count; ms = $sw.ElapsedMilliseconds; windows = $winList }
  }

  "foreground-title" {
    $fg = [OsOpener.Native]::GetForegroundWindow()
    $fgPid = 0
    [void][OsOpener.Native]::GetWindowThreadProcessId($fg, [ref]$fgPid)
    $studio = Get-StudioProcess
    Out-Json @{
      ok = $true; hwnd = [int64]$fg; title = (Get-WindowTitle $fg); className = (Get-WindowClass $fg); pid = $fgPid
      isStudio = ($studio -and $fgPid -eq $studio.Id)
      isStudioMain = ($studio -and $fg -eq $studio.MainWindowHandle)
    }
  }

  "uia-dump" {
    $h = Resolve-Hwnd
    $root = Get-RootElement $h
    $nodes = New-Object System.Collections.ArrayList
    Walk-Tree $root $Depth {
      param($el, $depth, $path)
      [void]$nodes.Add((Describe-Element $el $depth $path))
      return $false
    }
    if ($AsText) {
      foreach ($n in $nodes) {
        $r = if ($n.rect) { "[$($n.rect.x),$($n.rect.y) $($n.rect.w)x$($n.rect.h)]" } else { "[offscreen]" }
        $line = ("  " * $n.depth) + "$($n.controlType) hwnd=$($n.nativeHwnd) name='$($n.name)' id='$($n.automationId)' class='$($n.className)' $r pats=$($n.patterns -join ',')"
        [Console]::Out.WriteLine($line)
      }
      [Console]::Out.WriteLine("# nodes=$($nodes.Count) depth=$Depth truncated=$($script:nodeCount -ge $MaxNodes) ms=$($sw.ElapsedMilliseconds)")
    } else {
      Out-Json @{ ok = $true; hwnd = [int64]$h; count = $nodes.Count; truncated = ($script:nodeCount -ge $MaxNodes); ms = $sw.ElapsedMilliseconds; nodes = $nodes }
    }
  }

  "uia-find" {
    if (-not $Name -and -not $AutomationId -and -not $ControlType) { Fail "BAD_ARGS" "-Name, -AutomationId or -ControlType required" }
    $h = Resolve-Hwnd
    $root = Get-RootElement $h
    $found = Find-Elements $root $Depth
    $matchList = @($found | ForEach-Object { Describe-Element $_.el $_.depth $_.path })
    Out-Json @{ ok = $true; count = $matchList.Count; ms = $sw.ElapsedMilliseconds; matches = $matchList }
  }

  "uia-click" {
    if (-not $Name -and -not $AutomationId) { Fail "BAD_ARGS" "-Name or -AutomationId required" }
    Assert-NoUnsavedDialog
    Assert-StudioForeground
    $h = Resolve-Hwnd
    $root = Get-RootElement $h
    $found = Find-Elements $root $Depth
    $target = $found | Where-Object { -not $_.el.Current.IsOffscreen } | Select-Object -First 1
    if (-not $target) { $target = $found | Select-Object -First 1 }
    if (-not $target) { Fail "UIA_ELEMENT_NOT_FOUND" "No UIA element matched name=/$Name/ automationId=/$AutomationId/ controlType=$ControlType within depth $Depth." }
    $d = Describe-Element $target.el $target.depth $target.path
    Assert-ClickAllowed $target.el $d
    $used = Invoke-Element $target.el
    Out-Json @{ ok = ($used -ne $null); method = $used; element = $d; candidates = $found.Count; ms = $sw.ElapsedMilliseconds }
  }

  "uia-settext" {
    if ($null -eq $Text) { Fail "BAD_ARGS" "-Text required" }
    Assert-NoUnsavedDialog
    $h = Resolve-Hwnd
    $root = Get-RootElement $h
    if ($First -and -not $Name -and -not $AutomationId) { $ControlType = "Edit" }
    $found = Find-Elements $root $Depth
    $target = $found | Where-Object { -not $_.el.Current.IsOffscreen -and $_.el.Current.IsEnabled } | Select-Object -First 1
    if (-not $target) { Fail "UIA_ELEMENT_NOT_FOUND" "No editable UIA element matched name=/$Name/ automationId=/$AutomationId/ controlType=$ControlType." }
    $d = Describe-Element $target.el $target.depth $target.path
    $method = $null
    try {
      $vp = $target.el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
      if (-not $vp.Current.IsReadOnly) { $vp.SetValue($Text); $method = "ValuePattern" }
    } catch { $method = $null }
    if (-not $method) {
      Assert-StudioForeground
      try { $target.el.SetFocus() } catch {}
      Start-Sleep -Milliseconds 100
      [System.Windows.Forms.SendKeys]::SendWait("^a")
      [System.Windows.Forms.SendKeys]::SendWait([regex]::Replace($Text, '([+^%~(){}\[\]])', '{$1}'))
      $method = "SendKeys"
    }
    Out-Json @{ ok = $true; method = $method; element = $d; ms = $sw.ElapsedMilliseconds }
  }

  "send-keys" {
    if (-not $Keys) { Fail "BAD_ARGS" "-Keys required" }
    if (-not (Test-KeysAllowed $Keys)) { Fail "FORBIDDEN_KEYS" "Key sequence not on the allow-list (^o, {ENTER}, {ESC}, or a brace-escaped literal)." }
    Assert-NoUnsavedDialog
    Assert-StudioForeground
    [System.Windows.Forms.SendKeys]::SendWait($Keys)
    Out-Json @{ ok = $true; keys = $Keys; ms = $sw.ElapsedMilliseconds }
  }

  "tab-list" {
    $h = Resolve-Hwnd
    $root = Get-RootElement $h
    $tabs = Find-TabItems $root $Depth
    # NB: not $out — that collides with the script's -Out parameter (a [string]).
    $tabInfo = New-Object System.Collections.ArrayList
    foreach ($t in $tabs) {
      $c = $t.el.Current
      [void]$tabInfo.Add(@{ label = $t.label; path = $t.path; offscreen = [bool]$c.IsOffscreen; rect = (Get-Rect $t.el); hasClose = ((Get-TabCloseButton $t.el) -ne $null) })
    }
    Out-Json @{ ok = $true; count = $tabInfo.Count; tabs = $tabInfo.ToArray(); ms = $sw.ElapsedMilliseconds }
  }

  "tab-close" {
    if (-not $Name) { Fail "BAD_ARGS" "-Name required (regex matched against the tab label)" }
    Assert-NoUnsavedDialog
    Assert-StudioForeground
    $h = Resolve-Hwnd
    $root = Get-RootElement $h
    $tabs = Find-TabItems $root $Depth
    $match = @($tabs | Where-Object { $_.label -match $Name })
    if ($match.Count -eq 0) { Fail "UIA_ELEMENT_NOT_FOUND" "No module tab label matched /$Name/." @{ labels = @($tabs | ForEach-Object { $_.label }) } }
    if ($match.Count -gt 1) { Fail "BAD_ARGS" "/$Name/ matched $($match.Count) tabs; refusing to guess." @{ labels = @($match | ForEach-Object { $_.label }) } }
    $tab = $match[0]
    # Bring it into view and select it, so the close button is realised and the right module closes.
    try { $tab.el.GetCurrentPattern([System.Windows.Automation.ScrollItemPattern]::Pattern).ScrollIntoView() } catch {}
    try { $tab.el.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select() } catch {}
    Start-Sleep -Milliseconds 250
    $btn = Get-TabCloseButton $tab.el
    if (-not $btn) { Fail "UIA_ELEMENT_NOT_FOUND" "Tab '$($tab.label)' exposes no close button." }
    $d = Describe-Element $btn 0 "$($tab.path)/close"
    # The name/id deny-lists still apply; only the "Button inside a TabItem" rule is waived here.
    if ($d.name -match $FORBIDDEN_CLICK_NAME) { Fail "FORBIDDEN_CONTROL" "Refusing to click element named '$($d.name)' (name deny-list)." @{ element = $d } }
    if ($d.automationId -match $FORBIDDEN_CLICK_ID) { Fail "FORBIDDEN_CONTROL" "Refusing to click element with AutomationId '$($d.automationId)' (id deny-list)." @{ element = $d } }
    $used = Invoke-Element $btn
    Start-Sleep -Milliseconds 400
    # A module with unsaved changes answers with a save prompt. Never answer it: Esc cancels the
    # close and keeps the changes, then report. The module stays open.
    $fgTitle = Get-WindowTitle ([OsOpener.Native]::GetForegroundWindow())
    if ($fgTitle -match '(?i)save|unsaved') {
      [System.Windows.Forms.SendKeys]::SendWait('{ESC}')
      Fail "UNSAVED_CHANGES_DIALOG" "Closing '$($tab.label)' raised '$fgTitle'; cancelled with Esc and left the module open." @{ foregroundTitle = $fgTitle; label = $tab.label }
    }
    Out-Json @{ ok = ($used -ne $null); method = $used; label = $tab.label; element = $d; ms = $sw.ElapsedMilliseconds }
  }

  "screenshot" {
    if (-not $Out) { Fail "BAD_ARGS" "-Out required" }
    $dir = Split-Path -Parent $Out
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
    $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
    Out-Json @{ ok = $true; path = (Resolve-Path $Out).Path; width = $b.Width; height = $b.Height; ms = $sw.ElapsedMilliseconds }
  }

  default { Fail "BAD_ARGS" "Unknown command '$Command'." }
}
