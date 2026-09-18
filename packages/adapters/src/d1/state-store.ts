import {
  StateStore,
  VerifiedEvent,
  EventClaim,
  CommandScope,
  StateSnapshot,
  CommandCommit,
  CommitOutcome,
  CharacterBinding,
  Permissions,
  SceneType
} from '../../core/src/ports/state-store';
import { ConversationSession, RuleSetName } from '../../core/src/domain/session/conversation';
import { CharacterSheet } from '../../core/src/domain/character/sheet';

export class D1StateStore implements StateStore {
  constructor(private db: D1Database) {}

  async claimEvent(event: VerifiedEvent): Promise<EventClaim> {
    const messageId = event.messageId;
    const messageKey = `${event.scene}:${event.externalId}:${messageId}`;
    
    // Check if already processed
    const existing = await this.db.prepare(`
      SELECT id, status, conversation_seq FROM received_events 
      WHERE event_id = ?
    `).bind(messageId).first();
    
    if (existing) {
      return {
        eventId: messageId,
        messageKey,
        conversationSeq: existing.conversation_seq || 0,
        status: existing.status as any,
        configDigest: 'default',
        seed: undefined
      };
    }
    
    // Get or create conversation sequence
    const convKey = `${event.scene}:${event.externalId}`;
    const seqResult = await this.db.prepare(`
      SELECT COALESCE(MAX(conversation_seq), -1) + 1 as next_seq
      FROM received_events
      WHERE message_key LIKE ?
    `).bind(`${convKey}%`).first();
    
    const conversationSeq = seqResult?.next_seq ?? 0;
    
    // Insert event record
    const transactionId = `txn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    await this.db.batch([
      this.db.prepare(`
        INSERT INTO received_events (id, event_id, message_key, conversation_seq, status, config_digest, transaction_id)
        VALUES (?, ?, ?, ?, 'pending', ?, ?)
      `).bind(messageId, messageId, messageKey, conversationSeq, 'default', transactionId),
      
      this.db.prepare(`
        INSERT INTO jobs (id, type, resource_id, status, next_attempt_at, deadline)
        VALUES (?, 'command', ?, 'pending', datetime('now'), datetime('+1 hour'))
      `).bind(`job_${messageId}`, messageId)
    ]);
    
    return {
      eventId: messageId,
      messageKey,
      conversationSeq,
      status: 'claimed',
      configDigest: 'default',
      seed: undefined
    };
  }

  async loadSnapshot(scope: CommandScope): Promise<StateSnapshot> {
    // Load conversation
    const conv = await this.db.prepare(`
      SELECT * FROM conversations
      WHERE bot_id = ? AND scene = ? AND external_id = ?
    `).bind(scope.botId, scope.scene, scope.conversationId).first();
    
    let session: ConversationSession | null = null;
    if (conv) {
      session = {
        id: conv.id,
        botId: conv.bot_id,
        scene: conv.scene as SceneType,
        externalId: conv.external_id,
        ruleSet: (conv.rule_set as RuleSetName) || 'coc7',
        diceSides: conv.dice_sides || 100,
        enabled: !!conv.enabled,
        settings: {
          ruleSet: session.ruleSet,
          diceSides: session.diceSides,
          timezone: 'Asia/Shanghai',
          enabled: session.enabled
        },
        version: conv.version,
        createdAt: new Date(conv.created_at),
        updatedAt: new Date(conv.updated_at)
      };
    }
    
    // Load character binding
    let binding: CharacterBinding | undefined;
    if (session) {
      const bind = await this.db.prepare(`
        SELECT sheet_id, version FROM character_bindings
        WHERE conversation_id = ?
      `).bind(session.id).first();
      
      if (bind) {
        binding = {
          sheetId: bind.sheet_id,
          version: bind.version
        };
      }
    }
    
    // Load permissions
    const permissions: Permissions = {
      isDiceMaster: false,
      isGroupHost: false,
      isTrusted: true,
      denied: false
    };
    
    return {
      conversation: session,
      characterBinding: binding,
      permissions
    };
  }

  async commit(plan: CommandCommit): Promise<CommitOutcome> {
    const updates = plan.updates;
    
    if (updates.length === 0) {
      return {
        success: true,
        executionId: plan.transactionId,
        updatedVersions: {}
      };
    }
    
    try {
      const batchStatements: D1PreparedStatement[] = [];
      const updatedVersions: Record<string, number> = {};
      
      for (const update of updates) {
        switch (update.type) {
          case 'conversation':
            batchStatements.push(
              this.db.prepare(`
                UPDATE conversations 
                SET version = ?, updated_at = datetime('now')
                WHERE id = ? AND version = ?
              `).bind(update.data['version'] || 1, update.id, update.expectedVersion)
            );
            break;
            
          case 'character':
            batchStatements.push(
              this.db.prepare(`
                UPDATE character_sheets 
                SET name = ?, attributes = ?, version = ?, updated_at = datetime('now')
                WHERE id = ? AND version = ?
              `).bind(
                update.data['name'],
                JSON.stringify(update.data['attributes']),
                update.data['version'] || 1,
                update.id,
                update.expectedVersion
              )
            );
            break;
            
          case 'binding':
            batchStatements.push(
              this.db.prepare(`
                INSERT OR REPLACE INTO character_bindings (id, conversation_id, principal_id, sheet_id, version)
                VALUES (?, ?, ?, ?, ?)
              `).bind(
                `bind_${update.id}`,
                update.id,
                update.data['principalId'],
                update.data['sheetId'],
                update.data['version'] || 1
              )
            );
            break;
        }
        
        updatedVersions[update.id] = update.data['version'] || 1;
      }
      
      if (batchStatements.length > 0) {
        await this.db.batch(batchStatements);
      }
      
      return {
        success: true,
        executionId: plan.transactionId,
        updatedVersions
      };
      
    } catch (error) {
      return {
        success: false,
        executionId: plan.transactionId,
        updatedVersions: {},
        errors: [{
          type: 'constraint_violation',
          resource: 'database',
          details: error instanceof Error ? error.message : 'Unknown error'
        }]
      };
    }
  }
}
