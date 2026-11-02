<#
.SYNOPSIS
  Installs the OutSystems token manager (skill + hooks) into ~/.claude.

.DESCRIPTION
  Copies the session-guard skill and the three hook scripts into the Claude Code
  user directory, then merges this folder's hook blocks into settings.json.

  The merge is idempotent and additive: existing hook entries are left alone and
  a block is only appended when no entry with the same matcher + command already
  exists. settings.json is backed up before the first write.

.PARAMETER ClaudeDir
  Target Claude Code directory. Defaults to $HOME/.claude.

.PARAMETER SkipMcpGuard
  Do not install the build-rules reminder hook (os-mcp-guard.sh). That hook names
  MOD skills (mod-code-review, servicestudio-action-layout, mod-naming-convention)
  that are NOT part of this repository; skip it unless you have them.

.PARAMETER DryRun
  Report what would change and write nothing.

.EXAMPLE
  ./install.ps1
.EXAMPLE
  ./install.ps1 -SkipMcpGuard -DryRun
#>
[CmdletBinding()]
param(
  [string] $ClaudeDir = (Join-Path $HOME '.claude'),
  [switch] $SkipMcpGuard,
  [switch] $DryRun
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

function Info($m) { Write-Host "  $m" }
function Ok($m)   { Write-Host "  [ok] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  [!]  $m" -ForegroundColor Yellow }

Write-Host "`nOutSystems token manager -> $ClaudeDir" -ForegroundColor Cyan
if ($DryRun) { Warn 'DRY RUN - nothing will be written' }

# --- 1. prerequisites -------------------------------------------------------
Write-Host "`n[1/4] Prerequisites"
$python = Get-Command py -ErrorAction SilentlyContinue
if ($python) { Ok "python launcher: $($python.Source)" }
else { Warn "'py' not found. The token guard runs as 'py -3 <script>'; install Python 3 or edit the command in settings.json." }

$sh = Get-Command sh -ErrorAction SilentlyContinue
if ($sh) { Ok "sh: $($sh.Source)" }
else { Warn "'sh' not found. The SessionStart hook runs via sh (Git Bash ships one)." }

# --- 2. copy skill + hooks --------------------------------------------------
Write-Host "`n[2/4] Files"
$skillDst = Join-Path $ClaudeDir 'skills/outsystems-mcp-session-guard'
$hooksDst = Join-Path $ClaudeDir 'hooks'

$copies = @(
  @{ From = Join-Path $here 'skill/SKILL.md';                  To = Join-Path $skillDst 'SKILL.md' }
  @{ From = Join-Path $here 'hooks/os-session-token-guard.py'; To = Join-Path $hooksDst 'os-session-token-guard.py' }
  @{ From = Join-Path $here 'hooks/os-session-start.sh';       To = Join-Path $hooksDst 'os-session-start.sh' }
)
if (-not $SkipMcpGuard) {
  $copies += @{ From = Join-Path $here 'hooks/os-mcp-guard.sh'; To = Join-Path $hooksDst 'os-mcp-guard.sh' }
} else {
  Warn 'skipping os-mcp-guard.sh (-SkipMcpGuard)'
}

foreach ($c in $copies) {
  if (-not (Test-Path $c.From)) { throw "missing source file: $($c.From)" }
  $dir = Split-Path -Parent $c.To
  $name = Split-Path -Leaf $c.To
  if ($DryRun) { Info "would copy $name -> $dir"; continue }
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  Copy-Item $c.From $c.To -Force
  Ok "$name -> $dir"
}

# --- 3. merge hook blocks into settings.json --------------------------------
Write-Host "`n[3/4] settings.json"
$settingsPath = Join-Path $ClaudeDir 'settings.json'
$snippetPath  = Join-Path $here 'settings-snippet.json'

# <HOME> in the snippet becomes this machine's Claude directory.
$snippetRaw = (Get-Content $snippetPath -Raw).Replace('<HOME>', ($ClaudeDir | Split-Path -Parent).Replace('\', '/'))
$snippet    = $snippetRaw | ConvertFrom-Json

if (Test-Path $settingsPath) {
  $settings = (Get-Content $settingsPath -Raw) | ConvertFrom-Json
  Ok 'read existing settings.json'
} else {
  $settings = [pscustomobject]@{}
  Warn 'no settings.json yet - it will be created'
}

if (-not $settings.PSObject.Properties['hooks']) {
  $settings | Add-Member -NotePropertyName hooks -NotePropertyValue ([pscustomobject]@{}) -Force
}

$added = 0; $kept = 0
foreach ($event in $snippet.hooks.PSObject.Properties.Name) {
  $incoming = @($snippet.hooks.$event)

  if (-not $settings.hooks.PSObject.Properties[$event]) {
    $settings.hooks | Add-Member -NotePropertyName $event -NotePropertyValue @() -Force
  }
  $existing = @($settings.hooks.$event)

  foreach ($block in $incoming) {
    if ($SkipMcpGuard -and ($block.hooks.command -join ' ') -match 'os-mcp-guard\.sh') { continue }

    # a block is already installed when some existing entry shares its matcher
    # AND already runs the same script
    $wanted = ($block.hooks | ForEach-Object { $_.command }) -join '|'
    $dupe = $existing | Where-Object {
      $_.matcher -eq $block.matcher -and
      (($_.hooks | ForEach-Object { $_.command }) -join '|') -eq $wanted
    }
    if ($dupe) { $kept++; Info "already present: $event / $($block.matcher)"; continue }

    $existing += $block
    $added++
    Ok "added: $event / $($block.matcher)"
  }
  $settings.hooks.$event = $existing
}

if ($added -eq 0) {
  Ok "nothing to add ($kept block(s) already installed)"
} elseif ($DryRun) {
  Warn "would add $added block(s)"
} else {
  if (Test-Path $settingsPath) {
    $backup = "$settingsPath.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
    Copy-Item $settingsPath $backup
    Ok "backup: $backup"
  }
  $json = $settings | ConvertTo-Json -Depth 32
  [System.IO.File]::WriteAllText($settingsPath, $json + "`n", (New-Object System.Text.UTF8Encoding $false))
  Ok "wrote settings.json ($added block(s) added, $kept kept)"
}

# --- 4. verify --------------------------------------------------------------
Write-Host "`n[4/4] Verify"
$checks = @(
  @{ Name = 'skill';       Path = Join-Path $skillDst 'SKILL.md' }
  @{ Name = 'token guard'; Path = Join-Path $hooksDst 'os-session-token-guard.py' }
  @{ Name = 'sessionstart';Path = Join-Path $hooksDst 'os-session-start.sh' }
)
$fail = 0
foreach ($c in $checks) {
  if (Test-Path $c.Path) { Ok "$($c.Name): $($c.Path)" } else { Warn "$($c.Name): MISSING"; $fail++ }
}
if (-not $DryRun -and (Test-Path $settingsPath)) {
  try { (Get-Content $settingsPath -Raw) | ConvertFrom-Json | Out-Null; Ok 'settings.json parses' }
  catch { Warn "settings.json does NOT parse - restore the .bak file"; $fail++ }
}

Write-Host ''
if ($fail -gt 0) { Write-Host "Finished with $fail problem(s)." -ForegroundColor Yellow; exit 1 }
Write-Host 'Done. Restart Claude Code so the hooks load.' -ForegroundColor Green
Write-Host 'Then: open a folder whose .mcp.json has a "servicestudio" entry; SessionStart will report token status.'
