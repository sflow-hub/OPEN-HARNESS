import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request } from 'node:https';

export type HttpResult = { status: number; body: string; contentType: string };
export type CredentialTransport = (url: URL, options: { method: string; headers: Record<string, string>; body?: string; allowPrivate?: boolean }) => Promise<HttpResult>;

export function addressKind(address: string): 'public' | 'private' | 'blocked' {
  let ip = address.toLowerCase().replace(/^\[|\]$/g, '');
  if (isIP(ip) === 6) ip = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
  if (ip.startsWith('::ffff:')) {
    const parts = ip.slice(7).split(':').map(part => parseInt(part, 16));
    return parts.length === 2 ? addressKind([parts[0] >> 8, parts[0] & 255, parts[1] >> 8, parts[1] & 255].join('.')) : 'blocked';
  }
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    if (ip === '100.100.100.200' || ip === '168.63.129.16' || a === 0 || a === 127 || a === 169 && b === 254 || a >= 224) return 'blocked';
    if (a === 10 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 100 && b >= 64 && b <= 127 || a === 198 && [18, 19].includes(b)) return 'private';
    return 'public';
  }
  if (isIP(ip) === 6) {
    if (ip.startsWith('::') || /^(fe|ff)/.test(ip) || ip === 'fd00:ec2::254' || ip.startsWith('2001:db8:') || ip.startsWith('2001:0:') || ip.startsWith('2001::') || ip.startsWith('64:ff9b:') || ip.startsWith('2002:')) return 'blocked';
    if (/^f[cd]/.test(ip)) return 'private';
    return 'public';
  }
  return 'blocked';
}

export const credentialHttp: CredentialTransport = async (url, options) => {
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('Credential requests require HTTPS without embedded credentials or fragments.');
  const coordinator = process.env.OPEN_HARNESS_INTERNAL_CONTROL_URL || process.env.OPEN_HARNESS_PUBLIC_URL;
  if (coordinator && url.origin === new URL(coordinator).origin || Number(url.port || 443) === Number(process.env.OPEN_HARNESS_PORT || 4317)) throw new Error('The coordinator cannot be an API destination.');
  if (Buffer.byteLength(options.body || '', 'utf8') > 1_000_000) throw new Error('API request bodies are limited to 1 MB.');
  const signal = AbortSignal.timeout(30_000);
  const addresses = await new Promise<Array<{ address: string; family: number }>>((resolve, reject) => {
    const aborted = () => reject(new Error('API request timed out.'));
    signal.addEventListener('abort', aborted, { once: true });
    lookup(url.hostname.replace(/^\[|\]$/g, ''), { all: true }).then(resolve, () => reject(new Error('Could not resolve the API destination.'))).finally(() => signal.removeEventListener('abort', aborted));
  });
  if (!addresses.length || addresses.some(item => addressKind(item.address) === 'blocked' || addressKind(item.address) === 'private' && !options.allowPrivate)) throw new Error('This API destination is not allowed. Private network access requires an explicit grant.');
  // Pin the validated address for this connection so a second DNS lookup cannot rebind it.
  return new Promise((resolve, reject) => {
    const req = request(url, { method: options.method, headers: options.headers, signal, lookup: (_hostname, lookupOptions, callback) => lookupOptions.all ? callback(null, addresses) : callback(null, addresses[0].address, addresses[0].family) }, response => {
      if ((response.statusCode || 0) >= 300 && (response.statusCode || 0) < 400) { response.destroy(); reject(new Error('API redirects are refused. Use the final endpoint URL.')); return; }
      const chunks: Buffer[] = []; let size = 0;
      response.on('data', chunk => { size += chunk.length; if (size > 1_000_000) { response.destroy(); reject(new Error('API responses are limited to 1 MB.')); } else chunks.push(chunk); });
      response.on('error', () => reject(new Error('The API response could not be read.')));
      response.on('end', () => resolve({ status: response.statusCode || 502, body: Buffer.concat(chunks).toString('utf8'), contentType: String(response.headers['content-type'] || 'text/plain') }));
    });
    req.on('error', () => reject(new Error(signal.aborted ? 'API request timed out.' : 'Could not reach the API destination.')));
    req.end(options.body);
  });
};

export function redactCredential(value: string, fields: Record<string, string>) {
  const secrets = new Set(Object.values(fields).filter(Boolean));
  if (fields.username && fields.password) secrets.add(Buffer.from(`${fields.username}:${fields.password}`).toString('base64'));
  if (fields.headers) { try { for (const item of Object.values(JSON.parse(fields.headers))) if (typeof item === 'string' && item) secrets.add(item); } catch {} }
  const representations = new Set([...secrets].flatMap(secret => [secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)]));
  for (const secret of [...representations].sort((a, b) => b.length - a.length)) value = value.replaceAll(secret, '[redacted]');
  return value;
}
