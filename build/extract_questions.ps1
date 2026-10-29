<#
.SYNOPSIS
  用 WPS Writer 的 COM 接口只读打开真题集 .doc，逐段导出为 JSON。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File build\extract_questions.ps1 -Source "D:\我的资料\2026政治真题集.doc"

.NOTES
  - 只读：不做任何保存，不修改源文件。
  - 需要本机安装 WPS Office（Kwps.Application）。
  - 输出 UTF-8（无 BOM）的 build/_raw_paragraphs.json。
#>
param(
  [Parameter(Mandatory = $true)]
  [string]$Source,
  [string]$OutFile = (Join-Path $PSScriptRoot '_raw_paragraphs.json')
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $Source)) { throw "源文件不存在: $Source" }

$wps = $null
$doc = $null
try {
  $wps = New-Object -ComObject Kwps.Application
  $wps.Visible = $false
  $wps.DisplayAlerts = 0
  $doc = $wps.Documents.Open((Resolve-Path -LiteralPath $Source).Path, $false, $true)

  $paras = New-Object System.Collections.Generic.List[string]
  foreach ($p in $doc.Paragraphs) {
    $t = $p.Range.Text
    if ($null -eq $t) { continue }
    $t = $t -replace "[`r`a`n]+$", ''
    $paras.Add($t)
  }

  $json = ConvertTo-Json -InputObject @($paras) -Compress
  [System.IO.File]::WriteAllText($OutFile, $json, (New-Object System.Text.UTF8Encoding($false)))

  Write-Host ("paragraphs={0} -> {1}" -f $paras.Count, $OutFile)
}
finally {
  if ($doc) { try { $doc.Close(0) } catch {} }
  if ($wps) { try { $wps.Quit() } catch {} }
}
