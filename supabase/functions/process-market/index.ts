// Supabase Edge Function — process-market
// Fetches detail page, analyses relevance with Claude, generates RFP if relevant.
// Deno runtime.
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Anthropic from "https://esm.sh/@anthropic-ai/sdk@0.40.0";
import { DOMParser } from "https://deno.land/x/deno_dom@v0.1.48/deno-dom-wasm.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const MODEL = "claude-sonnet-4-6";

const FETCH_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36",
  "Accept-Language": "fr-LU,fr;q=0.9,en;q=0.8",
  Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
};

// ── Company profile ──────────────────────────────────────────────────────────
const COMPANY_PROFILE = `
PROFIL D'ENTREPRISE — AGILOS

Agilos est une société de conseil IT belge spécialisée dans les solutions Data & Analytics.

EXPERTISES PRINCIPALES :
1. Business Intelligence : Qlik Sense, QlikView, Qlik Cloud, Qlik NPrinting, Power BI, SAP BusinessObjects, Vizlib
2. ETL & Intégration de données : Talend, Qlik Data Integration, TimeXtender, SSIS, dbt, Qlik Replicate
3. Architecture de données : Data Warehouse, Data Modeling, Data Lake, Databricks, Data Mesh, Snowflake
4. Cloud : Microsoft Azure, AWS, Qlik Cloud, Snowflake
5. Développement web & applicatif : HTML, CSS, JavaScript, Bootstrap, NodeJS, APIs REST, Web Mashups, Qlik Analytics Platform (QAP)
6. Intelligence Artificielle & ML : projets IA/ML, LLM, NLP, automatisation intelligente, RAG
7. ERP : SAP consulting, implémentation, reporting SAP
8. Bases de données : SQL Server, Oracle, PostgreSQL, Amazon Redshift, SAP HANA
9. Gestion de projet : AGILE/SCRUM, PMBOK, PMI, Design Thinking

CONSULTANTS DISPONIBLES :
- Jean-François Dierckx (JFD) : BI Architect & Project Manager, 25+ ans. Expert Qlik, SAP, Data Warehouse, gestion de projet, presales
- Loïc Lestienne (LLE) : Technical Consultant. Admin Qlik, Azure, Office 365, Infrastructure IT, migration Qlik Cloud
- Michael Laenen (MLA) : BI Architect. Expert Qlik Sense/QAP (développement avancé, web mashup, analytics platform), JS/NodeJS
- Piepezi Priso Mbape (PPR) : BI Developer, 7+ ans. Qlik, Power BI, ETL, migration de données, coaching
- Sofiene Khayati (SKH) : Senior BI & ETL Consultant, Team Lead technique. Expert Qlik, Talend, TimeXtender, Power BI, ETL
- Thomas Duvivier (TDU) : Data Platform Engineer, 15+ ans. TimeXtender, Power BI, Databricks, dbt, Data Mesh
- Vivien Rossignon (VRO) : Data Architect & Project Lead, 12+ ans. Qlik, Power BI, Azure, Snowflake, Data Warehouse, ETL

SECTEURS D'EXPÉRIENCE : Finance, Santé/Hôpital, Administration Publique, Manufacturing, Retail, RH, Automotive, Institutions Européennes

RÉFÉRENCES NOTABLES :
- ECDC (Centre Européen de Prévention des Maladies) — COVID-19 Vaccine Tracker (Qlik Sense)
- Banque de Luxembourg — Migration QlikView → Qlik Sense (300 utilisateurs)
- CTIE / Ministère de la Santé Luxembourg — Portail public statistiques de mortalité
- Umicore — Data Platform HR (Databricks, dbt, Data Mesh)
- Doosan Bobcat EMEA — Machine IQ dashboards (5 milliards de lignes, IoT)
- Grand Hôpital de Charleroi — Audit et optimisation Qlik Sense

MARCHÉS PERTINENTS (nous POUVONS répondre) :
✓ Développement IT, logiciels, applications web/mobiles
✓ Business Intelligence, Data Analytics, reporting, dashboarding
✓ ERP — implémentation, consulting, reporting (SAP, etc.)
✓ Intégration de données, ETL, data engineering, migration
✓ Architecture de données, data warehouse, data lake
✓ Consulting IT, conseil technique, assistance à maîtrise d'ouvrage IT
✓ Intelligence Artificielle, Machine Learning, LLM, automatisation
✓ Infrastructure IT, cloud computing, administration systèmes
✓ Transformation digitale, digitalisation de processus
✓ Formation informatique, coaching IT
✓ Profils Data / IT en régie ou forfait

MARCHÉS NON PERTINENTS (nous NE POUVONS PAS répondre) :
✗ Travaux de construction, génie civil, bâtiment (même si "IT" apparaît dans le titre)
✗ Services de nettoyage / entretien de locaux
✗ Services de transport, logistique physique
✗ Restauration, alimentation, catering
✗ Sécurité physique (gardiennage, surveillance)
✗ Équipements médicaux, pharmaceutiques
✗ Services juridiques (sauf si IT-juridique)
`;

