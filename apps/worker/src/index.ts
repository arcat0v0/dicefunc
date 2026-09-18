import { Hono } from 'hono';
import { handleWebhook } from './http';
import { processQueue } from './queue';
import { scheduled } from './scheduled';

const app = new Hono();

// Health check endpoint
app.get('/health', (c) => {
  return c.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// QQ Webhook endpoint
app.post('/webhooks/qq', async (c) => {
  const rawBody = await c.req.text();
  const signature = c.req.header('X-Signature-Ed25519');
  const timestamp = c.req.header('X-Signature-Timestamp');
  
  try {
    const result = await handleWebhook({
      body: rawBody,
      signature,
      timestamp,
      env: c.env
    });
    
    return c.json(result);
  } catch (error) {
    console.error('Webhook handling failed:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

export default {
  fetch: app.fetch,
  queue: processQueue,
  scheduled
};
