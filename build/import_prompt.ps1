# 供「导入答案.bat」调用的交互脚本：读入文件路径 → 调用 import_answers.py
$ErrorActionPreference = 'Stop'

function Find-Python {
    $cmd = Get-Command python -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $py = Get-Command py -ErrorAction SilentlyContinue
    if ($py) { return "$($py.Source) -3" }
    $candidates = @(
        "$env:LOCALAPPDATA\Programs\Python\Python313\python.exe",
        "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe",
        "$env:LOCALAPPDATA\Programs\Python\Python311\python.exe",
        "$env:ProgramFiles\Python313\python.exe",
        "$env:ProgramFiles\Python312\python.exe"
    )
    foreach ($c in $candidates) { if (Test-Path -LiteralPath $c) { return $c } }
    return $null
}

$py = Find-Python
if (-not $py) {
    Write-Host '没有找到 Python。请先安装 Python 3.9+（安装时勾选 Add to PATH），再运行本脚本。' -ForegroundColor Red
    exit 1
}

Write-Host ''
Write-Host '把答案文件（csv / xlsx / docx / txt / pdf）拖到本窗口，然后回车：' -ForegroundColor Cyan
$file = Read-Host '文件路径'
if ($null -eq $file) { exit 0 }
$file = $file.Trim().Trim('"').Trim("'")
if (-not $file) { Write-Host '没有输入文件，退出。' -ForegroundColor DarkGray; exit 0 }
if (-not (Test-Path -LiteralPath $file)) { Write-Host "文件不存在：$file" -ForegroundColor Red; exit 1 }

& $py (Join-Path $PSScriptRoot 'import_answers.py') --file $file
$code = $LASTEXITCODE
Write-Host ''
if ($code -eq 0) {
    Write-Host '导入完成。回到网页按 Ctrl+F5 刷新即可看到答案。' -ForegroundColor Green
} else {
    Write-Host "导入失败（退出码 $code），请看上面的提示。" -ForegroundColor Red
}
exit $code
