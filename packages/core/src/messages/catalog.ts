import type { ZhCNMessageKey } from './zh-CN/index.js';

export type MessageValue = string | number | boolean;

export interface MessageCatalog {
  format(key: MessageKey, values?: Readonly<Record<string, MessageValue>>): string;
  has(key: MessageKey): boolean;
}

export type MessageKey = ZhCNMessageKey;

export class DefaultMessageCatalog implements MessageCatalog {
  constructor(private readonly messages: Readonly<Record<MessageKey, string>>) {}

  format(key: MessageKey, values: Readonly<Record<string, MessageValue>> = {}): string {
    const template = this.messages[key];
    if (template === undefined) {
      throw new Error(`Missing message: ${key}`);
    }
    return template.replace(/\{([a-zA-Z0-9_]+)\}/gu, (_match, name: string) => {
      const value = values[name];
      if (value === undefined) {
        throw new Error(`Missing message value: ${key}.${name}`);
      }
      return String(value);
    });
  }

  has(key: MessageKey): boolean {
    return this.messages[key] !== undefined;
  }
}
