// Agilos RFP Automation — Main application
// Requires: config.js (globals), supabase CDN, marked CDN, bootstrap CDN

const { createClient } = window.supabase;
const db = createClient(window.SUPABASE_URL, window.SUPABASE_ANON, {
  db: { schema: "rfp" },
});
window._db = db; // debug: expose globally

// ── State ─────────────────────────────────────────────────────
let markets     = [];
let activeFilter = "all";
let activeCategory = "";
let detailMarketId = null;   // currently open in detail modal
let realtimeSub  = null;

// ── Boot ──────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", async () => {
  setupFilters();
  setupSearch();
  // debug
  const _test = await db.from("markets").select("id").limit(1);
  console.log("DB TEST:", JSON.stringify(_test));
  await loadMarkets();
  await loadStats();
  await loadLastScan();
  subscribeRealtime();
});

// ── Data ──────────────────────────────────────────────────────
async function loadMarkets() {
  let q = db.from("markets").select("*").order("created_at", { ascending: false });
  if (activeFilter === "relevant")     q = q.eq("is_relevant", true);
  else if (activeFilter === "not_relevant") q = q.eq("is_relevant", false);
  else if (activeFilter === "pending") q = q.in("status", ["pending","analyzing"]);
  else if (activeFilter === "rfp")     q = q.not("rfp_content", "is", null);
  if (activeCategory) q = q.eq("category", activeCategory);

  const { data, error } = await q;
  if (error) {
    console.error("loadMarkets error:", error);
    showToast("Erreur chargement : " + (error.message || JSON.stringify(error)), "danger");
    return;
  }
  markets = data ?? [];
  renderMarkets(applySearch(markets));
}

async function loadStats() {
  const [tot, rel, nrel, pend, rfp] = await Promise.all([
    db.from("markets").select("id", { count: "exact", head: true }),
    db.from("markets").select("id", { count: "exact", head: true }).eq("is_relevant", true),
    db.from("markets").select("id", { count: "exact", head: true }).eq("is_relevant", false),
    db.from("markets").select("id", { count: "exact", head: true }).in("status", ["pending","analyzing"]),
    db.from("markets").select("id", { count: "exact", head: true }).not("rfp_content", "is", null),
  ]);
  document.getElementById("stat-total").textContent      = tot.count  ?? 0;
  document.getElementById("stat-relevant").textContent   = rel.count  ?? 0;
  document.getElementById("stat-irrelevant").textContent = nrel.count ?? 0;
  document.getElementById("stat-pending").textContent    = pend.count ?? 0;
  document.getElementById("stat-rfp").textContent        = rfp.count  ?? 0;
}

