export interface QueueMessage {
  readonly jobId: string;
  readonly type: 'command' | 'archive-chunk';
  readonly schemaVersion: number;
}

export interface JobQueue {
  enqueueCommand(msg: QueueMessage): Promise<void>;
  enqueueArchive(msg: QueueMessage): Promise<void>;
}
