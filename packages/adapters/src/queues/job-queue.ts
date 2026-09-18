import { QueuesClient, Job, JobStatus, JobType } from '../../core/src/ports/job-queue';

export class CloudflareQueuesClient implements QueuesClient {
  constructor(
    private commandQueue: Queue<unknown>,
    private archiveQueue: Queue<unknown>
  ) {}

  async send(type: JobType, resourceId: string, payload: unknown): Promise<string> {
    const queue = type === 'archive' ? this.archiveQueue : this.commandQueue;
    
    await queue.send({
      type,
      resourceId,
      payload,
      timestamp: Date.now()
    });
    
    return `job_${resourceId}_${Date.now()}`;
  }

  async receive(): Promise<Job | null> {
    // Note: In Cloudflare Workers, queue consumption is triggered automatically
    // This method is for testing purposes
    return null;
  }

  async complete(id: string, success: boolean): Promise<void> {
    if (success) {
      console.log(`Job ${id} completed successfully`);
    } else {
      console.error(`Job ${id} failed`);
    }
  }

  async fail(id: string, error: Error): Promise<void> {
    console.error(`Job ${id} failed with error:`, error);
  }
}

export function createQueuesClient(
  commandQueue: Queue<unknown>,
  archiveQueue: Queue<unknown>
): QueuesClient {
  return new CloudflareQueuesClient(commandQueue, archiveQueue);
}
