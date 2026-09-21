import { characterMessages } from './character.js';
import { coc7Messages } from './coc7.js';
import { coreMessages } from './core.js';
import { dnd5eMessages } from './dnd5e.js';
import { storyLogMessages } from './story-log.js';
import { utilityMessages } from './utility.js';

export { HELP_BY_TOPIC, HELP_OVERVIEW, HELP_TOPIC_ALIASES } from './help.js';
export { COC_LEVEL_LABELS } from './coc7.js';
export { STORY_LOG_STATUS_LABELS } from './story-log.js';
export { createZhCNTemplates } from './templates.js';

export const zhCNMessages = {
  ...characterMessages,
  ...coc7Messages,
  ...dnd5eMessages,
  ...coreMessages,
  ...storyLogMessages,
  ...utilityMessages,
} as const;

export type ZhCNMessageKey = keyof typeof zhCNMessages;
