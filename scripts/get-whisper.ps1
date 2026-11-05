# Downloads whisper.cpp server (Windows x64) and a GGML model into .\whisper
# Usage (PowerShell, from the project root):
#   powershell -ExecutionPolicy Bypass -File scripts\get-whisper.ps1                 # CPU build, large-v3-turbo
#   powershell -ExecutionPolicy Bypass -File scripts\get-whisper.ps1 -Cuda           # NVIDIA GPU build
#   powershell -ExecutionPolicy Bypass -File scripts\get-whisper.ps1 -Model small    # smaller/faster model
param(
  [switch]$Cuda,
  [string]$Model = "large-v3-turbo"
)
$ErrorActionPreference = "Stop"
$dir = Join-Path $PSScriptRoot "..\whisper"
New-Item -ItemType Directory -Force -Path $dir | Out-Null

# Binaries are attached to build-tag releases (bNNNN), not to the vX.Y.Z "latest" release,
# and asset names change between builds - pick the newest release with a matching asset.
$pattern = if ($Cuda) { '^whisper-(bin-win-cuda-12\.4(\.0)?-x64|cublas-12\.4\.0-bin-x64)\.zip$' } else { '^whisper-bin-x64\.zip$' }
$releases = Invoke-RestMethod "https://api.github.com/repos/ggml-org/whisper.cpp/releases?per_page=20" -Headers @{ "User-Agent" = "get-whisper" }
$found = $null
foreach ($r in $releases) {
  $a = $r.assets | Where-Object { $_.name -match $pattern } | Select-Object -First 1
  if ($a) { $found = $a; Write-Host "Release $($r.tag_name)"; break }
}
if (-not $found) { throw "no asset matching $pattern in recent whisper.cpp releases" }
$asset = $found.name
$zip = Join-Path $env:TEMP $asset
Write-Host "Downloading $asset ..."
curl.exe -L --retry 5 -o $zip $found.browser_download_url
if ($LASTEXITCODE -ne 0) { throw "download failed (curl exit $LASTEXITCODE)" }
$tmp = Join-Path $env:TEMP "whisper-extract"
if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
Expand-Archive $zip -DestinationPath $tmp
$server = Get-ChildItem $tmp -Recurse -Filter "whisper-server.exe" | Select-Object -First 1
if (-not $server) { throw "whisper-server.exe not found in $asset" }
Copy-Item (Join-Path $server.DirectoryName "*") $dir -Recurse -Force

$modelFile = Join-Path $dir "ggml-$Model.bin"
$modelUrl = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-$Model.bin"
# curl.exe (built into Windows 10+) resumes partial downloads; Invoke-WebRequest does not.
$expected = [int64]((Invoke-WebRequest $modelUrl -Method Head -UseBasicParsing).Headers["Content-Length"] | Select-Object -First 1)
$have = if (Test-Path $modelFile) { (Get-Item $modelFile).Length } else { 0 }
if ($have -ne $expected) {
  Write-Host "Downloading model ggml-$Model.bin ($have / $expected bytes) ..."
  curl.exe -L -C - --retry 5 -o $modelFile $modelUrl
  if ($LASTEXITCODE -ne 0) { throw "model download failed (curl exit $LASTEXITCODE); rerun to resume" }
  $have = (Get-Item $modelFile).Length
  if ($have -ne $expected) { throw "model size $have != $expected; rerun to resume" }
}
Write-Host "Done. Set whisper.modelPath to whisper/ggml-$Model.bin in config.json"
