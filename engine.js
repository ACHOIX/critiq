// Board-game model v1.4 rule engine for the browser.
// A line-by-line port of tools/rule_checker.py (predict … evaluate). It is a convenience, not an
// authority: board_game_model.md prevails, and tests/test_site_engine.py checks this file against
// the Python engine on every push. Parameters come from the ```yaml model-parameters``` block.

export const ORDER = ["No", "Maybe", "Yes"];
export const WEAK_ROLES = new Set(["redundant", "inferior substitute"]);
export const GOOD_ROLES = new Set(["empty role", "incremental enhancer", "meaningful alternative"]);

// Python's round(x, n): round half to even on the exact binary value.
// toFixed() already rounds the exact binary value; it differs from Python only on exact ties
// (e.g. 7.125), where Python rounds to even and toFixed rounds away from zero.
export function pyRound(x, n = 0) {
  const exact = Math.abs(x).toFixed(80);
  const [int, frac] = exact.split(".");
  const tail = frac.slice(n);
  if (/^50*$/.test(tail)) {
    const kept = BigInt(int + frac.slice(0, n));
    const even = kept % 2n === 0n ? kept : kept + 1n;
    return Math.sign(x) * Number(even) / 10 ** n;
  }
  return Number(x.toFixed(n));
}

export const fmt2 = (x) => pyRound(x, 2).toFixed(2);

export function predict(p, bgg, sig, iae) {
  const e = p.enjoyment;
  return e.intercept + e.bgg_average * bgg + e.signature * (e.signatures.includes(sig) ? 1 : 0) + e.iae * iae;
}

function erf(x) {
  // Abramowitz–Stegun 7.1.26 is too coarse for 2-dp parity; use a high-precision series/continued fraction.
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  if (x < 3) {
    let sum = x, term = x, n = 0;
    while (Math.abs(term) > 1e-17 * Math.abs(sum)) {
      n += 1;
      term *= -x * x / n;
      sum += term / (2 * n + 1);
    }
    return sign * (2 / Math.sqrt(Math.PI)) * sum;
  }
  // erfc continued fraction for large x
  let f = 0;
  for (let k = 60; k >= 1; k--) f = k / 2 / (x + f);
  const erfc = Math.exp(-x * x) / Math.sqrt(Math.PI) / (x + f);
  return sign * (1 - erfc);
}

export const phi = (z) => 0.5 * (1 + erf(z / Math.SQRT2));

export function probs(p, pred) {
  const e = p.enjoyment;
  return [1 - phi((e.p_top_threshold - pred) / e.residual_sd), phi((e.p_low_threshold - pred) / e.residual_sd)];
}

export function band(p, rating) {
  for (const [lo, label] of p.rating_bands) if (rating >= lo) return label;
  return p.rating_bands[p.rating_bands.length - 1][1];
}

export function confidence(p, maturity, certainty, verified = true) {
  let lvl = p.confidence.matrix[maturity][certainty];
  if (!verified) {
    const order = ["Low", "Medium", "High"];
    lvl = order[Math.max(0, order.indexOf(lvl) - 1)];
  }
  return lvl;
}

export function sessionBurden(p, minutes, weight) {
  const sb = p.session_burden;
  const d = sb.duration_points.find(([lim]) => minutes < lim)[1];
  const t = sb.teach_points.find(([lim]) => weight < lim)[1];
  return d + t;
}

export function coverage(prof, rec) {
  const counts = new Set(String(rec ?? "").replace(/;/g, ",").split(",").map((x) => x.trim().replace(/\+$/, "")).filter(Boolean));
  const g = prof.group_profile;
  let sum = 0;
  for (const c of counts) {
    if (c in g) sum += g[c];
    else if (/^\d+$/.test(c) && Number(c) >= 9) sum += prof.each_9_plus;
  }
  const pct = pyRound(sum, 1);
  const has = (...xs) => xs.some((x) => counts.has(x));
  const fit = has("2", "4") ? "Core" : has("3") ? "Secondary" : has("5", "6") ? "Occasional" : counts.size ? "Rare" : "Unknown";
  return [pct, fit];
}

export function baseAnswer(p, r, boundaryRule = true) {
  const o = p.ownership;
  let a = r >= o.base_yes ? "Yes" : r < o.base_no ? "No" : "Maybe";
  if (boundaryRule && a !== "Maybe" && (Math.abs(r - o.base_yes) < o.boundary_margin || Math.abs(r - o.base_no) < o.boundary_margin)) a = "Maybe";
  return a;
}

const down = (a) => ORDER[Math.max(0, ORDER.indexOf(a) - 1)];
const lower = (a, c) => ORDER[Math.min(ORDER.indexOf(a), ORDER.indexOf(c))];

