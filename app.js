// Critiq — front end for the BoardGameCritiq repository.
// Reads the CSV-first research data and board_game_model.md, either from the same checkout (local
// preview) or from the private GitHub repository through the API with a read-only key kept on this
// device. Nothing is written back; locked evaluations still happen through Claude.
import { load as yamlLoad } from "./vendor/js-yaml-4.1.0.mjs";
import * as E from "./engine.js";

const DEFAULT_REPO = "ACHOIX/BoardGameCritiq";
const BRANCH = "main";
const FILES = {
  games: "data/production/03_games.csv",
  snaps: "data/production/04_bgg_snapshots.csv",
  audits: "data/production/09_reviewer_audits.csv",
  profile: "data/production/10_user_profile.csv",
  userGames: "data/production/11_user_games.csv",
  preds: "data/production/13_predictions.csv",
  outcomes: "data/production/14_outcomes.csv",
  pending: "data/production/18_pending_decisions.csv",
  registry: "data/validation/15_prospective_15_registry.csv",
  cases: "data/reproducible_results/candidate_case_results.csv",
  metrics: "data/reproducible_results/candidate_metrics.json",
  model: "board_game_model.md",
};
const KEY_AUTH = "critiq.auth";
const KEY_DRAFT = "critiq.draft";

const main = document.getElementById("main");
let D = null; // loaded data
let SOURCE = null; // { kind: "local" } | { kind: "github", token, repo }

// ------------------------------------------------------------------ small utilities
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const num = (v) => (v === "" || v === null || v === undefined || isNaN(Number(v)) ? null : Number(v));
const truthy = (v) => /^(true|yes)$/i.test(String(v ?? "").trim());
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode: keep in memory only */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};
const dateFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" });
const fmtDate = (s) => { const d = new Date(String(s).slice(0, 10) + "T12:00:00"); return isNaN(d) ? esc(s) : dateFmt.format(d); };
const r2 = (x) => (x === null || x === undefined ? "" : Number(x).toFixed(2));
const stripLead = (t) => { const x = String(t || "").replace(/^(keep|buy) only if:?\s*/i, ""); return x.charAt(0).toUpperCase() + x.slice(1); };
const firstSentence = (t) => { const s = String(t || "").trim(); const m = s.match(/^.+?[.!?](\s|$)/); return m ? m[0].trim() : s; };

function parseCSV(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = []; let row = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = ""; rows.push(row); row = [];
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  const head = rows.shift() || [];
  return rows.filter((r) => r.some((c) => c !== "")).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
}

// ------------------------------------------------------------------ data source
class SourceError extends Error { constructor(kind, msg) { super(msg); this.kind = kind; } }

async function fetchText(path) {
  if (SOURCE.kind === "local") {
    const r = await fetch("../" + path, { cache: "no-store" });
    if (!r.ok) throw new SourceError("missing", `Couldn't read ${path} (${r.status}).`);
    return r.text();
  }
  const [owner, repo] = SOURCE.repo.split("/");
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${BRANCH}`;
  let r;
  try {
    r = await fetch(url, { cache: "no-store", headers: { Authorization: `Bearer ${SOURCE.token}`, Accept: "application/vnd.github.raw", "X-GitHub-Api-Version": "2022-11-28" } });
  } catch {
    throw new SourceError("network", "Couldn't reach GitHub. Check your connection and try again.");
  }
  if (r.status === 401) throw new SourceError("auth", "GitHub rejected this key. Check it was copied in full and hasn't expired.");
  if (r.status === 403 && r.headers.get("x-ratelimit-remaining") === "0") throw new SourceError("network", "GitHub's rate limit was reached. Try again in a few minutes.");
  if (r.status === 404 || r.status === 403) throw new SourceError("auth", `This key can't read ${SOURCE.repo}. Give it access to that repository with Contents set to read-only.`);
  if (!r.ok) throw new SourceError("network", `GitHub returned an error (${r.status}) for ${path}.`);
  return r.text();
}

