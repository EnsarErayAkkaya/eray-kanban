# Agent Kanban in the Windows tray: runs the server with no window and stops it cleanly from the menu.
# Started by the desktop shortcut (npm run shortcut). -WriteIcon only saves the icon file and exits.
param([string]$WriteIcon)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing

# Three board columns; the short amber one is the lane that waits on you.
function New-KanbanBitmap([int]$Size) {
  $bmp = [System.Drawing.Bitmap]::new($Size, $Size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.Clear([System.Drawing.Color]::Transparent)
  $u = $Size / 32
  $cobalt = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(47, 91, 234))
  $amber = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(217, 154, 0))
  $g.FillRectangle($cobalt, 2 * $u, 3 * $u, 8 * $u, 26 * $u)
  $g.FillRectangle($cobalt, 12 * $u, 3 * $u, 8 * $u, 18 * $u)
  $g.FillRectangle($amber, 22 * $u, 3 * $u, 8 * $u, 11 * $u)
  $g.Dispose()
  return $bmp
}

if ($WriteIcon) {
  # An .ico holding one PNG image: sharp at every size Windows scales it to.
  $png = [System.IO.MemoryStream]::new()
  (New-KanbanBitmap 256).Save($png, [System.Drawing.Imaging.ImageFormat]::Png)
  $bytes = $png.ToArray()
  $w = [System.IO.BinaryWriter]::new([System.IO.File]::Create($WriteIcon))
  $w.Write([UInt16]0); $w.Write([UInt16]1); $w.Write([UInt16]1)
  $w.Write([Byte]0); $w.Write([Byte]0); $w.Write([Byte]0); $w.Write([Byte]0)
  $w.Write([UInt16]1); $w.Write([UInt16]32); $w.Write([UInt32]$bytes.Length); $w.Write([UInt32]22)
  $w.Write($bytes)
  $w.Close()
  exit 0
}

$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$port = if ($env:KANBAN_PORT) { $env:KANBAN_PORT } else { '4317' }
$url = "http://127.0.0.1:$port/"
$data = if ($env:KANBAN_DATA_DIR) { $env:KANBAN_DATA_DIR } else { Join-Path $repo 'data' }
$log = Join-Path $data 'server.log'

function Test-Up {
  try { return (Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 -Uri "${url}api/health").StatusCode -eq 200 } catch { return $false }
}

function Open-Board { Start-Process $url }
$autoOpen = $env:KANBAN_OPEN -ne '0'

# One tray per user: a second click on the shortcut just opens the board.
$isFirst = $false
$mutex = [System.Threading.Mutex]::new($true, 'Local\AgentKanbanTray', [ref]$isFirst)
if (-not $isFirst) {
  if ($autoOpen) { Open-Board }
  exit 0
}

# A server started from a terminal is adopted: the tray can still open and stop it.
$server = $null
if (Test-Up) {
  if ($autoOpen) { Open-Board }
} else {
  $node = (Get-Command node -ErrorAction SilentlyContinue).Source
  if (-not $node) {
    [System.Windows.Forms.MessageBox]::Show('Agent Kanban needs Node.js 24 or newer on your PATH.', 'Agent Kanban', 'OK', 'Error') | Out-Null
    exit 1
  }
  $psi = [System.Diagnostics.ProcessStartInfo]::new($node)
  $psi.Arguments = '"' + (Join-Path $repo 'node_modules\tsx\dist\cli.mjs') + '" scripts\start.ts --log'
  $psi.WorkingDirectory = $repo
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $server = [System.Diagnostics.Process]::Start($psi)
}

$state = @{ Up = $false; Stopping = $false; Crashed = $false; QuitAt = $null; LastCheck = [DateTime]::MinValue }

$tray = [System.Windows.Forms.NotifyIcon]::new()
$tray.Icon = [System.Drawing.Icon]::FromHandle((New-KanbanBitmap 32).GetHicon())
$tray.Text = 'Agent Kanban: starting'
$menu = [System.Windows.Forms.ContextMenuStrip]::new()
$openItem = $menu.Items.Add('Open board')
$openItem.Font = [System.Drawing.Font]::new($openItem.Font, [System.Drawing.FontStyle]::Bold)
$logItem = $menu.Items.Add('Open log')
$null = $menu.Items.Add('-')
$stopItem = $menu.Items.Add('Stop Agent Kanban')
$tray.ContextMenuStrip = $menu
$tray.Visible = $true

function Quit {
  $tray.Visible = $false
  $tray.Dispose()
  $mutex.ReleaseMutex()
  [System.Windows.Forms.Application]::Exit()
}

function Test-Alive {
  if ($server) { return -not $server.HasExited }
  return Test-Up
}

$openItem.add_Click({ Open-Board })
$tray.add_DoubleClick({ Open-Board })
$logItem.add_Click({ if (Test-Path $log) { Start-Process notepad.exe -ArgumentList "`"$log`"" } })
$tray.add_BalloonTipClicked({ if ($state.Crashed -and (Test-Path $log)) { Start-Process notepad.exe -ArgumentList "`"$log`"" } })

$stopItem.add_Click({
  $state.Stopping = $true
  $tray.Text = 'Agent Kanban: stopping'
  try {
    $token = (Get-Content -Raw -Path (Join-Path $data 'control.token')).Trim()
    $null = Invoke-WebRequest -UseBasicParsing -Method Post -TimeoutSec 5 -Headers @{ 'x-kanban-token' = $token } -Uri "${url}api/shutdown"
  } catch {}
  # The server stops its agents first; force it only if that takes too long (invariant 9).
  if ($server) {
    if (-not $server.WaitForExit(15000)) { & taskkill.exe /pid $server.Id /T /F | Out-Null }
  } else {
    $end = (Get-Date).AddSeconds(15)
    while ((Get-Date) -lt $end -and (Test-Up)) { Start-Sleep -Milliseconds 300 }
  }
  Quit
})

$timer = [System.Windows.Forms.Timer]::new()
$timer.Interval = 1000
$timer.add_Tick({
  if ($state.QuitAt) {
    if ((Get-Date) -ge $state.QuitAt) { $timer.Stop(); Quit }
    return
  }
  if ($state.Stopping) { return }
  # An adopted server is only visible over HTTP, so check it less often.
  if (-not $server -and $state.Up -and ((Get-Date) - $state.LastCheck).TotalSeconds -lt 3) { return }
  $state.LastCheck = Get-Date
  if (-not (Test-Alive)) {
    $tray.Text = 'Agent Kanban: stopped'
    # Exit code 0 is a clean stop, e.g. from `npm run stop`; anything else is worth the log.
    if ($server -and $server.ExitCode -ne 0) {
      $state.Crashed = $true
      $tray.ShowBalloonTip(8000, 'Agent Kanban stopped', "The server exited unexpectedly. Click to open its log ($log).", 'Error')
      $state.QuitAt = (Get-Date).AddSeconds(10)
    } else {
      $state.QuitAt = Get-Date
    }
    return
  }
  if (-not $state.Up -and (Test-Up)) {
    $state.Up = $true
    $tray.Text = "Agent Kanban: running on port $port"
    $tray.ShowBalloonTip(4000, 'Agent Kanban is running', 'Double-click this icon to open the board. Right-click to stop it.', 'Info')
  }
})
$timer.Start()

[System.Windows.Forms.Application]::Run()