// ── Detail page scrapers ─────────────────────────────────────────────────────
interface DetailData {
  title?: string;
  deadline?: string;
  full_description?: string;
  service?: string;
  cpv_codes?: string;
  lots?: string;
  procedure_type?: string;
}

// PMP Luxembourg scraper
async function scrapeDetailPage(url: string): Promise<DetailData> {
  const resp = await fetch(url, {
    headers: FETCH_HEADERS,
    signal: AbortSignal.timeout(20_000),
  });
  if (!resp.ok) return {};

  const html = await resp.text();
  const doc = new DOMParser().parseFromString(html, "text/html");
  if (!doc) return {};

  const text = doc.body?.textContent ?? "";

  // Helper: extract value after a label in the page text
  function extractAfterLabel(label: RegExp): string {
    const m = text.match(label);
    return m ? m[1].trim() : "";
  }

  // Deadline — anchored on date format to avoid capturing the questions-deadline
  const deadline = (() => {
    const m = text.match(
      /remise\s+des\s+plis[^:]*:\s*(\d{1,2}[\/\.]\d{1,2}[\/\.]\d{4}(?:\s+\d{1,2}[h:]\d{2})?)/i
    );
    return m ? m[1].trim() : "";
  })();

  // Full description (Objet)
  const full_description = extractAfterLabel(/Objet\s*:\s*([^\n|]{20,})/i);

  // Service (authority detail)
  const service = extractAfterLabel(/Service\s*:\s*([^\n|]+)/i);

  // CPV codes — extract all CPV numbers on the page
  const cpvMatches = text.match(/\b\d{8}(-\d)?\b/g) ?? [];
  const cpv_codes = [...new Set(cpvMatches)].slice(0, 10).join(", ");

  // Lots
  const lots = extractAfterLabel(/Lots?\s*:\s*([^\n|]+)/i);

  return { deadline, full_description, service, cpv_codes, lots };
}

