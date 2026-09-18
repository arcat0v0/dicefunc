import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';

export interface ConfigCheckOptions {
  dir: string;
}

interface YamlFile {
  path: string;
  relativePath: string;
}

function resolveConfigDir(inputDir: string): string {
  const direct = path.resolve(inputDir);
  if (fs.existsSync(direct)) {
    return direct;
  }
  const fromMonorepo = path.resolve(process.cwd(), '../../', inputDir);
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
  return files;
}

export async function runConfigCheck(options: ConfigCheckOptions): Promise<void> {
  const targetDir = resolveConfigDir(options.dir);
  if (!fs.existsSync(targetDir)) {
    console.error(`Error: Directory not found: ${options.dir}`);
    process.exit(1);
  }

  const files = readYamlFiles(targetDir);
  const errors: string[] = [];

  for (const file of files) {
    try {
      const content = fs.readFileSync(file.path, 'utf-8');
      const data = yaml.load(content, {
        listener: (_op: string, _state: unknown) => {},
      });

      if (data === null || typeof data !== 'object' || Array.isArray(data)) {
        errors.push(`${file.path}: Root structure must be an object`);
        continue;
      }

      const record = data as Record<string, unknown>;
      if (!('schemaVersion' in record)) {
        errors.push(`${file.path}: Missing required top-level field 'schemaVersion'`);
      } else if (typeof record.schemaVersion !== 'number') {
        errors.push(`${file.path}: Top-level 'schemaVersion' must be a number`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${file.path}: ${message}`);
    }
  }

  if (errors.length > 0) {
    console.error(`Configuration check failed with ${errors.length} error(s):`);
    for (const error of errors) {
      console.error(`  ✗ ${error}`);
    }
    process.exit(1);
  }

  console.log(`Configuration check passed: ${files.length} file(s) checked, 0 errors.`);
}
