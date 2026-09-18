export interface PreparedReply {
  readonly executionId: string;
  readonly part: number;
  readonly msgSeq: number;
  readonly deadline: Date;
  readonly recipient: Recipient;
  readonly content: ReplyContent;
  readonly templateKey: string;
  readonly variables: Record<string, unknown>;
}

export interface Recipient {
  readonly scene: SceneType;
  readonly externalId: string;
}

export type SceneType = 'groupAt' | 'c2c';

export interface ReplyContent {
  readonly type: 'text' | 'markdown' | 'rich';
  readonly text: string;
  readonly segments?: ReplySegment[];
}

export interface ReplySegment {
  readonly type: string;
  readonly data: Record<string, unknown>;
}

export interface DeliveryOutcome {
  readonly success: boolean;
  readonly platformMessageId?: string;
  readonly status: DeliveryStatus;
  readonly error?: DeliveryError;
  readonly sentAt?: Date;
}

export type DeliveryStatus = 'pending' | 'sending' | 'sent' | 'unknown' | 'failed' | 'expired';

export interface DeliveryError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export interface ReplySender {
  send(message: PreparedReply): Promise<DeliveryOutcome>;
  sendBatch(messages: PreparedReply[]): Promise<DeliveryOutcome[]>;
}
