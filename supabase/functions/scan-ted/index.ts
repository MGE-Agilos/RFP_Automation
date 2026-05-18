// Supabase Edge Function — scan-ted
// Fetches IT markets from TED (Tenders Electronic Daily) EU open data API.
// CPV scope: 48000000, 72000000, 72300000, 79000000 — LU + BE — max 50 notices.
// Deno runtime.
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const TED_API   = "https://api.ted.europa.eu/v3/notices/search";
const CPV_CODES = ["48000000", "72000000", "72300000", "79000000"];
const PLACES    = ["LU0", "BEL"];

// ── TED API call ──────────────────────────────────────────────────────────────
async function fetchTedNotices(): Promise<Record<string, unknown>[]> {
  const body = {
    query: `MAIN-CPV-CODE IN (${CPV_CODES.join(",")}) AND PLACE-OF-PERFORMANCE IN (${PLACES.join(",")})`,
    page: 1,
    limit: 50,
    fields: [
      "notice-id",
      "publication-number",
      "publication-date",
      "title-multilingual",
      "contracting-body",
      "deadline-for-submission",
      "short-description",
      "cpv-codes",
      "procedure-type",
    ],
  };

  const resp = await fetch(TED_API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`TED API ${resp.status}: ${txt.slice(0, 400)}`);
  }

  const data = await resp.json();
  // TED API v3 can return notices under different keys depending on version
  return (data.notices ?? data.data ?? data.results ?? []) as Record<string, unknown>[];
}

// ── Field extraction helpers ──────────────────────────────────────────────────
function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : String(v ?? "").trim();
}

function localeStr(v: unknown): string {
  if (!v || typeof v !== "object") return str(v);
  const o = v as Record<string, unknown>;
  return str(o.FRA ?? o.FR ?? o.ENG ?? o.EN ?? Object.values(o)[0] ?? "");
}

function authorityName(v: unknown): string {
  if (!v || typeof v !== "object") return str(v);
  const o = v as Record<string, unknown>;
  return str(o.officialName ?? o.name ?? o.NA ?? o.CAO ?? "");
}

// ── Cross-platform dedup helpers ──────────────────────────────────────────────
function normKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 40);
}

function titlesSimilar(a: string, b: string): boolean {
  const words = (s: string) =>
    s.toLowerCase().split(/\s+/).filter((w) => w.length > 4);
  const wb = new Set(words(b));
  return words(a).filter((w) => wb.has(w)).length >= 3;
}

// ── Serve ─────────────────────────────────────────────────────────────────────
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { db: { schema: "rfp" } }
    );

    // ── 1. Fetch from TED ──────────────────────────────────────
    const notices = await fetchTedNotices();
    console.log(`TED returned ${notices.length} notices`);

    // ── 2. Load existing markets for dedup ────────────────────
    const { data: existing } = await supabase
      .from("markets")
      .select("market_id, title, contracting_authority, source");

    const existingIds = new Set((existing ?? []).map((r) => r.market_id));

    // Build PMP authority → title map for cross-platform dedup
    const pmpByAuth = new Map<string, string>();
    for (const r of existing ?? []) {
      if (!r.source || r.source === "pmp") {
        const key = normKey(r.contracting_authority ?? "");
        if (key) pmpByAuth.set(key, r.title ?? "");
      }
    }

    // ── 3. Build rows to insert ───────────────────────────────
    const toInsert: Record<string, unknown>[] = [];
    let skippedExact = 0;
    let skippedDupes = 0;

    for (const n of notices) {
      // Notice ID: TED uses several possible field names
      const noticeId = str(
        n["notice-id"] ?? n["publication-number"] ?? n["ND"] ?? ""
      );
      if (!noticeId) continue;

      // Exact dedup
      if (existingIds.has(noticeId)) { skippedExact++; continue; }

      const title = localeStr(n["title-multilingual"] ?? n["TI"]) || str(n.title ?? "");
      if (!title) continue;

      const authority = authorityName(n["contracting-body"] ?? n["CA"]);
      const description =
        localeStr(n["short-description"] ?? n["TE"]) || str(n.description ?? "");
      const deadline   = str(n["deadline-for-submission"] ?? n["DT"] ?? "");
      const cpvRaw     = n["cpv-codes"] ?? n["CPV"] ?? [];
      const cpvStr     = Array.isArray(cpvRaw) ? cpvRaw.join(", ") : str(cpvRaw);
      const procedure  = str(n["procedure-type"] ?? n["PR"] ?? "");
      const pubDate    = str(n["publication-date"] ?? n["PD"] ?? "");
      const tedUrl     = `https://ted.europa.eu/fr/notice/${noticeId}`;

      // Cross-platform dedup: same authority + similar title already in PMP?
      const authKey  = normKey(authority);
      const pmpTitle = authKey ? (pmpByAuth.get(authKey) ?? "") : "";
      if (pmpTitle && titlesSimilar(title, pmpTitle)) {
        skippedDupes++;
        console.log(`Skipped TED ${noticeId} — likely duplicate of PMP: "${pmpTitle.slice(0, 60)}"`);
        continue;
      }

      toInsert.push({
        market_id:             noticeId,
        title,
        reference:             noticeId,
        procedure,
        category:              "Services",
        published_date:        pubDate,
        description,
        contracting_authority: authority,
        cpv_codes:             cpvStr,
        deadline,
        resolved_url:          tedUrl,
        source:                "ted",
        status:                "pending",
      });
    }

    // ── 4. Record scan ────────────────────────────────────────
    const { data: scanRecord } = await supabase
      .from("portal_scans")
      .insert({
        keywords:      CPV_CODES,
        markets_found: notices.length,
        markets_new:   toInsert.length,
        source:        "ted",
      })
      .select("id")
      .single();

    // ── 5. Insert new markets ─────────────────────────────────
    let insertedIds: string[] = [];
    if (toInsert.length > 0) {
      const { data: ins, error } = await supabase
        .from("markets")
        .insert(toInsert.map((m) => ({ ...m, scan_id: scanRecord?.id })))
        .select("id");
      if (error) console.error("Insert error:", error);
      insertedIds = (ins ?? []).map((r: { id: string }) => r.id);
    }

    return new Response(
      JSON.stringify({
        total_found:        notices.length,
        markets_new:        toInsert.length,
        skipped_exact:      skippedExact,
        skipped_duplicates: skippedDupes,
        inserted_ids:       insertedIds,
      }),
      { headers: { ...CORS, "Content-Type": "application/json" } }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("scan-ted error:", msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
