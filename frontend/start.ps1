# FairLens v4 — Windows PowerShell Start Script
# Usage: .\start.ps1 or .\start.ps1 -GeminiKey "YOUR_KEY"

param(
    [string]$GeminiKey = ""
)

Write-Host ""
Write-Host "╔══════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║  FairLens v4 — AI Bias Investigation System ║" -ForegroundColor Cyan
Write-Host "╚══════════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

# Set Gemini API key
if ($GeminiKey -ne "") {
    $env:GEMINI_API_KEY = $GeminiKey
    Write-Host "✅ Gemini API key set" -ForegroundColor Green
} elseif ($env:GEMINI_API_KEY) {
    Write-Host "✅ Gemini API key found in environment" -ForegroundColor Green
} else {
    Write-Host "⚠  No Gemini API key — will use rule-based explanations" -ForegroundColor Yellow
    Write-Host "   To enable Gemini: .\start.ps1 -GeminiKey 'YOUR_KEY'" -ForegroundColor Yellow
}

Write-Host ""

# Install backend dependencies
Write-Host "→ Installing Python dependencies..." -ForegroundColor White
pip install -r requirements.txt -q
Write-Host "✅ Backend dependencies installed" -ForegroundColor Green

# Start FastAPI backend
Write-Host ""
Write-Host "→ Starting FastAPI backend on http://localhost:8000 ..." -ForegroundColor White
$backendJob = Start-Job -ScriptBlock {
    Set-Location $using:PSScriptRoot\backend
    $env:GEMINI_API_KEY = $using:GeminiKey
    python main.py
}

Start-Sleep -Seconds 2

Write-Host "✅ Backend running at http://localhost:8000" -ForegroundColor Green
Write-Host "📖 API docs:        http://localhost:8000/docs" -ForegroundColor Gray
Write-Host ""

# Start React frontend
Write-Host "→ Starting React frontend on http://localhost:3000 ..." -ForegroundColor White
Set-Location frontend
npm run dev

# Cleanup on exit
Stop-Job $backendJob
Remove-Job $backendJob
