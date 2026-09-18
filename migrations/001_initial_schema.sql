-- Initial schema for DiceFunc Cloudflare Workers
-- Version: 1

-- Conversations table
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  scene TEXT NOT NULL,
  external_id TEXT NOT NULL,
  rule_set TEXT NOT NULL DEFAULT 'coc7',
  dice_sides INTEGER NOT NULL DEFAULT 100,
  enabled INTEGER NOT NULL DEFAULT 1,
  settings_override TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(bot_id, scene, external_id)
);

-- Principals table
CREATE TABLE IF NOT EXISTS principals (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  scene TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(bot_id, scene, scope_id)
);

-- Character sheets table
CREATE TABLE IF NOT EXISTS character_sheets (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  rule_set TEXT NOT NULL,
  name TEXT NOT NULL,
  attributes TEXT NOT NULL CHECK(json_valid(attributes)),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Character bindings table
CREATE TABLE IF NOT EXISTS character_bindings (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  sheet_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(conversation_id, principal_id),
  FOREIGN KEY (conversation_id) REFERENCES conversations(id),
  FOREIGN KEY (principal_id) REFERENCES principals(id),
  FOREIGN KEY (sheet_id) REFERENCES character_sheets(id)
);

-- Character snapshots table
CREATE TABLE IF NOT EXISTS character_snapshots (
  id TEXT PRIMARY KEY,
  sheet_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  attributes TEXT NOT NULL CHECK(json_valid(attributes)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(sheet_id, snapshot_id)
);

-- Encounters table (combat)
CREATE TABLE IF NOT EXISTS encounters (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  state TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (conversation_id) REFERENCES conversations(id)
);

-- Policy entries table
CREATE TABLE IF NOT EXISTS policy_entries (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  principal_id TEXT,
  group_ids TEXT,
  action TEXT NOT NULL,
  reason TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK(action IN ('deny', 'trust'))
);

-- Rate buckets table
CREATE TABLE IF NOT EXISTS rate_buckets (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL,
  window_ms INTEGER NOT NULL,
  max_requests INTEGER NOT NULL,
  last_reset TEXT NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  UNIQUE(key)
);

-- Received events table (inbox)
CREATE TABLE IF NOT EXISTS received_events (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  message_key TEXT NOT NULL,
  conversation_seq INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  config_digest TEXT NOT NULL,
  seed TEXT,
  lease TEXT,
  fencing_token TEXT,
  result_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(event_id),
  UNIQUE(message_key)
);

-- Command results table
CREATE TABLE IF NOT EXISTS command_results (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL,
  result_type TEXT NOT NULL,
  result_data TEXT NOT NULL CHECK(json_valid(result_data)),
  rule_version TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(execution_id)
);

-- Outgoing messages table
CREATE TABLE IF NOT EXISTS outgoing_messages (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL,
  part INTEGER NOT NULL,
  msg_seq INTEGER NOT NULL,
  deadline TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  platform_message_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(execution_id, part),
  UNIQUE(platform_message_id)
);

-- Story logs table
CREATE TABLE IF NOT EXISTS story_logs (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  capture_mode TEXT NOT NULL DEFAULT 'all',
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at TEXT,
  cursor INTEGER,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id)
);

-- Story log items table
CREATE TABLE IF NOT EXISTS story_log_items (
  id TEXT PRIMARY KEY,
  log_id TEXT NOT NULL,
  sequence_number INTEGER NOT NULL,
  direction TEXT NOT NULL,
  source_id TEXT NOT NULL,
  text TEXT NOT NULL,
  delivery_status TEXT NOT NULL DEFAULT 'pending',
  chunk_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(log_id, sequence_number),
  UNIQUE(source_id),
  FOREIGN KEY (log_id) REFERENCES story_logs(id)
);

-- Log archives table
CREATE TABLE IF NOT EXISTS log_archives (
  id TEXT PRIMARY KEY,
  log_id TEXT NOT NULL,
  snapshot_cursor INTEGER,
  format TEXT NOT NULL,
  object_key TEXT NOT NULL,
  digest TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  expires_at TEXT,
  deletion_status TEXT NOT NULL DEFAULT 'none',
  error_code TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(log_id, object_key)
);

-- Jobs table
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  next_attempt_at TEXT NOT NULL,
  deadline TEXT NOT NULL,
  lease TEXT,
  fencing_token TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(type, resource_id)
);

-- Config releases table
CREATE TABLE IF NOT EXISTS config_releases (
  id TEXT PRIMARY KEY,
  digest TEXT NOT NULL,
  bundle_ref TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(digest)
);

-- Schema migrations table
CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_conversations_bot_scene ON conversations(bot_id, scene);
CREATE INDEX IF NOT EXISTS idx_character_sheets_owner ON character_sheets(owner_id);
CREATE INDEX IF NOT EXISTS idx_story_logs_conversation ON story_logs(conversation_id);
CREATE INDEX IF NOT EXISTS idx_received_events_status ON received_events(status);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
