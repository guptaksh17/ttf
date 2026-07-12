-- 003_create_projection_tables.sql

CREATE TABLE IF NOT EXISTS availability_view (
    stream_id UUID PRIMARY KEY,
    court_id UUID NOT NULL,
    booking_date DATE NOT NULL,
    start_hour INTEGER NOT NULL,
    duration_hours INTEGER NOT NULL,
    status TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_availability_view_court_date 
ON availability_view(court_id, booking_date);

CREATE TABLE IF NOT EXISTS booking_history_view (
    stream_id UUID PRIMARY KEY,
    user_id UUID NOT NULL,
    court_id UUID NOT NULL,
    booking_date DATE NOT NULL,
    start_hour INTEGER NOT NULL,
    duration_hours INTEGER NOT NULL,
    total_amount NUMERIC(10,2) NOT NULL,
    status TEXT NOT NULL,
    last_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_booking_history_view_user_id 
ON booking_history_view(user_id);
