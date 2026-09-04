<#
  DiaExplore.ps1 - read-only UI Automation probe. Attaches to a running
  DIADesigner window, optionally right-clicks a node matched by an
  AutomationId regex, and dumps the resulting automation tree (Name,
  AutomationId, ControlType, BoundingRectangle) to -Out. Presses Escape
  afterward to close any menu it opened. Makes no other changes.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$TitleMatch,
  [Parameter(Mandatory = $true)][string]$OutFile,
  [string]$RightClickAidRegex,      # e.g. '\.Programming$' -- right-click this node first
  [string]$RightClickOffsetX = "170",
  [switch]$DumpWholeWindow,          # if set, dump the whole window tree instead of just the popup
  [string]$FilterNameRegex,          # optional: only keep items whose Name matches (case-insensitive)
  [string]$FilterAidRegex,           # optional: only keep items whose AutomationId matches
  [int]$TimeoutSec = 30
)

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
}
"@

$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$TRUE_COND = [System.Windows.Automation.Condition]::TrueCondition

function Write-Result([hashtable]$h) {
  [System.IO.File]::WriteAllText($OutFile, ($h | ConvertTo-Json -Depth 6), (New-Object System.Text.UTF8Encoding($false)))
}
function Fail($msg) { Write-Result @{ ok = $false; error = $msg }; exit 0 }

function Get-MainWindow([int]$procId) {
  foreach ($el in $AE::RootElement.FindAll($TS::Children, $TRUE_COND)) {
    try { if ($el.Current.ProcessId -eq $procId) { return $el } } catch {}
  }
  return $null
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
# are absent from the automation tree. Scroll it to the top so nodes materialise.
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

function Dump-Tree($root, [int]$maxCount) {
  # Depth isn't meaningful via FindAll(Descendants) (it's a flat result set,
  # order roughly matches tree order) but this is the API proven to work in
  # this environment -- TreeWalker.RawViewWalker returned null here.
  $items = New-Object System.Collections.Generic.List[object]
  $all = @()
  try { $all = $root.FindAll($TS::Descendants, $TRUE_COND) } catch {}
  $n = 0
  foreach ($el in $all) {
    if ($n -ge $maxCount) { break }
    try {
      $c = $el.Current
      $r = $c.BoundingRectangle
      $items.Add(@{
        name = $c.Name
        aid = $c.AutomationId
        controlType = $c.ControlType.ProgrammaticName
        isEnabled = $c.IsEnabled
        x = [int]$r.X; y = [int]$r.Y; w = [int]$r.Width; h = [int]$r.Height
      })
      $n++
    } catch {}
  }
  return ,$items
}

$proc = $null
foreach ($p in (Get-Process DIADesigner -ErrorAction SilentlyContinue)) {
  if ($p.MainWindowTitle -match [regex]::Escape($TitleMatch)) { $proc = $p; break }
}
if (-not $proc) { Fail("no DIADesigner window matching '$TitleMatch'") }

$win = Get-MainWindow $proc.Id
if (-not $win) { Fail("main window not found for pid $($proc.Id)") }
try { [Win]::ForceFront([IntPtr]$win.Current.NativeWindowHandle) } catch {}
try {
  $wp = $win.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern)
  $wp.SetWindowVisualState([System.Windows.Automation.WindowVisualState]::Maximized)
} catch {}
Start-Sleep -Milliseconds 800

Scroll-TreeTop $win | Out-Null

if ($DumpWholeWindow) {
  $items = Dump-Tree $win 1500
  if ($FilterNameRegex) { $items = @($items | Where-Object { $_.name -match $FilterNameRegex }) }
  if ($FilterAidRegex) { $items = @($items | Where-Object { $_.aid -match $FilterAidRegex }) }
  Write-Result @{ ok = $true; pid = $proc.Id; mode = "whole-window"; count = $items.Count; items = $items }
  exit 0
}

if (-not $RightClickAidRegex) { Fail("either -RightClickAidRegex or -DumpWholeWindow is required") }

Scroll-TreeTop $win | Out-Null
$node = Find-Desc $win $RightClickAidRegex $null
if (-not $node) { Fail("node matching '$RightClickAidRegex' not found") }
$r = $node.Current.BoundingRectangle
$px = [int]($r.X + [int]$RightClickOffsetX)
$py = [int]($r.Y + $r.Height / 2)

[Win]::Left($px, $py)
Start-Sleep -Milliseconds 400
[Win]::Right($px, $py)
Start-Sleep -Milliseconds 1200

# The context menu is usually a separate popup window (owned, topmost), not a
# descendant of the main window -- enumerate top-level children of the desktop
# and pick the one(s) that look like a menu.
$menuItems = New-Object System.Collections.Generic.List[object]
foreach ($top in $AE::RootElement.FindAll($TS::Children, $TRUE_COND)) {
  try {
    $ct = $top.Current.ControlType.ProgrammaticName
    if ($ct -notmatch 'Menu|Window') { continue }
    if ($top.Current.ProcessId -ne $proc.Id) { continue }
  } catch { continue }
  $items = Dump-Tree $top 400
  foreach ($it in $items) { $menuItems.Add($it) }
}

[System.Windows.Forms.SendKeys]::SendWait("{ESC}")

Write-Result @{ ok = $true; pid = $proc.Id; mode = "context-menu"; clickedAt = @($px,$py); count = $menuItems.Count; items = $menuItems }
