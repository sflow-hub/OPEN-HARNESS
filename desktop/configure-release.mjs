import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

if (!process.env.TAURI_SIGNING_PRIVATE_KEY) throw new Error('TAURI_SIGNING_PRIVATE_KEY is required for signed update artifacts.');
if (!process.env.OPEN_HARNESS_UPDATE_PUBKEY) throw new Error('OPEN_HARNESS_UPDATE_PUBKEY is required for desktop releases.');
if (process.platform === 'darwin' && (!process.env.APPLE_CERTIFICATE || !process.env.APPLE_SIGNING_IDENTITY || !process.env.APPLE_ID || !process.env.APPLE_PASSWORD || !process.env.APPLE_TEAM_ID)) throw new Error('Apple signing and notarization secrets are required for macOS releases.');
if (process.platform === 'win32' && !process.env.WINDOWS_CERTIFICATE_THUMBPRINT) throw new Error('A Windows code-signing certificate is required for Windows releases.');
const path = resolve(import.meta.dirname, '..', 'src-tauri', 'tauri.conf.json');
const config = JSON.parse(await readFile(path, 'utf8'));
config.bundle.createUpdaterArtifacts = true;
if (process.platform === 'win32') config.bundle.windows = { ...(config.bundle.windows || {}), certificateThumbprint: process.env.WINDOWS_CERTIFICATE_THUMBPRINT, digestAlgorithm: 'sha256', timestampUrl: 'http://timestamp.digicert.com' };
await writeFile(path, JSON.stringify(config, null, 2) + '\n');
console.log('Signed updater artifacts enabled for this release build.');
