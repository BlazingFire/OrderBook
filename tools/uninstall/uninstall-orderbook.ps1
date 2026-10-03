<#
.SYNOPSIS
  Remove OrderBook (Master Panel, Office Panel, or both) from this Windows PC.

.DESCRIPTION
  The NSIS uninstaller removes the program folder and, by design, nothing else:
  the company's records are not the program's to take with it
  (master/electron-builder.yml, `deleteAppDataOnUninstall: false`). That is the
  right default for an upgrade and the wrong one for "get this off the machine",
  which is what this script is for. It stops the panel and its own PostgreSQL,
  runs the uninstaller, and then sweeps every place the panel is known to leave
  something: the Electron profile, the updater cache, shortcuts, registry
  entries, firewall rules and - unless -KeepData - the data folder itself,
  wherever the operator relocated it.

  Three things are deliberate:

  - Processes are stopped by their PATH under an OrderBook install folder,
    never by image name. Another PostgreSQL server may be running on this PC
    (HANDOFF.md is explicit about it) and `Stop-Process postgres` would take
    it down too.
  - Every user profile under C:\Users is swept, because the installer is
    per-machine and the panel may have been run under more than one account.
    Other users' HKCU hives are NOT loaded and edited (that means mounting
    NTUSER.DAT files while they may be in use); their Run/AppCompat values
    stay, which costs nothing but a dangling reference.
  - -DryRun prints the complete plan on any machine, installed or not, so the
    plan can be reviewed before anything is touched.

.PARAMETER Panel
  master | office | all (default all).
.PARAMETER KeepData
  Leave every data folder, the location pointer, settings.env and the
  releases drop box alone. Program, profile, caches and registry still go.
.PARAMETER Yes
  No prompts: neither the initial confirmation nor the one for the releases
  folder. This is what the desktop app and the NSIS uninstaller pass.
.PARAMETER LeftoversOnly
  Called from inside the NSIS uninstaller: the program folder is already gone
  and the uninstaller must not be run again.
.PARAMETER DryRun
  Print every action and change nothing. Never elevates.
.PARAMETER Elevated
  Internal. Set on the re-invocation that -Verb RunAs starts, so that window
  waits for a key press before closing and the log stays readable.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File uninstall-orderbook.ps1 -Panel all -DryRun
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File uninstall-orderbook.ps1 -Panel master -KeepData -Yes

.NOTES
  Written for PowerShell 2.0, which is what Windows 7 ships, because the
  Windows 7 Office build runs this same script (docs/WINDOWS7.md). Nothing
  from PowerShell 3.0 or later: JSON is read with the .NET serializer, sets are
  hashtables (case-insensitive like the paths they hold), and folders are
  picked out with PSIsContainer. electron/tests/uninstall.test.ts holds the
  script to that list.
#>
[CmdletBinding()]
param(
  [ValidateSet('master', 'office', 'all')]
  [string]$Panel = 'all',
  [switch]$KeepData,
  [switch]$Yes,
  [switch]$LeftoversOnly,
  [switch]$DryRun,
  [switch]$Elevated
)

# This script's own path, for the elevated re-run. Read here at script scope:
# inside a function $MyInvocation describes the function instead.
$scriptPath = $MyInvocation.MyCommand.Path

# Before the first cmdlet: `-NoProfile` does not stop PowerShell auto-loading a module
# from the user's own writable Documents\WindowsPowerShell\Modules, which would run in
# this (usually elevated) process. Only the system's modules, from here on. The
# installers run this script by hash from memory and set the same first thing.
$env:PSModulePath = $PSHOME + '\Modules'

Set-StrictMode -Version Latest
# Stop on the unexpected; every removal that may legitimately fail (a locked
# file, a missing key) is wrapped so it is counted and reported instead.
$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------- elevation
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
  ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin -and -not $DryRun) {
  $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $scriptPath + '"'), '-Panel', $Panel, '-Elevated')
  foreach ($flag in 'KeepData', 'Yes', 'LeftoversOnly') {
    if ((Get-Variable -Name $flag -ValueOnly)) { $argList += "-$flag" }
  }
  Write-Host 'Administrator rights are needed to remove a per-machine install; asking for them...'
  $child = Start-Process -FilePath 'powershell.exe' -ArgumentList $argList -Verb RunAs -Wait -PassThru
  exit $child.ExitCode
}

