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
const COUNTRIES = ["LU", "BE"];

// ── TED API call ──────────────────────────────────────────────────────────────
async function fetchTedNotices(): Promise<Record<string, unknown>[]> {
  // Only fetch notices from the last 6 months
  const since = new Date();
  since.setMonth(since.getMonth() - 6);
  const sinceStr = since.toISOString().slice(0, 10).replace(/-/g, "");

  const body = {
    query: `PD>=${sinceStr} AND (${CPV_CODES.map(c => `PC=${c}`).join(" OR ")}) AND (CY=LUX OR CY=BEL)`,
    page: 1,
    limit: 50,
    fields: [
      "publication-number",
      "publication-date",
      "notice-title",
      "organisation-name-buyer",
      "deadline-receipt-tender-date-lot",
      "deadline-time-lot",
      "BT-24-Lot",
      "BT-300-Lot",
      "classification-cpv",
      "procedure-type",
      "notice-type",
      "links",
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

// Extract URL string from TED links values — handles both plain strings and {href:...} objects
function linkUrl(v: unknown): string {
  if (typeof v === "string") return v.trim();
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return str(o.href ?? o.url ?? "");
  }
  return "";
}

// Preferred display languages in order (3-letter then 2-letter ISO codes)
const LANG_PREF = ["FRA","FR","ENG","EN","NLD","NL","DEU","DE","ITA","IT","SPA","ES"];

// Extract text from a multilingual object.
// TED API uses lowercase keys: {fra: "...", eng: "...", nld: ["a","b"]}
function localeStr(v: unknown): string {
  if (!v || typeof v !== "object") return str(v);
  const o = v as Record<string, unknown>;
  if (o.text) return str(o.text);
  // Try both upper and lower case language keys
  for (const lang of LANG_PREF) {
    const val = o[lang] ?? o[lang.toLowerCase()];
    if (val) return Array.isArray(val) ? val.map(String).join(". ") : str(val);
  }
  // Fallback: first non-empty value
  for (const val of Object.values(o)) {
    if (Array.isArray(val) && val.length) return val.map(String).join(". ");
    if (val && typeof val === "string" && val.trim()) return val.trim();
  }
  return "";
}

// Search an array of {languageID, text} objects for the preferred language
function localeFromArray(v: unknown): string {
  if (!Array.isArray(v) || v.length === 0) return localeStr(v);
  for (const lang of LANG_PREF) {
    const match = v.find((item: unknown) => {
      if (!item || typeof item !== "object") return false;
      const lid = str((item as Record<string,unknown>).languageID).toUpperCase();
      return lid === lang || lid === lang.slice(0, 2);
    });
    if (match) return str((match as Record<string,unknown>).text ?? "");
  }
  // Fallback: first element
  const o = v[0] as Record<string, unknown>;
  return str(o?.text ?? "") || localeStr(v[0]);
}

// Pick best value from field that may be a scalar, object, or array of {languageID,text}
function pickLocale(v: unknown): string {
  if (Array.isArray(v)) return localeFromArray(v);
  return localeStr(v);
}

function authorityName(v: unknown): string {
  if (!v || typeof v !== "object") return str(v);
  const o = v as Record<string, unknown>;
  if (o.text) return str(o.text);
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
    if (notices.length > 0) {
      const n0 = notices[0];
      console.log("notice-title raw:", JSON.stringify(n0["notice-title"]));
      console.log("BT-24-Lot raw:", JSON.stringify(n0["BT-24-Lot"]));
      console.log("organisation-name-buyer raw:", JSON.stringify(n0["organisation-name-buyer"]));
    }

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
        n["publication-number"] ?? n["notice-identifier"] ?? n["ND"] ?? ""
      );
      if (!noticeId) continue;

      // Exact dedup
      if (existingIds.has(noticeId)) { skippedExact++; continue; }

      // TED returns arrays for lot-level fields — take first element
      const firstVal = (v: unknown) =>
        Array.isArray(v) ? (v[0] ?? "") : (v ?? "");

      const title = pickLocale(n["notice-title"] ?? n["TI"] ?? "");
      if (!title) continue;

      const authority = authorityName(firstVal(n["organisation-name-buyer"]) ?? "");
      // Description: BT-24-Lot = lot description, BT-300-Lot = additional info
      const description = pickLocale(n["BT-24-Lot"] ?? n["BT-300-Lot"] ?? "");
      // Combine date + time if both present
      const deadlineDate = str(firstVal(n["deadline-receipt-tender-date-lot"]) ?? "");
      const deadlineTime = str(firstVal(n["deadline-time-lot"]) ?? "");
      const deadline = deadlineDate
        ? deadlineTime ? `${deadlineDate} ${deadlineTime}` : deadlineDate
        : "";
      const cpvRaw  = n["classification-cpv"] ?? n["CPV"] ?? [];
      const cpvStr  = Array.isArray(cpvRaw)
        ? cpvRaw.map((c: unknown) => localeStr(c) || str(c)).filter(Boolean).join(", ")
        : str(cpvRaw);
      const procedure = localeStr(firstVal(n["procedure-type"]) ?? "");
      const pubDate   = str(n["publication-date"] ?? "");
      // TED notice URL — links.xml.MUL gives the XML URL; derive HTML URL from notice ID
      const links  = n["links"] as Record<string, unknown> | undefined;
      const xmlUrl = linkUrl((links?.["xml"] as Record<string,unknown>)?.["MUL"]);
      // Extract notice ID from XML URL if present, otherwise use noticeId directly
      const idFromXml = xmlUrl ? xmlUrl.replace(/.*\/notice\/([^/]+)\/xml.*/, "$1") : "";
      const canonicalId = idFromXml || noticeId;
      const tedUrl = `https://ted.europa.eu/fr/notice/-/detail/${canonicalId}`;

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
