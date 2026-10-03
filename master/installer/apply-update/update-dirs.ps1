# The folders the Master's nightly update works in, made and checked (1.4 R8).
#
# Two modes, one set of rules:
#
#   -Mode Install  -InstallDir <program folder>
#       Run by the installer, elevated, once. Hardens the program folder, makes
#       `%ProgramData%\OrderBook\staged-update` and `...\elevated`, and writes
#       `resources\apply-update\paths.json`. Exit 0 = the update task may be
#       registered; anything else = it must not be (the app then falls back to
#       asking for approval, as it does without a task).
#   -Mode Check    -Path <folder>
#       Run by the update task, elevated, every time. Exit 0 only when the folder
#       and every folder above it is still trustworthy.
#   -Mode Chain    -Path <folder>
#       The ancestor check alone (what Install makes for the program folder).
#
# What "trustworthy" means, and why:
#   * not a link (junction or symbolic link): a link lets whoever made it choose
#     where an administrator's writes land;
#   * owned by Administrators, SYSTEM or TrustedInstaller: an owner can always
#     rewrite the folder's ACL, so a folder owned by a standard user is theirs;
#   * no Allow entry for anybody else (Users, Everyone, a named user) that lets
#     them write into it, delete it, change its permissions or take its ownership.
#   For the folders above, only rights that let them *replace* the next folder
#   count: creating a new sibling (C:\ lets Authenticated Users) is harmless.
#
# Well-known SIDs throughout, so it works on any Windows language, and no
# environment variable is trusted: paths come from the Windows known-folder API.

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateSet('Install', 'Check', 'Chain')][string]$Mode,
    [string]$InstallDir,
    [string]$Path
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$AdminsSid = 'S-1-5-32-544'
$SystemSid = 'S-1-5-18'
$UsersSid = 'S-1-5-32-545'
$CreatorOwnerSid = 'S-1-3-0'
$TrustedInstallerSid = 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'
$Strong = @($AdminsSid, $SystemSid, $TrustedInstallerSid, $CreatorOwnerSid)
$TrustedOwners = @($AdminsSid, $SystemSid, $TrustedInstallerSid)

$FS = [System.Security.AccessControl.FileSystemRights]
# What lets a non-administrator change what is *in* a folder, or take it over.
$ContentWrite = [int]($FS::WriteData -bor $FS::AppendData -bor $FS::WriteExtendedAttributes -bor $FS::WriteAttributes -bor
    $FS::Delete -bor $FS::DeleteSubdirectoriesAndFiles -bor $FS::ChangePermissions -bor $FS::TakeOwnership)
# What lets them replace the folder itself, as a child of an ancestor.
$Replace = [int]($FS::Delete -bor $FS::DeleteSubdirectoriesAndFiles -bor $FS::ChangePermissions -bor $FS::TakeOwnership)

# The system's own icacls, by absolute path: never whatever PATH finds first.
$Icacls = Join-Path ([Environment]::SystemDirectory) 'icacls.exe'

function Get-Entry([string]$Target) { Get-Item -LiteralPath $Target -Force }

function Test-Link([string]$Target) {
    [bool]((Get-Entry $Target).Attributes -band [System.IO.FileAttributes]::ReparsePoint)
}

function Get-OwnerSid([string]$Target) {
    (Get-Acl -LiteralPath $Target).GetOwner([System.Security.Principal.SecurityIdentifier]).Value
}

# The first Allow entry that gives somebody outside the strong set a right in $Mask.
# $ThisFolder: ignore inherit-only entries (they apply to what is inside, not to it).
function Get-WeakEntry([string]$Target, [int]$Mask, [bool]$ThisFolder) {
    $rules = (Get-Acl -LiteralPath $Target).GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])
    foreach ($rule in $rules) {
        if ($rule.AccessControlType -ne 'Allow') { continue }
        if ($Strong -contains $rule.IdentityReference.Value) { continue }
        if ($ThisFolder -and ($rule.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly)) { continue }
        if (([int]$rule.FileSystemRights -band $Mask) -ne 0) { return $rule }
    }
    return $null
}

# Why a folder may not be trusted, or $null. $Content: it is the folder whose contents are used.
function Test-Folder([string]$Target, [bool]$Content) {
    if (Test-Link $Target) { return "$Target is a link" }
    $owner = Get-OwnerSid $Target
    if ($TrustedOwners -notcontains $owner) { return "$Target is owned by $owner" }
    $weak = Get-WeakEntry $Target $(if ($Content) { $ContentWrite } else { $Replace }) $true
    if ($weak) { return "$Target lets $($weak.IdentityReference.Value) change it" }
    return $null
}

# The folder and every folder above it, up to the drive root.
function Test-Chain([string]$Target, [bool]$ContentTarget) {
    $current = [System.IO.Path]::GetFullPath($Target)
    if ($current.Length -gt 3) { $current = $current.TrimEnd([char]92) }
    $first = $true
    while ($current) {
        $reason = Test-Folder $current ($first -and $ContentTarget)
        if ($reason) { return $reason }
        $first = $false
        $current = [System.IO.Path]::GetDirectoryName($current)
    }
    return $null
}

