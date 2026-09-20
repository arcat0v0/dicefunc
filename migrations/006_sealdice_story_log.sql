ALTER TABLE received_events ADD COLUMN sender_name TEXT;
ALTER TABLE received_events ADD COLUMN event_timestamp TEXT;

ALTER TABLE outgoing_messages ADD COLUMN story_log_id TEXT;
ALTER TABLE outgoing_messages ADD COLUMN story_log_sequence INTEGER;
ALTER TABLE outgoing_messages ADD COLUMN story_log_part INTEGER;

CREATE TABLE story_log_items_v3 (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  log_id TEXT NOT NULL,
  sequence_number INTEGER NOT NULL,
  sequence_part INTEGER NOT NULL DEFAULT 0,
  direction TEXT NOT NULL,
  source_id TEXT NOT NULL,
  nickname TEXT NOT NULL DEFAULT '',
  im_user_id TEXT NOT NULL DEFAULT '',
  uniform_id TEXT NOT NULL DEFAULT '',
  message_time INTEGER NOT NULL DEFAULT 0,
  text TEXT,
  is_dice INTEGER NOT NULL DEFAULT 0,
  command_id INTEGER NOT NULL DEFAULT 0,
  command_info TEXT CHECK(command_info IS NULL OR json_valid(command_info)),
  raw_msg_id TEXT,
  channel TEXT NOT NULL DEFAULT '',
  delivery_status TEXT NOT NULL DEFAULT 'pending',
  chunk_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(bot_id, id),
  UNIQUE(bot_id, log_id, sequence_number, sequence_part),
  FOREIGN KEY (log_id) REFERENCES story_logs(id)
);

INSERT INTO story_log_items_v3 (
  id,
  bot_id,
  log_id,
  sequence_number,
  sequence_part,
  direction,
  source_id,
  nickname,
  im_user_id,
  uniform_id,
  message_time,
  text,
  is_dice,
  command_id,
  command_info,
  raw_msg_id,
  channel,
  delivery_status,
  chunk_id,
  created_at
)
SELECT
  id,
  bot_id,
  log_id,
  sequence_number,
  ROW_NUMBER() OVER (
    PARTITION BY bot_id, log_id, sequence_number
    ORDER BY CASE direction WHEN 'inbound' THEN 0 ELSE 1 END, created_at, id
  ) - 1,
  direction,
  source_id,
  source_id,
  source_id,
  source_id,
  CAST(strftime('%s', created_at) AS INTEGER),
  text,
  CASE direction WHEN 'outbound' THEN 1 ELSE 0 END,
  0,
  NULL,
  NULL,
  '',
  delivery_status,
  chunk_id,
  created_at
FROM story_log_items;

DROP TABLE story_log_items;
ALTER TABLE story_log_items_v3 RENAME TO story_log_items;
CREATE INDEX idx_story_log_items_seq ON story_log_items(bot_id, log_id, sequence_number, sequence_part);

ALTER TABLE story_chunks ADD COLUMN item_count INTEGER NOT NULL DEFAULT 0;
UPDATE story_chunks
SET item_count = last_seq - first_seq + 1
WHERE item_count = 0;

UPDATE story_log_items
SET chunk_id = NULL
WHERE EXISTS (
  SELECT 1
  FROM log_archives
  WHERE log_archives.bot_id = story_log_items.bot_id
    AND log_archives.log_id = story_log_items.log_id
    AND log_archives.format <> 'txt'
    AND log_archives.status IN ('pending', 'uploading', 'failed')
);

DELETE FROM story_chunks
WHERE EXISTS (
  SELECT 1
  FROM log_archives
  WHERE log_archives.bot_id = story_chunks.bot_id
    AND log_archives.log_id = story_chunks.log_id
    AND log_archives.format <> 'txt'
    AND log_archives.status IN ('pending', 'uploading', 'failed')
);

UPDATE jobs
SET status = 'pending',
    attempts = 0,
    next_attempt_at = datetime('now'),
    lease = NULL,
    lease_expires_at = NULL,
    error_code = NULL,
    updated_at = datetime('now')
WHERE type = 'archive-chunk'
  AND EXISTS (
    SELECT 1
    FROM log_archives
    WHERE log_archives.bot_id = jobs.bot_id
      AND log_archives.id = jobs.resource_id
      AND log_archives.format <> 'txt'
      AND log_archives.status IN ('pending', 'uploading', 'failed')
  );

UPDATE log_archives
SET format = 'txt',
    digest = '',
    status = 'pending',
    error_code = NULL,
    updated_at = datetime('now')
WHERE format <> 'txt'
  AND status IN ('pending', 'uploading', 'failed');
