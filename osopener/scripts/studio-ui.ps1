<#
.SYNOPSIS
  osopener desktop helper (Windows PowerShell 5.1, .NET System.Windows.Automation).

  One sub-command per invocation; prints exactly ONE JSON line on stdout.
  Node spawns it as:
    powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File studio-ui.ps1 <cmd> [options]

  Sub-commands (all read-only unless marked):
    find-window                      Service Studio process + main window (pid, hwnd, title, exePath, fileVersion, minimized)
    launch [-ExePath p]              (writes) start ServiceStudio.exe, wait for its main window
    restore                          (writes) un-minimize the Studio main window WITHOUT activating it (no focus change)
    focus [-Hwnd h]                  (writes) restore + SetForegroundWindow on the Studio main window (or -Hwnd);
                                     reports `previous` = the window that had the foreground before, for `refocus`
    refocus -Hwnd h [-IfStudio]      (writes) give the foreground back to h (the user's window after a brief focus);
                                     -IfStudio: only when a Studio window holds the foreground right now
    foreground-title                 title/class/pid of the current foreground window
    studio-dialog                    the topmost visible Studio window that is not a module window (a dialog/progress
                                     popup), found by enumerating Studio's windows — independent of the foreground
    uia-dump [-Depth n] [-Hwnd h] [-AsText] UIA tree of the Studio main window (or -Hwnd); JSON array or -AsText lines
    uia-find -Name re | -AutomationId re [-ControlType t] [-Hwnd h] [-Depth n]
                                     elements whose Name / AutomationId match the regex (no click)
    uia-click (-Name re | -AutomationId re) [-ControlType t] [-Hwnd h] [-Depth n] [-Post]
                                     (writes) Invoke / Expand / Toggle / Select pattern, else a POSTED click
                                     (WM_LBUTTONDOWN/UP to the element's window); -Post forces the posted click
    uia-settext -Text t (-Name re | -AutomationId re | -First Edit) [-Hwnd h]
                                     (writes) ValuePattern.SetValue on an Edit; falls back to focus + type ONLY when
                                     Studio already owns the foreground
    send-keys -Keys k                (writes) System.Windows.Forms.SendKeys.SendWait (never Alt+F4); needs Studio in front
    cancel-save-prompt              (writes) invoke only the exact Cancel button on one verified Studio save dialog
    dismiss [-Hwnd h]                (writes) close a Studio dialog h with WindowPattern.Close, or (no -Hwnd) close an
                                     open shell dropdown with a posted click on its Toggle — never a keystroke
    tab-list                         list module tabs (label, offscreen, hasClose)
    tab-close -Name <regex>          close the module tab whose label matches (never answers a save prompt)
    screenshot -Out path [-Hwnd h]   capture window h with PrintWindow (works behind other windows), else primary screen
    file-version -ExePath p          FileVersion of an exe

  BACKGROUND OPERATION (2026-11-20, live on 11.55.97.65412): nothing here moves the user's cursor. Clicks are
  UIA patterns or posted window messages; only send-keys and the SendKeys fallback of uia-settext need Studio in
  the foreground, and both refuse (STUDIO_NOT_FOREGROUND) rather than type into someone else's window.

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
  [switch]$AsText,
  [switch]$Post,
  [switch]$IfStudio,
  [switch]$TakeFocus,
  [string]$Then,
  [int]$ThenDelayMs = 700
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
[DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
[DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
[DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr hWnd, bool fAltTab);
[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
[DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
[DllImport("user32.dll")] public static extern bool ScreenToClient(IntPtr hWnd, ref POINT p);
[DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
public struct POINT { public int X; public int Y; }
public struct RECT { public int Left, Top, Right, Bottom; }
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
  # Fast path (live 2026-11-20): with ~20 modules open the scripted walk hits MaxNodes long before it reaches the
  # dropdown's popup, so `-ControlType MenuItem` answered 0 after a minute and the open fell back to Ctrl+O. When the
  # query names a control type or an exact AutomationId, let UIA's native FindAll filter instead (depth unbounded).
  $exactId = $null
  if ($idRe -match '^\^([A-Za-z0-9_]+)\$$') { $exactId = $Matches[1] }
  if ($ct -or $exactId) {
    $conds = New-Object System.Collections.ArrayList
    if ($ct) {
      $ctObj = [System.Windows.Automation.ControlType]::$ct
      if ($ctObj) { [void]$conds.Add((New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, $ctObj))) }
    }
    if ($exactId) { [void]$conds.Add((New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, $exactId))) }
    if ($conds.Count -gt 0) {
      $cond = if ($conds.Count -eq 1) { $conds[0] } else { New-Object System.Windows.Automation.AndCondition(@($conds.ToArray([System.Windows.Automation.Condition]))) }
      $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
      $i = 0
      foreach ($el in $all) {
        $c = $el.Current
        $ok = $true
        if ($nameRe) { if (-not ($c.Name -match $nameRe)) { $ok = $false } }
        if ($idRe) { if (-not ($c.AutomationId -match $idRe)) { $ok = $false } }
        if ($ok) { [void]$found.Add(@{ el = $el; depth = -1; path = "find/$i" }) }
        $i++
      }
      return $found
    }
  }
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

# Every visible top-level Studio window that is not a module window, topmost first (EnumWindows walks the z-order).
# Module windows (the main one and the extra AggregatorWindows Studio opens past ~30 modules) all carry the main
# window's title; dialogs ("Open from Environment", "Progress", save prompts) carry their own. Unlike the foreground
# window, this does not change when the user clicks somewhere else, so it works while Studio is in the background.
function Get-StudioDialogs {
  $p = Get-StudioProcess
  if (-not $p) { return @() }
  $mainTitle = Get-WindowTitle $p.MainWindowHandle
  $script:dlgPid = [uint32]$p.Id
  $script:dlgList = New-Object System.Collections.ArrayList
  $cb = [OsOpener.Native+EnumWindowsProc]{
    param($h, $l)
    $wp = 0
    [void][OsOpener.Native]::GetWindowThreadProcessId($h, [ref]$wp)
    if ($wp -eq $script:dlgPid -and [OsOpener.Native]::IsWindowVisible($h)) { [void]$script:dlgList.Add($h) }
    return $true
  }
  [void][OsOpener.Native]::EnumWindows($cb, [IntPtr]::Zero)
  $res = @()
  foreach ($h in $script:dlgList) {
    if ($h -eq $p.MainWindowHandle) { continue }
    $t = Get-WindowTitle $h
    if ($t -eq $mainTitle) { continue }
    # The shell dropdown is its own top-level, blank-titled Avalonia `PopupRoot` window (live 2026-11-20). It is
    # not a dialog — counting it as a blank-titled "transient" window made openModule wait 60 s for it to go away.
    if (-not $t) {
      $cn = $null
      try { $cn = [System.Windows.Automation.AutomationElement]::FromHandle($h).Current.ClassName } catch {}
      if ($cn -eq 'PopupRoot') { continue }
    }
    $res += , @{ hwnd = [int64]$h; title = $t; className = (Get-WindowClass $h) }
  }
  return $res
}

function Assert-NoUnsavedDialog {
  foreach ($d in (Get-StudioDialogs)) {
    if ($d.title -match '(?i)save|unsaved') {
      Fail "UNSAVED_CHANGES_DIALOG" "A Studio window titled '$($d.title)' is open; refusing to send input." @{ foregroundTitle = $d.title; dialogHwnd = $d.hwnd }
    }
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

# A click that never touches the real mouse: WM_MOUSEMOVE + WM_LBUTTONDOWN/UP posted to the window that hosts the
# element, at the element's centre in that window's client coordinates. Avalonia hit-tests the message's own
# coordinates, so the user's cursor, the foreground window and any window covering Studio are all irrelevant.
# Live 2026-11-20 (11.55.97.65412): opens the shell dropdown, clicks `Open from Environment...` and recent-module
# entries (Avalonia MenuItems expose no Invoke pattern) with the cursor unmoved and the user's window still in front.
function Post-Click($el) {
  $r = Get-Rect $el
  if (-not $r) { return $false }
  $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
  $anc = $el
  while ($anc -and $anc.Current.NativeWindowHandle -eq 0) {
    try { $anc = $walker.GetParent($anc) } catch { $anc = $null }
  }
  if (-not $anc) { return $false }
  $hw = [IntPtr]$anc.Current.NativeWindowHandle
  $pt = New-Object OsOpener.Native+POINT
  $pt.X = $r.x + [int]($r.w / 2); $pt.Y = $r.y + [int]($r.h / 2)
  if (-not [OsOpener.Native]::ScreenToClient($hw, [ref]$pt)) { return $false }
  $l = [IntPtr]((($pt.Y -band 0xFFFF) -shl 16) -bor ($pt.X -band 0xFFFF))
  [void][OsOpener.Native]::PostMessage($hw, 0x0200, [IntPtr]0, $l)  # WM_MOUSEMOVE
  Start-Sleep -Milliseconds 40
  [void][OsOpener.Native]::PostMessage($hw, 0x0201, [IntPtr]1, $l)  # WM_LBUTTONDOWN (MK_LBUTTON)
  Start-Sleep -Milliseconds 40
  [void][OsOpener.Native]::PostMessage($hw, 0x0202, [IntPtr]0, $l)  # WM_LBUTTONUP
  return $true
}

function Invoke-Element($el, [bool]$forcePost = $false) {
  if ($forcePost) {
    if (Post-Click $el) { return 'PostedClick' }
    return $null
  }
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
    if (Post-Click $el) { $used = 'PostedClick' }
  }
  return $used
}

# Hands the foreground to $target. Windows only lets the foreground process do that, so attach to its input queue
# for the call. Returns the window that had the foreground before (0 when none).
function Set-Foreground([IntPtr]$target) {
  $fg = [OsOpener.Native]::GetForegroundWindow()
  $fgPid = 0
  $fgTid = [OsOpener.Native]::GetWindowThreadProcessId($fg, [ref]$fgPid)
  $tgtPid = 0
  $tgtTid = [OsOpener.Native]::GetWindowThreadProcessId($target, [ref]$tgtPid)
  $me = [OsOpener.Native]::GetCurrentThreadId()
  # Windows refuses SetForegroundWindow from a process that did not just receive input. Escalate until it sticks:
  # 1) attach to the foreground thread; 2) also to the target's thread + BringWindowToTop; 3) the synthetic-Alt trick
  # (a keyboard event makes this process the "last input" owner, which is what the foreground lock checks).
  for ($attempt = 1; $attempt -le 3; $attempt++) {
    $a1 = $false; $a2 = $false
    if ($fgTid -ne 0 -and $fgTid -ne $me) { $a1 = [OsOpener.Native]::AttachThreadInput($me, $fgTid, $true) }
    if ($attempt -ge 2 -and $tgtTid -ne 0 -and $tgtTid -ne $me -and $tgtTid -ne $fgTid) { $a2 = [OsOpener.Native]::AttachThreadInput($me, $tgtTid, $true) }
    if ($attempt -ge 3) {
      [OsOpener.Native]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)   # VK_MENU down
      [OsOpener.Native]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)   # VK_MENU up
    }
    [void][OsOpener.Native]::BringWindowToTop($target)
    [void][OsOpener.Native]::SetForegroundWindow($target)
    if ($a2) { [void][OsOpener.Native]::AttachThreadInput($me, $tgtTid, $false) }
    if ($a1) { [void][OsOpener.Native]::AttachThreadInput($me, $fgTid, $false) }
    Start-Sleep -Milliseconds 80
    if ([OsOpener.Native]::GetForegroundWindow() -eq $target) { break }
  }
  return $fg
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
    $prev = Set-Foreground $h
    Start-Sleep -Milliseconds 150
    $prevPid = 0
    [void][OsOpener.Native]::GetWindowThreadProcessId($prev, [ref]$prevPid)
    $sp = Get-StudioProcess
    $info = Get-StudioInfo
    $info.ok = $true
    $info.previous = [int64]$prev
    $info.previousIsStudio = ($sp -and $prevPid -eq $sp.Id)
    $info.targetForeground = ([OsOpener.Native]::GetForegroundWindow() -eq $h)
    $info.ms = $sw.ElapsedMilliseconds
    Out-Json $info
  }

  "refocus" {
    if ($Hwnd -eq 0) { Fail "BAD_ARGS" "-Hwnd required" }
    $h = [IntPtr]$Hwnd
    if (-not [OsOpener.Native]::IsWindow($h)) { Out-Json @{ ok = $true; restored = $false; reason = "window gone" }; exit 0 }
    if ($IfStudio) {
      # Only take the foreground back from Studio: never pull the user away from another app they moved to.
      $fgPid = 0
      [void][OsOpener.Native]::GetWindowThreadProcessId([OsOpener.Native]::GetForegroundWindow(), [ref]$fgPid)
      $sp = Get-StudioProcess
      if (-not ($sp -and $fgPid -eq $sp.Id)) { Out-Json @{ ok = $true; restored = $false; reason = "foreground is not Studio" }; exit 0 }
    }
    [void](Set-Foreground $h)
    Start-Sleep -Milliseconds 50
    Out-Json @{ ok = $true; restored = ([OsOpener.Native]::GetForegroundWindow() -eq $h); ms = $sw.ElapsedMilliseconds }
  }

  "restore" {
    $h = Resolve-Hwnd
    $was = [OsOpener.Native]::IsIconic($h)
    if ($was) { [void][OsOpener.Native]::ShowWindow($h, 4) }  # SW_SHOWNOACTIVATE: visible again, focus untouched
    $info = Get-StudioInfo
    $info.ok = $true; $info.restored = $was; $info.ms = $sw.ElapsedMilliseconds
    Out-Json $info
  }

  "studio-dialog" {
    # Same shape as foreground-title, so callers can swap one for the other: the topmost Studio dialog when one is
    # up, else the main window.
    $p = Get-StudioProcess
    if (-not $p) { Fail "STUDIO_NOT_FOUND" "ServiceStudio.exe is not running or has no main window." }
    $d = @(Get-StudioDialogs)
    if ($d.Count -gt 0) {
      Out-Json @{ ok = $true; hwnd = $d[0].hwnd; title = $d[0].title; className = $d[0].className; pid = $p.Id; isStudio = $true; isStudioMain = $false; count = $d.Count; dialogs = $d }
    } else {
      Out-Json @{ ok = $true; hwnd = [int64]$p.MainWindowHandle; title = (Get-WindowTitle $p.MainWindowHandle); pid = $p.Id; isStudio = $true; isStudioMain = $true; count = 0 }
    }
  }


  "cancel-save-prompt" {
    # Used ONLY when the caller explicitly opts into safe OSGraph recovery. Unlike generic dismiss, this command
    # can operate on a verified save prompt, but it may click ONLY the exact Cancel button. It never saves,
    # discards changes, closes a modified module tab, sends keys, or selects a default action.
    $candidates = New-Object System.Collections.ArrayList
    foreach ($dialog in @(Get-StudioDialogs)) {
      $h = [IntPtr]$dialog.hwnd
      if (-not [OsOpener.Native]::IsWindow($h)) { continue }
      $root = Get-RootElement $h
      $Name = '(?i)^(save|don.?t save)
    $p = Get-StudioProcess
    if (-not $p) { Fail "STUDIO_NOT_FOUND" "ServiceStudio.exe is not running or has no main window." }
    if ($Hwnd -ne 0 -and [IntPtr]$Hwnd -ne $p.MainWindowHandle) {
      $h = [IntPtr]$Hwnd
      if (-not [OsOpener.Native]::IsWindow($h)) { Out-Json @{ ok = $true; method = "already-gone" }; exit 0 }
      $t = Get-WindowTitle $h
      if ($t -match '(?i)save|unsaved') { Fail "UNSAVED_CHANGES_DIALOG" "Refusing to dismiss '$t': a save prompt is the user's to answer." @{ foregroundTitle = $t } }
      $el = Get-RootElement $h
      try { $el.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern).Close() } catch { Fail "UIA_ELEMENT_NOT_FOUND" "Window '$t' exposes no WindowPattern: $($_.Exception.Message)" }
      Out-Json @{ ok = $true; method = "WindowPattern.Close"; title = $t; ms = $sw.ElapsedMilliseconds }
      exit 0
    }
    # No dialog: close the shell dropdown if it is open. A posted click on its Toggle closes it the same way it opened.
    $root = Get-RootElement $p.MainWindowHandle
    $Name = $null; $AutomationId = '^Toggle$'; $ControlType = 'Button'
    $tg = @(Find-Elements $root 10) | Select-Object -First 1
    $state = $null
    if ($tg) { try { $state = [string]$tg.el.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern).Current.ToggleState } catch {} }
    if ($tg -and $state -eq 'On') {
      [void](Post-Click $tg.el)
      Out-Json @{ ok = $true; method = "toggle-posted-click"; ms = $sw.ElapsedMilliseconds }
    } else {
      Out-Json @{ ok = $true; method = "nothing-open"; ms = $sw.ElapsedMilliseconds }
    }
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
    # No foreground requirement any more: patterns and posted clicks both reach a background window.
    Assert-NoUnsavedDialog
    $h = Resolve-Hwnd
    $root = Get-RootElement $h
    $found = Find-Elements $root $Depth
    $target = $found | Where-Object { -not $_.el.Current.IsOffscreen } | Select-Object -First 1
    if (-not $target) { $target = $found | Select-Object -First 1 }
    if (-not $target) { Fail "UIA_ELEMENT_NOT_FOUND" "No UIA element matched name=/$Name/ automationId=/$AutomationId/ controlType=$ControlType within depth $Depth." }
    $d = Describe-Element $target.el $target.depth $target.path
    Assert-ClickAllowed $target.el $d
    $used = Invoke-Element $target.el ([bool]$Post)
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
    if ($Then -and -not (Test-KeysAllowed $Then)) { Fail "FORBIDDEN_KEYS" "-Then sequence not on the allow-list." }
    Assert-NoUnsavedDialog
    $prev = [IntPtr]::Zero
    if ($TakeFocus) {
      # Focus, type and (below) hand the foreground back inside ONE process: the window in which the user can click
      # away is milliseconds, not a second helper launch. The foreground guard still decides before every keystroke.
      if ($Hwnd -eq 0) { Fail "BAD_ARGS" "-Hwnd required with -TakeFocus" }
      $prev = Set-Foreground ([IntPtr]$Hwnd)
    }
    Assert-StudioForeground
    [System.Windows.Forms.SendKeys]::SendWait($Keys)
    if ($Then) {
      Start-Sleep -Milliseconds $ThenDelayMs
      Assert-StudioForeground
      [System.Windows.Forms.SendKeys]::SendWait($Then)
    }
    $back = $null
    if ($TakeFocus -and $prev -ne [IntPtr]::Zero) {
      $prevPid = 0
      [void][OsOpener.Native]::GetWindowThreadProcessId($prev, [ref]$prevPid)
      $sp = Get-StudioProcess
      if (-not ($sp -and $prevPid -eq $sp.Id) -and [OsOpener.Native]::IsWindow($prev)) {
        Start-Sleep -Milliseconds 150
        [void](Set-Foreground $prev)
        $back = ([OsOpener.Native]::GetForegroundWindow() -eq $prev)
      }
    }
    Out-Json @{ ok = $true; keys = $Keys; then = $Then; previous = [int64]$prev; returned = $back; ms = $sw.ElapsedMilliseconds }
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
    Start-Sleep -Milliseconds 600
    # A module with unsaved changes answers with a save prompt. Never answer it: cancel the close (which keeps the
    # changes) and report. The module stays open. The prompt is found among Studio's own windows, not as the
    # foreground, and cancelled through UIA (its Cancel button, else the window's own close = cancel), never by key.
    $prompt = @(Get-StudioDialogs) | Where-Object { $_.title -match '(?i)save|unsaved' } | Select-Object -First 1
    if (-not $prompt) {
      foreach ($dw in @(Get-StudioDialogs)) {
        $Name = '(?i)^(save|don.?t save)$'; $AutomationId = $null; $ControlType = 'Button'
        if (@(Find-Elements (Get-RootElement ([IntPtr]$dw.hwnd)) 12).Count -gt 0) { $prompt = $dw; break }
      }
    }
    if ($prompt) {
      $how = $null
      $proot = Get-RootElement ([IntPtr]$prompt.hwnd)
      $Name = '(?i)^cancel$'; $AutomationId = $null; $ControlType = 'Button'
      $cancel = @(Find-Elements $proot 12) | Select-Object -First 1
      if ($cancel) {
        try { $cancel.el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke(); $how = 'Cancel button' } catch {}
      }
      if (-not $how) {
        try { $proot.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern).Close(); $how = 'WindowPattern.Close' } catch {}
      }
      Fail "UNSAVED_CHANGES_DIALOG" "Closing '$($tab.label)' raised '$($prompt.title)'; cancelled ($how) and left the module open." @{ foregroundTitle = $prompt.title; label = $tab.label; cancelledWith = $how }
    }
    Out-Json @{ ok = ($used -ne $null); method = $used; label = $tab.label; element = $d; ms = $sw.ElapsedMilliseconds }
  }

  "screenshot" {
    if (-not $Out) { Fail "BAD_ARGS" "-Out required" }
    $dir = Split-Path -Parent $Out
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    if ($Hwnd -ne 0 -and [OsOpener.Native]::IsWindow([IntPtr]$Hwnd)) {
      # PrintWindow renders the window itself, so it works on any monitor and behind other windows.
      $wr = New-Object OsOpener.Native+RECT
      [void][OsOpener.Native]::GetWindowRect([IntPtr]$Hwnd, [ref]$wr)
      $bmp = New-Object System.Drawing.Bitmap ([Math]::Max(1, $wr.Right - $wr.Left)), ([Math]::Max(1, $wr.Bottom - $wr.Top))
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      $hdc = $g.GetHdc()
      [void][OsOpener.Native]::PrintWindow([IntPtr]$Hwnd, $hdc, 2)  # PW_RENDERFULLCONTENT
      $g.ReleaseHdc($hdc)
      $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
      $w = $bmp.Width; $hh = $bmp.Height
      $g.Dispose(); $bmp.Dispose()
      Out-Json @{ ok = $true; path = (Resolve-Path $Out).Path; width = $w; height = $hh; hwnd = $Hwnd; ms = $sw.ElapsedMilliseconds }
      exit 0
    }
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
; $AutomationId = $null; $ControlType = 'Button'
      $hasSaveChoices = (@(Find-Elements $root 12).Count -gt 0)
      if ($dialog.title -match '(?i)save|unsaved' -or $hasSaveChoices) {
        [void]$candidates.Add($dialog)
      }
    }
    if ($candidates.Count -ne 1) {
      Fail "UNSAVED_CHANGES_DIALOG" "Expected exactly one confirmed Studio save prompt; found $($candidates.Count). No dialog was touched." @{ count = $candidates.Count }
    }
    $prompt = $candidates[0]
    $h = [IntPtr]$prompt.hwnd
    $root = Get-RootElement $h
    $Name = '(?i)^cancel
    $p = Get-StudioProcess
    if (-not $p) { Fail "STUDIO_NOT_FOUND" "ServiceStudio.exe is not running or has no main window." }
    if ($Hwnd -ne 0 -and [IntPtr]$Hwnd -ne $p.MainWindowHandle) {
      $h = [IntPtr]$Hwnd
      if (-not [OsOpener.Native]::IsWindow($h)) { Out-Json @{ ok = $true; method = "already-gone" }; exit 0 }
      $t = Get-WindowTitle $h
      if ($t -match '(?i)save|unsaved') { Fail "UNSAVED_CHANGES_DIALOG" "Refusing to dismiss '$t': a save prompt is the user's to answer." @{ foregroundTitle = $t } }
      $el = Get-RootElement $h
      try { $el.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern).Close() } catch { Fail "UIA_ELEMENT_NOT_FOUND" "Window '$t' exposes no WindowPattern: $($_.Exception.Message)" }
      Out-Json @{ ok = $true; method = "WindowPattern.Close"; title = $t; ms = $sw.ElapsedMilliseconds }
      exit 0
    }
    # No dialog: close the shell dropdown if it is open. A posted click on its Toggle closes it the same way it opened.
    $root = Get-RootElement $p.MainWindowHandle
    $Name = $null; $AutomationId = '^Toggle$'; $ControlType = 'Button'
    $tg = @(Find-Elements $root 10) | Select-Object -First 1
    $state = $null
    if ($tg) { try { $state = [string]$tg.el.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern).Current.ToggleState } catch {} }
    if ($tg -and $state -eq 'On') {
      [void](Post-Click $tg.el)
      Out-Json @{ ok = $true; method = "toggle-posted-click"; ms = $sw.ElapsedMilliseconds }
    } else {
      Out-Json @{ ok = $true; method = "nothing-open"; ms = $sw.ElapsedMilliseconds }
    }
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
    # No foreground requirement any more: patterns and posted clicks both reach a background window.
    Assert-NoUnsavedDialog
    $h = Resolve-Hwnd
    $root = Get-RootElement $h
    $found = Find-Elements $root $Depth
    $target = $found | Where-Object { -not $_.el.Current.IsOffscreen } | Select-Object -First 1
    if (-not $target) { $target = $found | Select-Object -First 1 }
    if (-not $target) { Fail "UIA_ELEMENT_NOT_FOUND" "No UIA element matched name=/$Name/ automationId=/$AutomationId/ controlType=$ControlType within depth $Depth." }
    $d = Describe-Element $target.el $target.depth $target.path
    Assert-ClickAllowed $target.el $d
    $used = Invoke-Element $target.el ([bool]$Post)
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
    if ($Then -and -not (Test-KeysAllowed $Then)) { Fail "FORBIDDEN_KEYS" "-Then sequence not on the allow-list." }
    Assert-NoUnsavedDialog
    $prev = [IntPtr]::Zero
    if ($TakeFocus) {
      # Focus, type and (below) hand the foreground back inside ONE process: the window in which the user can click
      # away is milliseconds, not a second helper launch. The foreground guard still decides before every keystroke.
      if ($Hwnd -eq 0) { Fail "BAD_ARGS" "-Hwnd required with -TakeFocus" }
      $prev = Set-Foreground ([IntPtr]$Hwnd)
    }
    Assert-StudioForeground
    [System.Windows.Forms.SendKeys]::SendWait($Keys)
    if ($Then) {
      Start-Sleep -Milliseconds $ThenDelayMs
      Assert-StudioForeground
      [System.Windows.Forms.SendKeys]::SendWait($Then)
    }
    $back = $null
    if ($TakeFocus -and $prev -ne [IntPtr]::Zero) {
      $prevPid = 0
      [void][OsOpener.Native]::GetWindowThreadProcessId($prev, [ref]$prevPid)
      $sp = Get-StudioProcess
      if (-not ($sp -and $prevPid -eq $sp.Id) -and [OsOpener.Native]::IsWindow($prev)) {
        Start-Sleep -Milliseconds 150
        [void](Set-Foreground $prev)
        $back = ([OsOpener.Native]::GetForegroundWindow() -eq $prev)
      }
    }
    Out-Json @{ ok = $true; keys = $Keys; then = $Then; previous = [int64]$prev; returned = $back; ms = $sw.ElapsedMilliseconds }
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
    Start-Sleep -Milliseconds 600
    # A module with unsaved changes answers with a save prompt. Never answer it: cancel the close (which keeps the
    # changes) and report. The module stays open. The prompt is found among Studio's own windows, not as the
    # foreground, and cancelled through UIA (its Cancel button, else the window's own close = cancel), never by key.
    $prompt = @(Get-StudioDialogs) | Where-Object { $_.title -match '(?i)save|unsaved' } | Select-Object -First 1
    if (-not $prompt) {
      foreach ($dw in @(Get-StudioDialogs)) {
        $Name = '(?i)^(save|don.?t save)$'; $AutomationId = $null; $ControlType = 'Button'
        if (@(Find-Elements (Get-RootElement ([IntPtr]$dw.hwnd)) 12).Count -gt 0) { $prompt = $dw; break }
      }
    }
    if ($prompt) {
      $how = $null
      $proot = Get-RootElement ([IntPtr]$prompt.hwnd)
      $Name = '(?i)^cancel$'; $AutomationId = $null; $ControlType = 'Button'
      $cancel = @(Find-Elements $proot 12) | Select-Object -First 1
      if ($cancel) {
        try { $cancel.el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke(); $how = 'Cancel button' } catch {}
      }
      if (-not $how) {
        try { $proot.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern).Close(); $how = 'WindowPattern.Close' } catch {}
      }
      Fail "UNSAVED_CHANGES_DIALOG" "Closing '$($tab.label)' raised '$($prompt.title)'; cancelled ($how) and left the module open." @{ foregroundTitle = $prompt.title; label = $tab.label; cancelledWith = $how }
    }
    Out-Json @{ ok = ($used -ne $null); method = $used; label = $tab.label; element = $d; ms = $sw.ElapsedMilliseconds }
  }

  "screenshot" {
    if (-not $Out) { Fail "BAD_ARGS" "-Out required" }
    $dir = Split-Path -Parent $Out
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    if ($Hwnd -ne 0 -and [OsOpener.Native]::IsWindow([IntPtr]$Hwnd)) {
      # PrintWindow renders the window itself, so it works on any monitor and behind other windows.
      $wr = New-Object OsOpener.Native+RECT
      [void][OsOpener.Native]::GetWindowRect([IntPtr]$Hwnd, [ref]$wr)
      $bmp = New-Object System.Drawing.Bitmap ([Math]::Max(1, $wr.Right - $wr.Left)), ([Math]::Max(1, $wr.Bottom - $wr.Top))
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      $hdc = $g.GetHdc()
      [void][OsOpener.Native]::PrintWindow([IntPtr]$Hwnd, $hdc, 2)  # PW_RENDERFULLCONTENT
      $g.ReleaseHdc($hdc)
      $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
      $w = $bmp.Width; $hh = $bmp.Height
      $g.Dispose(); $bmp.Dispose()
      Out-Json @{ ok = $true; path = (Resolve-Path $Out).Path; width = $w; height = $hh; hwnd = $Hwnd; ms = $sw.ElapsedMilliseconds }
      exit 0
    }
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
; $AutomationId = $null; $ControlType = 'Button'
    $cancel = @(Find-Elements $root 12 | Where-Object { $_.el.Current.Name -ceq 'Cancel' -and $_.el.Current.IsEnabled }) | Select-Object -First 1
    if (-not $cancel) {
      Fail "UNSAVED_CHANGES_DIALOG" "Verified save prompt '$($prompt.title)' does not expose an enabled, exact Cancel button. Nothing was touched." @{ foregroundTitle = $prompt.title; dialogHwnd = $prompt.hwnd }
    }
    try {
      $cancel.el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
    } catch {
      Fail "UNSAVED_CHANGES_DIALOG" "Could not invoke Cancel on '$($prompt.title)': $($_.Exception.Message). No Save/Discard action was attempted." @{ foregroundTitle = $prompt.title; dialogHwnd = $prompt.hwnd }
    }
    Start-Sleep -Milliseconds 400
    $stillUp = @(Get-StudioDialogs | Where-Object { $_.hwnd -eq $prompt.hwnd })
    if ($stillUp.Count -gt 0) {
      Fail "UNSAVED_CHANGES_DIALOG" "Cancel was invoked, but the save prompt '$($prompt.title)' is still open. Refusing to retry blindly." @{ foregroundTitle = $prompt.title; dialogHwnd = $prompt.hwnd }
    }
    Out-Json @{ ok = $true; method = 'Cancel.Invoke'; title = $prompt.title; dialogHwnd = $prompt.hwnd; ms = $sw.ElapsedMilliseconds }
  }

  "dismiss" {
    $p = Get-StudioProcess
    if (-not $p) { Fail "STUDIO_NOT_FOUND" "ServiceStudio.exe is not running or has no main window." }
    if ($Hwnd -ne 0 -and [IntPtr]$Hwnd -ne $p.MainWindowHandle) {
      $h = [IntPtr]$Hwnd
      if (-not [OsOpener.Native]::IsWindow($h)) { Out-Json @{ ok = $true; method = "already-gone" }; exit 0 }
      $t = Get-WindowTitle $h
      if ($t -match '(?i)save|unsaved') { Fail "UNSAVED_CHANGES_DIALOG" "Refusing to dismiss '$t': a save prompt is the user's to answer." @{ foregroundTitle = $t } }
      $el = Get-RootElement $h
      try { $el.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern).Close() } catch { Fail "UIA_ELEMENT_NOT_FOUND" "Window '$t' exposes no WindowPattern: $($_.Exception.Message)" }
      Out-Json @{ ok = $true; method = "WindowPattern.Close"; title = $t; ms = $sw.ElapsedMilliseconds }
      exit 0
    }
    # No dialog: close the shell dropdown if it is open. A posted click on its Toggle closes it the same way it opened.
    $root = Get-RootElement $p.MainWindowHandle
    $Name = $null; $AutomationId = '^Toggle$'; $ControlType = 'Button'
    $tg = @(Find-Elements $root 10) | Select-Object -First 1
    $state = $null
    if ($tg) { try { $state = [string]$tg.el.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern).Current.ToggleState } catch {} }
    if ($tg -and $state -eq 'On') {
      [void](Post-Click $tg.el)
      Out-Json @{ ok = $true; method = "toggle-posted-click"; ms = $sw.ElapsedMilliseconds }
    } else {
      Out-Json @{ ok = $true; method = "nothing-open"; ms = $sw.ElapsedMilliseconds }
    }
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
    # No foreground requirement any more: patterns and posted clicks both reach a background window.
    Assert-NoUnsavedDialog
    $h = Resolve-Hwnd
    $root = Get-RootElement $h
    $found = Find-Elements $root $Depth
    $target = $found | Where-Object { -not $_.el.Current.IsOffscreen } | Select-Object -First 1
    if (-not $target) { $target = $found | Select-Object -First 1 }
    if (-not $target) { Fail "UIA_ELEMENT_NOT_FOUND" "No UIA element matched name=/$Name/ automationId=/$AutomationId/ controlType=$ControlType within depth $Depth." }
    $d = Describe-Element $target.el $target.depth $target.path
    Assert-ClickAllowed $target.el $d
    $used = Invoke-Element $target.el ([bool]$Post)
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
    if ($Then -and -not (Test-KeysAllowed $Then)) { Fail "FORBIDDEN_KEYS" "-Then sequence not on the allow-list." }
    Assert-NoUnsavedDialog
    $prev = [IntPtr]::Zero
    if ($TakeFocus) {
      # Focus, type and (below) hand the foreground back inside ONE process: the window in which the user can click
      # away is milliseconds, not a second helper launch. The foreground guard still decides before every keystroke.
      if ($Hwnd -eq 0) { Fail "BAD_ARGS" "-Hwnd required with -TakeFocus" }
      $prev = Set-Foreground ([IntPtr]$Hwnd)
    }
    Assert-StudioForeground
    [System.Windows.Forms.SendKeys]::SendWait($Keys)
    if ($Then) {
      Start-Sleep -Milliseconds $ThenDelayMs
      Assert-StudioForeground
      [System.Windows.Forms.SendKeys]::SendWait($Then)
    }
    $back = $null
    if ($TakeFocus -and $prev -ne [IntPtr]::Zero) {
      $prevPid = 0
      [void][OsOpener.Native]::GetWindowThreadProcessId($prev, [ref]$prevPid)
      $sp = Get-StudioProcess
      if (-not ($sp -and $prevPid -eq $sp.Id) -and [OsOpener.Native]::IsWindow($prev)) {
        Start-Sleep -Milliseconds 150
        [void](Set-Foreground $prev)
        $back = ([OsOpener.Native]::GetForegroundWindow() -eq $prev)
      }
    }
    Out-Json @{ ok = $true; keys = $Keys; then = $Then; previous = [int64]$prev; returned = $back; ms = $sw.ElapsedMilliseconds }
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
    Start-Sleep -Milliseconds 600
    # A module with unsaved changes answers with a save prompt. Never answer it: cancel the close (which keeps the
    # changes) and report. The module stays open. The prompt is found among Studio's own windows, not as the
    # foreground, and cancelled through UIA (its Cancel button, else the window's own close = cancel), never by key.
    $prompt = @(Get-StudioDialogs) | Where-Object { $_.title -match '(?i)save|unsaved' } | Select-Object -First 1
    if (-not $prompt) {
      foreach ($dw in @(Get-StudioDialogs)) {
        $Name = '(?i)^(save|don.?t save)$'; $AutomationId = $null; $ControlType = 'Button'
        if (@(Find-Elements (Get-RootElement ([IntPtr]$dw.hwnd)) 12).Count -gt 0) { $prompt = $dw; break }
      }
    }
    if ($prompt) {
      $how = $null
      $proot = Get-RootElement ([IntPtr]$prompt.hwnd)
      $Name = '(?i)^cancel$'; $AutomationId = $null; $ControlType = 'Button'
      $cancel = @(Find-Elements $proot 12) | Select-Object -First 1
      if ($cancel) {
        try { $cancel.el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke(); $how = 'Cancel button' } catch {}
      }
      if (-not $how) {
        try { $proot.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern).Close(); $how = 'WindowPattern.Close' } catch {}
      }
      Fail "UNSAVED_CHANGES_DIALOG" "Closing '$($tab.label)' raised '$($prompt.title)'; cancelled ($how) and left the module open." @{ foregroundTitle = $prompt.title; label = $tab.label; cancelledWith = $how }
    }
    Out-Json @{ ok = ($used -ne $null); method = $used; label = $tab.label; element = $d; ms = $sw.ElapsedMilliseconds }
  }

  "screenshot" {
    if (-not $Out) { Fail "BAD_ARGS" "-Out required" }
    $dir = Split-Path -Parent $Out
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    if ($Hwnd -ne 0 -and [OsOpener.Native]::IsWindow([IntPtr]$Hwnd)) {
      # PrintWindow renders the window itself, so it works on any monitor and behind other windows.
      $wr = New-Object OsOpener.Native+RECT
      [void][OsOpener.Native]::GetWindowRect([IntPtr]$Hwnd, [ref]$wr)
      $bmp = New-Object System.Drawing.Bitmap ([Math]::Max(1, $wr.Right - $wr.Left)), ([Math]::Max(1, $wr.Bottom - $wr.Top))
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      $hdc = $g.GetHdc()
      [void][OsOpener.Native]::PrintWindow([IntPtr]$Hwnd, $hdc, 2)  # PW_RENDERFULLCONTENT
      $g.ReleaseHdc($hdc)
      $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
      $w = $bmp.Width; $hh = $bmp.Height
      $g.Dispose(); $bmp.Dispose()
      Out-Json @{ ok = $true; path = (Resolve-Path $Out).Path; width = $w; height = $hh; hwnd = $Hwnd; ms = $sw.ElapsedMilliseconds }
      exit 0
    }
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
