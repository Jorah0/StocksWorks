# Creates Desktop + Start Menu shortcuts for StocksWorks (host) and StocksWorks Rig (remote miner).
# Run: npm run shortcuts        On a remote mining machine: npm run shortcuts -- -RigOnly
param([switch]$RigOnly)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node).Source
$shell = New-Object -ComObject WScript.Shell
$targets = @(
  @{ Name = 'StocksWorks'; Script = 'desktop.js'; Desc = 'StocksWorks trading desk'; IsHost = $true },
  @{ Name = 'StocksWorks Rig'; Script = 'rig\agent.js'; Desc = 'StocksWorks mining rig agent'; IsHost = $false }
) | Where-Object { -not $RigOnly -or -not $_.IsHost }

$dirs = @([Environment]::GetFolderPath('Desktop'), (Join-Path ([Environment]::GetFolderPath('Programs')) 'StocksWorks'))
foreach ($d in $dirs) { New-Item -ItemType Directory -Force $d | Out-Null }

foreach ($t in $targets) {
  foreach ($d in $dirs) {
    $lnk = $shell.CreateShortcut((Join-Path $d "$($t.Name).lnk"))
    $lnk.TargetPath = $node
    $lnk.Arguments = "`"$(Join-Path $root $t.Script)`""
    $lnk.WorkingDirectory = $root
    $lnk.Description = $t.Desc
    $lnk.WindowStyle = 7   # minimized console; the app opens in its own window
    $lnk.Save()
    Write-Host "Created $($lnk.FullName)"
  }
}
