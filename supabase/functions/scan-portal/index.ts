// Supabase Edge Function — scan-portal
// Scrapes https://pmp.b2g.etat.lu with IT keywords and inserts new markets into DB.
// Deno runtime.
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { DOMParser } from "https://deno.land/x/deno_dom@v0.1.48/deno-dom-wasm.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const BASE      = "https://pmp.b2g.etat.lu";
const SEARCH    = `${BASE}/espace-entreprise/search`;

const FETCH_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36",
  "Accept-Language": "fr-LU,fr;q=0.9,en;q=0.8",
  Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
};

// Default IT keywords — covers the main areas of Agilos expertise
const DEFAULT_KEYWORDS = [
  "informatique",
  "données",
  "Business Intelligence",
  "ERP",
  "développement logiciel",
  "intelligence artificielle",
  "numérique",
  "data consultant",
  "digital",
  "ETL",
];

// French month abbreviations → 2-digit month number
const MONTHS: Record<string, string> = {
  "Janv.": "01", "Févr.": "02", "Mars": "03", "Avril": "04",
  "Mai": "05",   "Juin": "06",  "Juil.": "07", "Août": "08",
  "Sept.": "09", "Oct.": "10",  "Nov.": "11",  "Déc.": "12",
};

interface MarketRow {
  market_id: string;
  title: string;
  reference: string;
  procedure: string;
  category: string;
  published_date: string;
  description: string;
  contracting_authority: string;
  resolved_url: string;
  status: "pending";
}

function fmtDate(day: string, month: string, year: string): string {
  const m = MONTHS[month.trim()] ?? "01";
  return `${day.trim().padStart(2, "0")}/${m}/${year.trim()}`;
}

async function searchPage(keyword: string): Promise<MarketRow[]> {
  const url = `${SEARCH}?keyWord=${encodeURIComponent(keyword)}`;
  const resp = await fetch(url, {
    headers: FETCH_HEADERS,
    signal: AbortSignal.timeout(18_000),
  });
  if (!resp.ok) return [];

  const html = await resp.text();
  const doc = new DOMParser().parseFromString(html, "text/html");
  if (!doc) return [];

  const markets: MarketRow[] = [];

  // Every market in the list has a "Accéder au marché" link pointing to
  // /entreprise/consultation/{market_id}?orgAcronyme=t5y
  const links = doc.querySelectorAll(
    `a.btn.btn-primary[href*="/entreprise/consultation/"]`
  );

  for (const link of links) {
    const href = (link as Element).getAttribute("href") ?? "";
    const idMatch = href.match(/\/consultation\/(\d+)/);
    if (!idMatch) continue;

    const marketId = idMatch[1];
    const orgMatch = href.match(/orgAcronyme=(\w+)/);
    const orgAcro  = orgMatch ? orgMatch[1] : "t5y";
    const resolvedUrl = `${BASE}/entreprise/consultation/${marketId}?orgAcronyme=${orgAcro}`;

    // Navigate up to the market container block
    let container: Element | null = (link as Element).parentElement;
    for (let i = 0; i < 12; i++) {
      if (!container) break;
      if (container.querySelector(".cons_categorie")) break;
      container = container.parentElement;
    }
    if (!container) continue;

    // ── Category & Procedure ─────────────────────────────────
    const category  = container.querySelector(".cons_categorie span")
      ?.textContent?.trim() ?? "";
    const procedure = container.querySelector(".cons_procedure abbr span")
      ?.textContent?.trim() ?? "";

    // ── Published date ───────────────────────────────────────
    const day   = container.querySelector(".date-min .day span")?.textContent?.trim()   ?? "";
    const month = container.querySelector(".date-min .month span")?.textContent?.trim() ?? "";
    const year  = container.querySelector(".date-min .year span")?.textContent?.trim()  ?? "";
    const publishedDate = (day && month && year) ? fmtDate(day, month, year) : "";

    // ── Reference & Title ────────────────────────────────────
    // The reference is the first small.pull-left text in .objet-line
    const refEl = container.querySelector(".objet-line .small.pull-left");
    const reference = refEl?.textContent?.trim() ?? "";

    // Title is in the truncate span within .objet-line
    const titleSpan = container.querySelector(".objet-line .truncate span");
    const title =
      (titleSpan?.getAttribute("title") ?? titleSpan?.textContent ?? "").trim();
    if (!title) continue;

    // ── Description (Objet) ──────────────────────────────────
    const descDiv = container.querySelector(".truncate-700");
    const description =
      (descDiv?.getAttribute("title") ?? descDiv?.textContent ?? "")
        .replace(/^Objet\s*:\s*/i, "")
        .trim();

    // ── Authority ────────────────────────────────────────────
    const authDiv = container.querySelector(
      "[id*='panelBlocDenomination'] .truncate-700"
    );
    const authority =
      (authDiv?.getAttribute("title") ?? authDiv?.textContent ?? "").trim();

    markets.push({
      market_id: marketId,
      title,
      reference,
      procedure,
      category,
      published_date: publishedDate,
      description,
      contracting_authority: authority,
      resolved_url: resolvedUrl,
      status: "pending",
    });
  }

  return markets;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const keywords: string[] = body.keywords ?? DEFAULT_KEYWORDS;

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { db: { schema: "rfp" } }
    );

    // Fetch existing market IDs to avoid inserting duplicates
    const { data: existing } = await supabase
      .from("markets")
      .select("market_id");
    const existingIds = new Set(
      (existing ?? []).map((r: { market_id: string }) => r.market_id)
    );

    // Collect unique new markets from all keyword searches
    const collected = new Map<string, MarketRow>();

    for (const keyword of keywords) {
      try {
        const results = await searchPage(keyword);
        for (const m of results) {
          if (!existingIds.has(m.market_id) && !collected.has(m.market_id)) {
            collected.set(m.market_id, m);
          }
        }
      } catch (e) {
        console.error(`Error searching "${keyword}":`, e);
      }
      // Polite delay between keyword searches
      await new Promise((r) => setTimeout(r, 600));
    }

    const newMarkets = [...collected.values()];

    // Record this scan
    const { data: scanRecord } = await supabase
      .from("portal_scans")
      .insert({
        keywords,
        markets_found: [...existingIds].length + newMarkets.length,
        markets_new: newMarkets.length,
      })
      .select("id")
      .single();

    const scanId = scanRecord?.id;

    // Batch-insert new markets
    let insertedIds: string[] = [];
    if (newMarkets.length > 0) {
      const { data: inserted, error: insertErr } = await supabase
        .from("markets")
        .insert(
          newMarkets.map((m) => ({
            ...m,
            scan_id: scanId,
          }))
        )
        .select("id");

      if (insertErr) {
        console.error("Insert error:", insertErr);
      }
      insertedIds = (inserted ?? []).map((r: { id: string }) => r.id);
    }

    return new Response(
      JSON.stringify({
        keywords_searched: keywords.length,
        markets_new: newMarkets.length,
        inserted_ids: insertedIds,
        scan_id: scanId,
      }),
      { headers: { ...CORS, "Content-Type": "application/json" } }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("scan-portal error:", msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
