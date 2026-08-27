import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME, migrations, StaticMigrationProvider } from './index.js';

describe('@wf/db', () => {
  it('exposes its package name', () => {
    expect(PACKAGE_NAME).toBe('@wf/db');
  });
});

describe('migration registry', () => {
  it('registers at least one migration', () => {
    expect(Object.keys(migrations).length).toBeGreaterThan(0);
  });

  it('gives every migration a reversible up/down pair', () => {
    for (const [name, migration] of Object.entries(migrations)) {
      expect(typeof migration.up, `${name}.up`).toBe('function');
      expect(typeof migration.down, `${name}.down`).toBe('function');
    }
  });

  it('names migrations so lexicographic order is execution order', () => {
    const names = Object.keys(migrations);
    expect(names).toStrictEqual([...names].sort());
    for (const name of names) {
      expect(name).toMatch(/^\d{3}-[a-z0-9-]+$/);
    }
  });

  it('serves the same set through the provider', async () => {
    const provided = await new StaticMigrationProvider().getMigrations();
    expect(Object.keys(provided)).toStrictEqual(Object.keys(migrations));
  });
});
