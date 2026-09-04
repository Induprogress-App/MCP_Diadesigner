<#
  DeltaBridge.ps1 - reflection bridge onto DIADesigner 1.14's own .NET assemblies.

  Delta ships no headless scripting host, but the shipped assemblies expose
  enough to decrypt project containers, parse PLC program headers and drive the
  ISP compiler. This script is the only place that knows about those types; the
  MCP server treats it as a JSON-in / JSON-out subprocess.

  The Delta libraries print diagnostics straight to stdout, so the JSON result is
  written to -Out instead. stdout is noise and must be ignored by the caller.

  Run it with the 32-bit PowerShell: the DIADesigner assemblies are x86.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Command,
  [Parameter(Mandatory = $true)][string]$InstallDir,
  [Parameter(Mandatory = $true)][string]$Out,
  [string]$Path = '',
  [string]$Arg = ''
)

$ErrorActionPreference = 'Continue'

function Write-Result([hashtable]$Value) {
  $json = $Value | ConvertTo-Json -Depth 20 -Compress:$false
  [System.IO.File]::WriteAllText($Out, $json, (New-Object System.Text.UTF8Encoding($false)))
}

function Fail([string]$Message, [string]$Detail = '') {
  Write-Result @{ ok = $false; error = $Message; detail = $Detail }
  exit 0
}

if (-not (Test-Path $InstallDir)) { Fail "Install directory not found: $InstallDir" }
Set-Location $InstallDir

