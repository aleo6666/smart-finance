#Requires -Version 7
param([switch]$Clean)

$ErrorActionPreference = 'Stop'

Write-Host "=== Smart Finance Local Shutdown ===" -ForegroundColor Cyan

Write-Host "`nStopping containers..." -ForegroundColor Yellow
if ($Clean) {
    docker compose --env-file .env.local down --volumes
    Write-Host "  Containers and volumes removed" -ForegroundColor Green
} else {
    docker compose --env-file .env.local down
    Write-Host "  Containers stopped (data preserved)" -ForegroundColor Green
}

Write-Host "`nRestoring LM Studio localhost binding..." -ForegroundColor Yellow
& lms server stop 2>$null
Start-Sleep -Seconds 2
& lms server start --port 1234 --bind 127.0.0.1
Write-Host "  OK LM Studio restored to 127.0.0.1:1234" -ForegroundColor Green

Write-Host "`nShutdown complete." -ForegroundColor Green
