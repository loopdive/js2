/**
 * <t262-conformance-trend> — test262 pass-rate-over-time chart.
 *
 * Shared by the landing page (website/index.html) and the conformance report
 * (website/public/benchmarks/report.html), which each carried their own copy of
 * this logic — same history files, same point-building, two legends that had
 * already drifted apart.
 *
 *   <t262-conformance-trend
 *     scope="overall|overall+proposal|ES2015|…"
 *     runs-base="./benchmarks/results/runs"  directory holding the index files
 *     height="260">
 *   </t262-conformance-trend>
 *
 * The STANDALONE lane is the primary series: the thick white line with the
 * gradient fill, the point dots and the peak label. The JS-host lane was
 * retired on 2026-10-12 (#6979 S7-e, stakeholder decision recorded in #5385):
 * it is drawn as a subdued, dashed background series that ends at the
 * retirement date, carries no dots or peak label, and is labelled "JS-host
 * lane, retired 2026-10-12" in the legend. There is no lane switch any more
 * (the old `mode` attribute is ignored). A lane is never substituted for the
 * other — a host curve under a "standalone" label is exactly the
 * quietly-wrong number #4362 set out to kill — so a lane with no history is
 * simply absent from the plot and marked "(no history yet)" in the legend.
 *
 * The standalone IR-only lane (overall scope only) is a dotted line under the
 * standalone one: the share of tests that pass with every unit compiled by the
 * IR, no legacy fallback (`ir_only_pass` in standalone-index.json). Runs
 * recorded before the history carried that field have no value, so the line
 * starts at its first measured run instead of ramping up from zero.
 *
 * Requires <trend-chart> (components/trend-chart.js) to be loaded; the data is
 * applied via customElements.whenDefined so load order does not matter.
 */
import { T262_EDITION_SCOPE_RANK, t262IsEditionScope, t262NormalizeEditionLabel } from "./t262-charts.js";

const CONFORMANCE_PROJECT_START = new Date("2026-02-27T00:00:00Z");

// One file per (scope kind × lane). The two lanes are separate FILES rather
// than two series in one file because they are produced by different CI jobs at
// different times — see scripts/append-run-history.mjs.
const LANE_FILES = {
  overall: { host: "index.json", standalone: "standalone-index.json" },
  edition: { host: "editions-index.json", standalone: "standalone-editions-index.json" },
};

const LANE_LABEL = {
  host: "JS-host lane, retired 2026-10-12",
  standalone: "Standalone pass rate",
  irOnly: "Standalone IR-only (no legacy fallback)",
};

// The JS-host test262 lane's last measurement day. Its frozen snapshot is
// still published (scripts/preserve-frozen-host-baseline.mjs), but no run
// after this date measured it, so the background series stops here instead of
// being carried forward to "now" as if it were still being measured.
export const T262_HOST_LANE_RETIRED_AT = new Date("2026-10-12T23:59:59Z");

const parseRunTimestamp = (value) => {
  const raw = String(value || "");
  if (!raw) return null;
  const isoDate = new Date(raw);
  if (Number.isFinite(isoDate.getTime())) return isoDate;
  const compact = raw.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/);
  if (compact) {
    const [, y, m, d, hh, mm, ss] = compact;
    return new Date(`${y}-${m}-${d}T${hh}:${mm}:${ss}Z`);
  }
  return null;
};