# ------------------------------------------------------------------ logging
$script:counts = @{ removed = 0; kept = 0; skipped = 0; failed = 0 }

function Note([string]$tag, [string]$message) {
  Write-Host ("[{0}] {1}" -f $tag, $message)
}

# What this script may delete. It usually runs ELEVATED, and the paths it is handed come
# from places the account's own programs can write (the registry's InstallLocation, a
# `<panel>-location.json` pointer, a redirected known folder), so a path is acted on only
# if it is plainly OrderBook's:
#   - its own name, or its parent folder's, says OrderBook (`...\OrderBook\master`,
#     `...\OrderBook Master Panel`, `orderbook-master-updater`, `OrderBook-Releases`);
#   - it is not a drive root, and neither it nor any folder above it is a link
#     (junction or symbolic link), so a delete cannot be steered somewhere else.
# A folder that fails is KEPT and said so: a data folder the operator moved to
# `E:\CompanyData` is the operator's to delete, not an elevated script's to guess.
function Get-DeleteRefusal([string]$path) {
  try { $full = [System.IO.Path]::GetFullPath($path) } catch { return 'it is not a valid path' }
  $full = $full.TrimEnd([char]92)
  $parent = [System.IO.Path]::GetDirectoryName($full)
  if (-not $parent) { return 'it is a drive root' }
  $leaf = [System.IO.Path]::GetFileName($full)
  $parentLeaf = [System.IO.Path]::GetFileName($parent.TrimEnd([char]92))
  if (($leaf -notlike '*OrderBook*') -and ($parentLeaf -notlike '*OrderBook*')) {
    return 'it is not an OrderBook folder (neither its name nor its parent folder says OrderBook)'
  }
  $walk = $full
  while ($walk) {
    # Attributes straight from the API: a folder that is not there is fine (there is
    # nothing to delete), one that cannot be read cannot be checked, so it is left alone.
    $attributes = $null
    try {
      $attributes = [System.IO.File]::GetAttributes($walk)
    } catch [System.IO.FileNotFoundException], [System.IO.DirectoryNotFoundException] {
      $attributes = $null
    } catch {
      return "$walk cannot be read, so it cannot be checked"
    }
    if ($null -ne $attributes -and ($attributes -band [System.IO.FileAttributes]::ReparsePoint)) { return "$walk is a link" }
    $walk = [System.IO.Path]::GetDirectoryName($walk)
  }
  return $null
}

# Links inside a folder that is about to be deleted are removed AS links, never followed:
# Remove-Item -Recurse in Windows PowerShell can walk through a junction and delete what it
# points at. Iterative, and never descends into a link.
function Remove-InnerLinks([string]$root) {
  if (-not (Test-Path -LiteralPath $root -PathType Container)) { return }
  $pending = New-Object System.Collections.Generic.Stack[string]
  $pending.Push($root)
  while ($pending.Count -gt 0) {
    $dir = $pending.Pop()
    foreach ($entry in @(Get-ChildItem -LiteralPath $dir -Force -ErrorAction SilentlyContinue)) {
      if ($entry.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
        if ($entry.PSIsContainer) { [System.IO.Directory]::Delete($entry.FullName, $false) } else { [System.IO.File]::Delete($entry.FullName) }
      } elseif ($entry.PSIsContainer) {
        $pending.Push($entry.FullName)
      }
    }
  }
}

function Remove-Leftover([string]$path, [string]$what) {
  if (-not $path) { return }
  $refusal = Get-DeleteRefusal $path
  if ($refusal) {
    Note 'keep' ("{0} left alone ({1}): {2}" -f $what, $refusal, $path)
    $script:counts.kept++
    return
  }
  $exists = Test-Path -LiteralPath $path
  if ($DryRun) {
    $suffix = ''
    if (-not $exists) { $suffix = ' (absent)' }
    Note 'dry-run' ("would remove {0}: {1}{2}" -f $what, $path, $suffix)
    return
  }
  if (-not $exists) {
    Note 'skip' ("{0} not present: {1}" -f $what, $path)
    $script:counts.skipped++
    return
  }
  Remove-InnerLinks $path
  Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $path) {
    Note 'fail' ("could not remove {0}: {1}" -f $what, $path)
    $script:counts.failed++
  } else {
    Note 'remove' ("{0}: {1}" -f $what, $path)
    $script:counts.removed++
  }
}

