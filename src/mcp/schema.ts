export interface Schema {
  type: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean';
  description?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  enum?: string[];
  maxItems?: number;
  additionalProperties?: boolean;
}

/** Some clients send null for omitted optional fields; treat those as absent. */
export function stripNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNulls);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null).map(([k, v]) => [k, stripNulls(v)]));
}

const typeOf = (v: unknown): string => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v);

/** Validates JSON against the small portable schema subset our tools use; returns the first problem found. */
export function validate(schema: Schema, value: unknown, path = 'arguments'): string | undefined {
  const actual = typeOf(value);
  const ok = schema.type === 'integer' ? Number.isInteger(value) : schema.type === 'number' ? actual === 'number' && Number.isFinite(value) : actual === schema.type;
  if (!ok) return `${path} must be ${schema.type === 'array' || schema.type === 'object' ? 'an' : 'a'} ${schema.type} (got ${actual})`;
  if (schema.enum && !schema.enum.includes(value as string)) return `${path} must be one of: ${schema.enum.join(', ')}`;
  if (Array.isArray(value)) {
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return `${path} has ${value.length} items; max is ${schema.maxItems} per call`;
    if (schema.items) {
      for (let i = 0; i < value.length; i++) {
        const err = validate(schema.items, value[i], `${path}[${i}]`);
        if (err) return err;
      }
    }
  } else if (actual === 'object') {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (obj[key] === undefined) return `${path}.${key} is required`;
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (obj[key] === undefined) continue;
      const err = validate(sub, obj[key], `${path}.${key}`);
      if (err) return err;
    }
  }
  return undefined;
}
