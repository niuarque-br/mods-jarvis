$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$venv = Join-Path $root ".venv-build"
$python = Join-Path $venv "Scripts\python.exe"
if (-not (Test-Path $python)) {
    if (Get-Command uv -ErrorAction SilentlyContinue) { uv venv $venv --python 3.11 -q } else { python -m venv $venv }
}
if (Get-Command uv -ErrorAction SilentlyContinue) {
    uv pip install --python $python -q "httpx>=0.27" "edge-tts>=7.0" pyinstaller
} else {
    & $python -m pip install -q "httpx>=0.27" "edge-tts>=7.0" pyinstaller
}
$work = Join-Path $root "build"
$helper = Join-Path $root "helper"
& $python -m PyInstaller --noconfirm --onefile --noconsole --log-level WARN `
    --name conversa-helper `
    --distpath (Join-Path $root "bin") `
    --workpath $work `
    --specpath $work `
    --paths $helper `
    --add-data "$(Join-Path $helper 'web');web" `
    --collect-data certifi `
    (Join-Path $helper "launcher.py")
if ($LASTEXITCODE -ne 0) { throw "PyInstaller falhou" }
Get-Item (Join-Path $root "bin\conversa-helper.exe") | Select-Object Name, Length
