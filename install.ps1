#Requires -Version 5.1
<# Download a verified CLI. Vault, plugin and Codex logic stays in the CLI. #>
[CmdletBinding()]
param(
    # The release preparation step fills this fallback from package.json.repository.
    [Alias('Repo')][string]$Repository = $(if ($env:OBSIDIAN_MCP_REPOSITORY) { $env:OBSIDIAN_MCP_REPOSITORY } else { 'ernando760/obsidian-mcp' }),
    [string]$Version,
    [Parameter(Position = 0)][string]$Vault,
    [string]$ConfigDir,
    [Nullable[int]]$Port,
    [string]$Name,
    [switch]$Manual,
    [switch]$NoEnable,
    [switch]$Update,
    [string]$InstallDir,
    [switch]$Help
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if ($Help) {
    Write-Output @'
Obsidian MCP - Windows bootstrap (Node.js 22.12+, Windows PowerShell 5.1+)
.\install.ps1 -Repo owner/repository [-Version tag] [-Vault 'C:\My Vault']
  -Repo / OBSIDIAN_MCP_REPOSITORY: official release repository
  -Version: exact stable release tag (default: latest)
  -Vault: omitted = CLI discovery/prompt
  -Update: run CLI update instead of install
  -Manual: generate manual Codex configuration
  -ConfigDir, -Port, -Name, -NoEnable: forwarded to the CLI
  -InstallDir: CLI and launcher directory (default: %LOCALAPPDATA%\ObsidianMCP)
No administrator privileges or global execution-policy changes are required.
'@
    exit 0
}
$tempDir = $null
try {
    if ($env:OS -ne 'Windows_NT') { throw 'Use install.sh on Linux/macOS.' }
    # Use modules belonging to this PowerShell runtime, even when launched
    # from a terminal whose PSModulePath points at another PowerShell version.
    Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Utility') -ErrorAction Stop
    Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security') -ErrorAction Stop
    if ($Repository -notmatch '^[A-Za-z0-9_-]+/[A-Za-z0-9_.-]+$' -or $Repository -match '/(?:\.|\.\.)$') { throw 'Provide -Repo owner/repository (the official release repository).' }
    if ($Version -and $Version -notmatch '^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$') { throw 'Provide an exact stable -Version tag.' }
    if ($null -ne $Port -and ($Port -lt 1024 -or $Port -gt 65535)) { throw 'Port must be between 1024 and 65535.' }
    $node = (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
    $nodeVersion = & $node -p 'process.versions.node'
    if ($LASTEXITCODE -ne 0 -or [version]$nodeVersion -lt [version]'22.12.0') { throw 'Install Node.js 22.12+ and rerun this script.' }
    if (-not $InstallDir) {
        $localData = [Environment]::GetFolderPath('LocalApplicationData')
        $InstallDir = Join-Path $localData 'ObsidianMCP'
    }
    $InstallDir = [IO.Path]::GetFullPath($InstallDir)
    if ($InstallDir -match '[\r\n]') { throw 'Installation paths cannot contain line breaks.' }
    $tempDir = Join-Path ([IO.Path]::GetTempPath()) ('obsidian-mcp-bootstrap-' + [guid]::NewGuid().ToString('N'))
    [IO.Directory]::CreateDirectory($tempDir) | Out-Null
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    function Get-ReleaseFile([string]$Uri, [string]$Destination, [long]$Limit) {
        if (-not $Uri.StartsWith('https://', [StringComparison]::OrdinalIgnoreCase)) { throw 'Downloads require HTTPS.' }
        $response = Invoke-WebRequest -UseBasicParsing -Uri $Uri -OutFile $Destination -PassThru -MaximumRedirection 5 -TimeoutSec 30 -Headers @{ 'User-Agent' = 'obsidian-mcp-bootstrap' }
        $finalUri = if ($response.BaseResponse.ResponseUri) { $response.BaseResponse.ResponseUri } else { $response.BaseResponse.RequestMessage.RequestUri }
        if ($finalUri.Scheme -ne 'https') { throw 'Insecure download redirect.' }
        if ((Get-Item -LiteralPath $Destination).Length -gt $Limit) { throw 'Download exceeds size limit.' }
    }
    $endpoint = if ($Version) { 'tags/' + $Version } else { 'latest' }
    $metadataFile = Join-Path $tempDir 'release.json'
    Get-ReleaseFile "https://api.github.com/repos/$Repository/releases/$endpoint" $metadataFile 1048576
    $release = Get-Content -LiteralPath $metadataFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $tag = [string]$release.tag_name
    if ($release.draft -ne $false -or $release.prerelease -ne $false -or $tag -notmatch '^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$' -or ($Version -and $Version -cne $tag)) { throw 'Invalid or non-stable release.' }
    function Get-Asset([string]$AssetName) {
        $matches = @($release.assets | Where-Object { $_.name -ceq $AssetName })
        $expected = "https://github.com/$Repository/releases/download/$tag/$AssetName"
        if ($matches.Count -ne 1 -or $matches[0].browser_download_url -cne $expected) { throw "Missing or invalid release asset: $AssetName" }
        return $matches[0]
    }
    $cliAsset = Get-Asset 'obsidian-mcp-cli.mjs'
    $sumsAsset = Get-Asset 'SHA256SUMS'
    $cliDownload = Join-Path $tempDir 'obsidian-mcp-cli.mjs'
    $sumsDownload = Join-Path $tempDir 'SHA256SUMS'
    Get-ReleaseFile $cliAsset.browser_download_url $cliDownload 20971520
    Get-ReleaseFile $sumsAsset.browser_download_url $sumsDownload 65536
    if ((Get-Item -LiteralPath $cliDownload).Length -eq 0) { throw 'The CLI download is empty.' }
    $entries = @(Get-Content -LiteralPath $sumsDownload -Encoding UTF8 | Where-Object { $_ -cmatch '^([a-f0-9]{64}) [ *]obsidian-mcp-cli\.mjs$' })
    $actualHash = (Get-FileHash -LiteralPath $cliDownload -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($entries.Count -ne 1 -or $entries[0].Substring(0, 64) -cne $actualHash -or ($cliAsset.digest -and $cliAsset.digest -cne "sha256:$actualHash")) { throw 'CLI checksum verification failed. Nothing was executed.' }
    function Assert-SafeDestination([string]$Path) {
        $current = $Path
        while ($current) {
            if (Test-Path -LiteralPath $current) {
                $item = Get-Item -LiteralPath $current -Force
                if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Reparse-point installation destination is forbidden: $current" }
                if ($current -ne $Path -and -not $item.PSIsContainer) { throw "Invalid destination: $current" }
            }
            $parent = Split-Path -Parent $current
            if ($parent -eq $current) { break }
            $current = $parent
        }
    }
    function Set-PrivateFile([string]$Path) {
        $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
        $system = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
        $acl = [System.Security.AccessControl.FileSecurity]::new()
        $acl.SetAccessRuleProtection($true, $false)
        $acl.SetOwner($sid)
        $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'Allow'))
        $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($system, 'FullControl', 'Allow'))
        Set-Acl -LiteralPath $Path -AclObject $acl
    }
    function Install-AtomicFile([string]$Source, [string]$Destination) {
        Assert-SafeDestination $Destination
        $temporary = Join-Path $InstallDir ('.obsidian-mcp-' + [guid]::NewGuid().ToString('N') + '.tmp')
        try {
            [IO.File]::Copy($Source, $temporary, $false)
            Set-PrivateFile $temporary
            # PowerShell coerces $null to an empty string for this .NET string
            # parameter. NullString passes a real null backup path instead.
            if ([IO.File]::Exists($Destination)) { [IO.File]::Replace($temporary, $Destination, [NullString]::Value) }
            else { [IO.File]::Move($temporary, $Destination) }
            Set-PrivateFile $Destination
        } finally {
            if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
        }
    }
    $cliPath = Join-Path $InstallDir 'obsidian-mcp-cli.mjs'
    $launcher = Join-Path $InstallDir 'obsidian-mcp.cmd'
    Assert-SafeDestination $cliPath
    Assert-SafeDestination $launcher
    [IO.Directory]::CreateDirectory($InstallDir) | Out-Null
    Install-AtomicFile $cliDownload $cliPath
    $launcherDownload = Join-Path $tempDir 'obsidian-mcp.cmd'
    [IO.File]::WriteAllText($launcherDownload, "@echo off`r`nnode `"%~dp0obsidian-mcp-cli.mjs`" %*`r`n", [Text.Encoding]::ASCII)
    Install-AtomicFile $launcherDownload $launcher
    Write-Host "Verified CLI $tag installed. Launcher: $launcher"
    Write-Host 'If this directory is not on PATH, use its full path. No global PATH or policy was changed.'
    $command = if ($Update) { 'update' } else { 'install' }
    $cliArguments = @($cliPath, $command, '--source', 'remote', '--repo', $Repository, '--version', $tag)
    if ($Vault) { $cliArguments += @('--vault', $Vault) }
    if ($ConfigDir) { $cliArguments += @('--config-dir', $ConfigDir) }
    if ($null -ne $Port) { $cliArguments += @('--port', [string]$Port) }
    if ($Name) { $cliArguments += @('--name', $Name) }
    if ($Manual) { $cliArguments += '--manual' }
    if ($NoEnable) { $cliArguments += '--no-enable' }
    & $node @cliArguments
    $cliExit = $LASTEXITCODE
} catch {
    [Console]::Error.WriteLine("Installation failed: $($_.Exception.Message)")
    $cliExit = 1
} finally {
    if ($tempDir -and (Test-Path -LiteralPath $tempDir)) { Remove-Item -LiteralPath $tempDir -Recurse -Force }
}
exit $cliExit
