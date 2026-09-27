<#
Open Harness - local browser launcher for Windows.

Starts the Docker-backed Open Harness stack from a downloaded release directory
and opens the dashboard in the default browser once it is healthy. Needs only
Docker Desktop with Linux containers: no Node, Python or Git on the host.
Written for Windows PowerShell 5.1; also runs on PowerShell 7. Kept to
ASCII on purpose: Windows PowerShell reads a BOM-less file in the ANSI code page,
which can turn other punctuation into stray quote characters.

  launchers\start.ps1 [-NoOpen] [-Build] [-Override <compose-override-file>]
                      [-Timeout <seconds>] [-Stop | -Status | -Logs | -Help]

The long forms --no-open, --build, --override, --timeout, --stop, --status,
--logs and --help are accepted too, so the two launchers share one CLI.

Exit codes: 0 ok / 2 Docker missing, not startable or not a Linux engine /
3 Compose failed / 4 the app did not become healthy in time / 5 the stack is
up and healthy but no paired browser window could be produced (no connection
link could be minted, or no browser could be opened) / 64 usage.
#>
[CmdletBinding()]
param(
  [switch]$NoOpen,
  [switch]$Build,
  [Alias('Folders')][string]$Override = '',
  [int]$Timeout = 0,
  [switch]$Stop,
  [switch]$Status,
  [switch]$Logs,
  [switch]$Help,
  [Parameter(ValueFromRemainingArguments = $true)][string[]]$Rest
)
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Continue'

# ---------------------------------------------------------------- locate ----
# The release directory is the parent of this script's directory, wherever the
# archive was extracted and whatever its path contains (spaces included).
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$releaseDir = (Resolve-Path (Join-Path $scriptDir '..')).Path
$logFile = Join-Path $releaseDir 'open-harness-launcher.log'
$appUrl = 'http://localhost:3000'
$healthUrl = if ($env:OPEN_HARNESS_HEALTH_URL) { $env:OPEN_HARNESS_HEALTH_URL } else { 'http://127.0.0.1:3000/api/health' }
$composeFile = 'compose.yaml'
$lockFile = 'image-lock.json'

$isWindowsHost = ($env:OS -eq 'Windows_NT')
$platform = if ($env:OPEN_HARNESS_LAUNCHER_PLATFORM) { $env:OPEN_HARNESS_LAUNCHER_PLATFORM } elseif ($isWindowsHost) { 'windows' } else { 'other' }

