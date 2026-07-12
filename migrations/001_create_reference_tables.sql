-- 001_create_reference_tables.sql

-- Enable uuid-ossp extension if we want, but gen_random_uuid() is built-in.
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS turfs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    city TEXT NOT NULL,
    address TEXT NOT NULL,
    opens_at TIME NOT NULL,
    closes_at TIME NOT NULL
);

CREATE TABLE IF NOT EXISTS courts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    turf_id UUID NOT NULL REFERENCES turfs(id) ON DELETE CASCADE,
    sport_type TEXT NOT NULL,
    name TEXT NOT NULL,
    base_price_per_hour NUMERIC(10,2) NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    phone TEXT NOT NULL
);
