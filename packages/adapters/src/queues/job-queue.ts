import type { JobQueue, QueueMessage } from '@dicefunc/core';

export class CloudflareQueuesClient implements JobQueue {
  constructor(
    private readonly commandQueue: Queue<QueueMessage>,
    private readonly archiveQueue: Queue<QueueMessage>,
  ) {}

  async enqueueCommand(msg: QueueMessage): Promise<void> {
    await this.commandQueue.send({
      jobId: msg.jobId,
      type: msg.type,
      schemaVersion: msg.schemaVersion,
    });
  }

  async enqueueArchive(msg: QueueMessage): Promise<void> {
    await this.archiveQueue.send({
      jobId: msg.jobId,
      type: msg.type,
      schemaVersion: msg.schemaVersion,
    });
  }
}
