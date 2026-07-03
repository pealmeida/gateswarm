# On-screen demo: Pi agent -> GateSwarm gateway.
# Requires: Pi CLI installed, and ~/.pi/agent/models.json configured with a
# "moma" provider pointing at http://localhost:8900/v1 (see docs/GATEWAY_QUICKSTART.md).
$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo
Write-Host "=== Pi agent via GateSwarm (provider: moma, model: gateswarm) ===" -ForegroundColor Cyan
Write-Host ""
Write-Host "> pi -p --provider moma --model gateswarm `"What is 7*6? Answer with just the number.`"" -ForegroundColor Yellow
& pi -p --provider moma --model gateswarm "What is 7*6? Answer with just the number."
Write-Host ""
Write-Host "> pi -p --provider moma --model gateswarm `"Write a one-line haiku about routers.`"" -ForegroundColor Yellow
& pi -p --provider moma --model gateswarm "Write a one-line haiku about routers."
Write-Host ""
Write-Host "=== pi demo complete ===" -ForegroundColor Green
