import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const service = 'dev.openharness.secrets';

function command(name: string, args: string[], input?: string) {
  return spawnSync(name, args, { input, encoding: 'utf8', timeout: 8_000, windowsHide: true, maxBuffer: 2_000_000 });
}

const account = (path: string) => `open-harness-${createHash('sha256').update(path).digest('hex').slice(0, 16)}`;

// "The vault holds nothing" and "the vault could not be reached" look identical from a
// failed lookup, and treating the second as the first is how an installation loses every
// stored key: the loader would report an empty map and the next save would overwrite the
// real blob with it. Every read therefore reports which of the two happened.
type VaultRead =
  | { state: 'ok'; value: string; backend: string }
  | { state: 'empty'; backend: string }
  | { state: 'unavailable'; backend: string; reason: string };

const DISABLED: VaultRead = { state: 'unavailable', backend: 'OS vault', reason: 'OPEN_HARNESS_DISABLE_OS_VAULT=1 is set.' };

function loadVault(path: string): VaultRead {
  if (process.env.OPEN_HARNESS_DISABLE_OS_VAULT === '1') return DISABLED;
  try {
    if (process.platform === 'darwin') {
      const backend = 'macOS Keychain';
      const result = command('security', ['find-generic-password', '-s', service, '-a', account(path), '-w']);
      if (result.status === 0) return { state: 'ok', value: result.stdout.trim(), backend };
      // `security` exits 44 for "no such item"; anything else is a locked or broken keychain.
      if (result.status === 44) return { state: 'empty', backend };
      return { state: 'unavailable', backend, reason: result.error ? result.error.message : (result.stderr || '').trim() || `security exited ${result.status}.` };
    }
    if (process.platform === 'linux') {
      const backend = 'system password vault';
      if (!process.env.DBUS_SESSION_BUS_ADDRESS) return { state: 'unavailable', backend, reason: 'No D-Bus session is available, so the password vault cannot be reached.' };
      const result = command('secret-tool', ['lookup', 'application', service, 'workspace', account(path)]);
      if (result.status === 0) return result.stdout.trim() ? { state: 'ok', value: result.stdout.trim(), backend } : { state: 'empty', backend };
      // secret-tool exits 1 both for "no match" and for a locked collection. It prints
      // nothing when there is simply no match, which is the only case safe to call empty.
      if (result.status === 1 && !(result.stderr || '').trim()) return { state: 'empty', backend };
      return { state: 'unavailable', backend, reason: result.error ? result.error.message : (result.stderr || '').trim() || `secret-tool exited ${result.status}.` };
    }
    if (process.platform === 'win32') {
      const backend = 'Windows account vault';
      const target = `${process.env.APPDATA || dirname(process.execPath)}\\Open Harness\\${account(path)}.dpapi`;
      const script = "$p=$args[0];if(-not (Test-Path -LiteralPath $p)){exit 44};$b=[IO.File]::ReadAllBytes($p);$d=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Text.Encoding]::UTF8.GetString($d))";
      const result = command('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script, target]);
      if (result.status === 0 && result.stdout) return { state: 'ok', value: result.stdout, backend };
      if (result.status === 44) return { state: 'empty', backend };
      return { state: 'unavailable', backend, reason: result.error ? result.error.message : (result.stderr || '').trim() || `PowerShell exited ${result.status}.` };
    }
    return { state: 'empty', backend: 'OS vault' };
  } catch (error) {
    return { state: 'unavailable', backend: 'OS vault', reason: error instanceof Error ? error.message : 'The OS vault could not be read.' };
  }
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

export class SecretsUnavailableError extends Error {}

export class SecretStore {
  private values: Record<string, string>;
  private markerPath: string;
  backend = 'restricted local file';
  constructor(private path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.markerPath = `${path.replace(/\.json$/, '')}.backend`;
    const recorded = existsSync(this.markerPath) ? readFileSync(this.markerPath, 'utf8').trim() : '';
    const vaulted = loadVault(path);
    const onDisk = existsSync(path);

    if (vaulted.state === 'ok') { this.values = this.parse(vaulted.value, vaulted.backend); this.backend = vaulted.backend; }
    else if (onDisk) { this.values = this.parse(readFileSync(path, 'utf8'), path); this.backend = 'restricted local file'; }
    else if (recorded.startsWith('vault')) {
      // Secrets exist in a vault this process cannot read. Starting fresh would mint a new
      // control token, invalidate every paired runner and agent token, and overwrite the
      // real blob on the first save. Stop instead, and say how to get back in.
      const detail = vaulted.state === 'unavailable' ? vaulted.reason : 'The vault reports no stored credentials.';
      throw new SecretsUnavailableError(
        `Open Harness stored its credentials in the ${recorded.slice(6) || vaulted.backend} and cannot read them now. ${detail}\n` +
        `Start Open Harness from an unlocked desktop session, or set OPEN_HARNESS_DISABLE_OS_VAULT=1 and re-enter the keys.\n` +
        `Nothing was changed. Delete ${this.markerPath} to start over with an empty credential store.`,
      );
    }
    else this.values = {};

    if (!this.values.controlToken) { this.values.controlToken = crypto.randomUUID() + crypto.randomUUID(); this.save(); }
    else this.record();
    if (existsSync(path)) chmodSync(path, 0o600);
  }
  get token() { return this.values.controlToken; }
  set(name: string, value: string) { if (!/^[A-Z][A-Z0-9_]{1,80}$/.test(name)) throw new Error("Invalid secret name."); this.values[name] = value; this.save(); }
  has(name: string) { return Boolean(this.values[name]); }
  names() { return Object.keys(this.values).filter(key => key !== "controlToken"); }
  environment() { return Object.fromEntries(Object.entries(this.values).filter(([key]) => key !== "controlToken")); }
  // save() reserializes the whole map, which still holds controlToken, so the vault blob
  // rewrites correctly and the dashboard token survives. The guard is defence in depth:
  // this is the one method that could otherwise brick it.
  delete(name: string) { if (name === "controlToken" || !(name in this.values)) return false; delete this.values[name]; this.save(); return true; }
  // Unreadable stored credentials are not the same as none: replacing them with a fresh
  // map is the one thing that cannot be undone, so say so and change nothing.
  private parse(raw: string, source: string): Record<string, string> {
    if (!raw.trim()) return {};
    let value: unknown;
    try { value = JSON.parse(raw); } catch { throw new SecretsUnavailableError(`The stored Open Harness credentials in ${source} are not readable JSON. Nothing was changed. Move that entry aside to start over with an empty credential store.`); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SecretsUnavailableError(`The stored Open Harness credentials in ${source} are not in the expected format. Nothing was changed. Move that entry aside to start over with an empty credential store.`);
    return value as Record<string, string>;
  }
  private record() { try { writeFileSync(this.markerPath, this.backend === 'restricted local file' ? 'file' : `vault:${this.backend}`, { mode: 0o600 }); } catch {} }
  private save() {
    const serialized = JSON.stringify(this.values);
    const backend = saveVault(this.path, serialized);
    // Only drop the file copy once the vault hands the same bytes back. A backend that
    // accepts a write and stores nothing would otherwise take the last readable copy.
    if (backend) {
      const confirmed = loadVault(this.path);
      if (confirmed.state === 'ok' && confirmed.value.trim() === serialized) {
        this.backend = backend; this.record();
        if (existsSync(this.path)) unlinkSync(this.path);
        return;
      }
    }
    this.backend = 'restricted local file';
    writeFileSync(this.path, JSON.stringify(this.values, null, 2), { mode: 0o600 });
    chmodSync(this.path, 0o600);
    this.record();
  }
}