function Keep([string]$path, [string]$what) {
  Note 'keep' ("{0}: {1}" -f $what, $path)
  $script:counts.kept++
}

# Get-ItemProperty objects only carry the values a key actually has, and
# StrictMode turns a missing property into an error - so look before reading.
function Get-RegValue($item, [string]$name) {
  $prop = $item.PSObject.Properties[$name]
  if ($null -eq $prop) { return $null }
  return $prop.Value
}

# The `dataDir` a `<panel>-location.json` pointer names. The serializer is in
# .NET 3.5, which Windows 7 has built in, and in every .NET 4.x. A pointer
# without the field, or that is not a JSON object, throws, and the caller
# reads that as "no relocated folder".
function Read-DataDir([string]$file) {
  Add-Type -AssemblyName System.Web.Extensions
  $json = New-Object System.Web.Script.Serialization.JavaScriptSerializer
  $parsed = $json.DeserializeObject([IO.File]::ReadAllText($file))
  if (-not $parsed.ContainsKey('dataDir')) { return $null }
  return [string]$parsed['dataDir']
}

# ------------------------------------------------------------------- panels
$allPanels = @(
  @{ Panel = 'master'; Word = 'Master'; Product = 'OrderBook Master Panel'; AppId = 'com.orderbook.master' }
  @{ Panel = 'office'; Word = 'Office'; Product = 'OrderBook Office Panel'; AppId = 'com.orderbook.office' }
)
$panels = @($allPanels | Where-Object { $Panel -eq 'all' -or $_.Panel -eq $Panel })

# A name (folder, key, shortcut, rule) belongs to the run when it says
# OrderBook and, for a single-panel run, names that panel. A bare "OrderBook"
# is shared by both panels and is only taken when both are being removed.
function Test-Ours([string]$name) {
  if ($name -notlike '*OrderBook*') { return $false }
  if ($Panel -eq 'all') { return $true }
  foreach ($p in $panels) { if ($name -like ('*' + $p.Word + '*')) { return $true } }
  return $false
}

# --------------------------------------------------------- what is installed
$uninstallRoots = @(
  'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall'
)

$entries = @()
foreach ($root in $uninstallRoots) {
  if (-not (Test-Path $root)) { continue }
  foreach ($key in (Get-ChildItem -Path $root -ErrorAction SilentlyContinue)) {
    $props = Get-ItemProperty -Path $key.PSPath -ErrorAction SilentlyContinue
    if ($null -eq $props) { continue }
    $display = [string](Get-RegValue $props 'DisplayName')
    if (-not (Test-Ours $display)) { continue }
    $entries += @{
      Key = $key.PSPath
      DisplayName = $display
      InstallLocation = [string](Get-RegValue $props 'InstallLocation')
      UninstallString = [string](Get-RegValue $props 'UninstallString')
    }
  }
}

