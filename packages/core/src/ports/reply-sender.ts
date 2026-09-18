import type { PreparedReply } from './state-store.js';

export type DeliveryOutcome =
  | {
      readonly status: 'sent';
      readonly platformMessageId: string;
    }
  | {
      readonly status: 'retryable';
      readonly errorCode: string;
    }
  | {
      readonly status: 'failed';
      readonly errorCode: string;
    }
  | {
      readonly status: 'expired';
    };

export interface ReplySender {
  send(reply: PreparedReply): Promise<DeliveryOutcome>;
}
