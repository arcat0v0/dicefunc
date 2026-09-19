import type { SceneType } from '../../ports/state-store.js';

export interface CustomReplyRule {
  readonly id: string;
  readonly enabled: boolean;
  readonly priority: number;
  readonly scenes?: readonly SceneType[] | undefined;
  readonly match: {
    readonly exact?: string | undefined;
    readonly contains?: string | undefined;
    readonly prefix?: string | undefined;
    readonly suffix?: string | undefined;
    readonly minLength?: number | undefined;
    readonly maxLength?: number | undefined;
  };
  readonly cooldown?:
    | {
        readonly scope: 'user-in-conversation' | 'conversation';
        readonly seconds: number;
      }
    | undefined;
  readonly action: {
    readonly template?: string | undefined;
    readonly text?: string | undefined;
  };
  readonly stop?: boolean | undefined;
}

export function matchCustomReply(
  text: string,
  scene: SceneType,
  rules: readonly CustomReplyRule[],
): CustomReplyRule | undefined {
  const trimmed = text.trim();
  const sorted = [...rules].sort((a, b) => b.priority - a.priority);

  for (const rule of sorted) {
    if (!rule.enabled) continue;
    if (rule.scenes && rule.scenes.length > 0 && !rule.scenes.includes(scene)) {
      continue;
    }

    const { match } = rule;
    if (match.minLength !== undefined && trimmed.length < match.minLength) {
      continue;
    }
    if (match.maxLength !== undefined && trimmed.length > match.maxLength) {
      continue;
    }
    if (match.exact !== undefined && trimmed !== match.exact) {
      continue;
    }
    if (match.contains !== undefined && !trimmed.includes(match.contains)) {
      continue;
    }
    if (match.prefix !== undefined && !trimmed.startsWith(match.prefix)) {
      continue;
    }
    if (match.suffix !== undefined && !trimmed.endsWith(match.suffix)) {
      continue;
    }

    return rule;
  }

  return undefined;
}
