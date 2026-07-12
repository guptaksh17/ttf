-- Migration: Create event_outbox table and indexes
CREATE TABLE IF NOT EXISTS event_outbox (
  id BIGSERIAL PRIMARY KEY,
  event_log_id UUID NOT NULL REFERENCES event_log(id) ON DELETE CASCADE,
  published BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  published_at TIMESTAMPTZ,
  CONSTRAINT uq_event_log_id UNIQUE (event_log_id)
);

CREATE INDEX IF NOT EXISTS idx_event_outbox_unpublished ON event_outbox (id) WHERE published = false;
