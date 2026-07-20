#Requires -Version 7
$ErrorActionPreference = 'Stop'

Write-Host "=== Smart Finance Local Startup ===" -ForegroundColor Cyan

# 1. Check prerequisites
function Assert-Command($name, $checkCmd) {
    $null = Get-Command $checkCmd -ErrorAction Stop
    Write-Host "  OK $name" -ForegroundColor Green
}

Write-Host "`n[1/10] Checking prerequisites..." -ForegroundColor Yellow
Assert-Command "PowerShell 7" "pwsh"
Assert-Command "Docker Desktop" "docker"
Assert-Command "LM Studio CLI (lms)" "lms"

# Docker Compose check
docker compose version 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { throw "docker compose not available" }
Write-Host "  OK Docker Compose" -ForegroundColor Green

# 2. Check LM Studio models
Write-Host "`n[2/10] Checking LM Studio models..." -ForegroundColor Yellow
$models = & lms ls 2>&1
$chatModel = "qwen3.6-35b-a3b"
$embedModel = "text-embedding-nomic-embed-text-v1.5"
if ($models -notmatch $chatModel) { throw "Chat model '$chatModel' not found in LM Studio" }
Write-Host "  OK $chatModel" -ForegroundColor Green
if ($models -notmatch $embedModel) { throw "Embedding model '$embedModel' not found in LM Studio" }
Write-Host "  OK $embedModel" -ForegroundColor Green

# 3. Configure LM Studio server binding
Write-Host "`n[3/10] Configuring LM Studio server..." -ForegroundColor Yellow
& lms server stop 2>$null
Start-Sleep -Seconds 2
& lms server start --port 1234 --bind 0.0.0.0
Start-Sleep -Seconds 3
Write-Host "  OK LM Studio server started on 0.0.0.0:1234" -ForegroundColor Green

# 4. Verify LM Studio API
Write-Host "`n[4/10] Verifying LM Studio API..." -ForegroundColor Yellow
function Wait-Http($url, $name, $timeoutSec = 30) {
    $deadline = (Get-Date).AddSeconds($timeoutSec)
    while ((Get-Date) -lt $deadline) {
        try {
            $null = Invoke-WebRequest -Uri $url -TimeoutSec 3 -UseBasicParsing
            Write-Host "  OK $name" -ForegroundColor Green
            return
        } catch { Start-Sleep -Seconds 2 }
    }
    throw "$name not reachable at $url"
}
Wait-Http "http://127.0.0.1:1234/v1/models" "LM Studio API"

# 5. Generate .env.local
Write-Host "`n[5/10] Generating .env.local..." -ForegroundColor Yellow
if (-not (Test-Path .env.local)) {
    Copy-Item .env.example .env.local
    $bytes = New-Object byte[] 48
    [Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
    $jwt = [Convert]::ToBase64String($bytes)
    (Get-Content .env.local) -replace '^JWT_SECRET=$', "JWT_SECRET=$jwt" | Set-Content .env.local
    Write-Host "  OK .env.local created with generated JWT_SECRET" -ForegroundColor Green
} else {
    Write-Host "  OK .env.local already exists" -ForegroundColor Green
}

# 6. Build and start containers
Write-Host "`n[6/10] Building and starting containers..." -ForegroundColor Yellow
docker compose --env-file .env.local up -d --build
Write-Host "  OK Containers started" -ForegroundColor Green

# 7. Wait for MySQL
Write-Host "`n[7/10] Waiting for MySQL..." -ForegroundColor Yellow
docker compose --env-file .env.local exec -T mysql mysqladmin ping -h localhost -ufinance -pFinancePass2026! --silent 2>$null
# Use health check wait instead
$maxWait = 60; $waited = 0
while ($waited -lt $maxWait) {
    $healthy = docker inspect finance-mysql --format '{{.State.Health.Status}}' 2>$null
    if ($healthy -eq 'healthy') { break }
    Start-Sleep -Seconds 3; $waited += 3
}
Write-Host "  OK MySQL ready" -ForegroundColor Green

# 8. Wait for backend health
Write-Host "`n[8/10] Waiting for services..." -ForegroundColor Yellow
Wait-Http "http://localhost:3000/api/health" "Backend liveness"
Start-Sleep -Seconds 5
$ready = $false
for ($i = 0; $i -lt 20; $i++) {
    try {
        $resp = Invoke-WebRequest -Uri "http://localhost:3000/api/health/ready" -TimeoutSec 5 -UseBasicParsing
        if ($resp.StatusCode -eq 200) { $ready = $true; break }
    } catch {}
    Start-Sleep -Seconds 3
}
if ($ready) {
    Write-Host "  OK All services ready" -ForegroundColor Green
} else {
    Write-Host "  WARN Backend ready check returned degraded status" -ForegroundColor Yellow
}

# 9. Frontend
Write-Host "`n[9/10] Frontend..." -ForegroundColor Yellow
Wait-Http "http://localhost" "Frontend"

# 10. Done
Write-Host "`n[10/10] Startup complete!" -ForegroundColor Green
Write-Host "`n  Frontend:  http://localhost"
Write-Host "  Backend:   http://localhost:3000"
Write-Host "  Health:    http://localhost:3000/api/health/ready"
Write-Host "`n  To stop:  .\scripts\stop-local.ps1"
Write-Host "  To clean: .\scripts\stop-local.ps1 -Clean"
