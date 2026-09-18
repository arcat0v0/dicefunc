export interface StoryLog {
  readonly id: string;
  readonly conversationId: string;
  readonly name: string;
  readonly status: LogStatus;
  readonly captureMode: CaptureMode;
  readonly revision: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly closedAt?: Date;
  readonly cursor?: number;
}

export type LogStatus = 'new' | 'recording' | 'paused' | 'closed' | 'archived';
export type CaptureMode = 'all' | 'at_only';

export interface StoryLogItem {
  readonly id: string;
  readonly logId: string;
  readonly sequenceNumber: number;
  readonly direction: 'inbound' | 'outbound';
  readonly sourceId: string;
  readonly text: string;
  readonly deliveryStatus: DeliveryStatus;
  readonly chunkId?: string;
  readonly createdAt: Date;
}

export type DeliveryStatus = 'pending' | 'sent' | 'failed' | 'unknown';

export interface ArchiveChunk {
  readonly logId: string;
  readonly firstSequence: number;
  readonly lastSequence: number;
  readonly objectKey: string;
  readonly sha256: string;
  readonly byteCount: number;
  readonly verifiedAt?: Date;
}

export function createStoryLog(
  conversationId: string,
  name: string,
  captureMode: CaptureMode = 'all'
): StoryLog {
  return {
    id: generateLogId(),
    conversationId,
    name,
    status: 'new',
    captureMode,
    revision: 1,
    createdAt: new Date(),
    updatedAt: new Date()
  };
}

function generateLogId(): string {
  return `log_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}
