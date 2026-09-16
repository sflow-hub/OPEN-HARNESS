import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const service = 'dev.openharness.secrets';

function command(name: string, args: string[], input?: string) {
  return spawnSync(name, args, { input, encoding: 'utf8', timeout: 8_000, windowsHide: true, maxBuffer: 2_000_000 });
}

const account = (path: string) => `open-harness-${createHash('sha256').update(path).digest('hex').slice(0, 16)}`;
function loadVault(path: string) {
  if (process.env.OPEN_HARNESS_DISABLE_OS_VAULT === '1') return null;
  try {
    if (process.platform === 'darwin') { const result = command('security', ['find-generic-password', '-s', service, '-a', account(path), '-w']); return result.status === 0 ? { value: result.stdout.trim(), backend: 'macOS Keychain' } : null; }
    if (process.platform === 'linux' && process.env.DBUS_SESSION_BUS_ADDRESS) { const result = command('secret-tool', ['lookup', 'application', service, 'workspace', account(path)]); return result.status === 0 && result.stdout.trim() ? { value: result.stdout.trim(), backend: 'system password vault' } : null; }
    if (process.platform === 'win32') {
      const script = "$p=$args[0];if(Test-Path -LiteralPath $p){$b=[IO.File]::ReadAllBytes($p);$d=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Text.Encoding]::UTF8.GetString($d))}";
      const result = command('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script, `${process.env.APPDATA || dirname(process.execPath)}\\Open Harness\\${account(path)}.dpapi`]);
      return result.status === 0 && result.stdout ? { value: result.stdout, backend: 'Windows account vault' } : null;
    }
  } catch {}
  return null;
}

function saveVault(path: string, value: string) {
  if (process.env.OPEN_HARNESS_DISABLE_OS_VAULT === '1') return null;
  try {
    if (process.platform === 'darwin') return command('security', ['add-generic-password', '-U', '-s', service, '-a', account(path), '-w', value]).status === 0 ? 'macOS Keychain' : null;
    if (process.platform === 'linux' && process.env.DBUS_SESSION_BUS_ADDRESS) return command('secret-tool', ['store', '--label=Open Harness credentials', 'application', service, 'workspace', account(path)], value).status === 0 ? 'system password vault' : null;
    if (process.platform === 'win32') {
      const target = `${process.env.APPDATA || dirname(process.execPath)}\\Open Harness\\${account(path)}.dpapi`;
      const script = "$p=$args[0];$v=[Console]::In.ReadToEnd();$d=Split-Path -Parent $p;New-Item -ItemType Directory -Force -Path $d|Out-Null;$b=[Text.Encoding]::UTF8.GetBytes($v);$e=[Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[IO.File]::WriteAllBytes($p,$e)";
      return command('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script, target], value).status === 0 ? 'Windows account vault' : null;
    }
  } catch {}
  return null;
}

export class SecretStore {
  private values: Record<string, string>;
  backend = 'restricted local file';
  constructor(private path: string) {
    mkdirSync(dirname(path), { recursive: true });
    const vaulted = loadVault(path);
    try { this.values = vaulted?.value ? JSON.parse(vaulted.value) : existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {}; }
    catch { this.values = {}; }
    if (vaulted) this.backend = vaulted.backend;
    if (!this.values.controlToken) { this.values.controlToken = crypto.randomUUID() + crypto.randomUUID(); this.save(); }
    if (existsSync(path)) chmodSync(path, 0o600);
  }
  get token() { return this.values.controlToken; }
  set(name: string, value: string) { if (!/^[A-Z][A-Z0-9_]{1,80}$/.test(name)) throw new Error("Invalid secret name."); this.values[name] = value; this.save(); }
  has(name: string) { return Boolean(this.values[name]); }
  names() { return Object.keys(this.values).filter(key => key !== "controlToken"); }
  environment() { return Object.fromEntries(Object.entries(this.values).filter(([key]) => key !== "controlToken")); }
  private save() {
    const serialized = JSON.stringify(this.values);
    const backend = saveVault(this.path, serialized);
    if (backend) { this.backend = backend; if (existsSync(this.path)) unlinkSync(this.path); return; }
    this.backend = 'restricted local file'; writeFileSync(this.path, JSON.stringify(this.values, null, 2), { mode: 0o600 }); chmodSync(this.path, 0o600);
  }
}
