import { describe, expect, it } from 'vitest';
import { compareVersions } from '../../src/shared/config.js';

const sign = (a: string, b: string) => Math.sign(compareVersions(a, b));

describe('compareVersions', () => {
  it('orders major, minor and patch numerically, not as text', () => {
    expect(sign('0.3.1', '0.3.1')).toBe(0);
    expect(sign('0.3.1', '0.3.2')).toBe(-1);
    expect(sign('0.3.10', '0.3.9')).toBe(1);
    expect(sign('0.10.0', '0.9.9')).toBe(1);
    expect(sign('1.0.0', '0.99.99')).toBe(1);
    expect(sign('0.2.9', '1.0.0')).toBe(-1);
  });

  it('puts a pre-release before its release and orders pre-releases numerically', () => {
    expect(sign('1.0.0-beta.1', '1.0.0')).toBe(-1);
    expect(sign('1.0.0', '1.0.0-beta.1')).toBe(1);
    expect(sign('1.0.0-beta.2', '1.0.0-beta.10')).toBe(-1);
    expect(sign('1.0.0-alpha', '1.0.0-beta')).toBe(-1);
    expect(sign('1.0.0-rc.1', '0.9.0')).toBe(1);
    expect(sign('1.0.0+build.5', '1.0.0')).toBe(0);
  });

  it('treats a missing or malformed version as older than any real one', () => {
    expect(sign('', '0.0.1')).toBe(-1);
    expect(sign('0.0.1', 'undefined')).toBe(1);
    expect(sign('v1', 'v2')).toBe(0);
  });
});
