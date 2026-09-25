#Requires -Version 7
<#
.SYNOPSIS
  后台启动 dev 服务器（复用 package.json 的 dev 脚本），等待可访问后返回。
.EXAMPLE
  ./dev-start.ps1
  ./dev-start.ps1 -Port 4178   # 浏览器存储按端口分开：换端口就看不到 5180 上的工程；5173 会与旧工具共用存储
  ./dev-start.ps1 -Force      # 端口被占用时先终止再启动
#>
[CmdletBinding()]
param([int]$Port = 5180, [switch]$Force)

$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
try {
  if (-not (Test-Path node_modules)) {
    Write-Host "缺少 node_modules，请先运行 npm ci"
    exit 1
  }

  $busy = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
              Select-Object -ExpandProperty OwningProcess -Unique)
  if ($busy) {
    # vite.config.ts 设了 strictPort，端口被占用会直接失败而不是换端口
    if (-not $Force) {
      Write-Host "端口 $Port 已被 PID $($busy -join ', ') 占用。用 -Force 重启，或先运行 ./dev-stop.ps1"
      exit 1
    }
    & "$PSScriptRoot/dev-stop.ps1" -Port $Port
  }

  New-Item -ItemType Directory -Force .cache | Out-Null
  $out = Join-Path $PSScriptRoot '.cache/dev-server.log'
  $err = Join-Path $PSScriptRoot '.cache/dev-server.err.log'

  Start-Process npm.cmd -ArgumentList 'run', 'dev', '--', '--port', $Port `
    -WorkingDirectory $PSScriptRoot -WindowStyle Hidden `
    -RedirectStandardOutput $out -RedirectStandardError $err

  $url = "http://127.0.0.1:$Port/"
  foreach ($i in 1..60) {
    try {
      if ((Invoke-WebRequest $url -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200) {
        $serverPid = (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
                       Select-Object -First 1).OwningProcess
        Write-Host "已启动: $url (PID $serverPid)   日志: .cache/dev-server.log   停止: ./dev-stop.ps1"
        exit 0
      }
    } catch { }
    Start-Sleep -Milliseconds 500
  }

  Write-Host "30 秒内未就绪，日志末尾："
  Get-Content $out, $err -Tail 30 -ErrorAction SilentlyContinue
  exit 1
} finally { Pop-Location }
