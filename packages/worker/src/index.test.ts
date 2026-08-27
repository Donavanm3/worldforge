import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from './index.js';

describe('@wf/worker', () => {
  it('exposes its package name', () => {
    expect(PACKAGE_NAME).toBe('@wf/worker');
  });
});
