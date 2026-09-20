ALTER TABLE received_events ADD COLUMN sender_scene TEXT;
ALTER TABLE received_events ADD COLUMN sender_scope_id TEXT;
ALTER TABLE received_events ADD COLUMN sender_external_id TEXT;

CREATE TABLE IF NOT EXISTS c2c_message_authorizations (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  user_openid TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1,
  last_event_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(bot_id, user_openid)
);

CREATE TABLE IF NOT EXISTS hidden_roll_link_challenges (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  c2c_principal_id TEXT NOT NULL,
  user_openid TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(bot_id, token_hash)
);

CREATE INDEX IF NOT EXISTS idx_hidden_roll_challenges_principal
ON hidden_roll_link_challenges(bot_id, c2c_principal_id, consumed_at, expires_at);

CREATE TABLE IF NOT EXISTS hidden_roll_bindings (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  group_scope_id TEXT NOT NULL,
  group_principal_id TEXT NOT NULL,
  c2c_principal_id TEXT NOT NULL,
  user_openid TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active', 'revoked')),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_hidden_roll_active_group_principal
ON hidden_roll_bindings(bot_id, group_principal_id)
WHERE status = 'active';

ALTER TABLE outgoing_messages ADD COLUMN delivery_mode TEXT NOT NULL DEFAULT 'passive' CHECK(delivery_mode IN ('passive', 'active'));
ALTER TABLE outgoing_messages ADD COLUMN condition_part INTEGER;
ALTER TABLE outgoing_messages ADD COLUMN condition_status TEXT CHECK(condition_status IS NULL OR condition_status IN ('sent', 'failed'));
