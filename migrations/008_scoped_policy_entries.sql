CREATE TABLE policy_entries_v2 (
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
  UNIQUE(bot_id, id)
);

INSERT INTO policy_entries_v2 (
  id, bot_id, scope_type, scope_id, principal_id, action, reason,
  version, created_at, updated_at
)
SELECT
  id, bot_id, scope_type, scope_id, principal_id, action, reason,
  version, created_at, updated_at
FROM policy_entries;

DROP TABLE policy_entries;
ALTER TABLE policy_entries_v2 RENAME TO policy_entries;
CREATE UNIQUE INDEX idx_policy_entries_scope_target
ON policy_entries(bot_id, scope_type, scope_id, COALESCE(principal_id, ''));
