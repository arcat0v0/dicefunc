import { DefaultMessageCatalog } from './catalog.js';
import { zhCNMessages } from './zh-CN/index.js';

export type { MessageCatalog, MessageKey, MessageValue } from './catalog.js';
export { DefaultMessageCatalog } from './catalog.js';
export {
  formatCnmodsDetail,
  formatCnmodsSearchResult,
  formatCoc7CardBatch,
  formatCoc7CardSingle,
  formatDnd5eFreeCard,
  formatDnd5ePresetCard,
} from './formatters.js';
export {
  COC_LEVEL_LABELS,
  createZhCNTemplates,
  HELP_BY_TOPIC,
  HELP_OVERVIEW,
  HELP_TOPIC_ALIASES,
  STORY_LOG_STATUS_LABELS,
  zhCNMessages,
} from './zh-CN/index.js';

export const defaultMessageCatalog = new DefaultMessageCatalog(zhCNMessages);
