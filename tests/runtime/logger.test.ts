import {
  type LogEvent,
  buildLogEntry,
  isValidMetadataValue,
  serializeLogEntry,
} from '@dicefunc/core';
import { describe, expect, it } from 'vitest';

describe('isValidMetadataValue', () => {
  it('accepts finite numbers and booleans', () => {
    expect(isValidMetadataValue(123)).toBe(true);
    expect(isValidMetadataValue(0)).toBe(true);
    expect(isValidMetadataValue(-45.6)).toBe(true);
    expect(isValidMetadataValue(true)).toBe(true);
    expect(isValidMetadataValue(false)).toBe(true);
  });

  it('rejects non-finite numbers', () => {
    expect(isValidMetadataValue(Number.NaN)).toBe(false);
    expect(isValidMetadataValue(Number.POSITIVE_INFINITY)).toBe(false);
  });

  it('accepts strings matching the whitelist pattern up to 128 characters', () => {
    expect(isValidMetadataValue('valid_key-1.2:test')).toBe(true);
    expect(isValidMetadataValue('a'.repeat(128))).toBe(true);
  });

  it('rejects strings containing chinese, spaces, or exceeding 128 characters', () => {
    expect(isValidMetadataValue('包含中文')).toBe(false);
    expect(isValidMetadataValue('string with space')).toBe(false);
    expect(isValidMetadataValue('a'.repeat(129))).toBe(false);
    expect(isValidMetadataValue('invalid$char*')).toBe(false);
  });

  it('rejects objects, arrays, null, and undefined', () => {
    expect(isValidMetadataValue(null)).toBe(false);
    expect(isValidMetadataValue(undefined)).toBe(false);
    expect(isValidMetadataValue({})).toBe(false);
    expect(isValidMetadataValue([1, 2])).toBe(false);
  });
});

describe('buildLogEntry metadata filtering', () => {
  it('filters out invalid metadata keys and keeps valid ones', () => {
    const entry = buildLogEntry({
      level: 'info',
      event: 'test.event',
      component: 'test-runner',
      environment: 'test',
      metadata: {
        validKey: 'val_123',
        validNum: 42,
        validBool: true,
        invalidChinese: '中文内容',
        invalidSpace: 'hello world',
        tooLong: 'z'.repeat(129),
        nestedObj: { a: 1 },
      },
    });

    expect(entry.metadata).toBeDefined();
    expect(entry.metadata?.validKey).toBe('val_123');
    expect(entry.metadata?.validNum).toBe(42);
    expect(entry.metadata?.validBool).toBe(true);
    expect(entry.metadata?.invalidChinese).toBeUndefined();
    expect(entry.metadata?.invalidSpace).toBeUndefined();
    expect(entry.metadata?.tooLong).toBeUndefined();
    expect(entry.metadata?.nestedObj).toBeUndefined();
  });

  it('omits metadata property if all provided metadata is invalid', () => {
    const entry = buildLogEntry({
      level: 'info',
      event: 'test.event',
      component: 'test-runner',
      environment: 'test',
      metadata: {
        invalid1: '中文',
        invalid2: 'has space',
      },
    });

    expect(entry.metadata).toBeUndefined();
  });
});

describe('serializeLogEntry truncation and null handling', () => {
  it('truncates excessive metadata to fit within 8KiB UTF-8 limit', () => {
    const hugeMetadata: Record<string, string> = {};
    for (let i = 0; i < 150; i++) {
      hugeMetadata[`key_${i.toString().padStart(3, '0')}`] = 'x'.repeat(100);
    }

    const entry: LogEvent = {
      schemaVersion: 1,
      timestamp: new Date().toISOString(),
      level: 'info',
      event: 'test.large',
      component: 'test-logger',
      environment: 'test',
      metadata: hugeMetadata,
    };

    const initialByteLength = new TextEncoder().encode(JSON.stringify(entry)).length;
    expect(initialByteLength).toBeGreaterThan(8192);

    const serialized = serializeLogEntry(entry, 8192);
    expect(serialized).not.toBeNull();
    if (serialized === null) {
      throw new Error('expected serialized entry');
    }

    const finalByteLength = new TextEncoder().encode(serialized).length;
    expect(finalByteLength).toBeLessThanOrEqual(8192);

    const parsed = JSON.parse(serialized) as LogEvent;
    expect(parsed.event).toBe('test.large');
    expect(Object.keys(parsed.metadata ?? {}).length).toBeLessThan(150);
  });

  it('returns null when the base log entry itself exceeds the byte budget', () => {
    const oversizedEntry: LogEvent = {
      schemaVersion: 1,
      timestamp: new Date().toISOString(),
      level: 'error',
      event: 'oversized_event_'.padEnd(9000, 'y'),
      component: 'test-logger',
      environment: 'test',
    };

    const serialized = serializeLogEntry(oversizedEntry, 8192);
    expect(serialized).toBeNull();
  });
});