// TED notice: fetch eForms XML and extract description + deadline
async function fetchTedXmlData(noticeId: string): Promise<DetailData> {
  const xmlUrl = `https://ted.europa.eu/en/notice/${noticeId}/xml`;
  const resp = await fetch(xmlUrl, {
    headers: { ...FETCH_HEADERS, Accept: "application/xml, text/xml, */*" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!resp.ok) {
    console.log(`TED XML fetch failed for ${noticeId}: ${resp.status}`);
    return {};
  }

  const xml = await resp.text();

  // Extract French or English title from XML (handles 2-letter "FR" and 3-letter "FRA" codes)
  const namePattern = (codes: string[]) => {
    const alt = codes.join("|");
    const rx = new RegExp(`<cbc:Name\\s+languageID=["'](${alt})["'][^>]*>([^<]{5,})<\\/cbc:Name>`, "i");
    return xml.match(rx)?.[2]?.trim() ?? "";
  };
  const xmlTitle = namePattern(["FRA","FR"]) || namePattern(["ENG","EN"]) || namePattern(["NLD","NL"]) || "";
  if (xmlTitle) console.log(`XML title found: "${xmlTitle.slice(0,80)}"`);

  // Extract all <cbc:Description> values — pick the longest (most informative)
  const descMatches = [...xml.matchAll(/<cbc:Description[^>]*>([^<]{20,})<\/cbc:Description>/g)];
  const full_description = descMatches
    .map((m) => m[1].trim())
    .sort((a, b) => b.length - a.length)[0]
    ?.slice(0, 3000) ?? "";

  // Deadline: find EndDate+EndTime pairs, pick the most recent future date (or nearest past)
  const dateTimePattern = /<cbc:EndDate>(\d{4}-\d{2}-\d{2})<\/cbc:EndDate>[\s\S]{0,200}?<cbc:EndTime>(\d{2}:\d{2}:\d{2})/g;
  const dateOnlyPattern = /<cbc:EndDate>(\d{4}-\d{2}-\d{2})<\/cbc:EndDate>/g;
  const pairs: Array<{date: string; time: string}> = [];
  let m: RegExpExecArray | null;
  while ((m = dateTimePattern.exec(xml)) !== null) pairs.push({ date: m[1], time: m[2] });
  if (!pairs.length) {
    while ((m = dateOnlyPattern.exec(xml)) !== null) pairs.push({ date: m[1], time: "" });
  }
  // Prefer future dates; fall back to the last date in the document
  const now = new Date().toISOString().slice(0, 10);
  const futurePairs = pairs.filter((p) => p.date >= now);
  const chosen = futurePairs[0] ?? pairs[pairs.length - 1];
  let deadline = "";
  if (chosen) {
    // Convert yyyy-mm-dd → dd/mm/yyyy
    const [y, mo, d] = chosen.date.split("-");
    deadline = `${d}/${mo}/${y}${chosen.time ? " " + chosen.time.slice(0, 5) : ""}`;
  }

  // CPV codes from <cbc:ItemClassificationCode>
  const cpvMatches = [...xml.matchAll(/<cbc:ItemClassificationCode[^>]*>(\d{8})<\/cbc:ItemClassificationCode>/g)];
  const cpv_codes = [...new Set(cpvMatches.map((m) => m[1]))].slice(0, 10).join(", ");

  return { full_description, deadline, cpv_codes, title: xmlTitle };
}

// ── Serve ────────────────────────────────────────────────────────────────────
serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS });
  }

  try {
    const { market_id: id } = await req.json();
    if (!id) {
      return new Response(JSON.stringify({ error: "market_id required" }), {
        status: 400,
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { db: { schema: "rfp" } }
    );
    const claude = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY")! });

    // ── 1. Fetch market record ───────────────────────────────
    const { data: market, error: fetchErr } = await supabase
      .from("markets")
      .select("*")
      .eq("id", id)
      .single();

    if (fetchErr || !market) {
      return new Response(JSON.stringify({ error: "Market not found" }), {
        status: 404,
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    // ── 2. Scrape detail page ────────────────────────────────
    await supabase.from("markets").update({ status: "analyzing" }).eq("id", id);

    let detailData: DetailData = {};
    const isTed = (market.source === "ted") ||
      (market.resolved_url ?? "").includes("ted.europa.eu");

    if (isTed && market.market_id) {
      // TED: fetch eForms XML for structured description + deadline
      try {
        detailData = await fetchTedXmlData(market.market_id);
        await supabase.from("markets").update({
          ...(detailData.title && { title: detailData.title }),
          full_description: detailData.full_description || market.description || "",
          deadline:         detailData.deadline         || market.deadline    || "",
          cpv_codes:        detailData.cpv_codes        || market.cpv_codes   || "",
        }).eq("id", id);
      } catch (e) {
        console.error("TED XML fetch error:", e);
        await supabase.from("markets").update({
          full_description: market.description || "",
        }).eq("id", id);
      }
    } else if (!isTed && market.resolved_url) {
      // PMP: scrape the detail page for richer data
      try {
        detailData = await scrapeDetailPage(market.resolved_url);
        await supabase.from("markets").update({
          deadline:         detailData.deadline         || market.deadline,
          full_description: detailData.full_description || market.description,
          service:          detailData.service,
          cpv_codes:        detailData.cpv_codes,
          lots:             detailData.lots,
        }).eq("id", id);
      } catch (e) {
        console.error("PMP scrape error:", e);
      }
    }

    // Merge fields for Claude
    const fullDesc =
      detailData.full_description || market.full_description || market.description || "";
    const deadline = detailData.deadline || market.deadline || "";
    const service  = detailData.service  || market.service  || "";
    const cpvCodes = detailData.cpv_codes || market.cpv_codes || "";

    // ── 3. Claude relevance analysis ─────────────────────────
    const analysisPrompt = `Voici un marché public luxembourgeois à analyser :

TITRE : ${market.title}
RÉFÉRENCE : ${market.reference || ""}
PROCÉDURE : ${market.procedure || ""}
CATÉGORIE : ${market.category || ""}
CODES CPV : ${cpvCodes}
AUTORITÉ CONTRACTANTE : ${market.contracting_authority || ""}
SERVICE : ${service}
DATE LIMITE : ${deadline}
LOTS : ${market.lots || "Non"}
DESCRIPTION COMPLÈTE :
${fullDesc.slice(0, 5000)}

---
${COMPANY_PROFILE}
---

Analyse ce marché et réponds en JSON avec exactement ces champs :
{
  "is_relevant": true/false,
  "relevance_score": 0-100,
  "relevance_reason": "Explication concise en 2-3 phrases pourquoi pertinent ou non",
  "key_requirements": ["compétence1", "compétence2"],
  "matching_consultants": ["JFD", "SKH"],
  "market_type": "type de mission en quelques mots"
}`;

    const analysisResp = await claude.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system:
        "Tu es un expert en appels d'offres IT pour Agilos. Réponds UNIQUEMENT en JSON valide, sans markdown ni texte autour.",
      messages: [{ role: "user", content: analysisPrompt }],
    });

    let analysis: Record<string, unknown> = {
      is_relevant: false,
      relevance_score: 0,
      relevance_reason: "Erreur d'analyse",
    };

    try {
      let raw = (analysisResp.content[0] as { text: string }).text.trim();
      raw = raw.replace(/^```(?:json)?/, "").replace(/```$/, "").trim();
      analysis = JSON.parse(raw);
    } catch (e) {
      console.error("JSON parse error:", e);
    }

    await supabase.from("markets").update({
      is_relevant:          analysis.is_relevant,
      relevance_score:      analysis.relevance_score,
      relevance_reason:     analysis.relevance_reason,
      key_requirements:     analysis.key_requirements,
      matching_consultants: analysis.matching_consultants,
      market_type:          analysis.market_type,
      status:               "analyzed",
    }).eq("id", id);

    // ── 4. Auto-generate RFP if relevant ─────────────────────
    if (analysis.is_relevant) {
      const today  = new Date().toLocaleDateString("fr-BE");
      const reqs   = Array.isArray(analysis.key_requirements)
        ? (analysis.key_requirements as string[]).join(", ") : "";
      const consu  = Array.isArray(analysis.matching_consultants)
        ? (analysis.matching_consultants as string[]).join(", ") : "";

      const rfpPrompt = `Génère une réponse professionnelle à cet appel d'offres public pour la société Agilos.

MARCHÉ :
Titre       : ${market.title}
Référence   : ${market.reference || ""}
Catégorie   : ${market.category || ""}
Autorité    : ${market.contracting_authority || ""}
Service     : ${service}
Date limite : ${deadline}
Codes CPV   : ${cpvCodes}
Lots        : ${market.lots || "Non"}
Lien        : ${market.resolved_url || ""}

DESCRIPTION :
${fullDesc.slice(0, 4000)}

ANALYSE :
- Pertinence : ${analysis.relevance_reason}
- Type de mission : ${analysis.market_type || ""}
- Compétences clés : ${reqs}
- Consultants suggérés : ${consu}

---
${COMPANY_PROFILE}
---

Rédige la réponse en Markdown, en français. Agilos est une société de **conseil IT** — nous ne vendons pas de produits ou de solutions logicielles, mais des **prestations de consulting** (profils de consultants, jours/man, livrables). La réponse doit refléter cela.

# RÉPONSE À L'APPEL D'OFFRES
## ${market.title}
**Référence :** ${market.reference || ""}
**Soumis par :** Agilos | **Date :** ${today}

---

## 1. PRÉSENTATION D'AGILOS
[Présentation courte adaptée au contexte — société de conseil IT belge, expertise Data & Analytics, références dans le secteur public luxembourgeois et institutions européennes]

## 2. COMPRÉHENSION DU BESOIN
[Reformuler précisément le besoin exprimé dans l'appel d'offres : contexte client, objectifs, contraintes, livrables attendus par le pouvoir adjudicateur]

## 3. PROFILS ET ÉQUIPE PROPOSÉS
[Pour chaque consultant Agilos proposé, décrire :
- Nom, prénom, rôle dans la mission
- Expertise technique et fonctionnelle spécifique au marché (outils, langages, domaines)
- Années d'expérience, certifications pertinentes
- 2-3 missions similaires avec résultats concrets
- Disponibilité et modalité d'intervention (régie / forfait)]

## 4. PRESTATIONS ET LIVRABLES
[Décrire précisément ce qu'Agilos s'engage à réaliser :
- Liste des livrables concrets (rapports, dashboards, modèles de données, formations, documentations, etc.)
- Activités incluses dans la prestation par phase
- Modalités de transfert de compétences si applicable
NE PAS décrire un outil ou une "solution" — décrire les PRESTATIONS que les consultants vont effectuer]

## 5. MÉTHODOLOGIE ET PLANNING
[Phases de la mission, jalons, livrables par phase, gouvernance, reporting, modalités de suivi]

## 6. RÉFÉRENCES PERTINENTES
[2-3 projets similaires réalisés par Agilos avec résultats mesurables — privilégier les références secteur public ou institutions]

## 7. PROPOSITION COMMERCIALE
| Profil | Rôle | Taux journalier | Jours estimés | Montant |
|--------|------|----------------|---------------|---------|
| [Consultant 1] | [ex: BI Architect] | À définir | À définir | — |
| [Consultant 2] | [ex: ETL Developer] | À définir | À définir | — |
| **TOTAL** | | | | **À définir** |

*Charge et tarifs à préciser selon le cahier des charges définitif et les exigences du pouvoir adjudicateur.*

---
*Document généré automatiquement — à personnaliser et valider avant envoi officiel*`;

      const rfpResp = await claude.messages.create({
        model: MODEL,
        max_tokens: 4096,
        system:
          "Tu es un expert en rédaction de réponses à appels d'offres IT pour Agilos. Rédige un document professionnel, convaincant, adapté au secteur public luxembourgeois.",
        messages: [{ role: "user", content: rfpPrompt }],
      });

      const rfpContent = (rfpResp.content[0] as { text: string }).text.trim();

      await supabase.from("markets").update({
        rfp_content:      rfpContent,
        rfp_generated_at: new Date().toISOString(),
      }).eq("id", id);
    }

    return new Response(
      JSON.stringify({ success: true, is_relevant: analysis.is_relevant }),
      { headers: { ...CORS, "Content-Type": "application/json" } }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("process-market error:", msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
