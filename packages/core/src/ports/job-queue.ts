export interface Job {
  readonly id: string;
  readonly type: JobType;
  readonly resourceId: string;
  readonly status: JobStatus;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly nextAttemptAt: Date;
  readonly deadline: Date;
  readonly lease?: JobLease;
}

export type JobType = 'command' | 'reply' | 'archive' | 'purge';

export type JobStatus = 
  | 'pending'
  | 'queued'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'dead_lettered';

export interface JobLease {
  readonly leasedAt: Date;
  readonly leaseDurationMs: number;
  readonly ownerId: string;
  readonly fencingToken: string;
}

export interface QueuesClient {
  send(type: JobType, resourceId: string, payload: unknown): Promise<string>;
  receive(): Promise<Job | null>;
  complete(id: string, success: boolean): Promise<void>;
  fail(id: string, error: Error): Promise<void>;
}

export interface ScheduledTask {
  run(): Promise<void>;
}
