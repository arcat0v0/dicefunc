ALTER TABLE received_events
ADD COLUMN mentions TEXT CHECK(mentions IS NULL OR json_valid(mentions));
