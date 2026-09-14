import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export class SecretStore {
  private values: Record<string, string>;
  constructor(private path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.values = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
    if (!this.values.controlToken) { this.values.controlToken = crypto.randomUUID() + crypto.randomUUID(); this.save(); }
    chmodSync(path, 0o600);
  }
  get token() { return this.values.controlToken; }
  set(name: string, value: string) { if (!/^[A-Z][A-Z0-9_]{1,80}$/.test(name)) throw new Error("Invalid secret name."); this.values[name] = value; this.save(); }
  has(name: string) { return Boolean(this.values[name]); }
  names() { return Object.keys(this.values).filter(key => key !== "controlToken"); }
  environment() { return Object.fromEntries(Object.entries(this.values).filter(([key]) => key !== "controlToken")); }
  private save() { writeFileSync(this.path, JSON.stringify(this.values, null, 2), { mode: 0o600 }); chmodSync(this.path, 0o600); }
}
