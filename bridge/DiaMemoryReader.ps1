<#
  DiaMemoryReader.ps1 - reads the decrypted Ladder program from a running
  DIADesigner process's heap via ClrMD and writes it as JSON to -Out.

  DIADesigner stores program logic AES-encrypted (runtime-derived key, not
  recoverable offline), but an open project holds the objects decrypted in
  memory. This attaches read-only (non-invasive) and reconstructs the networks.

  Must run in 32-bit PowerShell to match the x86 DIADesigner process.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][int]$TargetPid,
  [Parameter(Mandatory=$true)][string]$Out,
  [int]$MaxNetworks = 8000,
  [switch]$OnlyCommented,
  [string]$PouName = '',
  [switch]$ListPous,
  [switch]$RunPou,
  [string]$PouNamesFile = ''
)
$ErrorActionPreference='Continue'

$clrmd = Join-Path $PSScriptRoot 'clrmd'
$deltaDir = 'C:\Program Files (x86)\Delta Industrial Automation\DIAStudio\DIADesigner 1.14'

# Resolve ClrMD's dependencies by simple name (their assembly versions never
# match what a plain .NET Framework host offers), guarding against recursion.
$script:resolving = @{}
$resolver = [System.ResolveEventHandler]{
  param($sender, $e)
  $simple = $e.Name.Split(',')[0]
  if ($script:resolving.ContainsKey($simple)) { return $null }
  $script:resolving[$simple] = $true
  try {
    foreach ($dir in @($clrmd, $deltaDir)) {
      $cand = Join-Path $dir ($simple + '.dll')
      if (Test-Path $cand) { try { return [Reflection.Assembly]::LoadFrom($cand) } catch { return $null } }
    }
    return $null
  } finally { $script:resolving.Remove($simple) }
}
[AppDomain]::CurrentDomain.add_AssemblyResolve($resolver)

$clrmdDll = Join-Path $clrmd 'Microsoft.Diagnostics.Runtime.dll'
if (-not (Test-Path $clrmdDll)) {
  [IO.File]::WriteAllText($Out, '{"ok":false,"error":"ClrMD not found in bridge/clrmd"}', (New-Object Text.UTF8Encoding($false)))
  exit 0
}
[Reflection.Assembly]::LoadFrom($clrmdDll) | Out-Null

try {
  $src = Get-Content (Join-Path $PSScriptRoot 'DiaMemoryReader.cs') -Raw
  Add-Type -TypeDefinition $src -ReferencedAssemblies @($clrmdDll, (Join-Path $clrmd 'System.Collections.Immutable.dll')) -Language CSharp
} catch {
  [IO.File]::WriteAllText($Out, ('{"ok":false,"error":"compile failed: ' + ($_.Exception.Message -replace '"','\"' -replace "[\r\n]",' ') + '"}'), (New-Object Text.UTF8Encoding($false)))
  exit 0
}

try {
  if ($ListPous) {
    $json = [DiaMemoryReader]::ListPous($TargetPid)
  } elseif ($RunPou -and $PouNamesFile) {
    $names = [IO.File]::ReadAllLines($PouNamesFile)
    $json = [DiaMemoryReader]::RunPous($TargetPid, $names, $MaxNetworks, [bool]$OnlyCommented)
  } elseif ($RunPou) {
    $json = [DiaMemoryReader]::RunPou($TargetPid, $PouName, $MaxNetworks, [bool]$OnlyCommented)
  } else {
    $json = [DiaMemoryReader]::Run($TargetPid, $MaxNetworks, [bool]$OnlyCommented, $PouName)
  }
  [IO.File]::WriteAllText($Out, $json, (New-Object Text.UTF8Encoding($false)))
} catch {
  [IO.File]::WriteAllText($Out, ('{"ok":false,"error":"read failed: ' + (($_.Exception.GetBaseException().Message) -replace '"','\"' -replace "[\r\n]",' ') + '"}'), (New-Object Text.UTF8Encoding($false)))
}
