$ErrorActionPreference = "Stop"
$Coordinator = $env:OPEN_HARNESS_COORDINATOR
$PairingCode = $env:OPEN_HARNESS_PAIRING_CODE
if (-not $Coordinator -or -not $PairingCode) { throw "The coordinator address and pairing code are required." }

$InstallDir = if ($env:OPEN_HARNESS_RUNNER_DIR) { $env:OPEN_HARNESS_RUNNER_DIR } else { Join-Path $env:LOCALAPPDATA "OpenHarnessRunner" }
$StateDir = if ($env:OPEN_HARNESS_RUNNER_STATE_DIR) { $env:OPEN_HARNESS_RUNNER_STATE_DIR } else { Join-Path $env:USERPROFILE ".open-harness-runner" }
$HermesImage = if ($env:OPEN_HARNESS_HERMES_IMAGE) { $env:OPEN_HARNESS_HERMES_IMAGE } else { "open-harness-hermes:2026.9.11" }
if ($HermesImage -notmatch '^[A-Za-z0-9._:/@-]+$') { throw "Invalid Hermes image name." }
$NodeVersion = "v22.23.2"
$Arch = if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -eq "Arm64") { "arm64" } else { "x64" }
$NodeDir = Join-Path $InstallDir "node"
$Node = Join-Path $NodeDir "node.exe"
New-Item -ItemType Directory -Force -Path (Join-Path $InstallDir "runtime\hermes\extension"), (Join-Path $InstallDir "runtime\ubuntu\helpers"), (Join-Path $InstallDir "runtime\ubuntu\lock"), $StateDir | Out-Null

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
@("Dockerfile", "NOTICE.md", "container-init.sh", "cua_compat.py", "coordination.mjs", "inspect_runtime.py", "managed_entry.py", "security-constraints.txt", "apply-security-overrides.py", "extension/open_harness_policy.py", "extension/pyproject.toml") | ForEach-Object { Get-RunnerFile "runtime/hermes/$_" }

@("helpers/check-native-platform.sh", "helpers/ubuntu-snapshot.sh", "helpers/check_packages.py", "helpers/curl_http3.py", "helpers/debian_inputs.py", "helpers/debian_origin.py", "helpers/elf_arch.py", "helpers/ohpkg.py", "lock/runtime-inputs.lock.json", "lock/ubuntu-os-packages.txt") | ForEach-Object { Get-RunnerFile "runtime/ubuntu/$_" }

function Test-DockerCommand([string[]]$DockerArguments) {
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { return $false }
  & docker @DockerArguments *> $null
  return $LASTEXITCODE -eq 0
}

$RuntimeContract = [regex]::Match((Get-Content -Raw (Join-Path $InstallDir "runtime\hermes\Dockerfile")), '(?m)^ARG OPEN_HARNESS_RUNTIME=(\d+)\r?$').Groups[1].Value
if (-not $RuntimeContract) { throw "The downloaded runtime has no valid contract version." }
function Test-RuntimeContract {
  if (-not (Test-DockerCommand @("image", "inspect", $HermesImage))) { return $false }
  $Image = & docker image inspect $HermesImage | ConvertFrom-Json
  return $LASTEXITCODE -eq 0 -and [string]$Image[0].Config.Labels.'dev.openharness.runtime' -eq $RuntimeContract
}
$DockerRunning = Test-DockerCommand @("version")
$DockerReady = Test-RuntimeContract
if ($DockerRunning -and -not $DockerReady) {
  Write-Host "Preparing the private agent workspace. This first-time step can take several minutes..."
  & docker build -f (Join-Path $InstallDir "runtime\hermes\Dockerfile") -t $HermesImage $InstallDir
  if ($LASTEXITCODE -ne 0) { throw "The private agent workspace could not be prepared." }
  $DockerReady = Test-RuntimeContract
}
if (-not $DockerReady) { throw "Docker is required for private agent workspaces. Install and start Docker Desktop, then run this pairing command again: https://docs.docker.com/desktop/setup/install/windows-install/" }

$Arguments = @((Join-Path $InstallDir "runtime\runner.mjs"), "--coordinator", $Coordinator, "--pairing-code", $PairingCode, "--once", "1")
$env:OPEN_HARNESS_RUNNER_STATE_DIR = $StateDir
$env:OPEN_HARNESS_HERMES_IMAGE = $HermesImage
& $Node @Arguments
if ($LASTEXITCODE -ne 0) { throw "Runner pairing failed." }

$Runner = Join-Path $InstallDir "runtime\runner.mjs"
$TaskCommand = "cmd /c set OPEN_HARNESS_RUNNER_STATE_DIR=$StateDir&& set OPEN_HARNESS_HERMES_IMAGE=$HermesImage&& `"$Node`" `"$Runner`""
schtasks.exe /Create /F /SC ONLOGON /TN "Open Harness Runner" /TR $TaskCommand | Out-Null
schtasks.exe /Run /TN "Open Harness Runner" | Out-Null
Write-Host "Installed. The runner starts automatically when you sign in."
