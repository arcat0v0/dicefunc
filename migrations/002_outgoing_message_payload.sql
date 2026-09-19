ALTER TABLE outgoing_messages ADD COLUMN scene TEXT;
ALTER TABLE outgoing_messages ADD COLUMN target_id TEXT;
ALTER TABLE outgoing_messages ADD COLUMN origin_message_id TEXT;
ALTER TABLE outgoing_messages ADD COLUMN template_key TEXT;
ALTER TABLE outgoing_messages ADD COLUMN variant_id TEXT;
ALTER TABLE outgoing_messages ADD COLUMN text TEXT;