# ----------------------------------------------------------------- output ----
function Write-Log([string]$text) {
  try { Add-Content -Path $logFile -Value ("{0} {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $text) -ErrorAction Stop } catch { }
}
function Say([string]$text) { Write-Host $text; Write-Log $text }
function Warn([string]$text) { [Console]::Error.WriteLine($text); Write-Log $text }
function Show-Hints {
  Warn ('Look at:  cd "{0}"; docker compose ps' -f $releaseDir)
  Warn ('          cd "{0}"; docker compose logs --tail=100 open-harness' -f $releaseDir)
  Warn ('Launcher log: {0}' -f $logFile)
}
function Pause-IfWrapped {
  if ($env:OPEN_HARNESS_LAUNCHER_PAUSE -eq '1' -and -not [Console]::IsInputRedirected) {
    Write-Host 'Press Return to close this window. ' -NoNewline
    [void][Console]::ReadLine()
  }
}
function Fail([int]$code, [string]$text) { Warn $text; Show-Hints; Pause-IfWrapped; exit $code }
function Show-Usage {
  Write-Host @'
Usage: launchers\start.ps1 [options]

  (no option)          Start Open Harness and open a paired browser window.
  --no-open            Start and wait for health, but do not mint a pairing code
                       or open a browser (for scripts and acceptance runs).
  --build              Development only: build the coordinator image from the
                       source tree next to compose.yaml instead of using the
                       pinned release image.
  --override <file>    Add an explicitly chosen Compose override file, such as
                       your edited copy of compose.host-folders.example.yaml.
                       Nothing on this computer is shared without it.
  --timeout <seconds>  How long to wait for Docker to start and for the app to
                       become healthy (default 300, or OPEN_HARNESS_LAUNCHER_TIMEOUT).
  --stop               Stop the stack. Your data stays in its Docker volumes.
  --status             Show the containers and whether the app answers.
  --logs               Show recent coordinator logs.
  --help               This text.
'@
}

# ------------------------------------------------------------ arguments ----
# GNU-style long options arrive in $Rest; fold them onto the switches.
$openBrowser = -not $NoOpen
$build = [bool]$Build
$overrideFile = $Override
$action = 'start'
if ($Stop) { $action = 'stop' }
if ($Status) { $action = 'status' }
if ($Logs) { $action = 'logs' }
if ($Help) { Show-Usage; exit 0 }
$timeoutSeconds = $Timeout
if ($Rest) {
  for ($i = 0; $i -lt $Rest.Count; $i++) {
    switch ($Rest[$i]) {
      '--no-open' { $openBrowser = $false }
      '--build' { $build = $true }
      { $_ -eq '--override' -or $_ -eq '--folders' } { if ($i + 1 -ge $Rest.Count) { Show-Usage; exit 64 }; $i++; $overrideFile = $Rest[$i] }
      '--timeout' { if ($i + 1 -ge $Rest.Count) { Show-Usage; exit 64 }; $i++; $timeoutSeconds = 0; if (-not [int]::TryParse($Rest[$i], [ref]$timeoutSeconds) -or $timeoutSeconds -lt 0) { Show-Usage; exit 64 } }
      '--stop' { $action = 'stop' }
      '--status' { $action = 'status' }
      '--logs' { $action = 'logs' }
      '--help' { Show-Usage; exit 0 }
      '-h' { Show-Usage; exit 0 }
      default { Show-Usage; exit 64 }
    }
  }
}
if ($timeoutSeconds -le 0) {
  $fromEnv = 0
  if ($env:OPEN_HARNESS_LAUNCHER_TIMEOUT -and [int]::TryParse($env:OPEN_HARNESS_LAUNCHER_TIMEOUT, [ref]$fromEnv) -and $fromEnv -gt 0) { $timeoutSeconds = $fromEnv } else { $timeoutSeconds = 300 }
}

Set-Location -LiteralPath $releaseDir
Say ("Open Harness launcher starting in: {0}" -f $releaseDir)

# ------------------------------------------------------- release contract ----
# A downloaded release carries compose.yaml, image-lock.json and the engine
# entrypoint; a source checkout has no lock and is used only through --build,
# which needs the coordinator Dockerfile instead. The check follows the mode,
# not the action, so --build --stop works in a source tree too.
foreach ($required in @($composeFile, 'runtime\dind-entrypoint.sh')) {
  if (-not (Test-Path -LiteralPath (Join-Path $releaseDir $required) -PathType Leaf)) {
    Fail 64 ("This does not look like a complete Open Harness release: {0} is missing from {1}. Extract the whole archive and run the launcher from inside it." -f $required, $releaseDir)
  }
}
if ($build) {
  if (-not (Test-Path -LiteralPath (Join-Path $releaseDir 'Dockerfile.coordinator') -PathType Leaf)) {
    Fail 64 '--build needs the source tree (Dockerfile.coordinator) next to compose.yaml. A downloaded browser release uses the pinned images and does not need it.'
  }
} elseif (-not (Test-Path -LiteralPath (Join-Path $releaseDir $lockFile) -PathType Leaf)) {
  Fail 64 ("This does not look like a complete Open Harness release: {0} is missing from {1}. Extract the whole archive and run the launcher from inside it (a source checkout is started with --build)." -f $lockFile, $releaseDir)
}
if ($overrideFile -and -not (Test-Path -LiteralPath $overrideFile -PathType Leaf)) { Fail 64 ("The folder override file does not exist: {0}" -f $overrideFile) }

# A downloaded release ships compose.yaml with every image pinned by digest and
# OPEN_HARNESS_HERMES_PULL=1 already set, and image-lock.json records the same
# digests for the package validator; the launcher does not rewrite any of them.
# --build is the source tree's own path: the coordinator is built here and the
# Hermes image is prepared locally, so pulling is switched off explicitly.
if ($build) { $env:OPEN_HARNESS_HERMES_PULL = '0' }

# --------------------------------------------------------------- docker ----
# Docker Desktop installs per user by default (%LOCALAPPDATA%\Programs\DockerDesktop,
# per docs.docker.com/desktop/setup/install/windows-install/) or for all users
# (%ProgramFiles%\Docker\Docker). Both keep "Docker Desktop.exe" at the install root
# and the CLI under resources\bin. OPEN_HARNESS_DOCKER_APP names an install root
# (or the .exe itself) explicitly, for tests and unusual installs.
function Get-DockerInstallRoots {
  $roots = @()
  if ($env:OPEN_HARNESS_DOCKER_APP) {
    if (Test-Path -LiteralPath $env:OPEN_HARNESS_DOCKER_APP -PathType Leaf) { $roots += (Split-Path -Parent $env:OPEN_HARNESS_DOCKER_APP) } else { $roots += $env:OPEN_HARNESS_DOCKER_APP }
  }
  if ($env:LOCALAPPDATA) { $roots += (Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop') }
  if ($env:ProgramFiles) { $roots += (Join-Path $env:ProgramFiles 'Docker\Docker') }
  return $roots
}
function Find-DockerDesktopExe {
  foreach ($root in (Get-DockerInstallRoots)) {
    $candidate = Join-Path $root 'Docker Desktop.exe'
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
  }
  return ''
}
$dockerDesktopExe = if ($platform -eq 'windows') { Find-DockerDesktopExe } else { '' }
# Docker Desktop adds its CLI directory to PATH, but a shell opened before the
# install (or a double-clicked launcher in a fresh session) may not have it yet.
# The install's own resources\bin is appended after the caller's PATH, so a
# docker the operator put first stays first.
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  foreach ($root in (Get-DockerInstallRoots)) {
    $cliDir = Join-Path $root 'resources\bin'
    if (Test-Path -LiteralPath (Join-Path $cliDir 'docker.exe') -PathType Leaf) { $env:PATH = $env:PATH + [IO.Path]::PathSeparator + $cliDir; break }
  }
}
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  if ($dockerDesktopExe) { Fail 2 ("Docker Desktop is installed at {0} but its command-line tools were not found beside it or on PATH. Open Docker Desktop once and finish its setup, then run this launcher again." -f (Split-Path -Parent $dockerDesktopExe)) }
  Fail 2 'Docker Desktop is not installed. Download it from https://www.docker.com/products/docker-desktop/ and choose Linux containers during setup (WSL 2 is recommended), then run this launcher again.'
}
function Test-DaemonReady { & docker info *> $null; return ($LASTEXITCODE -eq 0) }

if (-not (Test-DaemonReady)) {
  if ($dockerDesktopExe) {
    Say 'Docker Desktop is not running. Starting it...'
    try { Start-Process -FilePath $dockerDesktopExe | Out-Null } catch { Warn 'Could not start Docker Desktop from here; waiting in case it is starting on its own.' }
  } elseif ($platform -eq 'windows') {
    Fail 2 'Docker Desktop is installed but could not be located to start it. Start Docker Desktop from the Start menu, wait for its whale icon to settle, then run this launcher again.'
  } else {
    Say ("Docker is installed but not running. Start it - waiting up to {0} seconds." -f $timeoutSeconds)
  }
  $waited = 0
  while (-not (Test-DaemonReady)) {
    if ($waited -ge $timeoutSeconds) { Fail 2 ("Docker did not become ready within {0} seconds. Open Docker Desktop, wait for its whale icon to settle, then run this launcher again." -f $timeoutSeconds) }
    Start-Sleep -Seconds 2; $waited += 2
  }
  Say 'Docker is ready.'
}

$engineOs = (& docker info --format '{{.OSType}}' 2>$null | Out-String).Trim()
if ($engineOs -ne 'linux') { Fail 2 ("Docker is running {0} containers, but Open Harness needs Linux containers. Right-click the Docker Desktop whale icon and choose 'Switch to Linux containers...', then run this launcher again." -f $engineOs) }
& docker compose version *> $null
if ($LASTEXITCODE -ne 0) { Fail 2 "Docker Compose v2 ('docker compose') is not available. Update Docker Desktop, which includes it, then run this launcher again." }

# --------------------------------------------------------------- compose ----
# Every Compose call uses the same file list so an override chosen once applies
# to up, stop, ps and logs alike.
function Invoke-Compose { param([string[]]$Arguments)
  $files = @('-f', $composeFile)
  if ($overrideFile) { $files += @('-f', $overrideFile) }
  # Out-Host keeps Compose's output on the console instead of in this function's return value.
  & docker compose @files @Arguments | Out-Host
  return $LASTEXITCODE
}
function Test-Healthy {
  try {
    $response = Invoke-WebRequest -Uri $healthUrl -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
    return ($response.StatusCode -eq 200)
  } catch { return $false }
}

switch ($action) {
  'stop' {
    Say 'Stopping Open Harness. Your agents, conversations and credentials stay in Docker volumes.'
    if ((Invoke-Compose @('stop')) -ne 0) { Fail 3 'Docker Compose could not stop the stack.' }
    Say 'Stopped. Run this launcher again to start it.'
    Pause-IfWrapped; exit 0
  }
  'status' {
    if ((Invoke-Compose @('ps')) -ne 0) { Fail 3 'Docker Compose could not list the stack.' }
    if (Test-Healthy) { Say ("The app answers at {0}" -f $appUrl) } else { Say ("The app is not answering at {0} yet." -f $appUrl) }
    Pause-IfWrapped; exit 0
  }
  'logs' {
    if ((Invoke-Compose @('logs', '--tail=200')) -ne 0) { Fail 3 'Docker Compose could not read the logs.' }
    Pause-IfWrapped; exit 0
  }
}

if ($build) {
  Say 'Building the coordinator image from source and starting the Open Harness containers...'
  if ((Invoke-Compose @('up', '-d', '--build')) -ne 0) { Fail 3 'Docker Compose could not build and start the stack.' }
} else {
  Say 'Downloading the pinned Open Harness images (the first start can take several minutes)...'
  if ((Invoke-Compose @('pull')) -ne 0) { Fail 3 'Docker Compose could not download the pinned images. Check your internet connection and that Docker Desktop is signed in if your registry needs it, then run this launcher again.' }
  Say 'Starting the Open Harness containers...'
  if ((Invoke-Compose @('up', '-d', '--no-build')) -ne 0) { Fail 3 'Docker Compose could not start the stack.' }
}

Say ("Waiting for the app to become healthy (up to {0} seconds)..." -f $timeoutSeconds)
$waited = 0
while (-not (Test-Healthy)) {
  if ($waited -ge $timeoutSeconds) { Fail 4 ("The app did not answer at {0} within {1} seconds. The containers are still running and your data is intact." -f $healthUrl, $timeoutSeconds) }
  Start-Sleep -Seconds 2; $waited += 2
}

# --------------------------------------------------------------- pairing ----
# The dashboard hands out its operator token only to a browser that presents a
# one-use code minted inside the coordinator container. The code travels in the
# URL fragment, omitted from the initial HTTP request. The page exchanges it
# with the local coordinator on load. It is never printed here.
function Open-Url([string]$url) {
  try {
    if ($env:OPEN_HARNESS_BROWSER_COMMAND) { & $env:OPEN_HARNESS_BROWSER_COMMAND $url *> $null; return ($LASTEXITCODE -eq 0) }
    if ($platform -eq 'windows') { Start-Process -FilePath $url | Out-Null; return $true }
    if (Get-Command xdg-open -ErrorAction SilentlyContinue) { & xdg-open $url *> $null; return $true }
    if (Get-Command open -ErrorAction SilentlyContinue) { & open $url *> $null; return $true }
    return $false
  } catch { return $false }
}

if (-not $openBrowser) {
  Say ("Open Harness is running at {0}" -f $appUrl)
  Say ("No browser was opened (--no-open). To pair one, mint a code with: docker compose -f {0} exec -T open-harness node /opt/open-harness/runtime/browser-pair.mjs - then open {1}/#pair=<code>." -f $composeFile, $appUrl)
  Pause-IfWrapped; exit 0
}

# The helper prints one JSON object with a base64url code; anything else - a
# non-zero exit, no output, or a code in another shape - means no usable link,
# and the launcher says so instead of opening a dashboard that would only ask
# for pairing. The helper's own stderr goes to the log, never to the URL.
function Fail-Mint([string]$reason) {
  Fail 5 ("Open Harness is running at {0}, but no browser connection link could be created ({1}). No browser was opened, because a dashboard opened without a link only asks for pairing. This usually means the coordinator image is older than this launcher or did not start correctly: run the launcher with --logs, update the release if it is out of date, then run this launcher again." -f $appUrl, $reason)
}
$pairCode = ''
$pairStatus = -1
$pairJson = ''
try {
  $files = @('-f', $composeFile); if ($overrideFile) { $files += @('-f', $overrideFile) }
  $pairJson = (& docker compose @files exec -T open-harness node /opt/open-harness/runtime/browser-pair.mjs 2>>$logFile | Out-String)
  $pairStatus = $LASTEXITCODE
} catch { $pairStatus = -1 }
if ($pairStatus -ne 0) { Fail-Mint ("the pairing helper in the coordinator container exited with status {0}" -f $pairStatus) }
try { $pair = $pairJson | ConvertFrom-Json; if ($pair -and $pair.code) { $pairCode = [string]$pair.code } } catch { $pairCode = '' }
if (-not $pairCode) { Fail-Mint 'the pairing helper printed no code' }
if ($pairCode -notmatch '^[A-Za-z0-9_-]+$') { Fail-Mint 'the pairing helper printed a code in an unexpected form' }
if ($pairCode.Length -lt 32 -or $pairCode.Length -gt 128) { Fail-Mint 'the pairing helper printed a code of unexpected length' }

$target = '{0}/#pair={1}' -f $appUrl, [uri]::EscapeDataString($pairCode)
if (Open-Url $target) {
  Say ("Open Harness is running at {0} - a paired browser window is opening." -f $appUrl)
} else {
  Fail 5 ("Open Harness is running at {0}, but no browser could be opened from here. Run the launcher again from a desktop session, or open {0} and follow the pairing instructions shown there." -f $appUrl)
}
Pause-IfWrapped
exit 0
