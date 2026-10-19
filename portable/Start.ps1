param([int]$Port = 0, [switch]$NoBrowser)
$ErrorActionPreference = 'Stop'

function ConvertTo-ProcessArgument([string]$Value) {
    # Windows CommandLineToArgvW quoting; paths are data, never PowerShell code.
    $escaped = [regex]::Replace($Value, '(\\*)("|$)', {
        param($match)
        $slashes = $match.Groups[1].Value
        if ($match.Groups[2].Value -eq '"') { return $slashes + $slashes + '\"' }
        return $slashes + $slashes
    })
    return '"' + $escaped + '"'
}

function Test-ReleaseVersion($Value) {
    return $Value -is [string] -and $Value.Length -le 60 -and
        $Value -cmatch '\A(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)-studio\.(0|[1-9][0-9]*)\z'
}

function Read-StrictTransaction([string]$Path) {
    $item = Get-Item -LiteralPath $Path -Force
    if ($item.Length -gt 65536 -or $item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
        throw 'Invalid update transaction file.'
    }
    $json = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
    # Transactions are flat JSON. Tokenize keys before ConvertFrom-Json so
    # duplicate/escaped keys cannot silently overwrite earlier fields in PS 5.
    $jsonString = '"(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"'
    $jsonValue = '(?:' + $jsonString + '|true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)'
    $pair = '(?<key>' + $jsonString + ')\s*:\s*' + $jsonValue
    $parsed = [regex]::Match($json, '\A\s*\{\s*(?:' + $pair + '(?:\s*,\s*' + $pair + ')*)?\s*\}\s*\z')
    if (-not $parsed.Success) { throw 'Invalid update transaction JSON.' }
    $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($keyToken in $parsed.Groups['key'].Captures) {
        $key = $keyToken.Value | ConvertFrom-Json
        if (-not $seen.Add($key)) { throw 'Duplicate update transaction fields.' }
    }
    return $json | ConvertFrom-Json
}

function Get-RecoveryVersion([string]$Root, [string]$Current) {
    $updatesPath = Join-Path $Root 'updates'
    $transactionPath = Join-Path $updatesPath 'transaction.json'
    if (-not (Test-Path -LiteralPath $transactionPath)) { return $Current }
    if ((Get-Item -LiteralPath $updatesPath -Force).Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
        throw 'Update records must stay inside this installation.'
    }
    $tx = Read-StrictTransaction $transactionPath
    $required = @('id', 'old', 'new', 'action', 'phase', 'backup_complete')
    $names = @($tx.PSObject.Properties.Name)
    foreach ($name in $required) { if ($names -cnotcontains $name) { throw 'Missing update transaction field.' } }
    foreach ($name in $names) { if (($required + @('error')) -cnotcontains $name) { throw 'Unknown update transaction field.' } }
    $active = @('stopping', 'backing_up', 'switching', 'validating', 'recovery_required')
    if ($tx.backup_complete -isnot [bool] -or ($active + @('committed', 'reverted')) -cnotcontains $tx.phase -or
        @('install', 'rollback') -cnotcontains $tx.action -or -not (Test-ReleaseVersion $tx.old) -or
        -not (Test-ReleaseVersion $tx.new) -or $tx.old -ceq $tx.new -or @($tx.old, $tx.new) -cnotcontains $Current -or
        $tx.id -isnot [string] -or $tx.id -cnotmatch '\A[a-f0-9]{32}\z' -or
        ($names -ccontains 'error' -and $tx.error -isnot [string])) { throw 'Invalid update transaction.' }
    if ((@('stopping', 'backing_up', 'reverted') -ccontains $tx.phase -and $Current -cne $tx.old) -or
        (@('validating', 'committed') -ccontains $tx.phase -and $Current -cne $tx.new) -or
        (@('switching', 'validating', 'committed') -ccontains $tx.phase -and -not $tx.backup_complete)) {
        throw 'Update transaction conflicts with current.json. All folders were preserved.'
    }
    if ($active -ccontains $tx.phase) { return $tx.old }
    return $Current
}

try {
    $installRoot = [System.IO.Path]::GetFullPath($PSScriptRoot)
    $pointerPath = Join-Path $installRoot 'current.json'
    if ((Get-Item -LiteralPath $pointerPath).Length -gt 65536) { throw 'current.json is too large.' }
    $pointer = Get-Content -LiteralPath $pointerPath -Raw -Encoding UTF8
    # The bootstrap accepts only the exact pointer grammar; duplicate fields
    # must fail before choosing an interpreter (ConvertFrom-Json loses them).
    $pattern = '\A\s*\{\s*"version"\s*:\s*"((0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)-studio\.(0|[1-9][0-9]*))"\s*\}\s*\z'
    $pointerMatch = [regex]::Match($pointer, $pattern)
    if (-not $pointerMatch.Success -or $pointerMatch.Groups[1].Value.Length -gt 60) { throw 'Invalid current.json.' }
    $version = Get-RecoveryVersion $installRoot $pointerMatch.Groups[1].Value
    $versionsPath = Join-Path $installRoot 'versions'
    $releasePath = Join-Path $versionsPath $version
    $pythonPath = Join-Path $releasePath 'python'
    $executable = Join-Path $pythonPath 'python.exe'
    $launcher = Join-Path $installRoot 'launcher.py'
    foreach ($itemPath in @($versionsPath, $releasePath, $pythonPath, $executable, $launcher)) {
        $item = Get-Item -LiteralPath $itemPath -Force
        if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
            throw 'Program paths must not be links to another location.'
        }
    }
    if ($Port -ne 0 -and ($Port -lt 1024 -or $Port -gt 65535)) { throw 'Port must be between 1024 and 65535.' }
    $arguments = @('-I', '-B', $launcher, '--root', $installRoot)
    if ($Port -gt 0) { $arguments += @('--port', [string]$Port) }
    if ($NoBrowser) { $arguments += '--no-browser' }
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $executable
    $startInfo.Arguments = [string]::Join(' ', @($arguments | ForEach-Object { ConvertTo-ProcessArgument $_ }))
    $startInfo.WorkingDirectory = $installRoot
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    [void][System.Diagnostics.Process]::Start($startInfo)
    exit 0
} catch {
    $logFolder = Join-Path $PSScriptRoot 'updates'
    [void][System.IO.Directory]::CreateDirectory($logFolder)
    $logPath = Join-Path $logFolder 'launcher.log'
    [System.IO.File]::AppendAllText($logPath, [DateTime]::UtcNow.ToString('o') + ' ' + $_.Exception.Message + "`r`n")
    if (-not $NoBrowser -and $env:DEEPWHITE_STUDIO_NO_BROWSER -ne '1') {
        Add-Type -AssemblyName System.Windows.Forms
        [void][System.Windows.Forms.MessageBox]::Show($_.Exception.Message + "`r`n`r`n" + $logPath, 'DeepWhite Studio')
    }
    exit 1
}