function Set-Protected([string]$Target, [object[]]$Grants) {
    # Owner first (icacls handles the privilege), then a DACL with inheritance cut and only what is listed.
    & $Icacls $Target /setowner "*$AdminsSid" /L | Out-Null
    $security = New-Object System.Security.AccessControl.DirectorySecurity
    $security.SetOwner((New-Object System.Security.Principal.SecurityIdentifier $AdminsSid))
    $security.SetAccessRuleProtection($true, $false)
    foreach ($grant in $Grants) {
        $sid = New-Object System.Security.Principal.SecurityIdentifier $grant.Sid
        $inherit = if ($grant.Subtree) { 'ContainerInherit, ObjectInherit' } else { 'None' }
        $security.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sid, $grant.Rights, $inherit, 'None', 'Allow')))
    }
    [System.IO.Directory]::SetAccessControl($Target, $security)
}

# A folder that is in the way: a link is removed (never followed); anything else is moved aside.
function Clear-Squatter([string]$Target) {
    if (-not (Test-Path -LiteralPath $Target)) { return }
    if (Test-Link $Target) {
        [System.IO.Directory]::Delete($Target, $false)
        return
    }
    $owner = Get-OwnerSid $Target
    if ($TrustedOwners -contains $owner) { return }
    $aside = "$Target.untrusted-$([guid]::NewGuid().ToString('N'))"
    Move-Item -LiteralPath $Target -Destination $aside
}

function Install-Mode {
    if (-not $InstallDir) { throw 'InstallDir is required' }
    $install = [System.IO.Path]::GetFullPath($InstallDir).TrimEnd('\')

    $full = [System.Security.AccessControl.FileSystemRights]::FullControl
    $readRun = [System.Security.AccessControl.FileSystemRights]::ReadAndExecute
    $modify = [System.Security.AccessControl.FileSystemRights]::Modify

    # --- the program folder: Administrators own it and nobody else writes it ---
    # A custom install folder inherits Users:Modify from wherever it was made, which
    # would make the update script and the release keys editable by any program.
    if (Test-Link $install) { throw "$install is a link" }
    Set-Protected $install @(
        @{ Sid = $AdminsSid; Rights = $full; Subtree = $true },
        @{ Sid = $SystemSid; Rights = $full; Subtree = $true },
        @{ Sid = $UsersSid; Rights = $readRun; Subtree = $true })
    # Anything already inside it that is a link, or owned or writable by somebody else.
    & $Icacls $install /setowner "*$AdminsSid" /T /C /L | Out-Null
    foreach ($item in (Get-ChildItem -LiteralPath $install -Recurse -Force -Directory)) {
        if (Test-Link $item.FullName) { throw "$($item.FullName) is a link inside the program folder" }
        $weak = Get-WeakEntry $item.FullName $ContentWrite $false
        if ($weak) { throw "$($item.FullName) lets $($weak.IdentityReference.Value) change it" }
    }
    $reason = Test-Chain $install $true
    if ($reason) { throw $reason }

    # --- the two working folders under the machine-wide data folder ---
    # From the known-folder API, never %ProgramData%: an environment variable is
    # something the account's other programs can set.
    $programData = [Environment]::GetFolderPath('CommonApplicationData')
    $root = Join-Path $programData 'OrderBook'
    Clear-Squatter $root
    if (-not (Test-Path -LiteralPath $root)) { New-Item -ItemType Directory -Path $root | Out-Null }
    # Users may pass through it to staged-update, and nothing more.
    Set-Protected $root @(
        @{ Sid = $AdminsSid; Rights = $full; Subtree = $true },
        @{ Sid = $SystemSid; Rights = $full; Subtree = $true },
        @{ Sid = $UsersSid; Rights = $readRun; Subtree = $false })

    $stage = Join-Path $root 'staged-update'
    $work = Join-Path $root 'elevated'
    foreach ($folder in @($stage, $work)) {
        Clear-Squatter $folder
        if (-not (Test-Path -LiteralPath $folder)) { New-Item -ItemType Directory -Path $folder | Out-Null }
    }
    # Anybody may leave files in staged-update; nothing in it is believed.
    Set-Protected $stage @(
        @{ Sid = $AdminsSid; Rights = $full; Subtree = $true },
        @{ Sid = $SystemSid; Rights = $full; Subtree = $true },
        @{ Sid = $UsersSid; Rights = $modify; Subtree = $true })
    # Only administrators write elevated; Users may read it, so the app can read the task's answer.
    Set-Protected $work @(
        @{ Sid = $AdminsSid; Rights = $full; Subtree = $true },
        @{ Sid = $SystemSid; Rights = $full; Subtree = $true },
        @{ Sid = $UsersSid; Rights = $readRun; Subtree = $true })

    # What was just made must be what the task will accept.
    $reason = Test-Chain $work $true
    if ($reason) { throw $reason }
    $reason = Test-Folder $root $false
    if ($reason) { throw $reason }

    $applyDir = Join-Path $install 'resources\apply-update'
    $powershell = Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\v1.0\powershell.exe'
    $json = @{ stage = $stage; work = $work; powershell = $powershell } | ConvertTo-Json -Compress
    [System.IO.File]::WriteAllText((Join-Path $applyDir 'paths.json'), $json, (New-Object System.Text.UTF8Encoding $false))
}

try {
    switch ($Mode) {
        'Install' { Install-Mode }
        'Check' {
            if (-not $Path) { throw 'Path is required' }
            $reason = Test-Chain $Path $true
            if ($reason) { Write-Output $reason; exit 1 }
        }
        'Chain' {
            if (-not $Path) { throw 'Path is required' }
            $reason = Test-Chain $Path $true
            if ($reason) { Write-Output $reason; exit 1 }
        }
    }
    exit 0
} catch {
    Write-Output $_.Exception.Message
    exit 1
}
