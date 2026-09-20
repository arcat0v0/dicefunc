export interface QueueMessage {
  readonly jobId: string;
  readonly type: 'command' | 'archive-chunk' | 'archive-delete';
  readonly schemaVersion: number;
}

export interface JobQueue {
  enqueueCommand(msg: QueueMessage): Promise<void>;
  enqueueArchive(msg: QueueMessage): Promise<void>;
}
