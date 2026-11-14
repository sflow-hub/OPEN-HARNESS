import type { Credentials } from './credentials';
import { CredentialError } from './credentials';
import type { CredentialOAuth } from './credential-oauth';
import { credentialHttp, redactCredential, type CredentialTransport } from './credential-http';
import type { CredentialGrant } from '../lib/agent-profile';
import { CODEX_PROVIDER } from '../lib/codex';

export type ApiInput = { credentialRef: string; url: string; method?: string; query?: Record<string, string>; headers?: Record<string, string>; body?: unknown };
export async function credentialApi(credentials: Credentials, oauth: CredentialOAuth, grant: CredentialGrant, input: ApiInput, transport: CredentialTransport = credentialHttp) {
  if (!grant || grant.credentialRef !== input.credentialRef) throw new CredentialError('This credential is not granted to this run.', 403);
  if (credentials.row(input.credentialRef).provider === CODEX_PROVIDER) throw new CredentialError('ChatGPT sign-in credentials are only available for model requests.', 403);
  let url: URL; try { url = new URL(input.url); } catch { throw new CredentialError('Enter a valid API URL.'); }
  const method = String(input.method || 'GET').toUpperCase();
  if (!grant.allowedOrigins.includes(url.origin) || !grant.allowedMethods.includes(method)) throw new CredentialError('This API origin or method is not granted to this run.', 403);
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.headers || {})) {
    if (!/^[!#$%&'*+.^_`|~0-9a-zA-Z-]+$/.test(key) || typeof value !== 'string' || /[\r\n]/.test(value) || ['authorization', 'proxy-authorization', 'cookie', 'host', 'content-length', 'connection', 'transfer-encoding'].includes(key.toLowerCase())) throw new CredentialError('This request header is not allowed.');
    headers[key.toLowerCase()] = value;
  }
  for (const [key, value] of Object.entries(input.query || {})) { if (typeof value !== 'string') throw new CredentialError('Query values must be text.'); url.searchParams.set(key, value); }
  await oauth.ready(input.credentialRef);
  const row = credentials.row(input.credentialRef), config = JSON.parse(row.config), fields = credentials.fields(row.ref);
  const privateFields = fields;
  const addHeader = (name: string, value: string) => { const key = name.toLowerCase(); if (headers[key] !== undefined) throw new CredentialError('Request headers cannot override credential authentication.'); headers[key] = value; };
  switch (row.type) {
    case 'model-api-key': addHeader('Authorization', `Bearer ${fields.value}`); break;
    case 'api-key': {
      const name = config.parameterName || 'X-API-Key';
      if (config.placement === 'query') { if (url.searchParams.has(name)) throw new CredentialError('Query parameters cannot override credential authentication.'); url.searchParams.set(name, fields.value); }
      else addHeader(name, fields.value);
      break;
    }
    case 'bearer': addHeader('Authorization', `Bearer ${fields.token}`); break;
    case 'basic': addHeader('Authorization', `Basic ${Buffer.from(`${fields.username}:${fields.password}`).toString('base64')}`); break;
    case 'headers': for (const [key, value] of Object.entries(JSON.parse(fields.headers || '{}'))) addHeader(key, String(value)); break;
    case 'oauth2': addHeader('Authorization', `Bearer ${fields.accessToken}`); break;
  }
  if (!credentials.present(row.ref)) throw new CredentialError('This credential is missing required secret fields.', 409);
  let body: string | undefined;
  if (input.body !== undefined) { if (['GET', 'HEAD'].includes(method)) throw new CredentialError('GET and HEAD requests cannot have a body.'); body = typeof input.body === 'string' ? input.body : JSON.stringify(input.body); if (!headers['content-type']) headers['content-type'] = 'application/json'; }
  try {
    const result = await transport(url, { method, headers, body, allowPrivate: grant.allowPrivateNetwork === true });
    credentials.touch([row.ref]);
    return { status: result.status, contentType: redactCredential(result.contentType, privateFields), body: redactCredential(result.body, privateFields) };
  } catch (error) { throw new CredentialError(redactCredential(error instanceof Error ? error.message : 'API request failed.', privateFields), 502); }
}
