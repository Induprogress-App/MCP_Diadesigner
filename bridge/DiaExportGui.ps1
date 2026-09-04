<#
  DiaExportGui.ps1 - drives DIADesigner 1.14 through UI Automation to export a
  project's program to a native .export file.

  DIADesigner has no headless/scriptable export: the only export path is the GUI
  (right-click the Programming node -> Export -> pick objects -> OK -> Save As).
  This script automates exactly that, verified by hand first.

  Requirements: an interactive, UNLOCKED desktop session. WPF does not render on
  the lock screen, so the Project Explorer / dialog trees never materialise in
  the UIAutomation tree there.

  Result JSON is written to -Out (stdout is noisy WPF chatter).
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$DiaExe,
  [Parameter(Mandatory = $true)][string]$ProjectDiade,
  [Parameter(Mandatory = $true)][string]$OutFile,       # result JSON
  [Parameter(Mandatory = $true)][string]$ExportPath,    # .export to produce
  [int]$TimeoutSec = 180
)

# Elements vanish from the automation tree as views change; treat that as normal
# rather than fatal, and guard the genuinely required steps explicitly.
$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms, System.Drawing

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint x,uint y,uint d,IntPtr e);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int n);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk,byte scan,uint flags,IntPtr extra);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  public const uint LDOWN=2, LUP=4, RDOWN=8, RUP=16;
  // A process that is not already foreground cannot normally call
  // SetForegroundWindow (Windows foreground lock). Attaching to the current
  // foreground thread and nudging ALT lifts that lock so clicks land in DIADesigner.
  public static void ForceFront(IntPtr h){
    uint pid;
    uint fg = GetWindowThreadProcessId(GetForegroundWindow(), out pid);
    uint me = GetCurrentThreadId();
    AttachThreadInput(me, fg, true);
    ShowWindow(h,3);
    keybd_event(0x12,0,0,IntPtr.Zero); SetForegroundWindow(h); keybd_event(0x12,0,2,IntPtr.Zero);
    AttachThreadInput(me, fg, false);
  }
  public static void Left(int x,int y){ SetCursorPos(x,y); System.Threading.Thread.Sleep(110); mouse_event(LDOWN,0,0,0,IntPtr.Zero); mouse_event(LUP,0,0,0,IntPtr.Zero); }
  public static void Right(int x,int y){ SetCursorPos(x,y); System.Threading.Thread.Sleep(110); mouse_event(RDOWN,0,0,0,IntPtr.Zero); mouse_event(RUP,0,0,0,IntPtr.Zero); }
  public static void Dbl(int x,int y){ SetCursorPos(x,y); System.Threading.Thread.Sleep(90); mouse_event(LDOWN,0,0,0,IntPtr.Zero); mouse_event(LUP,0,0,0,IntPtr.Zero); System.Threading.Thread.Sleep(90); mouse_event(LDOWN,0,0,0,IntPtr.Zero); mouse_event(LUP,0,0,0,IntPtr.Zero); }
}
"@

$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$TRUE_COND = [System.Windows.Automation.Condition]::TrueCondition

$steps = New-Object System.Collections.Generic.List[string]
function Note($m) { $steps.Add($m) }

function Write-Result([hashtable]$h) {
  $h['steps'] = $steps
  [System.IO.File]::WriteAllText($OutFile, ($h | ConvertTo-Json -Depth 8), (New-Object System.Text.UTF8Encoding($false)))
}
function Fail($msg) { Write-Result @{ ok = $false; error = $msg }; exit 0 }

function Get-MainWindow([int]$procId) {
  foreach ($el in $AE::RootElement.FindAll($TS::Children, $TRUE_COND)) {
    try { if ($el.Current.ProcessId -eq $procId) { return $el } } catch {}
  }
  return $null
}

function Front($win) {
  try { [Win]::ForceFront([IntPtr]$win.Current.NativeWindowHandle) } catch {}
  try {
    $wp = $win.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern)
    $wp.SetWindowVisualState([System.Windows.Automation.WindowVisualState]::Maximized)
  } catch {}
  Start-Sleep -Milliseconds 800
}

function Find-Desc($root, [string]$aidRegex, [string]$nameRegex) {
  $all = @()
  try { $all = $root.FindAll($TS::Descendants, $TRUE_COND) } catch { return $null }
  foreach ($el in $all) {
    try {
      $c = $el.Current
      if ($aidRegex -and $c.AutomationId -notmatch $aidRegex) { continue }
      if ($nameRegex -and $c.Name -notmatch $nameRegex) { continue }
      return $el
    } catch {}
  }
  return $null
}

function Center($el) {
  $r = $el.Current.BoundingRectangle
  return @([int]($r.X + $r.Width / 2), [int]($r.Y + $r.Height / 2))
}

# The Project Explorer is a virtualized WPF TreeView: nodes scrolled out of view
# are absent from the automation tree. Scroll it to the top so the Programming
# node materialises before we look for it.
function Scroll-TreeTop($win) {
  $all = @()
  try { $all = $win.FindAll($TS::Descendants, $TRUE_COND) } catch { return $false }
  foreach ($el in $all) {
    try {
      if ($el.Current.ControlType.ProgrammaticName -notmatch 'Tree$') { continue }
      $sp = $el.GetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern)
      if ($sp.Current.VerticallyScrollable) {
        $sp.SetScrollPercent([System.Windows.Automation.ScrollPattern]::NoScroll, 0)
        Start-Sleep -Milliseconds 600
        return $true
      }
    } catch {}
  }
  return $false
}

