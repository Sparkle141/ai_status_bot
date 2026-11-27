@echo off
chcp 65001 >nul
setlocal
set "BASE_DIR=%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
  "$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false);" ^
  "$pkg = Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction SilentlyContinue | Select-Object -First 1;" ^
  "$nodeExe = if ($pkg) { Join-Path $pkg.InstallLocation 'app\resources\cua_node\bin\node.exe' } else { (Get-Command node -ErrorAction SilentlyContinue).Source };" ^
  "if (-not $nodeExe -or -not (Test-Path $nodeExe)) { Write-Host 'node.exe를 찾을 수 없습니다.'; exit 1 };" ^
  "$render = Join-Path '%BASE_DIR%' 'collector\render-cli.mjs';" ^
  "while ($true) {" ^
  "  $procs = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^(codex|ChatGPT|claude|cowork-svc|Antigravity|agy|language_server|cursor|ollama|lm-studio|windsurf|gemini|aider|opencode)\.exe$' };" ^
  "  $s = @{ codexAppCount=0; codexAppServerPids=@(); codexExecServerPids=@(); codexCliOtherPids=@(); claudeDesktopCount=0; claudeCliPids=@(); coworkSvcPids=@(); antigravityCount=0; agyCliPids=@(); languageServerCount=0; otherAiProcs=@() };" ^
  "  foreach ($p in $procs) { $c=[string]$p.CommandLine; if ($p.Name -eq 'ChatGPT.exe' -and $c -match 'OpenAI\.Codex') { $s.codexAppCount++ } elseif ($p.Name -eq 'codex.exe') { if ($c -match '\bapp-server\b') { $s.codexAppServerPids+=[int]$p.ProcessId } elseif ($c -match '\bexec-server\b') { $s.codexExecServerPids+=[int]$p.ProcessId } else { $s.codexCliOtherPids+=[int]$p.ProcessId } } elseif ($p.Name -eq 'claude.exe') { if ($c -match 'WindowsApps\\AnthropicPBC\.Claude|AnthropicClaude\\app-|--user-data-dir=|--type=') { $s.claudeDesktopCount++ } else { $s.claudeCliPids+=[int]$p.ProcessId } } elseif ($p.Name -eq 'cowork-svc.exe') { $s.coworkSvcPids+=[int]$p.ProcessId } elseif ($p.Name -eq 'Antigravity.exe') { $s.antigravityCount++ } elseif ($p.Name -eq 'agy.exe') { $s.agyCliPids+=[int]$p.ProcessId } elseif ($p.Name -eq 'language_server.exe') { $s.languageServerCount++ } else { $s.otherAiProcs += @{ name=$p.Name; pid=[int]$p.ProcessId } } };" ^
  "  $env:AI_PROC_JSON = ($s | ConvertTo-Json -Compress -Depth 4);" ^
  "  $out = & $nodeExe $render 2>&1 | Out-String;" ^
  "  Clear-Host; Write-Output $out.TrimEnd(); Write-Output ''; Write-Output '[안내] 5초마다 자동 갱신됩니다. 종료하려면 Ctrl+C를 누르세요.';" ^
  "  Start-Sleep -Seconds 5" ^
  "}"
