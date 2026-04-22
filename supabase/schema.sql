-- ============================================================
-- Agilos RFP Automation — Supabase Schema
-- Schéma dédié : "rfp"
--
-- ÉTAPES D'INSTALLATION :
-- 1. Exécuter ce script dans Supabase SQL Editor
-- 2. Aller dans Supabase Dashboard → Settings → API
--    → "Exposed schemas" → Ajouter "rfp"
-- 3. Redémarrer PostgREST (bouton "Reload schema cache" dans la même page)
-- ============================================================

-- Créer le schéma dédié au projet
CREATE SCHEMA IF NOT EXISTS rfp;

-- ── Portal scan history ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rfp.portal_scans (
    id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    keywords      JSONB,
    markets_found INTEGER DEFAULT 0,
    markets_new   INTEGER DEFAULT 0,
    scanned_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ── Markets ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rfp.markets (
    id                    UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    market_id             TEXT UNIQUE,       -- ID natif du portail (ex: "541487")
    scan_id               UUID REFERENCES rfp.portal_scans(id) ON DELETE SET NULL,
    title                 TEXT NOT NULL,
    reference             TEXT,             -- ex: "2600797"
    procedure             TEXT,             -- ex: "EU.OUV"
    category              TEXT,             -- 'Travaux' | 'Services' | 'Fournitures'
    published_date        TEXT,
    deadline              TEXT,             -- "11/05/2026 10:00"
    contracting_authority TEXT,
    service               TEXT,             -- service détaillé depuis la page de détail
    description           TEXT,             -- objet court (depuis la liste)
    full_description      TEXT,             -- description complète (depuis la page de détail)
    cpv_codes             TEXT,             -- ex: "72000000, 72200000"
    lots                  TEXT,
    resolved_url          TEXT,             -- URL de la page de détail du marché
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

-- ── Indexes ────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_rfp_markets_status      ON rfp.markets(status);
CREATE INDEX IF NOT EXISTS idx_rfp_markets_is_relevant ON rfp.markets(is_relevant);
CREATE INDEX IF NOT EXISTS idx_rfp_markets_created_at  ON rfp.markets(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rfp_markets_market_id   ON rfp.markets(market_id);
CREATE INDEX IF NOT EXISTS idx_rfp_markets_category    ON rfp.markets(category);

-- ── Auto-update updated_at ─────────────────────────────────────
CREATE OR REPLACE FUNCTION rfp.update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS markets_updated_at ON rfp.markets;
CREATE TRIGGER markets_updated_at
    BEFORE UPDATE ON rfp.markets
    FOR EACH ROW EXECUTE FUNCTION rfp.update_updated_at();

-- ── Row Level Security ─────────────────────────────────────────
ALTER TABLE rfp.portal_scans ENABLE ROW LEVEL SECURITY;
ALTER TABLE rfp.markets      ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon_all_portal_scans" ON rfp.portal_scans FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "anon_all_markets"      ON rfp.markets      FOR ALL TO anon USING (true) WITH CHECK (true);

-- ── Realtime ───────────────────────────────────────────────────
-- Note: si la publication supabase_realtime n'inclut pas encore le schéma rfp,
-- exécuter : ALTER PUBLICATION supabase_realtime ADD TABLE rfp.markets;
ALTER PUBLICATION supabase_realtime ADD TABLE rfp.markets;
ALTER PUBLICATION supabase_realtime ADD TABLE rfp.portal_scans;
