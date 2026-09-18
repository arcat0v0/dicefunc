import {
  ReplySender,
  PreparedReply,
  DeliveryOutcome,
  DeliveryStatus,
  SceneType
} from '../../core/src/ports/reply-sender';

export class QQReplySender implements ReplySender {
  constructor(
    private appId: string,
    private appSecret: string,
    private baseUrl: string = 'https://bot.q.qq.com'
  ) {}

  async send(message: PreparedReply): Promise<DeliveryOutcome> {
    try {
      const url = this.buildReplyUrl(message.recipient);
      
      const payload = this.buildPayload(message);
      
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `QQBot ${this.appId}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });
      
      const result = await response.json();
      
      if (response.ok) {
        return {
          success: true,
          platformMessageId: result.id || result.message_id,
          status: 'sent',
          sentAt: new Date()
        };
      } else {
        return {
          success: false,
          status: 'failed' as DeliveryStatus,
          error: {
            code: result.code?.toString() || 'QQ_ERROR',
            message: result.message || 'QQ API error',
            retryable: isRetryableError(result.code)
          }
        };
      }
      
    } catch (error) {
      return {
        success: false,
        status: 'unknown' as DeliveryStatus,
        error: {
          code: 'NETWORK_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
          retryable: true
        }
      };
    }
  }

  async sendBatch(messages: PreparedReply[]): Promise<DeliveryOutcome[]> {
    const outcomes: DeliveryOutcome[] = [];
    
    // QQ has rate limits, send in batches
    const batchSize = 5;
    for (let i = 0; i < messages.length; i += batchSize) {
      const batch = messages.slice(i, i + batchSize);
      
      const results = await Promise.all(
        batch.map(msg => this.send(msg))
      );
      
      outcomes.push(...results);
      
      // Respect rate limits
      if (i + batchSize < messages.length) {
        await delay(1000);
      }
    }
    
    return outcomes;
  }

  private buildReplyUrl(recipient: { scene: SceneType; externalId: string }): string {
    const scenePrefix = recipient.scene === 'c2c' ? '' : 'guilds/';
    const groupId = recipient.externalId;
    
    return `${this.baseUrl}/v2/groups/${groupId}/messages`;
  }

  private buildPayload(message: PreparedReply): unknown {
    const content = this.renderContent(message);
    
    const replyData = {
      content,
      msg_type: 7,
      seq: message.msgSeq,
      reference_message_id: message.executionId
    };
    
    return replyData;
  }

  private renderContent(message: PreparedReply): string {
    switch (message.content.type) {
      case 'text':
        return escapeMarkdown(message.content.text);
        
      case 'markdown':
        return convertToMarkdown(message.content.text);
        
      default:
        return escapeMarkdown(message.content.text);
    }
  }
}

function escapeMarkdown(text: string): string {
  // Escape special Markdown characters for QQ
  return text
    .replace(/\\/g, '\\\\')
    .replace(/\*/g, '\\*')
    .replace(/_/g, '\\_')
    .replace(/`/g, '\\`');
}

function convertToMarkdown(text: string): string {
  // Convert simple markdown to QQ-compatible format
  return text
    .replace(/^### (.*)$/gm, '**$1**')
    .replace(/^## (.*)$/gm, '**$1**')
    .replace(/^# (.*)$/gm, '*$1*')
    .replace(/```(\w*)\n([\s\S]*?)```/g, '$2');
}

function isRetryableError(code?: number): boolean {
  // QQ rate limiting codes
  if (code === 429 || code === 500) {
    return true;
  }
  
  // Network errors are retryable
  return true;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
