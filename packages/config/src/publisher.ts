import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import type { CompiledConfig } from './compiler.js';

export interface StorageAdapter {
  kvPut(key: string, value: string): Promise<void>;
  kvGet(key: string): Promise<string | null>;
  r2Put(key: string, value: string): Promise<void>;
  r2Get(key: string): Promise<string | null>;
}

function resolveConfigPath(inputPath: string): string {
  const direct = path.resolve(inputPath);
  if (fs.existsSync(direct)) {
    return direct;
  }
  const fromMonorepo = path.resolve(process.cwd(), '../../', inputPath);
  if (fs.existsSync(fromMonorepo)) {
    return fromMonorepo;
  }
  return direct;
}

function readYamlFiles(dir: string): { path: string; relativePath: string }[] {
  const files: { path: string; relativePath: string }[] = [];

  function traverse(currentDir: string) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        traverse(fullPath);
      } else if (entry.name.endsWith('.yaml') || entry.name.endsWith('.yml')) {
        files.push({
          path: fullPath,
          relativePath: path.relative(dir, fullPath),
        });
      }
    }
  }

  traverse(dir);
  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

async function calculateDigest(content: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function compileConfigDirectory(dirPath: string): Promise<CompiledConfig> {
  const resolved = resolveConfigPath(dirPath);
  const files = readYamlFiles(resolved);
  if (files.length === 0) {
    throw new Error(`No YAML configuration files found in ${resolved}`);
  }

  let maxSchemaVersion = 0;
  const mergedData: Record<string, unknown> = {};

  for (const file of files) {
    const content = fs.readFileSync(file.path, 'utf-8');
    const data = yaml.load(content);
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error(`Invalid YAML configuration in ${file.path}`);
    }
    const record = data as Record<string, unknown>;
    if (typeof record.schemaVersion !== 'number') {
      throw new Error(`Invalid or missing schemaVersion in ${file.path}`);
    }
    if (record.schemaVersion > maxSchemaVersion) {
      maxSchemaVersion = record.schemaVersion;
    }
    Object.assign(mergedData, record);
  }

  const serialized = JSON.stringify(mergedData);
  const digest = await calculateDigest(serialized);

  return {
    schemaVersion: maxSchemaVersion,
    data: mergedData,
    digest,
  };
}

export async function publishConfigPackage(
  pkg: CompiledConfig,
  storage: StorageAdapter,
): Promise<{
  digest: string;
  kvKey: string;
  r2Key: string;
  activeVersionKey: string;
}> {
  const payload = JSON.stringify(pkg, null, 2);
  const r2Key = `configs/pkg_${pkg.digest}.json`;
  const kvKey = `config:${pkg.digest}`;
  const activeVersionKey = 'config:active_version';

  await storage.r2Put(r2Key, payload);
  await storage.kvPut(kvKey, payload);
  await storage.kvPut(activeVersionKey, pkg.digest);

  return {
    digest: pkg.digest,
    kvKey,
    r2Key,
    activeVersionKey,
  };
}

export async function rollbackConfigVersion(
  targetVersion: string,
  storage: StorageAdapter,
): Promise<{
  previousVersion: string | null;
  activeVersion: string;
}> {
  const previousVersion = await storage.kvGet('config:active_version');

  const pkgInKv = await storage.kvGet(`config:${targetVersion}`);
  if (!pkgInKv) {
    const pkgInR2 = await storage.r2Get(`configs/pkg_${targetVersion}.json`);
    if (!pkgInR2) {
      throw new Error(`Target config version ${targetVersion} does not exist in KV or R2 archive`);
    }
    await storage.kvPut(`config:${targetVersion}`, pkgInR2);
  }

  await storage.kvPut('config:active_version', targetVersion);

  return {
    previousVersion,
    activeVersion: targetVersion,
  };
}

export class InMemoryStorageAdapter implements StorageAdapter {
  private readonly kv = new Map<string, string>();
  private readonly r2 = new Map<string, string>();

  async kvPut(key: string, value: string): Promise<void> {
    this.kv.set(key, value);
  }

  async kvGet(key: string): Promise<string | null> {
    return this.kv.get(key) ?? null;
  }

  async r2Put(key: string, value: string): Promise<void> {
    this.r2.set(key, value);
  }

  async r2Get(key: string): Promise<string | null> {
    return this.r2.get(key) ?? null;
  }
}
