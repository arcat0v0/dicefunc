import type { RandomSource } from '../../ports/random-source.js';

export type LogRecordingStatus = 'new' | 'recording' | 'paused' | 'closed';

export type ArchiveStatus =
  | 'pending'
  | 'uploading'
  | 'verified'
  | 'ready'
  | 'failed'
  | 'deleting'
  | 'deleted';

export interface SealDiceTextLogItem {
  readonly nickname: string;
  readonly imUserId: string;
  readonly time: number;
  readonly message: string;
}

export function createSealDiceTextLogFormatter(
  timeZone: string,
): (item: SealDiceTextLogItem) => string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    calendar: 'gregory',
    numberingSystem: 'latn',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  return (item) => {
    let year = '';
    let month = '';
    let day = '';
    let hour = '';
    let minute = '';
    let second = '';
    for (const part of formatter.formatToParts(new Date(item.time * 1000))) {
      if (part.type === 'year') year = part.value;
      else if (part.type === 'month') month = part.value;
      else if (part.type === 'day') day = part.value;
      else if (part.type === 'hour') hour = part.value;
      else if (part.type === 'minute') minute = part.value;
      else if (part.type === 'second') second = part.value;
    }
    return `${item.nickname}(${item.imUserId}) ${year}-${month}-${day} ${hour}:${minute}:${second}\n${item.message}\n\n`;
  };
}

export interface StoryLog {
  readonly id: string;
  readonly conversationId: string;
  readonly name: string;
  readonly status: LogRecordingStatus;
  readonly archiveStatus: ArchiveStatus;
  readonly captureMode: 'all' | 'at_only';
  readonly version: number;
  readonly cursor: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function createArchiveAccessToken(
  random: RandomSource,
): Promise<{ readonly token: string; readonly tokenHash: string }> {
  const token = bytesToBase64Url(await random.bytes(32));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  const tokenHash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  return { token, tokenHash };
}

export function createStoryLog(input: {
  readonly id: string;
  readonly conversationId: string;
  readonly name: string;
  readonly captureMode?: 'all' | 'at_only' | undefined;
  readonly createdAt: Date;
}): StoryLog {
  return {
    id: input.id,
    conversationId: input.conversationId,
    name: input.name,
    status: 'new',
    archiveStatus: 'pending',
    captureMode: input.captureMode ?? 'all',
    version: 1,
    cursor: 0,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}

export function updateLogStatus(log: StoryLog, status: LogRecordingStatus, now: Date): StoryLog {
  return {
    id: log.id,
    conversationId: log.conversationId,
    name: log.name,
    status,
    archiveStatus: log.archiveStatus,
    captureMode: log.captureMode,
    version: log.version + 1,
    cursor: log.cursor,
    createdAt: log.createdAt,
    updatedAt: now,
  };
}

export function updateArchiveStatus(
  log: StoryLog,
  archiveStatus: ArchiveStatus,
  now: Date,
): StoryLog {
  return {
    id: log.id,
    conversationId: log.conversationId,
    name: log.name,
    status: log.status,
    archiveStatus,
    captureMode: log.captureMode,
    version: log.version + 1,
    cursor: log.cursor,
    createdAt: log.createdAt,
    updatedAt: now,
  };
}

export function advanceLogCursor(log: StoryLog, itemCount: number, now: Date): StoryLog {
  if (log.status !== 'recording') {
    throw new Error(`Cannot append to story log when status is ${log.status}`);
  }
  return {
    id: log.id,
    conversationId: log.conversationId,
    name: log.name,
    status: log.status,
    archiveStatus: log.archiveStatus,
    captureMode: log.captureMode,
    version: log.version + 1,
    cursor: log.cursor + itemCount,
    createdAt: log.createdAt,
    updatedAt: now,
  };
}
