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
    $version = $pointerMatch.Groups[1].Value
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
    $logFolder = Join-Path $PSScriptRoot 'userdata\logs'
    [void][System.IO.Directory]::CreateDirectory($logFolder)
    $logPath = Join-Path $logFolder 'launcher.log'
    [System.IO.File]::AppendAllText($logPath, [DateTime]::UtcNow.ToString('o') + ' ' + $_.Exception.Message + "`r`n")
    if (-not $NoBrowser -and $env:DEEPWHITE_STUDIO_NO_BROWSER -ne '1') {
        Add-Type -AssemblyName System.Windows.Forms
        [void][System.Windows.Forms.MessageBox]::Show($_.Exception.Message + "`r`n`r`n" + $logPath, 'DeepWhite Studio')
    }
    exit 1
}
