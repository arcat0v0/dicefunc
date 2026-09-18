import { VerifiedEvent, Principal, SceneType } from '../../core/src/ports/state-store';

export interface WebhookContext {
  body: string;
  signature?: string;
  timestamp?: string;
  env: WorkerEnv;
}

export interface WorkerEnv {
  QQ_APP_SECRET: string;
  DB: D1Database;
  CONFIG_KV: KVNamespace;
  COMMAND_QUEUE: Queue<unknown>;
}

export interface WebhookResponse {
  ret: number;
  msg: string;
  data?: {
    nonce_str: string;
    timestamp: number;
  };
}

export async function handleWebhook(context: WebhookContext): Promise<WebhookResponse> {
  const { body, signature, timestamp, env } = context;
  
  try {
    // Parse the request body
    let jsonData: unknown;
    try {
      jsonData = JSON.parse(body);
    } catch (error) {
      return { ret: -1, msg: 'Invalid JSON' };
    }
    
    // Verify signature if present
    if (signature && timestamp) {
      const valid = await verifySignature({
        body,
        signature,
        timestamp,
        secret: env.QQ_APP_SECRET
      });
      
      if (!valid) {
        return { ret: -1, msg: 'Invalid signature' };
      }
    }
    
    // Handle challenge response
    const op = jsonData['op'];
    if (op === 13) {
      return handleChallenge(jsonData as { nonce_str: string });
    }
    
    // Handle events
    if (op === 0) {
      return await handleEvent(jsonData, env);
    }
    
    // Handle confirmation
    if (op === 12) {
      return { ret: 0, msg: 'ok' };
    }
    
    return { ret: 0, msg: 'ok' };
    
  } catch (error) {
    console.error('Webhook error:', error);
    return { ret: -1, msg: 'Internal server error' };
  }
}

function handleChallenge(data: { nonce_str: string }): WebhookResponse {
  return {
    ret: 0,
    msg: 'ok',
    data: {
      nonce_str: data.nonce_str,
      timestamp: Math.floor(Date.now() / 1000)
    }
  };
}

async function handleEvent(
  jsonData: unknown,
  env: WorkerEnv
): Promise<WebhookResponse> {
  const event = jsonData as Record<string, unknown>;
  
  // Extract scene type
  const messageType = event.message_type as string;
  const scene: SceneType = messageType === 'all' ? 'groupAll' : 'groupAt';
  
  // Create verified event
  const verifiedEvent: VerifiedEvent = {
    botId: 'default_bot',
    scene,
    externalId: event.group_openid || event.user_id?.toString() || 'unknown',
    messageId: event.event_id || event.message_id || `evt_${Date.now()}`,
    timestamp: new Date(event.time_stamp ? Number(event.time_stamp) * 1000 : Date.now()),
    text: extractMessageText(event.message),
    sender: createPrincipal(scene, event),
    rawBody: new TextEncoder().encode(JSON.stringify(event))
  };
  
  // Queue the event for processing
  try {
    await env.COMMAND_QUEUE.send({
      type: 'command',
      eventId: verifiedEvent.messageId,
      data: verifiedEvent
    });
    
    return { ret: 0, msg: 'ok' };
  } catch (error) {
    console.error('Failed to queue event:', error);
    return { ret: -1, msg: 'Failed to queue event' };
  }
}

function extractMessageText(message: unknown): string | undefined {
  if (!message || typeof message !== 'object') return undefined;
  
  const msg = message as Record<string, unknown>;
  
  // Try different message formats
  if (msg.elements) {
    const elements = msg.elements as Array<Record<string, unknown>>;
    const textElement = elements.find(e => e.element_type === 'text');
    if (textElement) {
      return textElement.content as string;
    }
  }
  
  if (msg.content) {
    return msg.content as string;
  }
  
  if (msg.text) {
    return msg.text as string;
  }
  
  return undefined;
}

function createPrincipal(scene: SceneType, event: Record<string, unknown>): Principal {
  const openid = event.sender_openid || event.user_id?.toString();
  const scopeId = event.group_openid || event.user_id?.toString() || 'unknown';
  
  return {
    scene,
    scopeId,
    externalId: openid || scopeId
  };
}

async function verifySignature(
  params: { body: string; signature: string; timestamp: string; secret: string }
): Promise<boolean> {
  // TODO: Implement Ed25519 signature verification using Web Crypto API
  // For development, we'll skip strict verification
  // In production, this should use crypto.subtle.verify with Ed25519
  
  try {
    const signatureBuffer = hexToArrayBuffer(params.signature);
    const timestampBuffer = new TextEncoder().encode(params.timestamp);
    const message = new Uint8Array([
      ...timestampBuffer,
      ...new TextEncoder().encode(params.body)
    ]);
    
    // This is a placeholder - actual implementation needs:
    // 1. QQ app public key from credentials
    // 2. Ed25519 verification using crypto.subtle
    // 3. Proper key parsing
    
    return true; // Skip verification in dev mode
    
  } catch (error) {
    console.error('Signature verification failed:', error);
    return false;
  }
}

function hexToArrayBuffer(hex: string): ArrayBuffer {
  const cleaned = hex.replace(/[^0-9a-f]/gi, '');
  const bytes = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < cleaned.length; i += 2) {
    bytes[i / 2] = parseInt(cleaned.substring(i, i + 2), 16);
  }
  return bytes.buffer;
}
