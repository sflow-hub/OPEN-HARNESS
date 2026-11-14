export type CredentialType = 'model-api-key' | 'api-key' | 'bearer' | 'basic' | 'headers' | 'oauth2';
export type CredentialField = { key: string; label: string; secret?: boolean; required?: boolean; options?: string[]; default?: string; help?: string };
export type CredentialTypeDefinition = { id: CredentialType; label: string; fields: CredentialField[]; modelCompatible: boolean; test: 'model' | 'http' };
const httpFields: CredentialField[] = [
  { key: 'testUrl', label: 'Connection test URL', help: 'Optional HTTPS endpoint used only when you click Test connection.' },
  { key: 'allowPrivateNetwork', label: 'Allow private network', options: ['false', 'true'], default: 'false' },
];
export const CREDENTIAL_TYPES: CredentialTypeDefinition[] = [
  { id: 'model-api-key', label: 'Model API key', modelCompatible: true, test: 'model', fields: [{ key: 'value', label: 'Value', secret: true, required: true }] },
  { id: 'api-key', label: 'API key', modelCompatible: true, test: 'http', fields: [
    { key: 'value', label: 'Value', secret: true, required: true },
    { key: 'placement', label: 'Send key in', options: ['header', 'query'], default: 'header' },
    { key: 'parameterName', label: 'Header or query name', default: 'X-API-Key', required: true }, ...httpFields,
  ] },
  { id: 'bearer', label: 'Bearer token', modelCompatible: false, test: 'http', fields: [{ key: 'token', label: 'Token', secret: true, required: true }, ...httpFields] },
  { id: 'basic', label: 'Basic authentication', modelCompatible: false, test: 'http', fields: [{ key: 'username', label: 'Username', secret: true, required: true }, { key: 'password', label: 'Password', secret: true, required: true }, ...httpFields] },
  { id: 'headers', label: 'Multiple headers', modelCompatible: false, test: 'http', fields: [{ key: 'headers', label: 'Headers JSON', secret: true, required: true, help: 'A JSON object of header names and values.' }, ...httpFields] },
  { id: 'oauth2', label: 'OAuth2', modelCompatible: false, test: 'http', fields: [
    { key: 'grantType', label: 'Grant type', options: ['authorization_code', 'client_credentials'], default: 'authorization_code' },
    { key: 'authorizationUrl', label: 'Authorization URL' }, { key: 'tokenUrl', label: 'Token URL', required: true },
    { key: 'clientId', label: 'Client ID', required: true }, { key: 'clientSecret', label: 'Client secret', secret: true },
    { key: 'clientAuth', label: 'Client authentication', options: ['body', 'basic', 'none'], default: 'body' },
    { key: 'scopes', label: 'Scopes', help: 'Space-separated scopes.' },
    { key: 'authorizationParams', label: 'Authorization parameters JSON', help: 'Optional parameters such as access_type or prompt.' }, ...httpFields,
  ] },
];
export function credentialType(id: string): CredentialTypeDefinition {
  const type = CREDENTIAL_TYPES.find(item => item.id === id);
  if (!type) throw new Error('Choose a supported credential type.');
  return type;
}
export function modelCredential(item: { type?: string }) { return !item.type || credentialType(item.type).modelCompatible; }