async function loadLastScan() {
  const { data } = await db.from("portal_scans")
    .select("scanned_at, markets_new")
    .order("scanned_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const el = document.getElementById("last-scan-label");
  if (data) {
    const d = new Date(data.scanned_at);
    el.textContent = `Dernier scan : ${d.toLocaleDateString("fr-BE")} ${d.toLocaleTimeString("fr-BE", { hour:"2-digit", minute:"2-digit" })} (+${data.markets_new} nouveaux)`;
  }
}

// ── Realtime ──────────────────────────────────────────────────
function subscribeRealtime() {
  if (realtimeSub) db.removeChannel(realtimeSub);
  realtimeSub = db.channel("markets-rt")
    .on("postgres_changes", { event: "*", schema: "rfp", table: "markets" }, async (payload) => {
      await loadMarkets();
      await loadStats();
      // Refresh detail modal if it's showing the updated market
      if (detailMarketId && payload.new?.id === detailMarketId) {
        fillDetailModal(payload.new);
      }
    })
    .subscribe();
}

// ── Scanner ───────────────────────────────────────────────────
window.scanPortal = async function () {
  const btn = document.getElementById("btn-scan");
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner-border spinner-border-sm me-1"></span>Scan en cours…`;

  const banner = document.getElementById("scan-banner");
  banner.classList.remove("d-none");
  document.getElementById("scan-status-text").textContent = "Recherche des marchés sur pmp.b2g.etat.lu…";
  document.getElementById("scan-progress-text").textContent = "";

  try {
    // Step 1: Scan the portal
    const scanResp = await callFunction("scan-portal", {});
    if (!scanResp.ok) {
      const err = await scanResp.json().catch(() => ({}));
      throw new Error(err.error || scanResp.statusText);
    }
    const { markets_new, inserted_ids } = await scanResp.json();

    document.getElementById("scan-status-text").textContent =
      `${markets_new} nouveau(x) marché(s) trouvé(s). Analyse en cours…`;

    await loadLastScan();

    if (markets_new === 0) {
      showToast("Aucun nouveau marché depuis le dernier scan.", "info");
      return;
    }

    showToast(`${markets_new} nouveaux marchés ajoutés. Analyse Claude en cours…`, "success");

    // Step 2: Fire-and-forget analysis for each new market (3 concurrently)
    document.getElementById("scan-progress-text").textContent =
      `(0 / ${inserted_ids.length} analysés)`;

    let done = 0;
    const concurrency = 3;
    for (let i = 0; i < inserted_ids.length; i += concurrency) {
      const batch = inserted_ids.slice(i, i + concurrency);
      await Promise.all(batch.map((id) =>
        callFunction("process-market", { market_id: id })
          .then(() => {
            done++;
            document.getElementById("scan-progress-text").textContent =
              `(${done} / ${inserted_ids.length} analysés)`;
          })
          .catch(console.error)
      ));
    }

    document.getElementById("scan-status-text").textContent = "Analyse terminée.";
    document.getElementById("scan-progress-text").textContent = "";
    showToast("Analyse de tous les nouveaux marchés terminée.", "success");

  } catch (err) {
    showToast("Erreur : " + err.message, "danger");
    console.error(err);
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<i class="bi bi-cloud-download me-1"></i>Scanner le portail`;
    setTimeout(() => banner.classList.add("d-none"), 4000);
  }
};

// ── Rendering ─────────────────────────────────────────────────
function renderMarkets(list) {
  const grid  = document.getElementById("markets-grid");
  const empty = document.getElementById("empty-state");
  if (!list.length) { grid.innerHTML = ""; empty.classList.remove("d-none"); return; }
  empty.classList.add("d-none");
  grid.innerHTML = list.map(card).join("");

  grid.querySelectorAll(".market-card").forEach((el) => {
    el.addEventListener("click", () => openDetail(el.dataset.id));
  });
  grid.querySelectorAll("[data-action]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const { action, id } = btn.dataset;
      if (action === "rfp")     showRFP(id);
      if (action === "analyze") triggerAnalysis(id);
      if (action === "delete")  deleteMarket(id);
    });
  });
}

// ── Card helpers ──────────────────────────────────────────────
const CAT_COLOR  = { Travaux: "warning", Services: "primary", Fournitures: "info" };
const PROC_LABEL = { "EU.OUV": "Ouverte EU", "EU.NEG-C": "Négociée EU", "LU.OUV": "Ouverte LU", "SAD-A": "SAD" };

function statusBadge(m) {
  if (m.status === "analyzing") return `<span class="badge bg-warning text-dark"><span class="spinner-grow spinner-grow-sm me-1"></span>Analyse…</span>`;
  if (m.status === "error")     return `<span class="badge bg-danger" title="${esc(m.error_message)}">Erreur</span>`;
  if (m.is_relevant === true)   return `<span class="badge bg-success"><i class="bi bi-check-circle me-1"></i>Pertinent</span>`;
  if (m.is_relevant === false)  return `<span class="badge bg-danger"><i class="bi bi-x-circle me-1"></i>Non pertinent</span>`;
  return `<span class="badge bg-secondary">En attente</span>`;
}

function scoreBar(score) {
  if (score == null) return "";
  const pct   = Math.min(100, Math.max(0, score));
  const color = pct >= 70 ? "success" : pct >= 40 ? "warning" : "danger";
  return `<div class="d-flex align-items-center gap-2 mt-2">
    <div class="progress flex-grow-1" style="height:5px">
      <div class="progress-bar bg-${color}" style="width:${pct}%"></div>
    </div>
    <small class="text-muted fw-bold">${pct}%</small>
  </div>`;
}

function card(m) {
  const catColor   = CAT_COLOR[m.category] ?? "secondary";
  const hasRFP     = !!m.rfp_content;
  const analyzing  = m.status === "analyzing" || m.status === "pending";
  const deadline   = m.deadline
    ? `<div class="small text-danger mt-1"><i class="bi bi-calendar3 me-1"></i>${m.deadline}</div>` : "";
  const authority  = m.contracting_authority
    ? `<div class="small text-muted text-truncate"><i class="bi bi-building me-1"></i>${esc(m.contracting_authority)}</div>` : "";

  return `
    <div class="col-xl-4 col-lg-6">
      <div class="card h-100 border-0 shadow-sm market-card" data-id="${m.id}">
        <div class="card-body pb-2">
          <div class="d-flex justify-content-between align-items-start mb-2 gap-1">
            <span class="badge bg-${catColor} text-dark">${m.category || "—"}</span>
            ${statusBadge(m)}
          </div>
          <h6 class="card-title mb-1 lh-sm fw-semibold" title="${esc(m.title)}">
            ${esc(m.title.length > 90 ? m.title.slice(0, 88) + "…" : m.title)}
          </h6>
          ${authority}
          ${deadline}
          ${m.relevance_reason
            ? `<p class="small text-muted mt-2 mb-0 lh-sm">${esc(m.relevance_reason.slice(0, 110))}…</p>`
            : ""}
          ${scoreBar(m.relevance_score)}
        </div>
        <div class="card-footer bg-transparent border-0 d-flex gap-2 pt-0 pb-3">
          ${analyzing
            ? `<button class="btn btn-sm btn-outline-secondary disabled">
                 <span class="spinner-border spinner-border-sm me-1"></span>En cours
               </button>`
            : `<button class="btn btn-sm btn-outline-primary" data-action="analyze" data-id="${m.id}">
                 <i class="bi bi-arrow-repeat me-1"></i>Ré-analyser
               </button>`
          }
          ${hasRFP
            ? `<button class="btn btn-sm btn-success" data-action="rfp" data-id="${m.id}">
                 <i class="bi bi-file-text me-1"></i>RFP
               </button>`
            : ""}
          <button class="btn btn-sm btn-link text-danger ms-auto p-0" data-action="delete" data-id="${m.id}" title="Supprimer">
            <i class="bi bi-trash3"></i>
          </button>
        </div>
      </div>
    </div>`;
}

// ── Detail modal ──────────────────────────────────────────────
function openDetail(id) {
  const m = markets.find((x) => x.id === id);
  if (!m) return;
  fillDetailModal(m);
  new bootstrap.Modal(document.getElementById("detail-modal")).show();
}

function fillDetailModal(m) {
  detailMarketId = m.id;
  const catColor = CAT_COLOR[m.category] ?? "secondary";
  document.getElementById("d-category").textContent        = m.category || "";
  document.getElementById("d-category").className         = `badge bg-${catColor} text-dark`;
  document.getElementById("d-procedure").textContent       = PROC_LABEL[m.procedure] || m.procedure || "";
  document.getElementById("d-status").innerHTML            = statusBadge(m);
  document.getElementById("d-title").textContent           = m.title;
  document.getElementById("d-authority").textContent       = m.contracting_authority || "—";
  document.getElementById("d-service").textContent         = m.service || "—";
  document.getElementById("d-deadline").textContent        = m.deadline || "—";
  document.getElementById("d-reference").textContent       = m.reference || "—";
  document.getElementById("d-cpv").textContent             = m.cpv_codes || "—";
  document.getElementById("d-description").textContent     = m.full_description || m.description || "—";
  document.getElementById("d-url").href                    = m.resolved_url || "#";
  document.getElementById("d-url").textContent             = m.resolved_url || "—";
  document.getElementById("d-btn-portal").href             = m.resolved_url || "#";

  // Analysis section
  document.getElementById("d-reason").textContent          = m.relevance_reason || "—";
  document.getElementById("d-market-type").textContent     = m.market_type || "—";

  const reqs = m.key_requirements;
  document.getElementById("d-requirements").innerHTML = Array.isArray(reqs) && reqs.length
    ? reqs.map((r) => `<span class="badge bg-light text-dark border me-1 mb-1">${esc(r)}</span>`).join("")
    : "<span class='text-muted'>—</span>";

  const cons = m.matching_consultants;
  document.getElementById("d-consultants").innerHTML = Array.isArray(cons) && cons.length
    ? cons.map((c) => `<span class="badge bg-agilos me-1 mb-1">${esc(c)}</span>`).join("")
    : "<span class='text-muted'>—</span>";

  document.getElementById("d-score").innerHTML = scoreBar(m.relevance_score);

  // RFP button
  const rfpBtn = document.getElementById("d-btn-rfp");
  if (m.rfp_content) rfpBtn.classList.remove("d-none");
  else rfpBtn.classList.add("d-none");

  // Analyze button
  document.getElementById("d-btn-analyze").disabled = m.status === "analyzing";
}

window.reanalyzeFromDetail = function () {
  if (detailMarketId) triggerAnalysis(detailMarketId);
};
window.viewRFPFromDetail = function () {
  if (detailMarketId) showRFP(detailMarketId);
};

// ── RFP viewer ────────────────────────────────────────────────
function showRFP(id) {
  const m = markets.find((x) => x.id === id);
  if (!m?.rfp_content) return;

  document.getElementById("rfp-modal-title").textContent = m.title;
  document.getElementById("rfp-body").innerHTML = marked.parse(m.rfp_content);
  document.getElementById("btn-download-rfp").onclick = () => downloadRFP(m);

  new bootstrap.Modal(document.getElementById("rfp-modal")).show();
}

function downloadRFP(m) {
  const safe = m.title.replace(/[^a-z0-9\s\-]/gi, "_").slice(0, 60).trim();
  const blob = new Blob([m.rfp_content], { type: "text/markdown;charset=utf-8" });
  const a = Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(blob),
    download: `RFP_${m.reference || safe}.md`,
  });
  a.click();
}

// ── Actions ───────────────────────────────────────────────────
async function triggerAnalysis(id) {
  await db.from("markets").update({ status: "analyzing" }).eq("id", id);
  callFunction("process-market", { market_id: id }).catch((e) => {
    console.error(e);
    showToast("Erreur lors de l'analyse", "danger");
  });
}

async function deleteMarket(id) {
  if (!confirm("Supprimer ce marché et son RFP ?")) return;
  await db.from("markets").delete().eq("id", id);
  markets = markets.filter((m) => m.id !== id);
  renderMarkets(applySearch(markets));
  await loadStats();
}

// ── Filters ───────────────────────────────────────────────────
function setupFilters() {
  document.querySelectorAll("[data-filter]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      document.querySelectorAll("[data-filter]").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      activeFilter = btn.dataset.filter;
      await loadMarkets();
    });
  });
  document.getElementById("cat-filter").addEventListener("change", async (e) => {
    activeCategory = e.target.value;
    await loadMarkets();
  });
}

function setupSearch() {
  document.getElementById("search-input").addEventListener("input", () => {
    renderMarkets(applySearch(markets));
  });
}

function applySearch(list) {
  const q = (document.getElementById("search-input")?.value ?? "").toLowerCase().trim();
  if (!q) return list;
  return list.filter((m) =>
    m.title.toLowerCase().includes(q) ||
    (m.contracting_authority ?? "").toLowerCase().includes(q) ||
    (m.description ?? "").toLowerCase().includes(q) ||
    (m.reference ?? "").toLowerCase().includes(q)
  );
}

// ── Utilities ─────────────────────────────────────────────────
function callFunction(name, body) {
  return fetch(`${window.FUNCTIONS_URL}/${name}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: window.SUPABASE_ANON,
      Authorization: `Bearer ${window.SUPABASE_ANON}`,
    },
    body: JSON.stringify(body),
  });
}

function esc(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function showToast(msg, type = "info") {
  const colors = { success: "bg-success", danger: "bg-danger", warning: "bg-warning text-dark", info: "bg-info text-dark" };
  const id = "t" + Date.now();
  document.getElementById("toast-container").insertAdjacentHTML("beforeend", `
    <div id="${id}" class="toast align-items-center text-white ${colors[type] ?? "bg-secondary"} border-0" role="alert">
      <div class="d-flex">
        <div class="toast-body">${esc(msg)}</div>
        <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast"></button>
      </div>
    </div>`);
  const el = document.getElementById(id);
  new bootstrap.Toast(el, { delay: 6000 }).show();
  el.addEventListener("hidden.bs.toast", () => el.remove());
}
