import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';

export interface ReplyPreviewOptions {
  flavor?: string;
}

interface TemplateVariant {
  id: string;
  weight: number;
  text: string;
}

interface TemplateDefinition {
  variants: TemplateVariant[];
}

interface FlavorManifest {
  schemaVersion: number;
  id: string;
  displayName?: string | undefined;
  extends?: string | null | undefined;
  files?: string[] | undefined;
}

const SAMPLE_VARIABLES: Record<string, Record<string, unknown>> = {
  'dice.roll.success': {
    actor: { name: '调查员' },
    expression: '3d6+2',
    total: 14,
    individualRolls: '3, 4, 5',
  },
  'dice.roll.failure': {
    actor: { name: '调查员' },
    expression: '3d6+2',
    total: 6,
    individualRolls: '1, 2, 1',
  },
  'coc.check.success': {
    actor: { name: '调查员' },
    skill: { name: '侦查' },
    roll: { total: 42 },
    target: { value: 60 },
  },
  'coc.check.failure': {
    actor: { name: '调查员' },
    skill: { name: '侦查' },
    roll: { total: 75 },
    target: { value: 60 },
  },
};

const DEFAULT_SAMPLE_VARS: Record<string, unknown> = {
  actor: { name: '调查员' },
  skill: { name: '侦查' },
  target: { value: 60 },
  roll: { total: 42, expression: '1d100', individualRolls: '42' },
  expression: '3d6+2',
  total: 14,
  individualRolls: '3, 4, 5',
};

function resolveExistingPath(subPath: string): string {
  if (fs.existsSync(subPath)) {
    return subPath;
  }
  const fromMonorepo = path.resolve(process.cwd(), '../../', subPath);
  if (fs.existsSync(fromMonorepo)) {
    return fromMonorepo;
  }
  return subPath;
}

function loadTemplatesFromFlavor(flavorName: string): Record<string, TemplateDefinition> {
  const flavorDir = resolveExistingPath(path.join('config', 'flavors', flavorName));
  const manifestPath = path.join(flavorDir, 'manifest.yaml');

  if (!fs.existsSync(manifestPath)) {
    console.error(`Error: Flavor manifest not found: ${manifestPath}`);
    process.exit(1);
  }

  const manifestContent = fs.readFileSync(manifestPath, 'utf-8');
  const manifest = yaml.load(manifestContent) as FlavorManifest;

  const templates: Record<string, TemplateDefinition> = {};

  if (manifest.extends) {
    const parentTemplates = loadTemplatesFromFlavor(manifest.extends);
    Object.assign(templates, parentTemplates);
  }

  const replyFiles = new Set<string>();
  if (Array.isArray(manifest.files)) {
    for (const f of manifest.files) {
      replyFiles.add(path.join(flavorDir, f));
    }
  }

  const repliesDir = path.join(flavorDir, 'replies');
  if (fs.existsSync(repliesDir)) {
    const entries = fs.readdirSync(repliesDir);
    for (const entry of entries) {
      if (entry.endsWith('.yaml') || entry.endsWith('.yml')) {
        replyFiles.add(path.join(repliesDir, entry));
      }
    }
  }

  for (const filePath of replyFiles) {
    if (!fs.existsSync(filePath)) {
      continue;
    }
    const content = fs.readFileSync(filePath, 'utf-8');
    const data = yaml.load(content) as Record<string, unknown>;
    if (data && typeof data === 'object' && 'templates' in data) {
      const fileTemplates = data.templates as Record<string, unknown>;
      for (const [key, val] of Object.entries(fileTemplates)) {
        if (val && typeof val === 'object' && 'variants' in val) {
          const rawVariants = (val as { variants: unknown[] }).variants;
          if (Array.isArray(rawVariants)) {
            templates[key] = {
              variants: rawVariants.map((v) => {
                const variantObj = v as Record<string, unknown>;
                return {
                  id: String(variantObj.id ?? 'default'),
                  weight: typeof variantObj.weight === 'number' ? variantObj.weight : 1,
                  text: String(variantObj.text ?? ''),
                };
              }),
            };
          }
        }
      }
    }
  }

  return templates;
}

function getSampleVariablesForEvent(eventKey: string): Record<string, unknown> {
  const specific = SAMPLE_VARIABLES[eventKey];
  if (specific) {
    return specific;
  }
  return DEFAULT_SAMPLE_VARS;
}

function interpolateVariables(template: string, vars: Record<string, unknown>): string {
  return template.replace(/\{\{([a-zA-Z0-9_.]+)\}\}/g, (_match, varPath: string) => {
    const parts = varPath.split('.');
    let current: unknown = vars;
    for (const part of parts) {
      if (current !== null && typeof current === 'object' && part in current) {
        current = (current as Record<string, unknown>)[part];
      } else {
        return `{{${varPath}}}`;
      }
    }
    if (Array.isArray(current)) {
      return current.join(', ');
    }
    if (current !== undefined && current !== null) {
      return String(current);
    }
    return `{{${varPath}}}`;
  });
}

export async function runReplyPreview(
  eventKey: string,
  options: ReplyPreviewOptions,
): Promise<void> {
  const flavor = options.flavor || 'classic';
  const templates = loadTemplatesFromFlavor(flavor);

  if (!(eventKey in templates)) {
    console.error(`Error: Template key "${eventKey}" not found in flavor "${flavor}".`);
    console.error('\nAvailable template keys:');
    const sortedKeys = Object.keys(templates).sort();
    if (sortedKeys.length === 0) {
      console.error('  (none)');
    } else {
      for (const k of sortedKeys) {
        console.error(`  - ${k}`);
      }
    }
    process.exit(1);
  }

  const templateDef = templates[eventKey];
  if (!templateDef) {
    console.error(`Error: Template definition not found for "${eventKey}".`);
    process.exit(1);
  }

  const sampleVars = getSampleVariablesForEvent(eventKey);

  console.log(`模板键: ${eventKey}`);
  console.log(`风格: ${flavor}\n`);
  console.log('示例变量:');
  console.log(JSON.stringify(sampleVars, null, 2));
  console.log('\n变体列表:');

  for (const variant of templateDef.variants) {
    console.log('\n----------------------------------------');
    console.log(`[变体: ${variant.id}] (权重: ${variant.weight})`);
    console.log('渲染结果:');
    const rendered = interpolateVariables(variant.text.trim(), sampleVars);
    console.log(rendered);
  }
  console.log('----------------------------------------');
}
