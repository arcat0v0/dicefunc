import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';

export interface ConfigExplainOptions {
  group?: string;
  key?: string;
}

const BUILTIN_DEFAULTS: Record<string, unknown> = {
  ruleSet: 'coc7',
  diceSides: 100,
  flavor: 'classic',
  timezone: 'Asia/Shanghai',
  enabled: true,
  defaults: {
    ruleSet: 'coc7',
    diceSides: 100,
    flavor: 'classic',
    timezone: 'Asia/Shanghai',
  },
  permissions: {
    allowCharacterSharing: false,
    maxDiceRolls: 1000,
  },
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

function resolveGroupFilePath(groupName: string): string {
  const directResolved = resolveExistingPath(groupName);
  if (fs.existsSync(directResolved)) {
    return directResolved;
  }
  const candidateYaml = resolveExistingPath(path.join('config', 'groups', `${groupName}.yaml`));
  if (fs.existsSync(candidateYaml)) {
    return candidateYaml;
  }
  const candidateYml = resolveExistingPath(path.join('config', 'groups', `${groupName}.yml`));
  if (fs.existsSync(candidateYml)) {
    return candidateYml;
  }
  return candidateYaml;
}

function getValueByDotPath(data: unknown, dotPath: string): { exists: boolean; value: unknown } {
  if (data === null || typeof data !== 'object') {
    return { exists: false, value: undefined };
  }

  const parts = dotPath.split('.');
  let current: unknown = data;

  for (const part of parts) {
    if (current !== null && typeof current === 'object' && part in current) {
      current = (current as Record<string, unknown>)[part];
    } else {
      return { exists: false, value: undefined };
    }
  }

  return { exists: true, value: current };
}

function getBuiltinValue(key: string): { exists: boolean; value: unknown } {
  const direct = getValueByDotPath(BUILTIN_DEFAULTS, key);
  if (direct.exists) {
    return direct;
  }

  if (key.startsWith('defaults.')) {
    const subKey = key.slice('defaults.'.length);
    const sub = getValueByDotPath(BUILTIN_DEFAULTS, subKey);
    if (sub.exists) {
      return sub;
    }
  } else {
    const inDef = getValueByDotPath(BUILTIN_DEFAULTS, `defaults.${key}`);
    if (inDef.exists) {
      return inDef;
    }
  }

  return { exists: false, value: undefined };
}

function getBotValue(botData: unknown, key: string): { exists: boolean; value: unknown } {
  const direct = getValueByDotPath(botData, key);
  if (direct.exists) {
    return direct;
  }

  if (!key.startsWith('defaults.')) {
    const inDefaults = getValueByDotPath(botData, `defaults.${key}`);
    if (inDefaults.exists) {
      return inDefaults;
    }
  }

  return { exists: false, value: undefined };
}

function getGroupValue(groupData: unknown, key: string): { exists: boolean; value: unknown } {
  const direct = getValueByDotPath(groupData, key);
  if (direct.exists) {
    return direct;
  }

  if (key.startsWith('defaults.')) {
    const subKey = key.slice('defaults.'.length);
    const inSettings = getValueByDotPath(groupData, `settings.${subKey}`);
    if (inSettings.exists) {
      return inSettings;
    }
    const inOverrides = getValueByDotPath(groupData, `overrides.${subKey}`);
    if (inOverrides.exists) {
      return inOverrides;
    }
  }

  const inSettingsDirect = getValueByDotPath(groupData, `settings.${key}`);
  if (inSettingsDirect.exists) {
    return inSettingsDirect;
  }

  const inOverridesDirect = getValueByDotPath(groupData, `overrides.${key}`);
  if (inOverridesDirect.exists) {
    return inOverridesDirect;
  }

  return { exists: false, value: undefined };
}

export async function runConfigExplain(options: ConfigExplainOptions): Promise<void> {
  const groupName = options.group || 'example';
  const key = options.key || 'defaults.ruleSet';

  const groupFilePath = resolveGroupFilePath(groupName);
  if (!fs.existsSync(groupFilePath)) {
    console.error(`Error: Group configuration file not found: ${groupFilePath}`);
    process.exit(1);
  }

  let groupConfig: unknown = null;
  try {
    const groupContent = fs.readFileSync(groupFilePath, 'utf-8');
    groupConfig = yaml.load(groupContent);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error loading group configuration ${groupFilePath}: ${message}`);
    process.exit(1);
  }

  const botFilePath = resolveExistingPath('config/bot.yaml');
  let botConfig: unknown = null;
  if (fs.existsSync(botFilePath)) {
    try {
      const botContent = fs.readFileSync(botFilePath, 'utf-8');
      botConfig = yaml.load(botContent);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Error loading bot configuration ${botFilePath}: ${message}`);
      process.exit(1);
    }
  }

  let finalValue: unknown = undefined;
  let finalSource = '';
  let foundAny = false;

  const step1 = getBuiltinValue(key);
  let step1Text = '(未定义)';
  if (step1.exists) {
    step1Text = JSON.stringify(step1.value);
    finalValue = step1.value;
    finalSource = '内置默认';
    foundAny = true;
  }

  const step2 = getBotValue(botConfig, key);
  let step2Text = '(未定义)';
  if (step2.exists) {
    step2Text = JSON.stringify(step2.value);
    finalValue = step2.value;
    finalSource = 'bot.yaml';
    foundAny = true;
  }

  const step3 = getGroupValue(groupConfig, key);
  let step3Text = '(未定义)';
  if (step3.exists) {
    step3Text = JSON.stringify(step3.value);
    finalValue = step3.value;
    finalSource = `群文件 (${groupFilePath})`;
    foundAny = true;
  }

  if (!foundAny) {
    console.error(`Error: Key "${key}" not found in defaults, bot.yaml, or ${groupFilePath}`);
    process.exit(1);
  }

  console.log(`配置键: ${key}`);
  console.log(`群组文件: ${groupFilePath}\n`);
  console.log('解析流程 (内置默认 -> bot.yaml -> 群文件):');
  console.log(`  1. [内置默认]: ${step1Text}`);
  console.log(`  2. [bot.yaml]: ${step2Text}`);
  console.log(`  3. [群文件]: ${step3Text}\n`);
  console.log(`最终值: ${JSON.stringify(finalValue)}`);
  console.log(`来源: ${finalSource}`);
}
