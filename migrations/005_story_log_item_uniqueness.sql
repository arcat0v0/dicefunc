CREATE TABLE story_log_items_v2 (
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
  UNIQUE(bot_id, log_id, sequence_number, direction, source_id),
  FOREIGN KEY (log_id) REFERENCES story_logs(id)
);

INSERT INTO story_log_items_v2 (
  id,
  bot_id,
  log_id,
  sequence_number,
  direction,
  source_id,
  text,
  delivery_status,
  chunk_id,
  created_at
)
SELECT
  id,
  bot_id,
  log_id,
  sequence_number,
  direction,
  source_id,
  text,
  delivery_status,
  chunk_id,
  created_at
FROM story_log_items;

DROP TABLE story_log_items;
ALTER TABLE story_log_items_v2 RENAME TO story_log_items;
CREATE INDEX idx_story_log_items_seq ON story_log_items(bot_id, log_id, sequence_number);