const formatHistoryLabel = (date) =>
  `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

const runsCache = new Map();
const fetchRuns = (url) => {
  if (!runsCache.has(url)) {
    runsCache.set(
      url,
      (async () => {
        try {
          let data;
          if (globalThis.t262ViewState) data = await globalThis.t262ViewState.fetchData(url, "runs");
          else {
            const response = await fetch(url);
            if (!response.ok) return null;
            data = await response.json();
          }
          return Array.isArray(data) ? data : null;
        } catch {
          return null;
        }
      })(),
    );
  }
  return runsCache.get(url);
};

/**
 * Turn a runs[] history array into chart points. `extract(run)` returns
 * `{ pass, total, timestampRaw }` or null to skip the run — that indirection is
 * what lets the same gap-filling / stale-endpoint / sparse-run handling serve
 * the overall history AND one ES edition's slice of an editions index.
 * `minRate` drops runs below that pass rate (a broken run, for a pass-rate
 * lane); `anchorAtProjectStart` starts the line at zero on the project's first
 * day. A lane whose history begins late, such as IR-only, turns both off.
 * Returns null when there isn't enough real data to draw.
 */
export function t262BuildHistoryPoints(runs, extract, { minRate = 5, anchorAtProjectStart = true } = {}) {
  if (!Array.isArray(runs)) return null;

  const extracted = runs
    .map((run) => extract(run))
    .filter((r) => r && Number(r.total ?? 0) > 1 && Number(r.pass ?? 0) >= 0)
    .map((r) => ({ pass: Number(r.pass || 0), total: Number(r.total || 0), timestampRaw: r.timestampRaw }))
    .sort((a, b) => {
      const ta = parseRunTimestamp(a.timestampRaw)?.getTime() ?? Number.POSITIVE_INFINITY;
      const tb = parseRunTimestamp(b.timestampRaw)?.getTime() ?? Number.POSITIVE_INFINITY;
      return ta - tb;
    });

  const rawPoints = extracted
    .map((run) => {
      const ts = String(run.timestampRaw || "");
      const date = parseRunTimestamp(ts);
      return {
        label: date ? formatHistoryLabel(date) : "",
        timestamp: ts,
        time: date?.getTime() ?? 0,
        pass: run.pass,
        total: run.total,
        rate: run.total > 0 ? (run.pass / run.total) * 100 : 0,
      };
    })
    .filter((point) => point.total > 0 && point.rate >= minRate);

  // A run whose corpus suddenly shrank by a quarter is a partial/aborted run,
  // not a conformance cliff — drop it rather than plotting the dive.
  const points = [];
  for (const point of rawPoints) {
    const prev = points.at(-1);
    if (prev && point.total < prev.total * 0.75) continue;
    points.push(point);
  }

  const firstPoint = points[0];
  if (anchorAtProjectStart && firstPoint?.timestamp) {
    const firstDate = new Date(firstPoint.timestamp);
    if (
      Number.isFinite(firstDate.getTime()) &&
      firstDate.getTime() - CONFORMANCE_PROJECT_START.getTime() > 12 * 60 * 60 * 1000
    ) {
      points.unshift({
        label: formatHistoryLabel(CONFORMANCE_PROJECT_START),
        timestamp: CONFORMANCE_PROJECT_START.toISOString(),
        time: CONFORMANCE_PROJECT_START.getTime(),
        pass: 0,
        total: 0,
        rate: 0,
      });
    }
  }

  // Hold the last measured value out to "now" when the newest run is stale, so
  // the line doesn't stop short and imply the project went quiet.
  const lastRun = extracted.at(-1);
  if (lastRun) {
    const ts = String(lastRun.timestampRaw || "");
    const lastRate = lastRun.total > 0 ? (lastRun.pass / lastRun.total) * 100 : 0;
    const lastDate = ts ? new Date(ts) : null;
    const now = new Date();
    if (
      Number.isFinite(lastRate) &&
      lastRate >= minRate &&
      lastDate instanceof Date &&
      Number.isFinite(lastDate.getTime()) &&
      now.getTime() - lastDate.getTime() > 12 * 60 * 60 * 1000
    ) {
      points.push({
        label: formatHistoryLabel(now),
        timestamp: now.toISOString(),
        time: now.getTime(),
        pass: lastRun.pass,
        total: lastRun.total,
        rate: lastRate,
      });
    }
  }

  if (points.length < 2) return null;
  return points;
}

/**
 * Clip a lane's points at `endsAt`: drop everything later and, if anything was
 * dropped, hold the last kept value to exactly `endsAt` so the line ends on the
 * retirement date rather than at its last run. Returns null when fewer than
 * two points remain.
 */
export function t262ClipLaneAt(points, endsAt) {
  if (!Array.isArray(points)) return null;
  const end = endsAt instanceof Date ? endsAt.getTime() : Number(endsAt);
  if (!Number.isFinite(end)) return points;
  const kept = points.filter((point) => point.time <= end);
  const last = kept.at(-1);
  if (last && kept.length < points.length && last.time < end) {
    const date = new Date(end);
    kept.push({ ...last, label: formatHistoryLabel(date), timestamp: date.toISOString(), time: end });
  }
  return kept.length >= 2 ? kept : null;
}

/**
 * Interleave the lanes (`{ seriesKey: points }`) onto one x axis. A given
 * timestamp usually has a value for only one lane, so each lane's last known
 * value is carried forward across the other lanes' points (a step chart of a
 * cumulative measure — the rate holds until the next run says otherwise). A
 * lane stays null BEFORE its first run so <trend-chart> breaks the line instead
 * of drawing a fabricated leading segment, and null AFTER its `endsAt` date (a
 * retired lane is not carried forward to "now").
 */
export function t262MergeConformanceLanes(lanes, { endsAt = {} } = {}) {
  const byTime = new Map();
  for (const [key, points] of Object.entries(lanes)) {
    for (const point of points ?? []) {
      const existing = byTime.get(point.time) ?? {
        label: point.label,
        timestamp: point.timestamp,
        time: point.time,
      };
      existing[key] = point.rate;
      byTime.set(point.time, existing);
    }
  }

  const merged = [...byTime.values()].sort((a, b) => a.time - b.time);
  for (const key of Object.keys(lanes)) {
    const end = endsAt[key] instanceof Date ? endsAt[key].getTime() : null;
    let last = null;
    for (const point of merged) {
      if (end !== null && point.time > end) point[key] = null;
      else if (typeof point[key] === "number") last = point[key];
      else point[key] = last;
    }
  }
  return merged.length >= 2 ? merged : null;
}

class T262ConformanceTrend extends HTMLElement {
  static get observedAttributes() {
    return ["scope", "runs-base", "height"];
  }

  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._renderToken = 0;
    this._built = false;
  }

  connectedCallback() {
    this._build();
    this._queueRender();
  }

  attributeChangedCallback() {
    if (!this.isConnected) return;
    this._build();
    this._queueRender();
  }

  get scope() {
    return this.getAttribute("scope") || "overall";
  }

  _build() {
    if (this._built) return;
    this._built = true;
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; }
        :host([hidden]) { display: none; }
        .chart { display: block; width: 100%; min-height: var(--t262-trend-min-height, 260px); }
        .chart[hidden] { display: none; }
        .legend {
          display: flex;
          flex-wrap: wrap;
          gap: 16px;
          margin-top: 14px;
          font-family: var(--t262-trend-font-mono, monospace);
          font-size: var(--t262-trend-legend-size, 10px);
          color: var(--t262-trend-text-muted, rgba(255, 255, 255, 0.46));
          letter-spacing: 0.04em;
        }
        .item { display: inline-flex; align-items: center; gap: 8px; }
        .item[hidden] { display: none; }
        /* Standalone is the thick white line; the retired JS-host lane is a
           thin, dashed, dim background line. The legend mirrors that
           weighting so the two curves are told apart without a colour key. */
        .swatch { width: 18px; height: 0; border-top: 2px solid rgba(255, 255, 255, 0.9); }
        .item[data-lane="host"] .swatch {
          border-top-width: 1px;
          border-top-style: dashed;
          border-top-color: rgba(255, 255, 255, 0.32);
        }
        .item[data-lane="irOnly"] .swatch {
          border-top-style: dotted;
          border-top-color: rgba(255, 255, 255, 0.75);
        }
        .item[data-lane="standalone"] { color: var(--t262-trend-text, #fff); }
        .item[data-lane="host"] { opacity: 0.7; }
        .item[data-available="false"] { opacity: 0.4; }
        .note { font-size: 0.9em; letter-spacing: 0.02em; }
        .empty {
          font-family: var(--t262-trend-font-mono, monospace);
          font-size: var(--t262-trend-legend-size, 10px);
          color: var(--t262-trend-text-muted, rgba(255, 255, 255, 0.46));
        }
        .empty[hidden] { display: none; }
      </style>
      <trend-chart class="chart" mode="step" x-key="time"></trend-chart>
      <div class="empty" hidden>No conformance history available yet.</div>
      <div class="legend">
        <span class="item" data-lane="standalone" data-available="true">
          <span class="swatch"></span><span class="label"></span><span class="note"></span>
        </span>
        <span class="item" data-lane="irOnly" data-available="true">
          <span class="swatch"></span><span class="label"></span><span class="note"></span>
        </span>
        <span class="item" data-lane="host" data-available="true">
          <span class="swatch"></span><span class="label"></span><span class="note"></span>
        </span>
      </div>
    `;
    this._chart = this.shadowRoot.querySelector("trend-chart");
    this._empty = this.shadowRoot.querySelector(".empty");
    for (const item of this.shadowRoot.querySelectorAll(".item")) {
      item.querySelector(".label").textContent = LANE_LABEL[item.dataset.lane];
    }
  }

  _queueRender() {
    const token = ++this._renderToken;
    queueMicrotask(() => {
      if (token !== this._renderToken) return;
      this._render(token);
    });
  }

  async _render(token) {
    const base = (this.getAttribute("runs-base") || "./benchmarks/results/runs").replace(/\/$/, "");
    const scope = this.scope;
    const isOverallScope = !scope || scope === "overall" || scope === "overall+proposal";
    const files = isOverallScope ? LANE_FILES.overall : LANE_FILES.edition;

    const [hostRuns, standaloneRuns] = await Promise.all([
      fetchRuns(`${base}/${files.host}`),
      fetchRuns(`${base}/${files.standalone}`),
    ]);
    if (token !== this._renderToken) return;

    // An edition scope is CUMULATIVE (#3458): the selected edition plus every
    // earlier one, matching the js-host <t262-edition-bars> accumulation and
    // the landing page's standalone summary. Proposals / Unclassified buckets
    // carry no rank and never contribute.
    const selectedRank = T262_EDITION_SCOPE_RANK.get(t262NormalizeEditionLabel(scope));
    const extract = isOverallScope
      ? (run) => ({ pass: run?.pass, total: run?.total, timestampRaw: run?.timestamp })
      : (run) => {
          if (typeof selectedRank !== "number" || !Array.isArray(run?.editions)) return null;
          let pass = 0;
          let total = 0;
          for (const entry of run.editions) {
            const raw = String(entry?.edition || "");
            if (!t262IsEditionScope(raw)) continue;
            const rank = T262_EDITION_SCOPE_RANK.get(t262NormalizeEditionLabel(raw));
            if (typeof rank !== "number" || rank > selectedRank) continue;
            pass += Number(entry.pass || 0);
            total += Number(entry.total || 0);
          }
          if (total <= 0) return null;
          return { pass, total, timestampRaw: run.timestamp };
        };

    const hostPoints = t262ClipLaneAt(t262BuildHistoryPoints(hostRuns, extract), T262_HOST_LANE_RETIRED_AT);
    const standalonePoints = t262BuildHistoryPoints(standaloneRuns, extract);
    // Only the overall standalone history records `ir_only_pass`.
    const irOnlyPoints = isOverallScope
      ? t262BuildHistoryPoints(
          standaloneRuns,
          (run) =>
            run?.ir_only_pass === undefined
              ? null
              : { pass: run.ir_only_pass, total: run.total, timestampRaw: run.timestamp },
          { minRate: 0, anchorAtProjectStart: false },
        )
      : null;
    const points = t262MergeConformanceLanes(
      { standaloneRate: standalonePoints, irOnlyRate: irOnlyPoints, hostRate: hostPoints },
      { endsAt: { hostRate: T262_HOST_LANE_RETIRED_AT } },
    );

    const lanePoints = { host: hostPoints, standalone: standalonePoints, irOnly: irOnlyPoints };
    for (const item of this.shadowRoot.querySelectorAll(".item")) {
      const lane = item.dataset.lane;
      const available = !!lanePoints[lane];
      item.hidden = lane === "irOnly" && !isOverallScope;
      item.dataset.available = String(available);
      item.querySelector(".note").textContent = available ? "" : "(no history yet)";
    }

    const height = this.getAttribute("height") || "260";
    this._chart.setAttribute("height", height);
    this.style.setProperty("--t262-trend-min-height", `${Number(height) || 260}px`);

    if (!points) {
      this._chart.hidden = true;
      this._empty.hidden = false;
      this._empty.textContent = globalThis.t262ViewState?.read().ir
        ? "IR conformance history is unmeasured or unavailable."
        : "No conformance history available yet.";
      return;
    }
    this._empty.hidden = true;
    this._chart.hidden = false;

    // Standalone is listed FIRST: <trend-chart> attaches its point dots and
    // peak label to seriesDef[0], so the retired host lane gets neither.
    const series = [
      { key: "standaloneRate", color: "#ffffff", fill: true },
      { key: "irOnlyRate", color: "#ffffff", lineWidth: 2, lineOpacity: 0.9, dasharray: "2 3" },
      { key: "hostRate", color: "#ffffff", lineWidth: 1, lineOpacity: 0.32, dasharray: "3 3", background: true },
    ];
    this._chart.setAttribute("labels-key", "label");
    this._chart.setAttribute("series", JSON.stringify(series));

    const applyData = () => {
      if (token !== this._renderToken) return;
      this._chart.data = points;
    };
    if (customElements.get("trend-chart")) applyData();
    else
      customElements
        .whenDefined("trend-chart")
        .then(applyData)
        .catch(() => {});
  }
}

// `typeof customElements.get` is checked because t262-charts.js installs a
// bare `{ define() {} }` shim under Node so its pure helpers stay unit-testable
// (#1777) — importing this module there must not throw.
if (typeof customElements.get !== "function" || !customElements.get("t262-conformance-trend")) {
  customElements.define("t262-conformance-trend", T262ConformanceTrend);
}

export { T262ConformanceTrend };
