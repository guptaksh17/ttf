-- 005_create_snapshots.sql

CREATE TABLE IF NOT EXISTS aggregate_snapshots (
    stream_id UUID NOT NULL,
    version INTEGER NOT NULL,
    state JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (stream_id, version)
);