export function rules(p, inp, rating, applyFriction = true, boundaryRule = true) {
  const o = p.ownership, path = [];
  const base = baseAnswer(p, rating, boundaryRule);
  path.push(`base=${base} (${fmt2(rating)})`);
  let ans = base, blocker = null, fa = false;
  if (applyFriction && inp.friction && rating < o.friction_applies_below) {
    if (inp.mode !== "purchase" && inp.relearning_easy) path.push("friction waived");
    else { ans = down(ans); fa = true; path.push(`friction → ${ans}`); }
  }
  if (inp.alpha_player) { ans = "No"; blocker = "alpha-player"; path.push("alpha-player co-op → No"); }
  const lon = inp.longevity || null, role = inp.role || null;
  if (base === "Maybe" && !fa && !blocker) {
    if (lon === "weak" && WEAK_ROLES.has(role)) { ans = "No"; blocker = "weak longevity + redundant/inferior"; }
    else if (lon === "weak" || WEAK_ROLES.has(role)) ans = "Maybe";
    else if (lon === "strong" || (lon === "adequate" && GOOD_ROLES.has(role))) ans = "Yes";
    else ans = "Maybe";
    path.push(`7 zone (longevity=${lon || "unknown"}, role=${role || "unknown"}) → ${ans}`);
  }
  if (base === "Yes" && !blocker) {
    if (lon === "weak") ans = lower(ans, "Maybe");
    if (WEAK_ROLES.has(role)) ans = lower(ans, "Maybe");
  }
  if (inp.try_again) ans = "Maybe";
  return { ans, base, blocker, fa, path };
}

export function evaluate(p, inp, boundaryRule = true, capApplies = null) {
  const o = p.ownership;
  const rating = inp.rating;
  const { ans, base, blocker, path } = rules(p, inp, rating, true, boundaryRule);
  const covCap = inp.coverage !== null && inp.coverage !== undefined && inp.coverage < o.coverage_cap_pct && !inp.named_group;
  if (inp.mode !== "purchase") return { verdict: covCap ? lower(ans, "Maybe") : ans, base, rules: ans, path, stress: null };
  let stress = null, passed = null;
  if (ans === "No" && !blocker) {
    stress = pyRound(rating + o.u80, 2);
    const sAns = rules(p, inp, stress, false, boundaryRule).ans;
    passed = sAns === "No";
    path.push(`U80 stress ${fmt2(stress)} → ${passed ? "No" : "not No"}`);
  }
  const caps = [];
  if (covCap) caps.push("coverage");
  if (capApplies === null ? inp.calibration_cap : capApplies) caps.push("calibration");
  const conf = inp.confidence, risk = inp.material_risk;
  const route = inp.trial_route && inp.attractive_upside;
  let v;
  if (conf === "Low") v = inp.trial_route ? "TRY FIRST" : "WATCH";
  else if (ans === "Yes") v = (rating < o.blind_buy_floor || conf === "Medium" || risk || caps.length) ? "TRY FIRST" : "BUY";
  else if (ans === "Maybe") v = route ? "TRY FIRST" : "PLAY, DON'T BUY";
  else if (blocker) v = conf === "High" ? "SKIP" : "PLAY, DON'T BUY";
  else if (passed && conf === "High") v = "SKIP";
  else v = route ? "TRY FIRST" : "PLAY, DON'T BUY";
  path.push(`→ ${v}`);
  return { verdict: v, base, rules: ans, path, stress, caps };
}

// Longevity label from the three yes/no checks (spec 6.1).
export function longevityLabel(checks) {
  if (!checks.some((c) => c !== null && c !== undefined)) return null;
  const n = checks.filter(Boolean).length;
  return n === 3 ? "strong" : n === 2 ? "adequate" : "weak";
}

// TRY FIRST trigger (spec 6.3 / reporting contract): Confidence, Risk or Both.
export function tryFirstTrigger(verdict, conf, risk, holds = false) {
  if (verdict !== "TRY FIRST") return "Not applicable";
  const c = conf !== "High", r = Boolean(risk) || holds;
  return c && r ? "Both" : c ? "Confidence" : "Risk";
}

// Ownership case (spec 6.3).
export function ownershipCase(verdict) {
  return verdict === "BUY" ? "Strong" : verdict === "SKIP" ? "Weak" : "Conditional";
}

// Full purchase-mode evaluation from form inputs. Mirrors spec section 11 steps 4 and the rule checker.
export function evaluateGame(p, prof, f) {
  const raw = predict(p, f.bgg, f.signature, f.iae);
  const pred = pyRound(raw, 2);
  const [pTop, pLow] = probs(p, raw);
  const verified = f.ratingsCount !== null && f.ratingsCount !== undefined && f.ratingsCount !== "";
  const conf = confidence(p, f.maturity, f.certainty, verified);
  const burden = sessionBurden(p, f.minutes, f.weight);
  const [cov, fit] = coverage(prof, f.players);
  const friction = burden <= p.ownership.friction_max_burden || Boolean(f.frictionException);
  const [lo, hi] = p.ownership.longevity_window;
  const longevityTriggered = (pred >= lo && pred <= hi) || (pred > hi && f.repetitionWarnings) || (pred < lo && f.roleRescue);
  const longevity = longevityTriggered ? longevityLabel(f.longevityChecks) : null;
  const inp = {
    mode: "purchase", rating: pred, confidence: conf, friction, coverage: cov, longevity, role: f.role || null,
    alpha_player: f.alphaPlayer, material_risk: f.materialRisk, trial_route: f.trialRoute, attractive_upside: f.trialRoute,
    calibration_cap: f.calibrationCap, named_group: f.namedGroup,
  };
  const res = evaluate(p, inp);
  const holds = res.verdict === "TRY FIRST" && (pred < p.ownership.blind_buy_floor || friction || (res.caps || []).length > 0);
  return {
    raw, pred, band: band(p, pred), pTop, pLow, verified, conf, burden, cov, fit, friction, longevityTriggered, longevity,
    ...res, trigger: tryFirstTrigger(res.verdict, conf, f.materialRisk, holds), ownershipCase: ownershipCase(res.verdict),
  };
}
