# Simulated interactive Pi session through GateSwarm (port 8900).
# Each turn: show the "user input", then run pi against the same session (-c),
# so the model keeps conversation context across turns - like typing into the TUI.
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo
$PI = "pi"
$ARGS_BASE = @("-p", "--provider", "moma", "--model", "gateswarm")

function Turn([string]$prompt, [bool]$continue) {
    Write-Host ""
    Write-Host ("user> " + $prompt) -ForegroundColor Yellow
    Write-Host "pi>" -ForegroundColor Green
    if ($continue) { & $PI @ARGS_BASE -c $prompt } else { & $PI @ARGS_BASE $prompt }
}

Write-Host "=== Simulated Pi session via GateSwarm MoMA router ===" -ForegroundColor Cyan

Turn "Hi! My favorite number is 42. What is 6*7? Answer briefly." $false
Turn "What did I say my favorite number was?" $true
Turn "Name one advantage of routing prompts to different models by complexity. One sentence." $true

Write-Host ""
Write-Host "=== session complete (3 turns, shared context) ===" -ForegroundColor Cyan
