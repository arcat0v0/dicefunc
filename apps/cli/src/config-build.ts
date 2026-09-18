import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';

export interface ConfigBuildOptions {
  dir?: string;
  file?: string;
  out?: string;
}

interface YamlFile {
  path: string;
  relativePath: string;
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

function readYamlFiles(dir: string): YamlFile[] {
  const files: YamlFile[] = [];

  function traverse(currentDir: string) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      const relativePath = path.relative(dir, fullPath);

      if (entry.isDirectory()) {
        traverse(fullPath);
      } else if (entry.name.endsWith('.yaml') || entry.name.endsWith('.yml')) {
        files.push({
          path: fullPath,
          relativePath,
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

export async function runConfigBuild(options: ConfigBuildOptions): Promise<void> {
  try {
    let compiled: {
      schemaVersion: number;
      data: Record<string, unknown>;
      digest: string;
    };

    if (options.file) {
      const filePath = resolveConfigPath(options.file);
      if (!fs.existsSync(filePath)) {
        console.error(`Error: File not found: ${options.file}`);
        process.exit(1);
      }

      const content = fs.readFileSync(filePath, 'utf-8');
      const data = yaml.load(content);

      if (data === null || typeof data !== 'object' || Array.isArray(data)) {
        console.error(`Error: Invalid YAML configuration in ${options.file}`);
        process.exit(1);
      }

      const record = data as Record<string, unknown>;
      if (typeof record.schemaVersion !== 'number') {
        console.error(`Error: Invalid or missing schemaVersion in ${options.file}`);
        process.exit(1);
      }

      const digest = await calculateDigest(content);
      compiled = {
        schemaVersion: record.schemaVersion,
        data: record,
        digest,
      };
    } else {
      const dirPath = resolveConfigPath(options.dir || './config');
      if (!fs.existsSync(dirPath)) {
        console.error(`Error: Directory not found: ${options.dir || './config'}`);
        process.exit(1);
      }

      const files = readYamlFiles(dirPath);
      if (files.length === 0) {
        console.error(`Error: No YAML configuration files found in ${dirPath}`);
        process.exit(1);
      }

      let maxSchemaVersion = 0;
      const mergedData: Record<string, unknown> = {};

      for (const file of files) {
        const content = fs.readFileSync(file.path, 'utf-8');
        const data = yaml.load(content);

        if (data === null || typeof data !== 'object' || Array.isArray(data)) {
          console.error(`Error: Invalid YAML configuration in ${file.path}`);
          process.exit(1);
        }

        const record = data as Record<string, unknown>;
        if (typeof record.schemaVersion !== 'number') {
          console.error(`Error: Invalid or missing schemaVersion in ${file.path}`);
          process.exit(1);
        }

        if (record.schemaVersion > maxSchemaVersion) {
          maxSchemaVersion = record.schemaVersion;
        }

        Object.assign(mergedData, record);
      }

      const serialized = JSON.stringify(mergedData);
      const digest = await calculateDigest(serialized);

      compiled = {
        schemaVersion: maxSchemaVersion,
        data: mergedData,
        digest,
      };
    }

    const jsonOutput = JSON.stringify(compiled, null, 2);

    if (options.out) {
      const outputPath = path.resolve(options.out);
      const outDir = path.dirname(outputPath);
      if (!fs.existsSync(outDir)) {
        fs.mkdirSync(outDir, { recursive: true });
      }
      fs.writeFileSync(outputPath, jsonOutput, 'utf-8');
    } else {
      process.stdout.write(`${jsonOutput}\n`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Configuration build failed: ${message}`);
    process.exit(1);
  }
}
