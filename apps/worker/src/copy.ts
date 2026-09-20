import { load } from 'js-yaml';
import classicCoreCopy from '../../../config/flavors/classic/replies/core.yaml?raw';

interface CopyVariant {
  readonly text?: unknown;
}

interface CopyDefinition {
  readonly variants?: readonly CopyVariant[];
}

interface CopyDocument {
  readonly templates?: Readonly<Record<string, CopyDefinition>>;
}

export const DEFAULT_BOT_NAME = 'Dicefunc';

export function readBotDisplayName(content: string): string {
  const document = load(content) as CopyDocument | null;
  const value = document?.templates?.['bot.name']?.variants?.[0]?.text;
  return typeof value === 'string' && value.trim() ? value.trim() : DEFAULT_BOT_NAME;
}

export const botDisplayName = readBotDisplayName(classicCoreCopy);
