#Requires -Version 7
<#
.SYNOPSIS
  终止本地 dev 服务器（按端口查占用进程，杀进程树）。
  会结束监听该端口的任何进程及其子进程（taskkill /T /F）：只在该端口上是本工具的开发服务器时使用。
.EXAMPLE
  ./dev-stop.ps1
  ./dev-stop.ps1 -Port 4178
#>
[CmdletBinding()]
param([int]$Port = 5180)

$ErrorActionPreference = 'Stop'

function Get-ListenerPids([int]$p) {
  @(Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue |
      Select-Object -ExpandProperty OwningProcess -Unique)
}

$targets = Get-ListenerPids $Port
if (-not $targets) {
  Write-Host "端口 $Port 无监听进程，无需终止。"
  exit 0
}

foreach ($procId in $targets) {
  $name = (Get-Process -Id $procId -ErrorAction SilentlyContinue).ProcessName
  Write-Host "终止 PID $procId ($name) 及其子进程…"
  # taskkill /T 杀整棵进程树；Stop-Process 不杀子进程
  & taskkill.exe /PID $procId /T /F 2>&1 | Out-Null
}

# 确认端口已释放，而不是假定 taskkill 成功
foreach ($i in 1..20) {
  if (-not (Get-ListenerPids $Port)) {
    Write-Host "已终止，端口 $Port 已释放。"
    exit 0
  }
  Start-Sleep -Milliseconds 250
}

Write-Error "端口 $Port 仍被占用：$((Get-ListenerPids $Port) -join ', ')"
exit 1
