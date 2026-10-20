param(
    [Parameter(Mandatory = $true)][string]$InstallRoot,
    [switch]$Check
)
$ErrorActionPreference = 'Stop'

function ConvertTo-ProcessArgument([string]$Value) {
    $escaped = [regex]::Replace($Value, '(\\*)("|$)', {
        param($match)
        $slashes = $match.Groups[1].Value
        if ($match.Groups[2].Value -eq '"') { return $slashes + $slashes + '\"' }
        return $slashes + $slashes
    })
    return '"' + $escaped + '"'
}

function Assert-RegularPath([string]$Path) {
    $item = Get-Item -LiteralPath $Path -Force
    if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
        throw 'MCP program paths must not redirect to another location.'
    }
}

try {
    $root = [System.IO.Path]::GetFullPath($InstallRoot)
    $pointerPath = Join-Path $root 'current.json'
    Assert-RegularPath $pointerPath
    if ((Get-Item -LiteralPath $pointerPath).Length -gt 65536) { throw 'current.json is too large.' }
    $pointer = Get-Content -LiteralPath $pointerPath -Raw -Encoding UTF8
    # Accept one exact field, without duplicate keys or path fragments.
    $pattern = '\A\s*\{\s*"version"\s*:\s*"((0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)-studio\.(0|[1-9][0-9]*))"\s*\}\s*\z'
    $matched = [regex]::Match($pointer, $pattern)
    if (-not $matched.Success -or $matched.Groups[1].Value.Length -gt 60) { throw 'Invalid current.json.' }
    $version = $matched.Groups[1].Value
    $versions = Join-Path $root 'versions'
    $release = Join-Path $versions $version
    $pythonFolder = Join-Path $release 'python'
    $application = Join-Path $release 'app'
    $executable = Join-Path $pythonFolder 'python.exe'
    $bridge = Join-Path $application 'studio_mcp.py'
    $versionFile = Join-Path $application 'VERSION'
    foreach ($path in @($versions, $release, $pythonFolder, $application, $executable, $bridge, $versionFile)) {
        Assert-RegularPath $path
    }
    if ((Get-Content -LiteralPath $versionFile -Raw -Encoding UTF8).Trim() -cne $version) {
        throw 'The selected application version does not match current.json.'
    }
    $port = 3848
    $installation = Join-Path $root 'installation.json'
    if (Test-Path -LiteralPath $installation) {
        $configuration = Get-Content -LiteralPath $installation -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($configuration.port -isnot [int] -or $configuration.port -lt 1024 -or $configuration.port -gt 65535) {
            throw 'Invalid installation port.'
        }
        $port = $configuration.port
    }
    # The actual running supervisor may have been launched with an explicit port.
    $processRecord = Join-Path (Join-Path $root 'updates') 'server-process.json'
    if (Test-Path -LiteralPath $processRecord) {
        $record = Get-Content -LiteralPath $processRecord -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($record.version -ceq $version -and $record.port -is [int] -and
                $record.port -ge 1024 -and $record.port -le 65535) { $port = $record.port }
    }
    $arguments = @('-I', '-B', $bridge, '--url', ('http://127.0.0.1:' + $port))
    if ($Check) { $arguments += @('--check', '--json') }
    $start = New-Object System.Diagnostics.ProcessStartInfo
    $start.FileName = $executable
    $start.Arguments = [string]::Join(' ', @($arguments | ForEach-Object { ConvertTo-ProcessArgument $_ }))
    $start.WorkingDirectory = $release
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.EnvironmentVariables['DEEPWHITE_STUDIO_RUNTIME_DIR'] = Join-Path $root 'userdata'
    $start.EnvironmentVariables['PYTHONUTF8'] = '1'
    # Copy raw streams. Windows PowerShell cannot reliably inherit a piped stdin
    # through Process.Start, and its ordinary native pipeline re-encodes text.
    $process = [System.Diagnostics.Process]::Start($start)
    $inputCopy = [Console]::OpenStandardInput().CopyToAsync($process.StandardInput.BaseStream)
    $outputCopy = $process.StandardOutput.BaseStream.CopyToAsync([Console]::OpenStandardOutput())
    $errorCopy = $process.StandardError.BaseStream.CopyToAsync([Console]::OpenStandardError())
    $inputClosed = $false
    while (-not $process.WaitForExit(50)) {
        if (-not $inputClosed -and $inputCopy.IsCompleted) {
            $process.StandardInput.Close()
            $inputClosed = $true
        }
    }
    [System.Threading.Tasks.Task]::WaitAll(@($outputCopy, $errorCopy))
    exit $process.ExitCode
} catch {
    # No raw exception text (can contain local account names or sensitive paths).
    [Console]::Error.WriteLine('MCP bootstrap failed. Check that the complete portable installation is present and that current.json selects a valid version. Re-copy configuration from this canvas.')
    exit 2
}
