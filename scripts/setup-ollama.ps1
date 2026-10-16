param([string]$Model = $env:OLLAMA_MODEL)

$ErrorActionPreference = 'Stop'
$studioRoot = Split-Path -Parent $PSScriptRoot
$toolsDirectory = Join-Path $studioRoot 'tools'
$ollamaDirectory = Join-Path $toolsDirectory 'ollama'
New-Item -ItemType Directory -Force -Path $toolsDirectory | Out-Null
$release = Invoke-RestMethod 'https://api.github.com/repos/ollama/ollama/releases/latest'
$asset = $release.assets | Where-Object name -eq 'ollama-windows-amd64.zip' | Select-Object -First 1
if (-not $asset -or -not $asset.digest.StartsWith('sha256:')) { throw 'The official download has no SHA-256 digest; installation stopped.' }
$archive = Join-Path $toolsDirectory 'ollama-windows-amd64.zip'
if (-not (Test-Path -LiteralPath (Join-Path $ollamaDirectory 'ollama.exe'))) {
  Write-Output "Downloading official Ollama $($release.tag_name) ($([math]::Round($asset.size / 1GB, 2)) GB)."
  & curl.exe --fail --location --retry 2 --output $archive $asset.browser_download_url
  if ($LASTEXITCODE -ne 0) { throw 'Ollama download failed.' }
  $actualDigest = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualDigest -ne $asset.digest.Substring(7)) { throw 'Ollama archive digest does not match the official release.' }
  Write-Output 'Archive checksum verified. Extracting portable runtime.'
  Expand-Archive -LiteralPath $archive -DestinationPath $ollamaDirectory -Force
  Remove-Item -LiteralPath $archive
}
& (Join-Path $PSScriptRoot 'start-ollama.ps1')
for ($attempt = 0; $attempt -lt 20; $attempt++) {
  try { Invoke-RestMethod 'http://127.0.0.1:11434/api/tags' -TimeoutSec 2 | Out-Null; break } catch { Start-Sleep -Seconds 1 }
}
if ([string]::IsNullOrWhiteSpace($Model)) {
  Write-Output 'Ollama is ready. No model was downloaded. Re-run with -Model "your-model:tag" to install your chosen local model.'
  return
}
Write-Output "Downloading local model: $Model. Size and memory requirements depend on the model."
& node.exe (Join-Path $PSScriptRoot 'pull-model.mjs') $Model
if ($LASTEXITCODE -ne 0) { throw 'Model download failed. Re-run this script to resume.' }
Write-Output "The local model is ready. Set OLLAMA_MODEL to $Model before starting the studio."
