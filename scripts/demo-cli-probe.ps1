# On-screen CLI probe against a running gateway (default port 8900).
# Exercises trivial / moderate / vision routing and prints the routing headers.
$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo
Write-Host "=== GateSwarm CLI probe ===" -ForegroundColor Cyan
& node scripts/demo-gateway-probe.mjs