# Where things are comes from the Windows known-folder API, never from an environment
# variable: the variables are something the account's other programs can set, and this
# script deletes what it finds here, usually elevated. (Every delete is also checked by
# Get-DeleteRefusal, because even a known folder can be redirected by the account.)
$systemDrive = [System.IO.Path]::GetPathRoot([Environment]::SystemDirectory).TrimEnd([char]92)
$localAppData = [Environment]::GetFolderPath('LocalApplicationData')
$programRoots = @(
  [Environment]::GetFolderPath('ProgramFiles'),
  [Environment]::GetFolderPath('ProgramFilesX86'),
  (Join-Path $localAppData 'Programs')
) | Where-Object { $_ }
$installDirs = New-Object System.Collections.Generic.List[string]
$seenDirs = @{}
function Add-InstallDir([string]$dir) {
  if (-not $dir) { return }
  $dir = $dir.TrimEnd('\')
  if (-not $seenDirs.ContainsKey($dir)) {
    $seenDirs[$dir] = $true
    $installDirs.Add($dir)
  }
}
foreach ($e in $entries) { Add-InstallDir $e.InstallLocation }
foreach ($root in $programRoots) {
  foreach ($d in @(Get-ChildItem -Path $root -Filter 'OrderBook*' -ErrorAction SilentlyContinue | Where-Object { $_.PSIsContainer })) {
    if (Test-Ours $d.Name) { Add-InstallDir $d.FullName }
  }
}
# The plan must read the same on a clean machine, so the default folders are
# listed even when nothing is there.
foreach ($p in $panels) {
  foreach ($root in $programRoots) { Add-InstallDir (Join-Path $root $p.Product) }
}

# Every profile on the PC. The current user's folders come from the known-folder
# API (they may be redirected); the others from C:\Users.
$profiles = New-Object System.Collections.Generic.List[object]
$seenProfiles = @{}
function Add-Profile([string]$homeDir, [string]$roaming, [string]$local) {
  if (-not $seenProfiles.ContainsKey($homeDir)) {
    $seenProfiles[$homeDir] = $true
    $profiles.Add(@{ Home = $homeDir; Roaming = $roaming; Local = $local })
  }
}
Add-Profile ([Environment]::GetFolderPath('UserProfile')) ([Environment]::GetFolderPath('ApplicationData')) $localAppData
$usersRoot = Join-Path $systemDrive 'Users'
foreach ($u in @(Get-ChildItem -Path $usersRoot -ErrorAction SilentlyContinue | Where-Object { $_.PSIsContainer })) {
  if (@('Public', 'Default', 'Default User', 'All Users') -contains $u.Name) { continue }
  Add-Profile $u.FullName (Join-Path $u.FullName 'AppData\Roaming') (Join-Path $u.FullName 'AppData\Local')
}

# The default drop folder only. A different one set with ORDERBOOK_RELEASES_DIR is
# NOT read from the environment here (an elevated recursive delete must never take its
# target from there); it is the operator's to remove by hand.
$releasesDir = Join-Path $systemDrive 'OrderBook-Releases'

# ------------------------------------------------------------------ summary
$mode = 'REMOVE'
if ($DryRun) { $mode = 'DRY RUN - nothing will be changed' }
$plural = 'ies'
if ($entries.Count -eq 1) { $plural = 'y' }
Write-Host ''
Write-Host ("OrderBook uninstall  ({0})" -f $mode)
Write-Host ("  Panels:      {0}" -f (($panels | ForEach-Object { $_.Product }) -join ', '))
if ($KeepData) { Write-Host '  Data:        KEPT (-KeepData)' } else { Write-Host '  Data:        ERASED - database, uploads, documents, settings, logs' }
if ($LeftoversOnly) { Write-Host '  Uninstaller: not run (-LeftoversOnly; the program folder is already gone)' }
Write-Host ("  Installed:   {0} registry entr{1} found" -f $entries.Count, $plural)
foreach ($e in $entries) { Write-Host ("    - {0}  ({1})" -f $e.DisplayName, $e.InstallLocation) }
Write-Host ("  Profiles:    {0}" -f (($profiles | ForEach-Object { $_.Home }) -join ', '))
Write-Host ''

if (-not $Yes -and -not $DryRun) {
  $answer = Read-Host 'Type YES to continue'
  if ($answer -ne 'YES') {
    Write-Host 'Nothing was changed.'
    exit 0
  }
}

# ---------------------------------------------------------- stop processes
Write-Host '-- Processes'
$running = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
    $exe = $_.Path
    if (-not $exe) { return $false }
    foreach ($dir in $installDirs) { if ($exe.StartsWith($dir + '\', [StringComparison]::OrdinalIgnoreCase)) { return $true } }
    return $false
  })
if ($running.Count -eq 0) { Note 'skip' 'no OrderBook process is running' }
foreach ($proc in $running) {
  if ($DryRun) { Note 'dry-run' ("would stop {0} (pid {1}): {2}" -f $proc.ProcessName, $proc.Id, $proc.Path); continue }
  try {
    Stop-Process -Id $proc.Id -Force -ErrorAction Stop
    $null = $proc.WaitForExit(15000)
    Note 'remove' ("stopped {0} (pid {1})" -f $proc.ProcessName, $proc.Id)
  } catch {
    Note 'fail' ("could not stop {0} (pid {1}): {2}" -f $proc.ProcessName, $proc.Id, $_.Exception.Message)
    $script:counts.failed++
  }
}

# -------------------------------------------------------------- uninstaller
Write-Host '-- Uninstaller'
if ($LeftoversOnly) {
  Note 'skip' 'uninstaller already running (-LeftoversOnly)'
} elseif ($entries.Count -eq 0) {
  Note 'skip' 'no OrderBook uninstall entry in the registry'
} else {
  foreach ($e in $entries) {
    $cmd = $e.UninstallString
    if (-not $cmd) { Note 'skip' ("{0}: no UninstallString" -f $e.DisplayName); continue }
    # UninstallString is `"<exe>"` possibly followed by arguments; only the
    # exe is wanted, the arguments are ours to choose.
    $exe = $cmd
    if ($cmd.StartsWith('"')) { $exe = $cmd.Substring(1, $cmd.IndexOf('"', 1) - 1) }
    $unArgs = @('/S')
    if (-not $KeepData) { $unArgs += '--delete-app-data' }
    # `_?=` makes NSIS run in place instead of copying itself to %TEMP% and
    # returning at once, so -Wait actually waits for the uninstall to finish.
    if ($e.InstallLocation) { $unArgs += ('_?=' + $e.InstallLocation) }
    if ($DryRun) { Note 'dry-run' ("would run {0} {1}" -f $exe, ($unArgs -join ' ')); continue }
    if (-not (Test-Path -LiteralPath $exe)) { Note 'skip' ("uninstaller missing: {0}" -f $exe); $script:counts.skipped++; continue }
    try {
      $run = Start-Process -FilePath $exe -ArgumentList $unArgs -Wait -PassThru -ErrorAction Stop
      Note 'remove' ("ran {0} (exit {1})" -f $e.DisplayName, $run.ExitCode)
    } catch {
      Note 'fail' ("uninstaller for {0}: {1}" -f $e.DisplayName, $_.Exception.Message)
      $script:counts.failed++
    }
  }
}

# ---------------------------------------------------------------- leftovers
Write-Host '-- Program folders'
foreach ($dir in $installDirs) {
  if ($LeftoversOnly -and -not (Test-Path -LiteralPath $dir)) { continue }
  Remove-Leftover $dir 'program folder'
}

Write-Host '-- Electron profile and updater cache'
foreach ($p in $panels) {
  foreach ($u in $profiles) {
    Remove-Leftover (Join-Path $u.Roaming $p.Product) 'profile'
    Remove-Leftover (Join-Path $u.Local $p.Product) 'profile cache'
    Remove-Leftover (Join-Path $u.Local ($p.Product + '-updater')) 'updater cache'
    Remove-Leftover (Join-Path $u.Local ('orderbook-' + $p.Panel + '-updater')) 'updater cache'
  }
}
foreach ($u in $profiles) {
  $tmp = Join-Path $u.Local 'Temp'
  $tmpFiles = @(Get-ChildItem -Path $tmp -Filter 'orderbook*' -ErrorAction SilentlyContinue)
  foreach ($t in $tmpFiles) { Remove-Leftover $t.FullName 'temp file' }
  if ($tmpFiles.Count -eq 0) { Note 'skip' ("no temp files: {0}\orderbook*" -f $tmp) }
}

Write-Host '-- Data'
foreach ($p in $panels) {
  foreach ($u in $profiles) {
    $ob = Join-Path $u.Roaming 'OrderBook'
    $pointer = Join-Path $ob ($p.Panel + '-location.json')
    $settings = Join-Path $ob ($p.Panel + '-settings.env')
    $dataDir = Join-Path $ob $p.Panel
    $relocated = $null
    if (Test-Path -LiteralPath $pointer) {
      try { $relocated = Read-DataDir $pointer } catch { $relocated = $null }
    }
    if ($KeepData) {
      Keep $dataDir 'data folder'
      if ($relocated) { Keep $relocated 'relocated data folder' }
      Keep $pointer 'location pointer'
      Keep $settings 'settings file'
      continue
    }
    Remove-Leftover $dataDir 'data folder'
    if ($relocated) { Remove-Leftover $relocated 'relocated data folder' }
    elseif ($DryRun) { Note 'dry-run' ("would remove the folder named in {0}, if any" -f $pointer) }
    Remove-Leftover $pointer 'location pointer'
    Remove-Leftover $settings 'settings file'
    if ((Test-Path -LiteralPath $ob) -and -not $DryRun -and
        (Get-ChildItem -LiteralPath $ob -Force -ErrorAction SilentlyContinue | Measure-Object).Count -eq 0) {
      Remove-Leftover $ob 'empty OrderBook folder'
    }
  }
}
if ($panels | Where-Object { $_.Panel -eq 'master' }) {
  if ($KeepData) {
    Keep $releasesDir 'releases folder'
  } else {
    # A drop box an operator may have filled by hand, so it gets its own
    # question when there is somebody to ask.
    $wipeReleases = $Yes -or $DryRun
    if (-not $wipeReleases -and (Test-Path -LiteralPath $releasesDir)) {
      $wipeReleases = (Read-Host ("Also delete the releases folder {0}? (y/N)" -f $releasesDir)) -eq 'y'
    }
    if ($wipeReleases) { Remove-Leftover $releasesDir 'releases folder' } else { Keep $releasesDir 'releases folder' }
  }
}

Write-Host '-- Shortcuts'
$shortcutRoots = @(
  [Environment]::GetFolderPath('CommonDesktopDirectory'),
  [Environment]::GetFolderPath('CommonPrograms')
)
foreach ($u in $profiles) {
  $shortcutRoots += (Join-Path $u.Home 'Desktop')
  $shortcutRoots += (Join-Path $u.Roaming 'Microsoft\Windows\Start Menu\Programs')
}
$found = 0
foreach ($root in $shortcutRoots) {
  # A recursive listing with -Filter stops dead, whatever -ErrorAction says, at
  # the first folder it may not read (another user's Start Menu, run without
  # elevation as -DryRun is). That costs this one root, not the whole run.
  $links = @()
  try {
    $links = @(Get-ChildItem -Path $root -Recurse -Filter '*OrderBook*.lnk' -ErrorAction SilentlyContinue)
  } catch {
    Note 'skip' ("could not search {0} for shortcuts: {1}" -f $root, $_.Exception.Message)
  }
  foreach ($lnk in $links) {
    if (-not (Test-Ours $lnk.Name)) { continue }
    $found++
    Remove-Leftover $lnk.FullName 'shortcut'
  }
}
if ($found -eq 0) { Note 'skip' ("no OrderBook shortcut under {0} locations" -f $shortcutRoots.Count) }

# ----------------------------------------------------------------- registry
Write-Host '-- Registry'
function Remove-RegKey([string]$path) {
  if ($DryRun) { Note 'dry-run' ("would delete key {0}" -f $path); return }
  Remove-Item -Path $path -Recurse -Force -ErrorAction SilentlyContinue
  if (Test-Path $path) { Note 'fail' ("key {0}" -f $path); $script:counts.failed++ }
  else { Note 'remove' ("key {0}" -f $path); $script:counts.removed++ }
}
function Remove-RegValue([string]$path, [string]$name) {
  if ($DryRun) { Note 'dry-run' ("would delete value {0} under {1}" -f $name, $path); return }
  Remove-ItemProperty -Path $path -Name $name -ErrorAction SilentlyContinue
  Note 'remove' ("value {0} under {1}" -f $name, $path); $script:counts.removed++
}

foreach ($e in $entries) { Remove-RegKey ($e.Key -replace '^Microsoft\.PowerShell\.Core\\Registry::', 'Registry::') }
if ($entries.Count -eq 0 -and $DryRun) { Note 'dry-run' 'would delete every Uninstall key whose DisplayName starts with OrderBook (none found)' }

# Login items. Electron writes `<productName>` = `"<exe>"` under Run. The
# value name or the exe path has to name the product (or sit in an install
# folder): matching a bare "OrderBook" in the path would also catch a developer
# checkout that happens to live in a folder of that name.
function Test-LoginItem([string]$name, [string]$data) {
  if (Test-Ours $name) { return $true }
  foreach ($p in $panels) { if ($data -like ('*' + $p.Product + '*')) { return $true } }
  foreach ($dir in $installDirs) { if ($data -like ('*' + $dir + '\*')) { return $true } }
  return $false
}
foreach ($runKey in 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run', 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run') {
  if (-not (Test-Path $runKey)) { continue }
  $props = Get-ItemProperty -Path $runKey -ErrorAction SilentlyContinue
  foreach ($prop in $props.PSObject.Properties) {
    if ($prop.Name -like 'PS*') { continue }
    if (Test-LoginItem $prop.Name ([string]$prop.Value)) { Remove-RegValue $runKey $prop.Name }
  }
  if ($DryRun) { Note 'dry-run' ("would delete login-item values mentioning OrderBook under {0}" -f $runKey) }
}

foreach ($parent in 'HKCU:\Software\Classes\Applications', 'HKCU:\Software', 'HKLM:\SOFTWARE') {
  foreach ($k in (Get-ChildItem -Path $parent -ErrorAction SilentlyContinue | Where-Object { $_.PSChildName -like 'OrderBook*' })) {
    if (Test-Ours $k.PSChildName) { Remove-RegKey ($parent + '\' + $k.PSChildName) }
  }
  if ($DryRun) { Note 'dry-run' ("would delete {0}\OrderBook*" -f $parent) }
}

foreach ($compat in 'HKCU:\Software\Microsoft\Windows NT\CurrentVersion\AppCompatFlags\Compatibility Assistant\Store',
                    'HKCU:\Software\Microsoft\Windows NT\CurrentVersion\AppCompatFlags\Layers') {
  if (-not (Test-Path $compat)) { continue }
  $props = Get-ItemProperty -Path $compat -ErrorAction SilentlyContinue
  foreach ($prop in $props.PSObject.Properties) {
    if ($prop.Name -like 'PS*') { continue }
    if (Test-Ours $prop.Name) { Remove-RegValue $compat $prop.Name }
  }
  if ($DryRun) { Note 'dry-run' ("would delete values naming OrderBook under {0}" -f $compat) }
}

# ----------------------------------------------------------------- firewall
if ($panels | Where-Object { $_.Panel -eq 'master' }) {
  Write-Host '-- Firewall (master)'
  foreach ($rule in 'OrderBook Master (TCP 4100)', 'OrderBook Discovery (UDP 45789)') {
    if ($DryRun) { Note 'dry-run' ("would delete firewall rule {0}" -f $rule); continue }
    $null = & netsh advfirewall firewall delete rule name="$rule" 2>&1
    Note 'remove' ("firewall rule {0}" -f $rule); $script:counts.removed++
  }
  if ($DryRun) {
    Note 'dry-run' 'would delete every firewall rule named OrderBook*'
  } else {
    try {
      $rules = @(Get-NetFirewallRule -DisplayName 'OrderBook*' -ErrorAction Stop)
      foreach ($r in $rules) { Remove-NetFirewallRule -Name $r.Name -ErrorAction SilentlyContinue; Note 'remove' ("firewall rule {0}" -f $r.DisplayName); $script:counts.removed++ }
    } catch {
      # No NetSecurity module (Server Core, stripped images): netsh above did
      # the two rules the installer creates, which is what matters.
      Note 'skip' ("Get-NetFirewallRule unavailable: {0}" -f $_.Exception.Message)
    }
  }
}

# ------------------------------------------------------------------ summary
Write-Host ''
if ($DryRun) {
  Write-Host 'Dry run complete. Nothing was changed.'
} else {
  Write-Host ("Done. removed {0}, kept {1}, skipped {2}, failed {3}" -f $script:counts.removed, $script:counts.kept, $script:counts.skipped, $script:counts.failed)
}
if ($Elevated) { $null = Read-Host 'Press Enter to close this window' }
if ($script:counts.failed -gt 0) { exit 1 }
exit 0