# Delta assemblies resolve their siblings relative to the install dir, not to the
# PowerShell host, so probing has to be wired up manually.
$resolver = [System.ResolveEventHandler] {
  param($sender, $e)
  $simple = $e.Name.Split(',')[0]
  foreach ($sub in @('', 'lib\', 'PluginView\')) {
    $candidate = Join-Path $InstallDir ($sub + $simple + '.dll')
    if (Test-Path $candidate) {
      try { return [Reflection.Assembly]::LoadFrom($candidate) } catch { return $null }
    }
  }
  return $null
}
[AppDomain]::CurrentDomain.add_AssemblyResolve($resolver)

function Load-Delta([string]$Name) {
  $dll = Join-Path $InstallDir $Name
  if (-not (Test-Path $dll)) { Fail "Assembly not found: $Name" }
  try { return [Reflection.Assembly]::LoadFrom($dll) }
  catch { Fail "Failed to load $Name" $_.Exception.Message }
}

switch ($Command) {

  # ---------------------------------------------------------------- detect ---
  'detect' {
    $exe = Join-Path $InstallDir 'DIADesigner.exe'
    $version = $null
    if (Test-Path $exe) { $version = (Get-Item $exe).VersionInfo.ProductVersion }
    $assemblies = @{}
    foreach ($n in @(
      'DeltaIA.DIAStudio.ProjectFile.Latest.dll',
      'DeltaIA.DIAStudio.IspProgramming.dll',
      'DeltaIA.DIAStudio.Programming.Project.dll',
      'DeltaIA.DIAStudio.Programming.Compilation.dll',
      'Delta.PLC.Common.Utility.dll')) {
      $assemblies[$n] = (Test-Path (Join-Path $InstallDir $n))
    }
    Write-Result @{
      ok = $true
      installDir = $InstallDir
      productVersion = $version
      bitness = $(if ([IntPtr]::Size -eq 4) { 'x86' } else { 'x64' })
      clrVersion = [string][Environment]::Version
      assemblies = $assemblies
    }
  }

  # ------------------------------------------------------- read-project ------
  # Decrypts a native .diade container and returns its solution/device tree.
  # 1.14 writes Base64-armoured containers; 1.13 wrote raw binary and this call
  # fails on those by design (migrate the project in the UI first).
  'read-project' {
    if (-not (Test-Path $Path)) { Fail "Project file not found: $Path" }
    Load-Delta 'DeltaIA.DIAStudio.ProjectFile.Latest.dll' | Out-Null
    $mgmt = [DeltaIA.DIAStudio.ProjectFile.Latest.ProjectFileManagement]
    $result = $null
    try { $result = $mgmt::GetProjectFileStringAfterDecrypt($Path) }
    catch { Fail 'Decrypt call threw' $_.Exception.GetBaseException().Message }

    if (-not $result.Result) {
      $hint = ''
      try {
        $head = [System.IO.File]::ReadAllBytes($Path)[0..15]
        $printable = ($head | Where-Object { $_ -ge 43 -and $_ -le 122 }).Count
        if ($printable -lt 12) {
          $hint = 'Container is raw binary (DIADesigner 1.13 format). Open the project in DIADesigner 1.14 and save it, or use Project Migrate, then retry.'
        }
      } catch {}
      Write-Result @{ ok = $false; error = [string]$result.ErrorMessage; hint = $hint; path = $Path }
      exit 0
    }

    $raw = [string]$result.ReturnValue
    $decoded = $null
    try { $decoded = $raw | ConvertFrom-Json } catch { Fail 'Decrypted payload is not JSON' $_.Exception.Message }

    $projects = @()
    foreach ($project in @($decoded.Solution.ProjectList)) {
      $devices = @()
      foreach ($device in @($project.DeviceList)) {
        $devices += [ordered]@{
          name = $device.Name
          id = $device.ID
          productClass = $device.ProductClass
          productCode = $device.ProductCode
          currentVersion = $device.CurrentVersion
          relativePath = $device.RelativePath
        }
      }
      $projects += [ordered]@{
        fileName = $project.FileName
        relativeDir = $project.RelativeDir
        author = $project.ProjectAuthor
        company = $project.ProjectCompany
        deviceCount = $devices.Count
        devices = $devices
      }
    }

    Write-Result @{
      ok = $true
      path = $Path
      projectFileVersion = $decoded.PROJECT_FILE_VERSION
      name = $decoded.Name
      projectVersion = $decoded.ProjectVersion
      savingTimeStamp = $decoded.Solution.SavingTimeStamp
      projects = $projects
      rawLength = $raw.Length
    }
  }

  # ----------------------------------------------------- program-header ------
  # PLC.prog / PLC.diaobj carry a 164-byte header that Delta obfuscates with a
  # positional XOR. Field offsets come from ProjectFileHeaderLocation, so they
  # track the installed version instead of being hard-coded here.
  'program-header' {
    if (-not (Test-Path $Path)) { Fail "Program container not found: $Path" }
    Load-Delta 'DeltaIA.DIAStudio.Programming.Compilation.dll' | Out-Null
    $locType = [DeltaIA.DIAStudio.Programming.Compilation.IspSystem.ProjectFileHeaderLocation]
    $gen = [DeltaIA.DIAStudio.Programming.Compilation.IspSystem.ProjectFileHeaderGenerator]

    $offsets = @{}
    foreach ($f in $locType.GetFields([Reflection.BindingFlags]'Public,NonPublic,Static')) {
      try { $offsets[$f.Name] = [int]$f.GetValue($null) } catch {}
    }

    $bytes = [System.IO.File]::ReadAllBytes($Path)
    $copy = New-Object byte[] $bytes.Length
    [Array]::Copy($bytes, $copy, $bytes.Length)
    try { $gen::Decrypt($copy) } catch { Fail 'Header decrypt failed' $_.Exception.GetBaseException().Message }

    function Get-Int32([byte[]]$buf, [int]$off) {
      if ($off -lt 0 -or ($off + 4) -gt $buf.Length) { return $null }
      return [BitConverter]::ToInt32($buf, $off)
    }

    $keys = @('Version', 'ProjectSize', 'ProjectStartPos', 'ExeCodeSize', 'AnsiCodePage')
    $decryptedFields = [ordered]@{}
    $rawFields = [ordered]@{}
    foreach ($key in $keys) {
      if ($offsets.ContainsKey($key)) {
        $decryptedFields[$key] = Get-Int32 $copy $offsets[$key]
        $rawFields[$key] = Get-Int32 $bytes $offsets[$key]
      }
    }

    # A container this small cannot hold offsets larger than itself; use that to
    # tell a genuine header from noise instead of reporting whichever we decoded.
    function Test-Plausible($fields, [int]$size) {
      foreach ($key in @('ProjectSize', 'ProjectStartPos', 'ExeCodeSize')) {
        $v = $fields[$key]
        if ($null -eq $v) { continue }
        if ($v -lt 0 -or $v -gt $size) { return $false }
      }
      return $true
    }

    $decryptedOk = Test-Plausible $decryptedFields $bytes.Length
    $rawOk = Test-Plausible $rawFields $bytes.Length
    $chosen = if ($decryptedOk) { 'decrypted' } elseif ($rawOk) { 'raw' } else { 'none' }
    $fields = if ($chosen -eq 'raw') { $rawFields } else { $decryptedFields }

    $notes = @(
      'Header field offsets come from ProjectFileHeaderLocation in the installed DIADesigner.',
      'Header bytes are obfuscated with a positional XOR (ProjectFileHeaderGenerator.Decrypt).',
      'The project payload past ProjectStartPos stays AES-encrypted; use load-program to decode it.'
    )
    if ($chosen -eq 'none') {
      $notes += 'WARNING: no header interpretation yields offsets that fit inside the file. The container is probably truncated or corrupt; the values below are not trustworthy.'
    }

    Write-Result @{
      ok = $true
      path = $Path
      size = $bytes.Length
      headerLength = $offsets['HeaderLength']
      headerPlausible = ($chosen -ne 'none')
      headerSource = $chosen
      headerOffsets = $offsets
      headerFields = $fields
      headerFieldsDecrypted = $decryptedFields
      headerFieldsRaw = $rawFields
      rawHeadHex = (($bytes[0..31] | ForEach-Object { $_.ToString('x2') }) -join ' ')
      notes = $notes
    }
  }

  # -------------------------------------------------------- load-program -----
  # Drives Delta's own loader. ProgrammingProjectBase swallows its errors and
  # leaves ProgrammingProjectFunction null on failure, so success is detected by
  # inspecting the object rather than by catching.
  'load-program' {
    if (-not (Test-Path $Path)) { Fail "Program container not found: $Path" }
    Load-Delta 'DeltaIA.DIAStudio.IspProgramming.dll' | Out-Null
    $type = [DeltaIA.DIAStudio.IspProgramming.Device.ProgrammingProjectBase]

    $obj = $null
    try { $obj = [Activator]::CreateInstance($type) }
    catch { Fail 'Could not instantiate ProgrammingProjectBase' $_.Exception.GetBaseException().Message }

    $loadError = ''
    try { $obj.Load($Path) }
    catch { $loadError = $_.Exception.GetBaseException().Message }

    $fn = $null
    try { $fn = $obj.ProgrammingProjectFunction } catch {}

    if (-not $fn) {
      Write-Result @{
        ok = $false
        path = $Path
        error = 'DIADesigner loaded the container but produced no programming project.'
        loadError = $loadError
        hint = 'This normally means the container is corrupt, belongs to an older DIADesigner, or the file is not a PLC program container.'
      }
      exit 0
    }

    $project = $null
    try { $project = $fn.ProgrammingProject } catch {}
    $pous = @()
    $duts = @()
    if ($project) {
      try {
        foreach ($p in $project.PouManager.PouList) {
          $pous += [ordered]@{
            name = [string]$p.Name
            pouType = [string]$p.PouType
            language = [string]$p.Language
          }
        }
      } catch {}
      try {
        foreach ($d in $project.DutManager.DataTypeList) {
          $duts += [string]$d.Name
        }
      } catch {}
    }

    Write-Result @{
      ok = $true
      path = $Path
      loadError = $loadError
      pouCount = $pous.Count
      pous = $pous
      dataTypes = $duts
    }
  }

  # -------------------------------------------------------------- compile ----
  'compile' {
    if (-not (Test-Path $Path)) { Fail "Program container not found: $Path" }
    Load-Delta 'DeltaIA.DIAStudio.IspProgramming.dll' | Out-Null
    $type = [DeltaIA.DIAStudio.IspProgramming.Device.ProgrammingProjectBase]
    $obj = $null
    try { $obj = [Activator]::CreateInstance($type) }
    catch { Fail 'Could not instantiate ProgrammingProjectBase' $_.Exception.GetBaseException().Message }

    $loadError = ''
    try { $obj.Load($Path) } catch { $loadError = $_.Exception.GetBaseException().Message }
    $fn = $null
    try { $fn = $obj.ProgrammingProjectFunction } catch {}
    if (-not $fn) {
      Write-Result @{ ok = $false; path = $Path; error = 'Project did not load; nothing to compile.'; loadError = $loadError }
      exit 0
    }

    $checkError = ''
    $compileError = ''
    if ($Arg -eq 'check') {
      try { $obj.Check() } catch { $checkError = $_.Exception.GetBaseException().Message }
    } else {
      try { $obj.Compile() } catch { $compileError = $_.Exception.GetBaseException().Message }
    }

    Write-Result @{
      ok = ($checkError -eq '' -and $compileError -eq '')
      path = $Path
      mode = $(if ($Arg -eq 'check') { 'check' } else { 'compile' })
      loadError = $loadError
      checkError = $checkError
      compileError = $compileError
    }
  }

  default { Fail "Unknown command: $Command" }
}
