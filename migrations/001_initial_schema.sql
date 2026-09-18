CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  scene TEXT NOT NULL,
  external_id TEXT NOT NULL,
  rule_set TEXT NOT NULL DEFAULT 'coc7',
  dice_sides INTEGER NOT NULL DEFAULT 100,
  enabled INTEGER NOT NULL DEFAULT 1,
  settings_override TEXT,
  receive_seq INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(bot_id, id),
  UNIQUE(bot_id, scene, external_id)
);

CREATE TABLE IF NOT EXISTS principals (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  scene TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(bot_id, id),
  UNIQUE(bot_id, scene, scope_id, external_id)
);

CREATE TABLE IF NOT EXISTS character_sheets (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  owner_principal TEXT NOT NULL,
  rule_set TEXT NOT NULL,
  name TEXT NOT NULL,
  attributes TEXT NOT NULL CHECK(json_valid(attributes)),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(bot_id, id)
);

CREATE TABLE IF NOT EXISTS character_bindings (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  sheet_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(bot_id, id),
  UNIQUE(bot_id, conversation_id, principal_id),
  FOREIGN KEY (conversation_id) REFERENCES conversations(id),
  FOREIGN KEY (principal_id) REFERENCES principals(id),
  FOREIGN KEY (sheet_id) REFERENCES character_sheets(id)
);

CREATE TABLE IF NOT EXISTS character_snapshots (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  sheet_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  attributes TEXT NOT NULL CHECK(json_valid(attributes)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(bot_id, id),
  UNIQUE(bot_id, sheet_id, snapshot_id),
  FOREIGN KEY (sheet_id) REFERENCES character_sheets(id)
);

CREATE TABLE IF NOT EXISTS encounters (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(json_valid(state)),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(bot_id, id),
  UNIQUE(bot_id, conversation_id),
  FOREIGN KEY (conversation_id) REFERENCES conversations(id)
);

CREATE TABLE IF NOT EXISTS deck_sessions (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  deck_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(json_valid(state)),
  remaining TEXT NOT NULL CHECK(json_valid(remaining)),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(bot_id, id),
  UNIQUE(bot_id, conversation_id, deck_id),
  FOREIGN KEY (conversation_id) REFERENCES conversations(id)
);

CREATE TABLE IF NOT EXISTS policy_entries (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  principal_id TEXT,
  action TEXT NOT NULL CHECK(action IN ('deny', 'trust')),
  reason TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(bot_id, id),
  UNIQUE(bot_id, scope_type, scope_id)
);

CREATE TABLE IF NOT EXISTS rate_buckets (
  bot_id TEXT NOT NULL,
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  bucket TEXT NOT NULL,
  tokens REAL NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (bot_id, scope_type, scope_id, bucket)
);

CREATE TABLE IF NOT EXISTS received_events (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  message_key TEXT NOT NULL,
  conversation_seq INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  payload TEXT,
  config_digest TEXT NOT NULL,
  seed TEXT,
  lease TEXT,
  lease_expires_at TEXT,
  fencing_token TEXT,
  result_id TEXT,
  transaction_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(bot_id, id),
  UNIQUE(bot_id, event_id),
  UNIQUE(bot_id, message_key)
);

CREATE TABLE IF NOT EXISTS command_results (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  result_type TEXT NOT NULL,
  result_data TEXT NOT NULL CHECK(json_valid(result_data)),
  rule_version TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(bot_id, id),
  UNIQUE(bot_id, execution_id)
);

CREATE TABLE IF NOT EXISTS outgoing_messages (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  part INTEGER NOT NULL,
  msg_seq INTEGER NOT NULL,
  deadline TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  platform_message_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(bot_id, id),
  UNIQUE(bot_id, execution_id, part, msg_seq)
);

CREATE TABLE IF NOT EXISTS story_logs (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  capture_mode TEXT NOT NULL DEFAULT 'all',
  revision INTEGER NOT NULL DEFAULT 1,
  cursor INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at TEXT,
  UNIQUE(bot_id, id),
  FOREIGN KEY (conversation_id) REFERENCES conversations(id)
);

CREATE TABLE IF NOT EXISTS story_log_items (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  log_id TEXT NOT NULL,
  sequence_number INTEGER NOT NULL,
  direction TEXT NOT NULL,
  source_id TEXT NOT NULL,
  text TEXT,
  delivery_status TEXT NOT NULL DEFAULT 'pending',
  chunk_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(bot_id, id),
  UNIQUE(bot_id, log_id, source_id),
  FOREIGN KEY (log_id) REFERENCES story_logs(id)
);

CREATE TABLE IF NOT EXISTS log_archives (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
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
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(bot_id, id),
  UNIQUE(bot_id, log_id, object_key),
  FOREIGN KEY (log_id) REFERENCES story_logs(id)
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  next_attempt_at TEXT NOT NULL,
  deadline TEXT NOT NULL,
  lease TEXT,
  lease_expires_at TEXT,
  fencing_token TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(bot_id, id)
);

CREATE TABLE IF NOT EXISTS commit_guards (
  bot_id TEXT NOT NULL,
  transaction_id TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  expected_version INTEGER NOT NULL,
  actual_version INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (bot_id, transaction_id, resource_type, resource_id),
  CHECK (actual_version = expected_version),
  CHECK (expected_version > 0)
);

CREATE TABLE IF NOT EXISTS config_releases (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  digest TEXT NOT NULL,
  bundle_ref TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(bot_id, id),
  UNIQUE(bot_id, digest)
);

CREATE TABLE IF NOT EXISTS story_chunks (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  log_id TEXT NOT NULL,
  first_seq INTEGER NOT NULL,
  last_seq INTEGER NOT NULL,
  object_key TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  verified_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(bot_id, id),
  UNIQUE(bot_id, log_id, first_seq),
  FOREIGN KEY (log_id) REFERENCES story_logs(id)
);

CREATE TABLE IF NOT EXISTS archive_grants (
  token_hash TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  archive_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(bot_id, token_hash),
  FOREIGN KEY (archive_id) REFERENCES log_archives(id)
);

CREATE TABLE IF NOT EXISTS log_audit_events (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  action TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  actor_scope_id TEXT NOT NULL,
  result TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(bot_id, id)
);

CREATE INDEX IF NOT EXISTS idx_conversations_bot_scene ON conversations(bot_id, scene);
CREATE INDEX IF NOT EXISTS idx_character_sheets_owner ON character_sheets(bot_id, owner_principal);
CREATE INDEX IF NOT EXISTS idx_story_logs_conversation ON story_logs(bot_id, conversation_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_story_logs_active_session ON story_logs(bot_id, conversation_id) WHERE status IN ('new', 'recording', 'paused');
CREATE INDEX IF NOT EXISTS idx_story_log_items_seq ON story_log_items(bot_id, log_id, sequence_number);
CREATE INDEX IF NOT EXISTS idx_received_events_status ON received_events(bot_id, status);
CREATE INDEX IF NOT EXISTS idx_jobs_status_next ON jobs(bot_id, status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_jobs_type_resource ON jobs(bot_id, type, resource_id);
CREATE INDEX IF NOT EXISTS idx_archive_grants_archive ON archive_grants(bot_id, archive_id);
CREATE INDEX IF NOT EXISTS idx_log_audit_events_resource ON log_audit_events(bot_id, resource_id);
