$ErrorActionPreference = 'Stop'
$studioRoot = Split-Path -Parent $PSScriptRoot
try {
  Invoke-RestMethod 'http://127.0.0.1:11434/api/tags' -TimeoutSec 2 | Out-Null
  return
} catch {}
$ollamaExecutable = Join-Path $studioRoot 'tools\ollama\ollama.exe'
if (-not (Test-Path -LiteralPath $ollamaExecutable)) { throw 'Install Ollama first.' }
$modelDirectory = Join-Path $studioRoot 'data\models'
New-Item -ItemType Directory -Force -Path $modelDirectory | Out-Null
$env:OLLAMA_MODELS = $modelDirectory
$env:OLLAMA_HOST = '127.0.0.1:11434'
$env:OLLAMA_NO_CLOUD = '1'
$env:OLLAMA_NUM_PARALLEL = '1'
$env:OLLAMA_MAX_LOADED_MODELS = '1'
Start-Process -FilePath $ollamaExecutable -ArgumentList 'serve' -WindowStyle Hidden -WorkingDirectory $studioRoot -RedirectStandardOutput (Join-Path $studioRoot 'data\ollama-out.log') -RedirectStandardError (Join-Path $studioRoot 'data\ollama-error.log')
for ($attempt = 0; $attempt -lt 30; $attempt++) {
  try {
    Invoke-RestMethod 'http://127.0.0.1:11434/api/tags' -TimeoutSec 2 | Out-Null
    Write-Output 'Local Ollama is ready in the background.'
    return
  } catch { Start-Sleep -Milliseconds 500 }
}
throw 'Ollama did not start. See data/ollama-error.log.'
