# Local GateSwarm gateway launcher (Windows PowerShell).
# Runs the gateway from source on port 8900 for local demos / manual testing.
#
# SECRETS_SOURCE=env loads keys straight from .env (no vault approval prompt).
# Set SV_BIN + SECRETS_SOURCE=auto if you use Sovereign Vault.
$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

if (-not $env:SECRETS_SOURCE) { $env:SECRETS_SOURCE = "env" }
if (-not $env:PORT)           { $env:PORT = "8900" }

Write-Host "=== GateSwarm MoMA Router - http://localhost:$($env:PORT) ===" -ForegroundColor Cyan
& node_modules\.bin\tsx.cmd src/moma-gateway.ts --port $env:PORT
