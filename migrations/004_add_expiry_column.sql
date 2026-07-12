-- 004_add_expiry_column.sql

ALTER TABLE availability_view 
ADD COLUMN IF NOT EXISTS reservation_expires_at TIMESTAMPTZ;
