-- ============================================================
-- Agilos RFP Automation — Supabase Schema
-- Run this in Supabase SQL Editor to initialize the database
-- ============================================================

-- Portal scan history
CREATE TABLE IF NOT EXISTS portal_scans (
    id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    keywords    JSONB,               -- keywords used for this scan
    markets_found   INTEGER DEFAULT 0,
    markets_new     INTEGER DEFAULT 0,
    scanned_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Public market records
CREATE TABLE IF NOT EXISTS markets (
    id                    UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    market_id             TEXT UNIQUE,      -- portal's native ID (e.g. "541487")
    scan_id               UUID REFERENCES portal_scans(id) ON DELETE SET NULL,
    title                 TEXT NOT NULL,
    reference             TEXT,             -- e.g. "2600797"
    procedure             TEXT,             -- e.g. "EU.OUV"
    category              TEXT,             -- 'Travaux', 'Services', 'Fournitures'
    published_date        TEXT,
    deadline              TEXT,             -- "11/05/2026 10:00"
    contracting_authority TEXT,
    service               TEXT,             -- detailed service name from detail page
    description           TEXT,             -- short description from list page
    full_description      TEXT,             -- full object from detail page
    cpv_codes             TEXT,             -- e.g. "72000000, 72200000"
    lots                  TEXT,
    resolved_url          TEXT,             -- detail page URL
    status                TEXT DEFAULT 'pending',
    -- 'pending' | 'analyzing' | 'analyzed' | 'error'
    is_relevant           BOOLEAN,
    relevance_score       INTEGER CHECK (relevance_score BETWEEN 0 AND 100),
    relevance_reason      TEXT,
    key_requirements      JSONB,            -- string[]
    matching_consultants  JSONB,            -- string[]
    market_type           TEXT,
    rfp_content           TEXT,
    rfp_generated_at      TIMESTAMPTZ,
    error_message         TEXT,
    created_at            TIMESTAMPTZ DEFAULT NOW(),
    updated_at            TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_markets_status      ON markets(status);
CREATE INDEX IF NOT EXISTS idx_markets_is_relevant ON markets(is_relevant);
CREATE INDEX IF NOT EXISTS idx_markets_created_at  ON markets(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_markets_market_id   ON markets(market_id);
CREATE INDEX IF NOT EXISTS idx_markets_category    ON markets(category);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS markets_updated_at ON markets;
CREATE TRIGGER markets_updated_at
    BEFORE UPDATE ON markets
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ── Row Level Security ──────────────────────────────────────────
ALTER TABLE portal_scans ENABLE ROW LEVEL SECURITY;
ALTER TABLE markets      ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon_all_portal_scans" ON portal_scans FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "anon_all_markets"      ON markets      FOR ALL TO anon USING (true) WITH CHECK (true);

-- ── Realtime ────────────────────────────────────────────────────
ALTER PUBLICATION supabase_realtime ADD TABLE markets;
ALTER PUBLICATION supabase_realtime ADD TABLE portal_scans;