function Wait-Window([int]$procId, [string]$titleRegex, [int]$sec) {
  $deadline = (Get-Date).AddSeconds($sec)
  while ((Get-Date) -lt $deadline) {
    $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
    if ($p -and $p.MainWindowTitle -match $titleRegex) { return $true }
    Start-Sleep -Milliseconds 800
  }
  return $false
}

# ---------------------------------------------------------------- launch ----
$projName = [System.IO.Path]::GetFileNameWithoutExtension($ProjectDiade)
$proc = $null

# Reuse an already-open instance of this project if present.
foreach ($p in (Get-Process DIADesigner -ErrorAction SilentlyContinue)) {
  if ($p.MainWindowTitle -match [regex]::Escape($projName)) { $proc = $p; break }
}
if (-not $proc) {
  Note("launching DIADesigner with project")
  $proc = Start-Process -FilePath $DiaExe -ArgumentList "`"$ProjectDiade`"" -PassThru
  if (-not (Wait-Window $proc.Id ([regex]::Escape($projName)) $TimeoutSec)) {
    Fail("project window did not appear within $TimeoutSec s")
  }
  Start-Sleep -Seconds 5
} else {
  Note("reusing open instance pid=$($proc.Id)")
}

$win = Get-MainWindow $proc.Id
if (-not $win) { Fail("main window not found for pid $($proc.Id)") }
Front $win

# ---------------------------------------------------------------- open editor ----
# Launching with a .diade path lands on the Project start page; the editor tree
# (with the Programming node) only appears after the recent-project row is
# activated. If the Programming node is already present we are past that.
Scroll-TreeTop $win | Out-Null
$prog = Find-Desc $win '\.Programming$' $null
if (-not $prog) {
  Note("start page detected, opening project into editor")
  $row = Find-Desc $win 'RowData.Row.ProjectName' ([regex]::Escape($projName))
  if ($row) {
    $c = Center $row
    [Win]::Dbl($c[0], $c[1])
    Start-Sleep -Seconds 6
  }
  $win = Get-MainWindow $proc.Id
  Scroll-TreeTop $win | Out-Null
  $prog = Find-Desc $win '\.Programming$' $null
}
if (-not $prog) { Fail("Programming node not found (could not open project editor)") }

# Right-click the middle of the row (label+70 lands before the text and misses
# the row; the row centre reliably raises the context menu).
$pr = $prog.Current.BoundingRectangle
$px = [int]($pr.X + 170)
$py = [int]($pr.Y + $pr.Height / 2)
Note("Programming node row at $px,$py")

# ---------------------------------------------------------------- export ----
[Win]::Left($px, $py)
Start-Sleep -Milliseconds 500
[Win]::Right($px, $py)
Start-Sleep -Milliseconds 1500

$exportBtn = $null
foreach ($try in 1..3) {
  $exportBtn = Find-Desc $win '^BOP_EXPORT$' $null
  if ($exportBtn) { break }
  Start-Sleep -Milliseconds 800
}
if (-not $exportBtn) { Fail("BOP_EXPORT not found in context menu") }
$c = Center $exportBtn
[Win]::Left($c[0], $c[1])
Note("clicked Export")
Start-Sleep -Seconds 2

# Export dialog: objects are pre-checked at the root; just confirm with OK.
$dlg = Find-Desc $win $null '^Export$'
if (-not $dlg) { Fail("Export dialog did not open") }
$okBtn = $null
foreach ($el in $dlg.FindAll($TS::Descendants, $TRUE_COND)) {
  try { if ($el.Current.Name -eq 'OK' -and $el.Current.ControlType.ProgrammaticName -match 'Button') { $okBtn = $el; break } } catch {}
}
if (-not $okBtn) { Fail("OK button not found in Export dialog") }
$c = Center $okBtn
[Win]::Left($c[0], $c[1])
Note("confirmed Export dialog")
Start-Sleep -Seconds 3

# Save As: type the full path and Save.
$saveWin = Find-Desc $win $null '^Save As$'
if (-not $saveWin) { Fail("Save As dialog did not open") }
$nameField = Find-Desc $saveWin '^1001$' $null
if (-not $nameField) { $nameField = Find-Desc $saveWin 'FileNameControlHost' $null }
if (-not $nameField) { Fail("file name field not found in Save As") }
$c = Center $nameField
[Win]::Left($c[0], $c[1])
Start-Sleep -Milliseconds 300
[System.Windows.Forms.SendKeys]::SendWait("^a")
Start-Sleep -Milliseconds 150
# SendKeys treats some chars specially; a raw file path is safe.
[System.Windows.Forms.SendKeys]::SendWait($ExportPath)
Start-Sleep -Milliseconds 400
$saveBtn = Find-Desc $saveWin '^1$' '^Save$'
if (-not $saveBtn) { $saveBtn = Find-Desc $saveWin $null '^Save$' }
if (-not $saveBtn) { Fail("Save button not found in Save As") }
$c = Center $saveBtn
[Win]::Left($c[0], $c[1])
Note("clicked Save")
Start-Sleep -Seconds 4

# Confirm overwrite if prompted.
$confirm = Find-Desc $win $null '^(Yes|Tak)$'
if ($confirm) { $c = Center $confirm; [Win]::Left($c[0], $c[1]); Note("confirmed overwrite"); Start-Sleep -Seconds 3 }

# ---------------------------------------------------------------- verify ----
$deadline = (Get-Date).AddSeconds(30)
$done = $false
while ((Get-Date) -lt $deadline) {
  if (Test-Path $ExportPath) { $done = $true; break }
  Start-Sleep -Milliseconds 800
}
if ($done) {
  $info = Get-Item $ExportPath
  Write-Result @{ ok = $true; exportPath = $ExportPath; size = $info.Length; pid = $proc.Id }
} else {
  Fail("export file was not created at $ExportPath")
}
