$ErrorActionPreference = "Stop"
$Coordinator = $env:OPEN_HARNESS_COORDINATOR
$PairingCode = $env:OPEN_HARNESS_PAIRING_CODE
$SitesToken = $env:OPEN_HARNESS_SITES_TOKEN
if (-not $Coordinator -or -not $PairingCode) { throw "The coordinator address and pairing code are required." }

$InstallDir = if ($env:OPEN_HARNESS_RUNNER_DIR) { $env:OPEN_HARNESS_RUNNER_DIR } else { Join-Path $env:LOCALAPPDATA "OpenHarnessRunner" }
$StateDir = if ($env:OPEN_HARNESS_RUNNER_STATE_DIR) { $env:OPEN_HARNESS_RUNNER_STATE_DIR } else { Join-Path $env:USERPROFILE ".open-harness-runner" }
$NodeVersion = "v22.23.2"
$Arch = if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -eq "Arm64") { "arm64" } else { "x64" }
$NodeDir = Join-Path $InstallDir "node"
$Node = Join-Path $NodeDir "node.exe"
New-Item -ItemType Directory -Force -Path (Join-Path $InstallDir "runtime\hermes\extension"), $StateDir | Out-Null

Write-Host "Installing Open Harness runner..."
if (-not (Test-Path $Node)) {
  $Zip = Join-Path $env:TEMP "open-harness-node.zip"
  Invoke-WebRequest "https://nodejs.org/dist/$NodeVersion/node-$NodeVersion-win-$Arch.zip" -OutFile $Zip
  $Extract = Join-Path $env:TEMP "open-harness-node"
  Remove-Item $Extract -Recurse -Force -ErrorAction SilentlyContinue
  Expand-Archive $Zip $Extract -Force
  Remove-Item $NodeDir -Recurse -Force -ErrorAction SilentlyContinue
  Move-Item (Join-Path $Extract "node-$NodeVersion-win-$Arch") $NodeDir
}

function Get-RunnerFile([string]$Path) {
  $Destination = Join-Path $InstallDir ($Path -replace '/', '\')
  $Headers = if ($SitesToken) { @{ "OAI-Sites-Authorization" = "Bearer $SitesToken" } } else { @{} }
  Invoke-WebRequest "$Coordinator/v1/install/file?path=$([uri]::EscapeDataString($Path))" -Headers $Headers -OutFile $Destination
}
Get-RunnerFile "runtime/runner.mjs"
@("Dockerfile", "NOTICE.md", "container-init.sh", "coordination.mjs", "inspect_runtime.py", "managed_entry.py", "extension/open_harness_policy.py", "extension/pyproject.toml") | ForEach-Object { Get-RunnerFile "runtime/hermes/$_" }

function Test-DockerCommand([string[]]$DockerArguments) {
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { return $false }
  & docker @DockerArguments *> $null
  return $LASTEXITCODE -eq 0
}

$DockerRunning = Test-DockerCommand @("version")
$DockerReady = Test-DockerCommand @("image", "inspect", "open-harness-hermes:2026.9.11")
if ($DockerRunning -and -not $DockerReady) {
  Write-Host "Preparing the private agent workspace. This first-time step can take several minutes..."
  & docker build -f (Join-Path $InstallDir "runtime\hermes\Dockerfile") -t open-harness-hermes:2026.9.11 $InstallDir
  if ($LASTEXITCODE -ne 0) { throw "The private agent workspace could not be prepared." }
  $DockerReady = Test-DockerCommand @("image", "inspect", "open-harness-hermes:2026.9.11")
}
$PythonReady = $false
foreach ($Python in @("python", "python3")) { if (Get-Command $Python -ErrorAction SilentlyContinue) { & $Python -c "import hermes_cli, open_harness_policy" 2>$null; if ($LASTEXITCODE -eq 0) { $PythonReady = $true; break } } }
if (-not $DockerReady -and -not $PythonReady) { throw "Docker is required for private agent workspaces. Install and start Docker Desktop, then run this pairing command again: https://docs.docker.com/desktop/setup/install/windows-install/" }

$Arguments = @((Join-Path $InstallDir "runtime\runner.mjs"), "--coordinator", $Coordinator, "--pairing-code", $PairingCode, "--once", "1")
if ($SitesToken) { $Arguments += @("--sites-token", $SitesToken) }
$env:OPEN_HARNESS_RUNNER_STATE_DIR = $StateDir
& $Node @Arguments
if ($LASTEXITCODE -ne 0) { throw "Runner pairing failed." }

$Runner = Join-Path $InstallDir "runtime\runner.mjs"
$TaskCommand = "cmd /c set OPEN_HARNESS_RUNNER_STATE_DIR=$StateDir&& `"$Node`" `"$Runner`""
schtasks.exe /Create /F /SC ONLOGON /TN "Open Harness Runner" /TR $TaskCommand | Out-Null
schtasks.exe /Run /TN "Open Harness Runner" | Out-Null
Write-Host "Installed. The runner starts automatically when you sign in."
