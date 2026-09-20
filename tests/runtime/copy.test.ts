import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BOT_NAME,
  botDisplayName,
  readBotDisplayName,
} from '../../apps/worker/src/copy.js';

describe('Worker copy configuration', () => {
  it('loads the bot display name from classic copy', () => {
    expect(botDisplayName).toBe('Dicefunc');
  });

  it('uses Dicefunc when the bot name copy is absent', () => {
    expect(readBotDisplayName('schemaVersion: 1\ntemplates: {}\n')).toBe(DEFAULT_BOT_NAME);
  });
});
