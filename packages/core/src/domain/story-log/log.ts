export type LogRecordingStatus = 'new' | 'recording' | 'paused' | 'closed';

export type ArchiveStatus =
  | 'pending'
  | 'uploading'
  | 'verified'
  | 'ready'
  | 'failed'
  | 'deleting'
  | 'deleted';

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
