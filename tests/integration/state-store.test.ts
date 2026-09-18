import { describe, it, expect, beforeEach, afterEach } from 'vitest';

// Integration test template for D1 state store
describe('D1 State Store', () => {
  let db: D1Database;
  
  beforeEach(async () => {
    // Setup test database
    db = env.DB;
  });
  
  afterEach(async () => {
    // Cleanup test data
    await db.prepare('DELETE FROM received_events').run();
    await db.prepare('DELETE FROM command_results').run();
  });
  
  it('should claim event and update status', async () => {
    const eventId = `test_${Date.now()}`;
    
    // Insert initial event
    await db.prepare(`
      INSERT INTO received_events (id, event_id, message_key, status)
      VALUES (?, ?, ?, 'pending')
    `).bind(eventId, eventId, `group:test:${eventId}`).run();
    
    // Claim event
    const result = await db.prepare(`
      UPDATE received_events 
      SET status = 'claimed', lease = ?, fencing_token = ?
      WHERE id = ? AND status = 'pending'
    `).bind('lease_123', 'token_456', eventId).run();
    
    expect(result.success).toBe(true);
    expect(result.meta.changes).toBe(1);
  });
  
  it('should handle concurrent claims', async () => {
    const eventId = `concurrent_${Date.now()}`;
    
    await db.prepare(`
      INSERT INTO received_events (id, event_id, message_key, status)
      VALUES (?, ?, ?, 'pending')
    `).bind(eventId, eventId, `group:test:${eventId}`).run();
    
    // First claim should succeed
    const firstClaim = await db.prepare(`
      UPDATE received_events 
      SET status = 'claimed', lease = ?
      WHERE id = ? AND status = 'pending'
    `).bind('lease_1', eventId).run();
    
    expect(firstClaim.meta.changes).toBe(1);
    
    // Second claim should fail
    const secondClaim = await db.prepare(`
      UPDATE received_events 
      SET status = 'claimed', lease = ?
      WHERE id = ? AND status = 'pending'
    `).bind('lease_2', eventId).run();
    
    expect(secondClaim.meta.changes).toBe(0);
  });
});
