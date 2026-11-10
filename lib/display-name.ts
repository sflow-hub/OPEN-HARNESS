export function accountDisplayName(value: unknown): string | undefined {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(value)) return;
  const name=value.trim();return name && name.length<=100 ? name : undefined;
}
