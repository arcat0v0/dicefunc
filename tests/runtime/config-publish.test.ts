import * as path from 'node:path';
import {
  InMemoryStorageAdapter,
  compileConfigDirectory,
  publishConfigPackage,
  rollbackConfigVersion,
} from '@dicefunc/config';
import { describe, expect, it } from 'vitest';

describe('Configuration Publishing', () => {
  const configDir = path.resolve(process.cwd(), 'config');

  it('compiles configuration directory into package with SHA-256 digest', async () => {
    const pkg = await compileConfigDirectory(configDir);
    expect(pkg.schemaVersion).toBeGreaterThan(0);
    expect(pkg.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(pkg.data).toBeDefined();
  });

  it('publishes config package to R2 backup and KV with active pointer', async () => {
    const pkg = await compileConfigDirectory(configDir);
    const storage = new InMemoryStorageAdapter();

    const result = await publishConfigPackage(pkg, storage);

    expect(result.digest).toBe(pkg.digest);
    expect(result.kvKey).toBe(`config:${pkg.digest}`);
    expect(result.r2Key).toBe(`configs/pkg_${pkg.digest}.json`);

    const inKv = await storage.kvGet(`config:${pkg.digest}`);
    expect(inKv).toBeDefined();
    const activeVersion = await storage.kvGet('config:active_version');
    expect(activeVersion).toBe(pkg.digest);
    const inR2 = await storage.r2Get(`configs/pkg_${pkg.digest}.json`);
    expect(inR2).toBeDefined();
  });

  it('rolls back active version to previous version and handles R2 restore', async () => {
    const pkg1 = {
      schemaVersion: 1,
      data: { version: 'v1' },
      digest: '1111111111111111111111111111111111111111111111111111111111111111',
    };
    const pkg2 = {
      schemaVersion: 1,
      data: { version: 'v2' },
      digest: '2222222222222222222222222222222222222222222222222222222222222222',
    };

    const storage = new InMemoryStorageAdapter();
    await publishConfigPackage(pkg1, storage);
    await publishConfigPackage(pkg2, storage);

    expect(await storage.kvGet('config:active_version')).toBe(pkg2.digest);

    const rollbackResult = await rollbackConfigVersion(pkg1.digest, storage);
    expect(rollbackResult.previousVersion).toBe(pkg2.digest);
    expect(rollbackResult.activeVersion).toBe(pkg1.digest);
    expect(await storage.kvGet('config:active_version')).toBe(pkg1.digest);

    await expect(
      rollbackConfigVersion(
        '3333333333333333333333333333333333333333333333333333333333333333',
        storage,
      ),
    ).rejects.toThrow('does not exist in KV or R2 archive');
  });
});
