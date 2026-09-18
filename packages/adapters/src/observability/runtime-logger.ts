import type { LogEvent, RuntimeLogger } from '@dicefunc/core';
import { serializeLogEntry } from '@dicefunc/core';

export class RuntimeLoggerAdapter implements RuntimeLogger {
  private readonly boundFields: Partial<LogEvent>;

  constructor(boundFields: Partial<LogEvent> = {}) {
    this.boundFields = boundFields;
  }

  log(entry: LogEvent): boolean {
    const mergedMetadata =
      this.boundFields.metadata !== undefined || entry.metadata !== undefined
        ? { ...(this.boundFields.metadata ?? {}), ...(entry.metadata ?? {}) }
        : undefined;

    const merged: LogEvent = {
      ...this.boundFields,
      ...entry,
      ...(mergedMetadata !== undefined ? { metadata: mergedMetadata } : {}),
    };

    if (merged.level === 'debug' && merged.environment === 'production') {
      return false;
    }

    const serialized = serializeLogEntry(merged, 8192);
    if (serialized === null) {
      return false;
    }

    switch (merged.level) {
      case 'debug':
        console.debug(serialized);
        break;
      case 'info':
        console.info(serialized);
        break;
      case 'warn':
        console.warn(serialized);
        break;
      case 'error':
        console.error(serialized);
        break;
    }

    return true;
  }

  child(fields: Partial<LogEvent>): RuntimeLogger {
    const mergedMetadata =
      this.boundFields.metadata !== undefined || fields.metadata !== undefined
        ? { ...(this.boundFields.metadata ?? {}), ...(fields.metadata ?? {}) }
        : undefined;

    return new RuntimeLoggerAdapter({
      ...this.boundFields,
      ...fields,
      ...(mergedMetadata !== undefined ? { metadata: mergedMetadata } : {}),
    });
  }
}
