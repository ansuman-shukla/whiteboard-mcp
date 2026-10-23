import { createHash } from 'node:crypto';

export const sha6 = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 6);

export function slug(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'canvas';
}
