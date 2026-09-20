import migration001 from '../../migrations/001_initial_schema.sql?raw';
import migration002 from '../../migrations/002_outgoing_message_payload.sql?raw';
import migration003 from '../../migrations/003_hidden_roll_bindings.sql?raw';
import migration004 from '../../migrations/004_sender_role.sql?raw';
import migration005 from '../../migrations/005_story_log_item_uniqueness.sql?raw';

export async function applyInitialSchema(db: D1Database): Promise<void> {
  const statements = [
    ...migration001.split(';'),
    ...migration002.split(';'),
    ...migration003.split(';'),
    ...migration004.split(';'),
    ...migration005.split(';'),
  ]
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => db.prepare(s));

  if (statements.length > 0) {
    await db.batch(statements);
  }
}
