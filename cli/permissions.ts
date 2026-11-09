import { execFile } from 'node:child_process';
import { chmod, stat } from 'node:fs/promises';

// Pass paths through the environment rather than interpolating PowerShell code.
async function windowsPermissions(path: string, checking: boolean): Promise<boolean> {
  const identity = `$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$system = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')`;
  const protect = `${identity}
$acl = [System.Security.AccessControl.FileSecurity]::new()
$acl.SetAccessRuleProtection($true, $false)
$acl.SetOwner($sid)
$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'Allow'))
$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($system, 'FullControl', 'Allow'))
Set-Acl -LiteralPath $env:OBSIDIAN_MCP_PERMISSION_PATH -AclObject $acl
Write-Output 'true'`;
  const check = `${identity}
$acl = Get-Acl -LiteralPath $env:OBSIDIAN_MCP_PERMISSION_PATH
$ok = $acl.AreAccessRulesProtected -and ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -eq $sid.Value)
$ownerAccess = $false
foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
  if ($rule.AccessControlType -ne 'Allow' -or $rule.IdentityReference.Value -notin @($sid.Value, $system.Value)) { $ok = $false }
  if ($rule.IdentityReference.Value -eq $sid.Value -and (($rule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -eq [System.Security.AccessControl.FileSystemRights]::FullControl)) { $ownerAccess = $true }
}
if ($ok -and $ownerAccess) { Write-Output 'true' } else { Write-Output 'false' }`;
  const code = `$ErrorActionPreference = 'Stop'\n${checking ? check : protect}`;
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')], {
      env: { ...process.env, OBSIDIAN_MCP_PERMISSION_PATH: path }, timeout: 15000, maxBuffer: 16384, windowsHide: true,
    }, (error, stdout) => {
      if (error) reject(new Error('Não foi possível verificar/aplicar a ACL privada. Use um volume Windows com suporte a ACL e Windows PowerShell.'));
      else resolve(stdout.trim().toLowerCase() === 'true');
    });
  });
}
export async function protectCredentials(path: string): Promise<void> {
  if (process.platform === 'win32') await windowsPermissions(path, false);
  else await chmod(path, 0o600);
}
export async function credentialsProtected(path: string): Promise<boolean> {
  if (process.platform === 'win32') return windowsPermissions(path, true);
  return ((await stat(path)).mode & 0o077) === 0;
}