async function ghApi(method, path, body) {
  const r = await fetch(`https://api.github.com/repos/${SOURCE.repo}${path}`, {
    method, cache: "no-store",
    headers: { Authorization: `Bearer ${SOURCE.token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return r;
}

async function loadRequests() {
  if (SOURCE.kind !== "github") return { list: null, error: "local" };
  try {
    const r = await ghApi("GET", "/issues?labels=evaluate&state=all&per_page=15&sort=created&direction=desc");
    if (r.status === 403 || r.status === 404) return { list: null, error: "permission" };
    if (!r.ok) return { list: null, error: "network" };
    return { list: await r.json(), error: null };
  } catch { return { list: null, error: "network" }; }
}

async function detectLocal() {
  try {
    const r = await fetch("../board_game_model.md", { cache: "no-store" });
    return r.ok && (await r.text()).includes("model-parameters");
  } catch { return false; }
}

async function loadAll() {
  const model = await fetchText(FILES.model); // one request first, so a bad key fails once
  const keys = Object.keys(FILES).filter((k) => k !== "model");
  const texts = await Promise.all(keys.map((k) => fetchText(FILES[k])));
  const raw = Object.fromEntries(keys.map((k, i) => [k, texts[i]]));
  raw.model = model;
  const csv = (k) => parseCSV(raw[k]);

  const md = raw.model;
  const block = md.match(/```yaml model-parameters\n([\s\S]*?)\n```/);
  if (!block) throw new SourceError("missing", "board_game_model.md has no model-parameters block.");
  const P = yamlLoad(block[1]);
  const release = (md.match(/Package release \| \*\*([^*]+)\*\*/) || [])[1] || "";

  const prof = { group_profile: {}, each_9_plus: 0, caps: {}, slots: [] };
  for (const r of csv("profile")) {
    if (r.user_id !== "arnold") continue;
    if (r.setting_type === "group_share") {
      if (r.key === "each_9_plus") prof.each_9_plus = Number(r.value); else prof.group_profile[r.key] = Number(r.value);
    } else if (r.setting_type === "calibration_cap") prof.caps[r.key] = { games: r.value.split("|").map((x) => x.trim()).filter(Boolean), description: r.description };
    else if (r.setting_type === "slot") prof.slots.push(r.key);
  }

  const games = new Map(csv("games").map((g) => [g.game_id, g]));
  const snaps = new Map();
  for (const s of csv("snaps")) {
    const cur = snaps.get(s.game_id);
    if (!cur || String(s.snapshot_date) > String(cur.snapshot_date) || (s.snapshot_date === cur.snapshot_date && s.snapshot_id > cur.snapshot_id)) snaps.set(s.game_id, s);
  }
  const userGames = new Map(csv("userGames").filter((u) => u.user_id === "arnold").map((u) => [u.game_id, u]));
  const preds = csv("preds");
  const rank = { preregistered: 3, "preregistered_legacy_v1.39cl": 2, historical_rescore: 1 };
  const byGame = new Map();
  for (const p of preds) {
    const id = p.game_id || "name:" + p.game;
    if (!byGame.has(id)) byGame.set(id, []);
    byGame.get(id).push(p);
  }
  const current = new Map();
  for (const [id, list] of byGame) {
    list.sort((a, b) => (rank[b.record_type] || 0) - (rank[a.record_type] || 0) || String(b.prediction_date).localeCompare(String(a.prediction_date)) || b.evaluation_id.localeCompare(a.evaluation_id));
    current.set(id, list[0]);
  }
  const outcomes = csv("outcomes");
  const audits = csv("audits");
  return {
    P, prof, release, games, snaps, userGames, preds, byGame, current, outcomes, audits,
    pending: csv("pending"), registry: parseCSV(raw.registry), cases: csv("cases"), metrics: JSON.parse(raw.metrics),
    requests: await loadRequests(), loadedAt: new Date(),
  };
}

// ------------------------------------------------------------------ shared view pieces
const VCLASS = { BUY: "v-BUY", "TRY FIRST": "v-TRY", "PLAY, DON'T BUY": "v-PLAY", SKIP: "v-SKIP", WATCH: "v-WATCH", Yes: "v-Yes", Maybe: "v-Maybe", No: "v-No" };
const verdictTag = (v, big = false) => v ? `<span class="verdict ${big ? "big" : ""} ${VCLASS[v] || ""}"><span class="cube" aria-hidden="true"></span>${esc(v)}</span>` : `<span class="muted">No verdict</span>`;
const COHORT = { preregistered: "Clean lock", "preregistered_legacy_v1.39cl": "Legacy lock (v1.39cl)", historical_rescore: "Diagnostic rescore", retrospective_diagnostic_unlocked: "Unlocked diagnostic", reconstructed_from_prose: "Reconstructed" };

function track(pred, actual) {
  const P = D.P, lo = 4, hi = 10;
  const pos = (x) => Math.max(0, Math.min(100, ((x - lo) / (hi - lo)) * 100));
  const no = P.ownership.base_no, yes = P.ownership.base_yes;
  const w1 = pos(no), w2 = pos(yes) - pos(no), w3 = 100 - pos(yes);
  const ticks = [4, 5, 6, 7, 8, 9, 10].map((t) => `<span style="left:${pos(t)}%">${t}</span>`).join("");
  const label = [pred !== null ? `Predicted ${r2(pred)}` : "", actual !== null ? `your rating ${actual}` : "", `buy thresholds ${no} and ${yes}`].filter(Boolean).join(", ");
  return `<div class="track" role="img" aria-label="${esc(label)}">
    ${pred !== null ? `<div class="marker pred" style="left:${pos(pred)}%"><b>${r2(pred)}</b><span class="disc"></span></div>` : ""}
    <div class="track-bar">
      <div class="track-zone no" style="width:${w1}%">No</div>
      <div class="track-zone maybe" style="width:${w2}%">Maybe</div>
      <div class="track-zone yes" style="width:${w3}%">Yes</div>
    </div>
    ${actual !== null ? `<div class="marker actual" style="left:${pos(actual)}%"><span class="sq"></span></div>` : ""}
    <div class="track-ticks" aria-hidden="true">${ticks}</div>
  </div>
  <div class="track-legend">${pred !== null ? `<span><i class="round"></i>Predicted</span>` : ""}${actual !== null ? `<span><i></i>Your rating ${esc(actual)}</span>` : ""}<span>Zones are the base buy answer: below ${no} No, from ${yes} Yes</span></div>`;
}

function statusOf(gid) {
  const u = D.userGames.get(gid);
  if (!u) return "";
  const rating = u.user_rating;
  if (truthy(u.owned)) return rating ? `Owned, rated ${rating}` : "Owned, not played";
  if (truthy(u.previously_owned)) return rating ? `Previously owned, rated ${rating}` : "Previously owned";
  return rating ? `Played, rated ${rating}` : "";
}

function driverOf(p) {
  const d = [];
  const conf = p.confidence;
  if (truthy(p.friction)) d.push(p.friction_exception_category ? `friction (${p.friction_exception_category})` : "session burden (friction)");
  if (/redundant|inferior/.test(p.collection_role)) d.push(`${p.collection_role} role`);
  if (truthy(p.material_unresolved_risk)) d.push("unresolved risk");
  if (conf && conf !== "High") d.push(`${conf.toLowerCase()} confidence`);
  if (p.longevity === "weak") d.push("weak longevity");
  if (/alpha-player/.test(p.decision_path)) d.push("alpha-player blocker");
  if (!d.length) return p.verdict === "BUY" ? "clears every gate" : "see decision path";
  return d.slice(0, 2).join(" + ");
}

function triggerOf(p) {
  const pred = num(p.predicted_rating);
  const holds = truthy(p.friction) || (pred !== null && pred < D.P.ownership.blind_buy_floor) || /cap/.test(p.decision_path);
  return E.tryFirstTrigger(p.verdict, p.confidence || "High", truthy(p.material_unresolved_risk), holds);
}

const field = (dt, dd) => dd === "" || dd === null || dd === undefined ? "" : `<dt>${esc(dt)}</dt><dd>${dd}</dd>`;
const splitHyp = (t) => String(t || "").split(/(?<=\.)\s+(?=[A-Z])/).filter(Boolean);
const bullets = (t) => { const parts = splitHyp(t); return parts.length > 1 ? `<ul>${parts.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : esc(t); };

// The reporting-contract layout (section 9), as a field-by-field mobile view.
function report(r) {
  const mur = r.mur === null ? "Not assessed" : r.mur ? "Present" : "Absent";
  return `
  <div class="panel hero">
    <h1>${esc(r.name)}</h1>
    <p class="lede">${r.bottomLine}</p>
    <div style="margin-top:14px">${verdictTag(r.verdict, true)}</div>
    ${track(r.pred, r.actual)}
    <div class="trio">
      <div><span>Confidence</span><b>${esc(r.conf || "Not recorded")}</b></div>
      <div><span>Material Unresolved Risk</span><b>${esc(mur)}</b></div>
      <div><span>TRY FIRST Trigger</span><b>${esc(r.trigger)}</b></div>
    </div>
  </div>
  <h2>Summary</h2>
  <dl class="fields">
    ${field("Game", esc(r.name))}
    ${field("Predicted Rating (0-10) + band", r.pred === null ? "Not recorded" : `<span class="num">${r2(r.pred)}</span> ${esc(r.band)}`)}
    ${field("Ownership case + main driver", `${esc(r.ownershipCase)}, ${esc(r.driver)}`)}
    ${field("Confidence (High / Medium / Low)", esc(r.conf || "Not recorded"))}
    ${field("Reason", `<p><b>Why:</b> ${esc(r.why || "Not recorded")}</p><p><b>Risk:</b> ${esc(r.risk || "Not recorded")}</p>`)}
    ${field("Verdict", verdictTag(r.verdict))}
  </dl>
  ${r.fits ? `<h2>Why it fits</h2><div>${bullets(r.fits)}</div>` : ""}
  ${r.fails ? `<h2>Why it may fail</h2><div>${bullets(r.fails)}</div>` : ""}
  ${r.path?.length ? `<h2>Decision path</h2><ol class="path">${r.path.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>` : ""}
  ${r.trial ? `<h2>Trial plan</h2><dl class="fields">
      ${field("Trigger", esc(r.trigger))}
      ${field("Route", esc(r.trial.route || "Not recorded"))}
      ${field("Buy only if", esc(stripLead(r.trial.buyOnlyIf) || "Not recorded"))}
      ${field("Buy hypotheses", bullets(r.trial.buyHyp || "Not recorded"))}
      ${field("Rejection hypotheses", bullets(r.trial.rejHyp || "Not recorded"))}
    </dl>` : ""}`;
}

// ------------------------------------------------------------------ views
let ask = { name: "", exposure: "No", owned: "No", note: "", status: "" };

function requestState(issue) {
  const body = issue.body || "";
  const m = body.match(/Result:\s*(G\d{4})\s+(E[\w-]+)/);
  if (issue.state === "closed" && m) {
    const p = D.preds.find((x) => x.evaluation_id === m[2]);
    return { done: true, gid: m[1], p, text: p ? "" : "Done. Reload to see the result." };
  }
  if (issue.state === "closed") return { done: true, text: issue.state_reason === "not_planned" ? "Cancelled" : "Closed without a result" };
  if ((issue.labels || []).some((l) => l.name === "working")) return { text: "Claude is evaluating it now" };
  if ((issue.labels || []).some((l) => l.name === "waiting")) return { text: "Waiting for your computer to read BGG" };
  return { text: "Waiting for the next hourly run" };
}

function viewHome() {
  const waiting = [...D.current.entries()].filter(([gid, p]) => {
    const u = D.userGames.get(gid);
    return p.record_type === "preregistered" && u && truthy(u.owned) && !u.user_rating;
  }).map(([, p]) => p).sort((a, b) => num(b.predicted_rating) - num(a.predicted_rating));
  const open = D.pending.filter((p) => p.status === "open");
  const R = D.requests || { list: null, error: "local" };
  const known = [...D.games.values()].find((g) => ask.name.trim() && g.name.toLowerCase() === ask.name.trim().toLowerCase());
  const knownPred = known && D.current.get(known.game_id);
  const disabled = R.error === "local" || R.error === "permission";

  return `
  <h1>Evaluate a game</h1>
  <p class="lede">Type a game. Claude looks it up on BGG, checks your eight reviewers, compares it with your shelf, and locks a verdict here.</p>
  <form id="ask" class="panel ask" autocomplete="off">
    <div class="field"><label for="a-name">Game</label>
      <input id="a-name" type="text" list="ask-games" data-ask="name" value="${esc(ask.name)}" placeholder="e.g. Brass: Birmingham" required>
      <datalist id="ask-games">${[...D.games.values()].map((g) => `<option value="${esc(g.name)}"></option>`).join("")}</datalist>
      ${knownPred ? `<div class="known small">Already evaluated: ${verdictTag(knownPred.verdict)} at ${r2(num(knownPred.predicted_rating))}, ${fmtDate(knownPred.prediction_date)}. <a href="#/game/${esc(known.game_id)}">Open it</a> or request a fresh evaluation.</div>` : ""}
    </div>
    <div class="grid2">
      <div class="field"><span class="label">Have you played it?</span>${seg("exposure", ["No", "Demoed", "Played"], ask.exposure, {}, "ask")}</div>
      <div class="field"><span class="label">Do you own it?</span>${seg("owned", ["No", "Yes"], ask.owned, {}, "ask")}</div>
    </div>
    <div class="field"><label for="a-note">Anything Claude should know <span class="muted">(optional)</span></label>
      <input id="a-note" type="text" data-ask="note" value="${esc(ask.note)}" placeholder="Edition, where you could try it, who you'd play with"></div>
    <button class="btn" type="submit" ${disabled ? "disabled" : ""}>Evaluate</button>
    ${ask.status ? `<p class="small" role="status" style="margin-top:12px">${ask.status}</p>` : ""}
    ${R.error === "local" ? `<p class="muted small" style="margin-top:12px">Requests work on the hosted site. This preview reads local files only.</p>` : ""}
    ${R.error === "permission" ? `<p class="error small" style="margin-top:12px">Your key can read the model but can't file requests. On GitHub, edit the key, set Issues to Read and write, save, then reload this page.</p>` : ""}
    <p class="muted small" style="margin-top:12px">Claude checks for requests every hour from 7:00 to 23:00 and sends a notification to your phone when the verdict is ready.</p>
  </form>

  ${R.list && R.list.length ? `<h2>Your requests</h2><ul class="list">${R.list.map((i) => {
    const st = requestState(i);
    const name = i.title.replace(/^Evaluate:\s*/i, "");
    if (st.p) return gameRow(st.p);
    return `<li><div class="row"><span class="row-title">${esc(name)}</span><span class="req-state">${fmtDate(i.created_at)}</span><span class="row-sub">${esc(st.text)}</span></div></li>`;
  }).join("")}</ul><div class="btnrow"><button class="btn secondary" type="button" data-action="reload">Check for updates</button></div>` : ""}

  ${waiting.length ? `<h2>Waiting for first play</h2>
  <p class="muted">Locked before you played. Your first game settles the trial question.</p>
  ${waiting.map((p) => `
    <div class="panel">
      <div class="row" style="padding:0"><a class="row-title" href="#/game/${esc(p.game_id)}"><h3>${esc(p.game)}</h3></a><span>${verdictTag(p.verdict)}</span></div>
      ${track(num(p.predicted_rating), null)}
      ${p.buy_only_if ? `<p><b>Keep only if:</b> ${esc(stripLead(p.buy_only_if))}</p>` : ""}
      ${p.trial_route ? `<p class="muted small">${esc(p.trial_route)}</p>` : ""}
    </div>`).join("")}` : ""}
  ${open.length ? `<h2>Open decisions</h2><ul class="list">${open.map((p) => `<li><a class="row" href="#/model"><span class="row-title">${esc(p.topic)}</span><span class="muted">${esc(p.decision_id)}</span><span class="row-sub">Decide ${esc(p.decide_at)}</span></a></li>`).join("")}</ul>` : ""}`;
}

async function submitAsk() {
  const name = ask.name.trim();
  if (!name) { ask.status = "Type the name of a game first."; route(); return; }
  const body = [`Game: ${name}`, `Played or demoed: ${ask.exposure}`, `Owned: ${ask.owned}`, `Note: ${ask.note.trim() || "none"}`, "", "Filed from the Critiq site. Claude: evaluate per board_game_model.md section 11, then add a line `Result: <game_id> <evaluation_id>` to this body and close the issue.", "<!-- critiq-request v1 -->"].join("\n");
  const btn = document.querySelector('#ask button[type="submit"]');
  if (btn) { btn.disabled = true; btn.textContent = "Sending…"; }
  try {
    const r = await ghApi("POST", "/issues", { title: `Evaluate: ${name}`, body, labels: ["evaluate"] });
    if (r.status === 403 || r.status === 404) { ask.status = `<span class="error">Your key can't file requests. On GitHub, edit the key and set Issues to Read and write.</span>`; D.requests = { list: null, error: "permission" }; }
    else if (!r.ok) ask.status = `<span class="error">GitHub returned an error (${r.status}). Try again in a moment.</span>`;
    else {
      const issue = await r.json();
      D.requests = { list: [issue, ...((D.requests && D.requests.list) || [])], error: null };
      ask = { name: "", exposure: "No", owned: "No", note: "", status: `Requested ${esc(name)}. You'll get a notification when the verdict is ready.` };
    }
  } catch { ask.status = `<span class="error">Couldn't reach GitHub. Check your connection and try again.</span>`; }
  route();
}

function gameRow(p) {
  const pred = num(p.predicted_rating);
  const sub = [pred !== null ? E.band(D.P, pred) : "", statusOf(p.game_id), COHORT[p.record_type] || p.record_type].filter(Boolean).join(", ");
  return `<li><a class="row" href="#/game/${esc(p.game_id || "")}">
    <span class="row-title">${esc(p.game)}</span>
    <span class="row-right">${verdictTag(p.verdict)}<span class="num">${pred === null ? "–" : r2(pred)}</span></span>
    <span class="row-sub">${esc(sub)}</span></a></li>`;
}

const GAME_FILTERS = ["All", "BUY", "TRY FIRST", "PLAY, DON'T BUY", "WATCH", "SKIP", "Owned"];
let gameFilter = "All", gameQuery = "";
function viewGames() {
  const all = [...D.current.values()].filter((p) => p.game_id);
  const list = all.filter((p) => {
    if (gameQuery && !p.game.toLowerCase().includes(gameQuery.toLowerCase())) return false;
    if (gameFilter === "All") return true;
    if (gameFilter === "Owned") return truthy(D.userGames.get(p.game_id)?.owned);
    return p.verdict === gameFilter;
  }).sort((a, b) => (num(b.predicted_rating) ?? -1) - (num(a.predicted_rating) ?? -1));
  return `
  <h1>Games</h1>
  <p class="lede">${all.length} games with a prediction. Each shows its current verdict: the latest clean lock, otherwise the legacy lock.</p>
  <input class="search" type="search" placeholder="Search games" aria-label="Search games" value="${esc(gameQuery)}" data-action="game-search">
  <div class="chips" role="group" aria-label="Filter by verdict">${GAME_FILTERS.map((f) => `<button class="chip" type="button" data-action="game-filter" data-value="${esc(f)}" aria-pressed="${f === gameFilter}">${VCLASS[f] ? `<span class="cube ${VCLASS[f]}" aria-hidden="true"></span>` : ""}${esc(f)}</button>`).join("")}</div>
  <p class="muted small">${list.length} shown, sorted by predicted rating</p>
  <ul class="list">${list.map(gameRow).join("") || `<li class="empty">No games match. Clear the search or pick another filter.</li>`}</ul>`;
}

function viewGame(gid) {
  const g = D.games.get(gid);
  const list = D.byGame.get(gid) || [];
  const p = D.current.get(gid);
  const u = D.userGames.get(gid);
  const snap = D.snaps.get(gid);
  if (!g && !p) return `<h1>Not found</h1><p>No game with id ${esc(gid)}.</p><a class="btn secondary" href="#/games">All games</a>`;
  const name = g?.name || p.game;
  const actual = num(u?.user_rating);
  let html = "";
  if (p) {
    const pred = num(p.predicted_rating);
    const murRaw = String(p.material_unresolved_risk || "");
    const mur = /^(true|yes)$/i.test(murRaw) ? true : /^(false|no)$/i.test(murRaw) ? false : null;
    const why = p.key_differentiator || "";
    const risk = p.material_risk_description || p.rejection_hypothesis || "";
    const bottom = `${esc(p.verdict)} at ${r2(pred)} (${esc(pred === null ? "" : E.band(D.P, pred))}), ${esc((p.confidence || "unrecorded").toLowerCase())} confidence. ${esc(firstSentence(risk || why))}`;
    html += report({
      name, pred, actual, band: pred === null ? "" : E.band(D.P, pred), conf: p.confidence, mur, trigger: triggerOf(p),
      ownershipCase: E.ownershipCase(p.verdict), driver: driverOf(p), why, risk, verdict: p.verdict, bottomLine: bottom,
      fits: [p.key_differentiator, p.buy_hypothesis].filter(Boolean).join(" "),
      fails: [p.material_risk_description, p.rejection_hypothesis].filter(Boolean).join(" "),
      path: String(p.decision_path || "").split(/;\s*/).filter(Boolean),
      trial: p.verdict === "TRY FIRST" ? { route: p.trial_route, buyOnlyIf: p.buy_only_if, buyHyp: p.buy_hypothesis, rejHyp: p.rejection_hypothesis } : null,
    });
    const audits = D.audits.filter((a) => a.evaluation_id === p.evaluation_id);
    const found = audits.filter((a) => a.check_status === "REVIEW_FOUND").length;
    html += `<h2>Evidence and calibration</h2>
    <dl class="fields">
      ${field("BGG at prediction", p.bgg_average_at_prediction ? `${esc(p.bgg_average_at_prediction)} from ${p.bgg_ratings_count_at_prediction ? esc(Number(p.bgg_ratings_count_at_prediction).toLocaleString("en-GB")) + " ratings" : "an unverified ratings count"}${p.bgg_source_url ? `, <a href="${esc(p.bgg_source_url)}" rel="noreferrer" target="_blank">source</a>` : ""}` : "Not recorded")}
      ${field("Signature", p.signature ? `${esc(p.signature)}${p.signature_certainty ? `, ${esc(p.signature_certainty)}` : ""}` : "")}
      ${field("IAE", esc(p.IAE))}
      ${field("Evidence maturity", esc(p.evidence_maturity))}
      ${field("Session burden", p.session_burden ? `${esc(p.session_burden)} of 8${truthy(p.friction) ? ", friction" : ""}${p.friction_exception_category ? ` (${esc(p.friction_exception_category)})` : ""}` : "")}
      ${field("Player-count coverage", p.player_count_coverage_pct ? `${esc(p.player_count_coverage_pct)}%, ${esc(p.group_fit)}` : "")}
      ${field("Longevity", truthy(p.longevity_triggered) ? `${esc(p.longevity)} (mastery ${truthy(p.longevity_mastery) ? "yes" : "no"}, variability ${truthy(p.longevity_variability) ? "yes" : "no"}, adaptation ${truthy(p.longevity_adaptation) ? "yes" : "no"})` : esc(p.longevity || "Not triggered"))}
      ${field("Closest substitute", esc(p.closest_substitute))}
      ${field("Collection role", esc(p.collection_role))}
      ${field("Record", `${esc(p.evaluation_id)}, ${esc(COHORT[p.record_type] || p.record_type)}, ${fmtDate(p.prediction_date)}${truthy(p.preregistered_locked) ? ", locked" : ""}${p.record_type === "preregistered" ? (truthy(p.valid_for_prospective_metrics) ? ", counts toward the checkpoint" : ", not counted yet") : ""}`)}
      ${field("Reviewers", audits.length ? `${audits.length} checked, ${found} with a review found` : "No audit recorded for this evaluation")}
    </dl>
    ${p.notes ? `<p class="muted small">${esc(p.notes)}</p>` : ""}
    ${audits.length ? `<div style="margin-top:12px">${audits.map((a) => `<details><summary>${esc(a.reviewer)}: ${a.check_status === "REVIEW_FOUND" ? "review found" : a.check_status === "NO_REVIEW_FOUND" ? "no review found" : esc(a.check_status.toLowerCase())}</summary><div>
      <p>${esc(a.key_findings)}</p>${a.relevance_to_user ? `<p class="muted">${esc(a.relevance_to_user)}</p>` : ""}${a.review_url ? `<p><a href="${esc(a.review_url)}" rel="noreferrer" target="_blank">Open the review</a></p>` : ""}</div></details>`).join("")}</div>` : ""}`;
  } else {
    html += `<div class="panel hero"><h1>${esc(name)}</h1><p class="lede">${esc(statusOf(gid) || "No prediction recorded")}</p>${actual !== null ? track(null, actual) : ""}</div>`;
  }
  if (u) {
    html += `<h2>Your record</h2><dl class="fields">
      ${field("Your rating", esc(u.user_rating || "Not rated yet"))}
      ${field("Owned", truthy(u.owned) ? "Yes" : truthy(u.previously_owned) ? "Previously" : "No")}
      ${field("Buy today", esc(u.buy_today))}
      ${field("Keep today", esc(u.keep_today))}
      ${field("Plays in the last 12 months", esc(u.plays_last_12_months))}
      ${field("Last played", esc(u.last_played_band))}
      ${field("Note", esc(u.ownership_note))}
    </dl>`;
  }
  const outs = D.outcomes.filter((o) => o.game_id === gid);
  if (outs.length) html += `<h2>Outcomes</h2><ul class="list">${outs.map((o) => `<li><div class="row"><span class="row-title">${esc(o.event_type.replace(/_/g, " "))}</span><span class="muted">${fmtDate(o.outcome_date)}</span><span class="row-sub">${esc([o.decision, o.actual_rating ? `rated ${o.actual_rating}` : "", o.notes].filter(Boolean).join(". "))}</span></div></li>`).join("")}</ul>`;
  if (snap) html += `<p class="muted small" style="margin-top:20px">Latest BGG snapshot: ${esc(snap.bgg_average)}${snap.bgg_ratings_count ? ` from ${esc(Number(snap.bgg_ratings_count).toLocaleString("en-GB"))} ratings` : ""}, weight ${esc(snap.bgg_weight)}, ${snap.snapshot_date ? fmtDate(snap.snapshot_date) : "date not recorded"}.</p>`;
  if (list.length > 1) html += `<h2>Earlier predictions</h2><ul class="list">${list.filter((x) => x !== p).map((x) => `<li><div class="row"><span class="row-title">${esc(x.evaluation_id)}</span><span class="row-right">${verdictTag(x.verdict)}<span class="num">${r2(num(x.predicted_rating))}</span></span><span class="row-sub">${esc(COHORT[x.record_type] || x.record_type)}, ${fmtDate(x.prediction_date)}</span></div></li>`).join("")}</ul>`;
  html += `<div class="btnrow"><a class="btn secondary" href="#/evaluate?game=${encodeURIComponent(gid)}">What-if: change the inputs</a></div>`;
  return html;
}

const SHELF_FILTERS = ["Owned", "Not played yet", "Previously owned", "Played, not owned"];
let shelfFilter = "Owned";
function viewShelf() {
  const all = [...D.userGames.values()];
  const pick = {
    "Owned": (u) => truthy(u.owned),
    "Not played yet": (u) => truthy(u.owned) && !u.user_rating,
    "Previously owned": (u) => truthy(u.previously_owned) && !truthy(u.owned),
    "Played, not owned": (u) => !truthy(u.owned) && !truthy(u.previously_owned) && u.user_rating,
  }[shelfFilter];
  const list = all.filter(pick).sort((a, b) => (num(b.user_rating) ?? -1) - (num(a.user_rating) ?? -1) || a.game_name.localeCompare(b.game_name));
  const owned = all.filter((u) => truthy(u.owned));
  return `
  <h1>Shelf</h1>
  <p class="lede">${owned.length} games owned, ${owned.filter((u) => !u.user_rating).length} not played yet.</p>
  <div class="chips" role="group" aria-label="Filter the shelf">${SHELF_FILTERS.map((f) => `<button class="chip" type="button" data-action="shelf-filter" data-value="${esc(f)}" aria-pressed="${f === shelfFilter}">${esc(f)}</button>`).join("")}</div>
  <ul class="list">${list.map((u) => {
    const sub = [u.buy_today ? `buy today ${u.buy_today}` : "", u.keep_today ? `keep ${u.keep_today}` : "", u.plays_last_12_months ? `${u.plays_last_12_months} plays in 12 months` : ""].filter(Boolean).join(", ");
    return `<li><a class="row" href="#/game/${esc(u.game_id)}"><span class="row-title">${esc(u.game_name)}</span>
      <span class="row-right">${u.keep_today ? verdictTag(u.keep_today) : ""}<span class="num">${esc(u.user_rating || "–")}</span></span>
      ${sub ? `<span class="row-sub">${esc(sub.charAt(0).toUpperCase() + sub.slice(1))}</span>` : ""}</a></li>`;
  }).join("") || `<li class="empty">Nothing here.</li>`}</ul>
  <p class="muted small">The cube shows your keep-today answer. Ratings are yours, out of 10.</p>`;
}

function viewModel() {
  const P = D.P, e = P.enjoyment;
  const clean = D.preds.filter((p) => p.record_type === "preregistered");
  const counting = clean.filter((p) => truthy(p.valid_for_prospective_metrics));
  const waiting = clean.filter((p) => !truthy(p.valid_for_prospective_metrics));
  const rated = clean.map((p) => ({ p, a: num(D.userGames.get(p.game_id)?.user_rating) })).filter((x) => x.a !== null);
  const m = D.metrics.metrics || {};
  const open = D.pending.filter((p) => p.status === "open");
  return `
  <h1>Model</h1>
  <p class="lede">Enjoyment model v1.4, frozen: ${e.intercept} + ${e.bgg_average} × BGG average + ${e.signature} × signature + ${e.iae} × IAE.</p>

  <h2>Clean predictions</h2>
  <p><span class="num" style="font-size:28px">${counting.length}</span> of 15 count toward the checkpoint. ${waiting.length ? `${waiting.length} more ${waiting.length === 1 ? "is" : "are"} locked but not counted yet.` : ""}</p>
  <ul class="list">${clean.map((p) => {
    const a = num(D.userGames.get(p.game_id)?.user_rating);
    return `<li><a class="row" href="#/game/${esc(p.game_id)}"><span class="row-title">${esc(p.game)}</span><span class="row-right">${verdictTag(p.verdict)}<span class="num">${r2(num(p.predicted_rating))}</span></span>
      <span class="row-sub">${esc(p.evaluation_id)}, ${truthy(p.valid_for_prospective_metrics) ? "counts" : "not counted yet"}, ${a !== null ? `your rating ${a}` : "no rating yet"}</span></a></li>`;
  }).join("")}</ul>

  <h2>Accuracy on clean predictions</h2>
  ${rated.length ? `<div class="tablewrap"><table><thead><tr><th>Game</th><th>Predicted</th><th>Yours</th><th>Error</th></tr></thead><tbody>${rated.map(({ p, a }) => `<tr><td>${esc(p.game)}</td><td>${r2(num(p.predicted_rating))}</td><td>${a}</td><td>${(a - num(p.predicted_rating)).toFixed(2)}</td></tr>`).join("")}</tbody></table></div>
    <p class="muted small">Error is your rating minus the prediction. Some of these ratings may predate the lock; check each record before reading anything into it.</p>`
    : `<p class="empty">No clean prediction has your rating yet. The first will come from a game waiting for first play.</p>`}

  <h2>Retrospective test</h2>
  <p>The interaction-gap idea, tried on ${esc(D.metrics.coverage?.historical_prediction_pairs ?? D.cases.length)} archived predictions: average error ${esc(m.baseline?.mae?.toFixed(2))} for the archived predictions, ${esc(m.gap?.mae?.toFixed(2))} with the gap penalty.</p>
  <p class="note">Not a validated improvement. The interaction labels were assigned after your ratings were known, so this is exploratory only. Decision recorded: ${esc(D.metrics.decision)}.</p>
  <div class="tablewrap"><table><thead><tr><th>Game</th><th>Yours</th><th>Archived</th><th>Error</th><th>With gap</th><th>Error</th></tr></thead><tbody>
  ${D.cases.map((c) => `<tr><td>${esc(c.game)}</td><td>${esc(Number(c.actual))}</td><td>${r2(num(c.archived_prediction))}</td><td>${r2(num(c.baseline_error))}</td><td>${r2(num(c.gap_prediction))}</td><td>${r2(num(c.gap_error))}</td></tr>`).join("")}
  </tbody></table></div>

  <h2>Open decisions</h2>
  ${open.length ? `<div>${open.map((d) => `<details><summary>${esc(d.decision_id)}: ${esc(d.topic)}</summary><div>
    <p>${esc(d.description)}</p>
    ${d.options ? `<p><b>Options</b></p><ul>${d.options.split(/\s+\|\s+/).map((o) => `<li>${esc(o)}</li>`).join("")}</ul>` : ""}
    <p class="muted small">Affects ${esc(d.affected_records)}. Decide ${esc(d.decide_at)}. Tell Claude your choice and it will be recorded.</p></div></details>`).join("")}</div>`
    : `<p class="empty">No open decisions.</p>`}

  <h2>Thresholds</h2>
  <dl class="fields">
    ${field("Buy answer", `Yes from ${P.ownership.base_yes}, No below ${P.ownership.base_no}, within ${P.ownership.boundary_margin} of a cutoff take the less extreme answer`)}
    ${field("BUY floor", `Predicted ${P.ownership.blind_buy_floor} or higher, High confidence, no unresolved risk`)}
    ${field("Friction", `Session burden ${P.ownership.friction_max_burden} or less, applied below ${P.ownership.friction_applies_below}`)}
    ${field("U80 stress test", `+${P.ownership.u80}`)}
    ${field("Residual SD", e.residual_sd)}
  </dl>

  <h2>This device</h2>
  <p class="muted">${SOURCE.kind === "local" ? "Reading files from this checkout." : `Reading ${esc(SOURCE.repo)} from GitHub with a read-only key stored only in this browser.`} Loaded ${esc(D.loadedAt.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }))}.</p>
  <div class="btnrow"><button class="btn secondary" type="button" data-action="reload">Reload data</button>${SOURCE.kind === "github" ? `<button class="btn secondary" type="button" data-action="forget">Forget key on this device</button>` : ""}</div>`;
}

// ------------------------------------------------------------------ evaluate (what-if)
const SIG_HELP = {
  ECON: "Deep economic or positional game where opponents change your plan and modelling them pays off.",
  COOP: "Co-op built on coordination or inference under limited communication against a demanding system.",
  PRED: "Short game built on out-guessing others, or interactive drafting.",
  NONE: "No clear signature. Use this when unsure, and mark certainty as debatable.",
};
const IAE_ANCHOR = (v) => v >= 9 ? "Constant meaningful pressure from others or the system" : v >= 7 ? "Strong engagement with quieter stretches" : v >= 5 ? "Meaningful response, but much private or low-pressure play" : v >= 3 ? "Mostly private optimisation or weak system pressure" : "Little consequential engagement";
const ROLE_HELP = {
  "": "Not decided yet",
  "empty role": "Nothing you own covers this experience",
  "incremental enhancer": "Expands a game or system you already value",
  "meaningful alternative": "You'd sometimes choose it over the closest game you own",
  redundant: "The game you own would usually win",
  "inferior substitute": "A game you own does this better",
};
const FRICTION_EXC = ["", "setup/teardown", "campaign continuity", "asymmetric relearning", "card/text load", "physical/table space"];
const PLAYER_COUNTS = ["1", "2", "3", "4", "5", "6", "7", "8", "9+"];

function defaultDraft() {
  return { name: "", bgg: "", count: "", weight: "", minutes: "", players: [], signature: "NONE", certainty: "clear", iae: 7, maturity: "established",
    substitute: "", differentiator: "", role: "", frictionException: "", alphaPlayer: false, repetitionWarnings: false, roleRescue: false,
    longevity: [false, false, false], materialRisk: false, riskText: "", trialRoute: true, route: "UNCERTAIN", calibrationCap: false, namedGroup: false };
}
let draft = null;

function prefillFromGame(gid) {
  const g = D.games.get(gid); if (!g) return false;
  const s = D.snaps.get(gid);
  const p = D.current.get(gid);
  draft = { ...defaultDraft(), name: g.name, bgg: s?.bgg_average || p?.bgg_average_at_prediction || "", count: s?.bgg_ratings_count || "", weight: s?.bgg_weight || "",
    minutes: g.playing_time_min || "", players: String(g.bgg_rec_players || "").split(",").map((x) => x.trim()).filter(Boolean).map((x) => Number(x) >= 9 ? "9+" : x) };
  if (p) {
    const b = (v) => truthy(v);
    Object.assign(draft, {
      signature: p.signature || "NONE", certainty: p.signature_certainty || "clear", iae: num(p.IAE) ?? 7,
      maturity: ["established", "thin", "sparse"].includes(p.evidence_maturity) ? p.evidence_maturity : "established",
      substitute: p.closest_substitute || "", differentiator: p.key_differentiator || "",
      role: ["empty role", "incremental enhancer", "meaningful alternative", "redundant", "inferior substitute"].includes(p.collection_role) ? p.collection_role : "",
      frictionException: FRICTION_EXC.includes(p.friction_exception_category) ? p.friction_exception_category : "",
      materialRisk: b(p.material_unresolved_risk), riskText: p.material_risk_description || "",
      longevity: [b(p.longevity_mastery), b(p.longevity_variability), b(p.longevity_adaptation)],
      trialRoute: Boolean(p.trial_route), route: /FULL GAME/.test(p.trial_route) ? "FULL GAME" : /DEMO|demo/.test(p.trial_route) ? "DEMO" : "UNCERTAIN",
      alphaPlayer: /alpha-player/.test(p.decision_path),
    });
  }
  return true;
}

function evalInputs() {
  const players = draft.players.map((x) => (x === "9+" ? "9" : x)).join(",");
  const bgg = num(draft.bgg), minutes = num(draft.minutes), weight = num(draft.weight);
  const missing = [bgg === null && "BGG average", minutes === null && "play time", weight === null && "weight", !draft.players.length && "player counts"].filter(Boolean);
  return { missing, f: { bgg, ratingsCount: num(draft.count), weight, minutes, players, signature: draft.signature, certainty: draft.certainty, iae: Number(draft.iae),
    maturity: draft.maturity, role: draft.role, frictionException: draft.frictionException, alphaPlayer: draft.alphaPlayer, repetitionWarnings: draft.repetitionWarnings,
    roleRescue: draft.roleRescue, longevityChecks: draft.longevity, materialRisk: draft.materialRisk, trialRoute: draft.trialRoute, calibrationCap: draft.calibrationCap, namedGroup: draft.namedGroup } };
}

const seg = (name, options, value, labels = {}, kind = "bind") => `<div class="seg" role="radiogroup">${options.map((o) => `<label><input type="radio" name="${name}" value="${esc(o)}" ${o === value ? "checked" : ""} data-${kind}="${name}"><span>${esc(labels[o] || o)}</span></label>`).join("")}</div>`;
const toggle = (name, label, hint, checked) => `<label class="toggle"><input type="checkbox" data-bind="${name}" ${checked ? "checked" : ""}><span>${esc(label)}${hint ? `<small>${esc(hint)}</small>` : ""}</span></label>`;

function viewEvaluate(params) {
  if (params.get("game") && prefillFromGame(params.get("game"))) store.set(KEY_DRAFT, draft);
  if (!draft) draft = { ...defaultDraft(), ...(store.get(KEY_DRAFT) || {}) };
  const owned = [...D.userGames.values()].filter((u) => truthy(u.owned)).map((u) => u.game_name).sort();
  const capNames = Object.values(D.prof.caps).flatMap((c) => c.games);
  return `
  <h1>What-if</h1>
  <p class="lede">Starts from the model's own inputs for a game. Change one and see how the verdict moves under the frozen v1.4 rules. Nothing is saved.</p>
  <form id="evalform" autocomplete="off" novalidate>
    <fieldset><legend>The game</legend>
      <div class="field"><label for="f-name">Name</label><input id="f-name" type="text" list="known-games" data-bind="name" value="${esc(draft.name)}">
        <datalist id="known-games">${[...D.games.values()].map((g) => `<option value="${esc(g.name)}"></option>`).join("")}</datalist>
        <p class="hint">Pick a known game to load its BGG facts and the model's latest judgments.</p></div>
      <div class="grid2">
        <div class="field"><label for="f-bgg">BGG average</label><input id="f-bgg" type="number" inputmode="decimal" step="0.001" min="1" max="10" data-bind="bgg" value="${esc(draft.bgg)}"></div>
        <div class="field"><label for="f-count">Number of ratings</label><input id="f-count" type="number" inputmode="numeric" min="0" data-bind="count" value="${esc(draft.count)}"></div>
        <div class="field"><label for="f-weight">Weight (1–5)</label><input id="f-weight" type="number" inputmode="decimal" step="0.01" min="1" max="5" data-bind="weight" value="${esc(draft.weight)}"></div>
        <div class="field"><label for="f-min">Play time (minutes)</label><input id="f-min" type="number" inputmode="numeric" min="1" data-bind="minutes" value="${esc(draft.minutes)}"></div>
      </div>
      <p class="hint">Leave the ratings count empty if you couldn't check it; confidence then drops one band.</p>
      <div class="field"><span class="label" id="pc-label">Recommended player counts on BGG</span>
        <div class="seg" role="group" aria-labelledby="pc-label">${PLAYER_COUNTS.map((c) => `<label><input type="checkbox" data-bind="players" value="${c}" ${draft.players.includes(c) ? "checked" : ""}><span>${c}</span></label>`).join("")}</div>
        <p class="hint">Use BGG's recommended counts, not only the best ones.</p></div>
    </fieldset>

    <fieldset><legend>The model's judgments</legend>
      <div class="field"><span class="label">Signature</span>${seg("signature", ["ECON", "COOP", "PRED", "NONE"], draft.signature)}<p class="hint" id="sig-help">${esc(SIG_HELP[draft.signature])}</p></div>
      <div class="field"><span class="label">How sure are you of the signature?</span>${seg("certainty", ["clear", "debatable"], draft.certainty, { clear: "Clear", debatable: "Debatable" })}</div>
      <div class="field"><label for="f-iae">Interaction and engagement (IAE)</label>
        <div class="iae-read"><span class="muted small" id="iae-anchor">${esc(IAE_ANCHOR(Number(draft.iae)))}</span><span class="num" id="iae-val">${esc(draft.iae)}</span></div>
        <input id="f-iae" type="range" min="0" max="10" step="0.5" data-bind="iae" value="${esc(draft.iae)}"></div>
      <div class="field"><span class="label">Evidence maturity</span>${seg("maturity", ["established", "thin", "sparse"], draft.maturity, { established: "Established", thin: "Thin", sparse: "Sparse" })}
        <p class="hint">Established: out two years or about 1,000 ratings, with several real reviews. Thin: new, few post-play reviews. Sparse: previews only.</p></div>
    </fieldset>

    <fieldset><legend>Ownership</legend>
      <div class="field"><label for="f-sub">Closest game you own</label><input id="f-sub" type="text" list="owned-games" data-bind="substitute" value="${esc(draft.substitute)}">
        <datalist id="owned-games">${owned.map((n) => `<option value="${esc(n)}"></option>`).join("")}</datalist>
        <p class="hint">If you wanted this experience tonight, which game you own would you play instead?</p></div>
      <div class="field"><label for="f-diff">What it adds</label><input id="f-diff" type="text" data-bind="differentiator" value="${esc(draft.differentiator)}"></div>
      <div class="field"><label for="f-role">Collection role</label><select id="f-role" data-bind="role">${Object.entries(ROLE_HELP).map(([k, v]) => `<option value="${esc(k)}" ${k === draft.role ? "selected" : ""}>${esc(k ? `${k[0].toUpperCase()}${k.slice(1)}: ${v}` : v)}</option>`).join("")}</select></div>
      <div class="field"><label for="f-fx">Burden the numbers miss</label><select id="f-fx" data-bind="frictionException">${FRICTION_EXC.map((k) => `<option value="${esc(k)}" ${k === draft.frictionException ? "selected" : ""}>${esc(k ? k[0].toUpperCase() + k.slice(1) : "None")}</option>`).join("")}</select>
        <p class="hint">Flags friction even when play time and weight look light.</p></div>
      <div id="longevity-slot"></div>
      <div class="field">
        ${toggle("materialRisk", "There's a specific unresolved risk", "Something plausible that, if confirmed in play, would turn an attractive buy into a pass.", draft.materialRisk)}
        <div id="risk-text" ${draft.materialRisk ? "" : "hidden"}><input type="text" aria-label="Describe the risk" placeholder="Describe the risk" data-bind="riskText" value="${esc(draft.riskText)}"></div>
        ${toggle("trialRoute", "I can try it before buying", "A demo, a friend's copy, BGA or a café.", draft.trialRoute)}
        <div id="route-slot" ${draft.trialRoute ? "" : "hidden"}><div class="field" style="margin-top:4px">${seg("route", ["DEMO", "FULL GAME", "UNCERTAIN"], draft.route, { DEMO: "Demo is enough", "FULL GAME": "Needs a full game", UNCERTAIN: "Not sure" })}</div></div>
        ${toggle("alphaPlayer", "Open-information co-op one player can run", "The alpha-player blocker.", draft.alphaPlayer)}
        ${toggle("calibrationCap", "A calibration note applies", capNames.length ? `Registered for ${capNames.join(", ")}.` : "", draft.calibrationCap)}
        <div id="group-slot"></div>
      </div>
    </fieldset>
  </form>
  <button class="dock" type="button" data-action="to-result" id="dock" aria-controls="result"></button>
  <section id="result" aria-live="polite" style="margin-top:32px"></section>`;
}

function renderEvalResult() {
  const { missing, f } = evalInputs();
  const result = document.getElementById("result");
  const dock = document.getElementById("dock");
  const lonSlot = document.getElementById("longevity-slot");
  const groupSlot = document.getElementById("group-slot");
  if (!result) return;
  if (missing.length) {
    result.innerHTML = `<h2>Result</h2><p class="empty">Add ${esc(missing.join(", "))} to see the verdict.</p>`;
    dock.innerHTML = `<span>Add ${esc(missing[0])}</span>`;
    lonSlot.innerHTML = ""; groupSlot.innerHTML = "";
    return;
  }
  const r = E.evaluateGame(D.P, D.prof, f);
  // Longevity checks only when the rules trigger them (spec 6.1).
  const [lo, hi] = D.P.ownership.longevity_window;
  let lon = "";
  if (r.pred > hi) lon += toggle("repetitionWarnings", "Two or more independent sources warn of repetition", "Above " + hi + " longevity is only checked on such warnings.", draft.repetitionWarnings);
  if (r.pred < lo) lon += toggle("roleRescue", "Its collection role could rescue it", "Below " + lo + " longevity is only checked for a plausible role rescue.", draft.roleRescue);
  if (r.longevityTriggered) lon += `<div class="field"><span class="label">Longevity checks</span>
    ${toggle("lon0", "Mastery", "Repeat play keeps revealing skill.", draft.longevity[0])}
    ${toggle("lon1", "Variability", "Different plays produce different decisions.", draft.longevity[1])}
    ${toggle("lon2", "Adaptation", "You must keep adapting to others or the system.", draft.longevity[2])}</div>`;
  if (lonSlot.dataset.sig !== lon.length + ":" + r.longevityTriggered + ":" + (r.pred > hi) + (r.pred < lo)) { lonSlot.innerHTML = lon; lonSlot.dataset.sig = lon.length + ":" + r.longevityTriggered + ":" + (r.pred > hi) + (r.pred < lo); }
  const needGroup = r.cov < D.P.ownership.coverage_cap_pct;
  const gHtml = needGroup ? toggle("namedGroup", "I have a recurring group for these player counts", `Coverage is ${r.cov}%, under the ${D.P.ownership.coverage_cap_pct}% cap.`, draft.namedGroup) : "";
  if (groupSlot.dataset.on !== String(needGroup)) { groupSlot.innerHTML = gHtml; groupSlot.dataset.on = String(needGroup); }

  const name = draft.name.trim() || "This game";
  const risk = draft.materialRisk ? (draft.riskText.trim() || "Unresolved risk not described yet") : "";
  const why = draft.differentiator.trim() || (draft.substitute ? `Compared with ${draft.substitute}` : "");
  const drivers = [];
  if (r.friction) drivers.push(draft.frictionException ? `friction (${draft.frictionException})` : "session burden (friction)");
  if (/redundant|inferior/.test(draft.role)) drivers.push(`${draft.role} role`);
  if (draft.materialRisk) drivers.push("unresolved risk");
  if (r.conf !== "High") drivers.push(`${r.conf.toLowerCase()} confidence`);
  if (r.pred < D.P.ownership.blind_buy_floor && r.rules === "Yes") drivers.push(`below the ${D.P.ownership.blind_buy_floor} BUY floor`);
  if ((r.caps || []).length) drivers.push(`${r.caps.join(" and ")} cap`);
  const facts = `Session burden ${r.burden} of 8${r.friction ? " (friction)" : ""}, coverage ${r.cov}% (${r.fit}), longevity ${r.longevityTriggered ? (r.longevity || "not checked yet") : "not triggered"}. ${(r.pTop * 100).toFixed(0)}% chance of 8.5 or more, ${(r.pLow * 100).toFixed(0)}% chance of 7 or less.`;
  result.innerHTML = `<p class="note">What-if only. Not a locked prediction and not saved to the model.</p>` + report({
    name, pred: r.pred, actual: null, band: r.band, conf: r.conf, mur: draft.materialRisk, trigger: r.trigger, ownershipCase: r.ownershipCase,
    driver: drivers.slice(0, 2).join(" + ") || (r.verdict === "BUY" ? "clears every gate" : "see decision path"),
    why, risk: risk || "None identified", verdict: r.verdict,
    bottomLine: `${esc(r.verdict)} at ${r2(r.pred)} (${esc(r.band)}), ${esc(r.conf.toLowerCase())} confidence. ${esc(facts)}`,
    path: r.path.map((s) => s.replace(/^→ /, "verdict: ")),
    trial: r.verdict === "TRY FIRST" ? { route: draft.trialRoute ? ({ DEMO: "DEMO: a targeted 30–40 minute test", "FULL GAME": "FULL GAME: the question needs the complete arc", UNCERTAIN: "UNCERTAIN: decide what would resolve it" }[draft.route]) : "No trial route available", buyOnlyIf: "Set in the locked evaluation", buyHyp: draft.differentiator.trim() || "Set in the locked evaluation", rejHyp: risk || "Set in the locked evaluation" } : null,
  }) + `<div class="btnrow"><button class="btn" type="button" data-action="copy-request">Copy request for Claude</button><button class="btn secondary" type="button" data-action="clear-eval">Clear form</button></div>
  <p class="muted small" id="copy-status" role="status"></p>`;
  dock.innerHTML = `<span class="verdict ${VCLASS[r.verdict]}"><span class="cube" aria-hidden="true"></span>${esc(r.verdict)}</span><span class="num">${r2(r.pred)}</span>`;
  dock.setAttribute("aria-label", `${r.verdict}, predicted ${r2(r.pred)}. Show the full result`);
}

function requestText() {
  const { f } = evalInputs();
  const r = E.evaluateGame(D.P, D.prof, f);
  return [
    `Please run a clean, locked v1.4 evaluation of ${draft.name || "this game"} for BoardGameCritiq, with stamped BGG data and the full reviewer audit.`,
    `My what-if on the site gave ${r.verdict} at ${r2(r.pred)} (${r.band}), ${r.conf} confidence. Treat my inputs as a starting point, not as the assessment:`,
    `- BGG ${f.bgg}${f.ratingsCount ? ` from ${f.ratingsCount} ratings` : " (ratings count unchecked)"}, weight ${f.weight}, ${f.minutes} min, recommended at ${draft.players.join(", ")}`,
    `- Signature ${f.signature} (${f.certainty}), IAE ${f.iae}, evidence ${f.maturity}`,
    `- Closest owned game: ${draft.substitute || "not set"}; role: ${draft.role || "not set"}${draft.differentiator ? `; adds: ${draft.differentiator}` : ""}`,
    draft.materialRisk ? `- Unresolved risk: ${draft.riskText || "not described"}` : "- No unresolved risk identified",
    `- Trial route: ${draft.trialRoute ? draft.route : "none"}${draft.frictionException ? `; friction: ${draft.frictionException}` : ""}`,
  ].join("\n");
}

// ------------------------------------------------------------------ unlock screen
function viewUnlock(error) {
  const auth = store.get(KEY_AUTH) || {};
  document.body.classList.add("locked");
  main.innerHTML = `
  <div class="unlock">
    <h1>Critiq</h1>
    <p class="lede">Your board game model lives in a private GitHub repository. Unlock this device with a GitHub key and the site reads the repository directly from GitHub. The key stays in this browser only.</p>
    ${error ? `<p class="error" role="alert">${esc(error)}</p>` : ""}
    <form id="unlock" class="panel">
      <div class="field" style="margin-top:0"><label for="u-key">GitHub key</label><input id="u-key" type="password" autocomplete="off" spellcheck="false" required></div>
      <div class="field"><label for="u-repo">Repository</label><input id="u-repo" type="text" value="${esc(auth.repo || DEFAULT_REPO)}" spellcheck="false"></div>
      <div class="btnrow"><button class="btn" type="submit">Unlock</button></div>
    </form>
    <h2>Make a key</h2>
    <ol>
      <li>On GitHub, open <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noreferrer">Settings, Developer settings, Fine-grained tokens</a>.</li>
      <li>Under Repository access, choose Only select repositories and pick BoardGameCritiq.</li>
      <li>Under Repository permissions, set Contents to Read-only and Issues to Read and write. Leave everything else as No access.</li>
      <li>Pick an expiry, generate the key, and paste it above.</li>
    </ol>
    <p class="muted small">This key can read your model and file evaluation requests, but it can't change your data. To revoke it, delete it on the same GitHub page.</p>
  </div>`;
  document.getElementById("unlock").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const token = document.getElementById("u-key").value.trim();
    const repo = document.getElementById("u-repo").value.trim() || DEFAULT_REPO;
    if (!token) return;
    SOURCE = { kind: "github", token, repo };
    ev.submitter && (ev.submitter.disabled = true, ev.submitter.textContent = "Unlocking…");
    try {
      D = await loadAll();
      store.set(KEY_AUTH, { token, repo });
      document.body.classList.remove("locked");
      route();
    } catch (e) {
      viewUnlock(e.message || String(e));
    }
  });
}

// ------------------------------------------------------------------ router and events
function route() {
  const [path, query = ""] = (location.hash.slice(1) || "/").split("?");
  const params = new URLSearchParams(query);
  const parts = path.split("/").filter(Boolean);
  const tab = parts[0] === "game" || parts[0] === "evaluate" ? "games" : parts[0] || "home";
  document.querySelectorAll(".nav a[data-tab]").forEach((a) => { if (a.dataset.tab === tab) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); });
  let html;
  switch (parts[0]) {
    case undefined: html = viewHome(); document.title = "Evaluate – Critiq"; break;
    case "games": html = viewGames(); document.title = "Games – Critiq"; break;
    case "game": html = viewGame(decodeURIComponent(parts[1] || "")); document.title = `${D.games.get(decodeURIComponent(parts[1] || ""))?.name || "Game"} – Critiq`; break;
    case "evaluate": html = viewEvaluate(params); document.title = "What-if – Critiq"; break;
    case "collection": html = viewShelf(); document.title = "Shelf – Critiq"; break;
    case "model": html = viewModel(); document.title = "Model – Critiq"; break;
    default: html = `<h1>Page not found</h1><p><a class="btn secondary" href="#/">Go home</a></p>`;
  }
  main.innerHTML = html;
  if (parts[0] === "evaluate") { renderEvalResult(); if (params.get("game")) history.replaceState(null, "", "#/evaluate"); }
  window.scrollTo(0, 0);
}

function bindDraft(t) {
  const k = t.dataset.bind;
  if (!k || !draft) return false;
  if (k === "players") draft.players = [...document.querySelectorAll('input[data-bind="players"]:checked')].map((x) => x.value);
  else if (/^lon[012]$/.test(k)) draft.longevity[Number(k[3])] = t.checked;
  else if (t.type === "checkbox") draft[k] = t.checked;
  else draft[k] = t.value;
  if (k === "name") {
    const g = [...D.games.values()].find((x) => x.name.toLowerCase() === t.value.trim().toLowerCase());
    if (g) {
      prefillFromGame(g.game_id);
      store.set(KEY_DRAFT, draft);
      route();
      return true;
    }
  }
  if (k === "signature") document.getElementById("sig-help").textContent = SIG_HELP[t.value];
  if (k === "iae") { document.getElementById("iae-val").textContent = t.value; document.getElementById("iae-anchor").textContent = IAE_ANCHOR(Number(t.value)); }
  if (k === "materialRisk") document.getElementById("risk-text").hidden = !t.checked;
  if (k === "trialRoute") document.getElementById("route-slot").hidden = !t.checked;
  store.set(KEY_DRAFT, draft);
  renderEvalResult();
  return true;
}

main.addEventListener("submit", (ev) => {
  if (ev.target.id === "ask") { ev.preventDefault(); submitAsk(); }
});
main.addEventListener("input", (ev) => {
  const t = ev.target;
  if (t.dataset.ask) {
    ask[t.dataset.ask] = t.value;
    if (t.dataset.ask === "name") {
      const hit = [...D.games.values()].some((g) => g.name.toLowerCase() === t.value.trim().toLowerCase());
      const shown = !!document.querySelector(".known");
      if (hit !== shown) { const pos = t.selectionStart; route(); const n = document.getElementById("a-name"); n.focus(); n.setSelectionRange(pos, pos); }
    }
    return;
  }
  if (t.dataset.action === "game-search") {
    gameQuery = t.value;
    const pos = t.selectionStart;
    main.innerHTML = viewGames();
    const s = main.querySelector('[data-action="game-search"]'); s.focus(); s.setSelectionRange(pos, pos);
    return;
  }
  if (t.dataset.bind && t.type !== "checkbox" && t.type !== "radio") bindDraft(t);
});
main.addEventListener("change", (ev) => {
  const t = ev.target;
  if (t.dataset.ask && t.type === "radio") { ask[t.dataset.ask] = t.value; return; }
  if (t.dataset.bind && (t.type === "checkbox" || t.type === "radio" || t.tagName === "SELECT")) bindDraft(t);
});
main.addEventListener("click", async (ev) => {
  const b = ev.target.closest("[data-action]");
  if (!b) return;
  const a = b.dataset.action;
  if (a === "game-filter") { gameFilter = b.dataset.value; main.innerHTML = viewGames(); main.querySelector(`[data-action="game-filter"][data-value="${CSS.escape(gameFilter)}"]`)?.focus(); }
  if (a === "shelf-filter") { shelfFilter = b.dataset.value; main.innerHTML = viewShelf(); main.querySelector(`[data-action="shelf-filter"][data-value="${CSS.escape(shelfFilter)}"]`)?.focus(); }
  if (a === "to-result") document.getElementById("result")?.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  if (a === "clear-eval") { draft = defaultDraft(); store.del(KEY_DRAFT); route(); }
  if (a === "copy-request") {
    const text = requestText();
    const st = document.getElementById("copy-status");
    try { await navigator.clipboard.writeText(text); st.textContent = "Copied. Paste it into a chat with Claude."; }
    catch { st.innerHTML = `Copy this into a chat with Claude:<textarea readonly rows="8" style="width:100%;margin-top:8px">${esc(text)}</textarea>`; st.querySelector("textarea").select(); }
  }
  if (a === "reload") { b.disabled = true; b.textContent = "Reloading…"; try { D = await loadAll(); route(); } catch (e) { handleLoadError(e); } }
  if (a === "forget") { store.del(KEY_AUTH); store.del(KEY_DRAFT); D = null; SOURCE = null; viewUnlock(); }
});

function handleLoadError(e) {
  if (SOURCE?.kind === "github") { viewUnlock(e.message || String(e)); return; }
  main.innerHTML = `<h1>Couldn't load the model</h1><p class="error">${esc(e.message || e)}</p><button class="btn" type="button" data-action="reload">Try again</button>`;
}

window.addEventListener("hashchange", () => { if (D) route(); });

(async function start() {
  if (await detectLocal()) SOURCE = { kind: "local" };
  else {
    const auth = store.get(KEY_AUTH);
    if (!auth?.token) { viewUnlock(); return; }
    SOURCE = { kind: "github", token: auth.token, repo: auth.repo || DEFAULT_REPO };
  }
  try { D = await loadAll(); route(); } catch (e) { handleLoadError(e); }
})();
