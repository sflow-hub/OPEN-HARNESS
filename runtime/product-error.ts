export class ProductError extends Error { constructor(message: string, readonly status = 400) { super(message); } }
export function text(value: unknown, label: string, max = 12000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new ProductError(`${label} is required (up to ${max} characters).`);
  return value.trim();
}
export function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProductError('A JSON object is required.'); return value as Record<string, unknown>; }
export function integer(value: unknown, label: string, min: number, max: number) { if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) throw new ProductError(`${label} must be between ${min} and ${max}.`); return Number(value); }
