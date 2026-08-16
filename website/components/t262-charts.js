/**
 * Shared web components for test262 conformance charts.
 * Used on both the landing page (index.html) and report page (report.html).
 *
 * Components:
 *   <t262-donut pass="..." fail="..." ce="..." skip="..." total="...">
 *   <t262-edition-bars src="./benchmarks/results/test262-editions.json">
 */

// #1777 — minimal shims so the module's pure edition-timeline helpers can be
// imported and unit-tested under Node (no DOM). In a browser HTMLElement and
// customElements already exist, so these branches never run.
const globalScope = typeof globalThis !== "undefined" ? globalThis : undefined;
if (globalScope && typeof globalScope.HTMLElement === "undefined") {
  globalScope.HTMLElement = class {};
}
if (globalScope && typeof globalScope.customElements === "undefined") {
  globalScope.customElements = { define() {} };
}

/* ── <t262-donut> ─────────────────────────────────────────────── */

class T262Donut extends HTMLElement {
  static get observedAttributes() {
    // #106 — `include-proposals`: when present, read `full_summary` (standard
    //         + annex_b + TC39 proposals) instead of the default `summary`
    //         (current-standard only). Drives the landing-page slider.
    return [
      "pass",
      "fail",
      "ce",
      "skip",
      "total",
      "src",
      "include-sloppy",
      "include-proposals",
      "caption-main",
      "caption-sub",
    ];
  }

  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._renderQueued = false;
    this._renderToken = 0;
    this._raf = 0;
    this._observer = null;
    this._displayState = { deg: 0, pct: 0, passCount: 0 };
    this._hasCompletedIntroAnimation = false;
    this._introMsPerDeg = null;
  }

  connectedCallback() {
    this._queueRender();
  }

  attributeChangedCallback() {
    this._queueRender();
  }

  disconnectedCallback() {
    if (this._raf) {
      cancelAnimationFrame(this._raf);
      this._raf = 0;
    }
    this._observer?.disconnect();
    this._observer = null;
  }

  _queueRender() {
    if (this._renderQueued) return;
    this._renderQueued = true;
    queueMicrotask(() => {
      this._renderQueued = false;
      this._render();
    });
  }

  _applyGaugeState({ tick, valueEl, wrap, glow, passCountEl }, current, target) {
    const safeDeg = Math.max(0, Number(current?.deg ?? 0));
    const safePct = Number(current?.pct ?? 0);
    const safePassCount = Math.max(0, Number(current?.passCount ?? 0));
    const failDeg = Number(target?.failDeg ?? 0);
    const ceDeg = Number(target?.ceDeg ?? 0);

    tick.style.transform = `rotate(${safeDeg}deg)`;
    valueEl.textContent = `${safePct.toFixed(1)}%`;
    if (passCountEl) {
      passCountEl.textContent = Math.round(safePassCount).toLocaleString();
    }

    wrap.style.background =
      "conic-gradient(" +
      "var(--_bg) 0deg 1deg," +
      "rgba(255,255,255,0.06) 1deg," +
      "rgba(255,255,255,0.9) " +
      safeDeg +
      "deg," +
      "rgba(255,255,255,0.06) " +
      safeDeg +
      "deg " +
      (failDeg - 1) +
      "deg," +
      "var(--_bg) " +
      (failDeg - 1) +
      "deg " +
      (failDeg + 1) +
      "deg," +
      "rgba(255,255,255,0.06) " +
      (failDeg + 1) +
      "deg " +
      (ceDeg - 1) +
      "deg," +
      "var(--_bg) " +
      (ceDeg - 1) +
      "deg " +
      (ceDeg + 1) +
      "deg," +
      "rgba(255,255,255,0.06) " +
      (ceDeg + 1) +
      "deg 359deg," +
      "var(--_bg) 359deg 360deg)";

    if (glow) {
      glow.style.background =
        "conic-gradient(" +
        "rgba(255,255,255,0) 0deg," +
        "rgba(255,255,255,0.25) " +
        safeDeg +
        "deg," +
        "rgba(255,255,255,0) " +
        (safeDeg + 1) +
        "deg 360deg)";
    }

    this._displayState = { deg: safeDeg, pct: safePct, passCount: safePassCount };
  }

  async _render() {
    const renderToken = ++this._renderToken;
    let pass = Number(this.getAttribute("pass") || 0);
    let fail = Number(this.getAttribute("fail") || 0);
    let ce = Number(this.getAttribute("ce") || 0);
    let skip = Number(this.getAttribute("skip") || 0);
    let total = Number(this.getAttribute("total") || 0);
    const captionMain = this.getAttribute("caption-main") || "ECMAScript";
    const captionSub = this.getAttribute("caption-sub") || "conformance";

    // Auto-fetch from report JSON if no attributes given
    if (pass === 0 && fail === 0 && ce === 0 && skip === 0) {
      const src = this.getAttribute("src") || "./benchmarks/results/test262-report.json";
      try {
        const resp = await fetch(src);
        if (renderToken !== this._renderToken) return;
        if (!resp.ok) return;
        const report = await resp.json();
        // Default: exclude sloppy-mode-only tests (noStrict).
        // With include-sloppy attribute: show all tests including sloppy.
        const includeSloppy = this.hasAttribute("include-sloppy");
        // #106 — When `include-proposals` is set, switch to `full_summary`
        // (standard + annex_b + TC39 proposals). Otherwise the default
        // `report.summary` already tracks current-standard only (~43k).
        const includeProposals = this.hasAttribute("include-proposals");
        let s;
        if (includeProposals && report?.full_summary) {
          s = report.full_summary;
        } else if (!includeSloppy && report?.no_sloppy_summary) {
          s = report.no_sloppy_summary;
        } else {
          s = report?.summary;
        }
        if (!s) return;
        pass = Number(s.pass ?? 0);
        fail = Number(s.fail ?? 0);
        ce = Number(s.compile_error ?? 0) + Number(s.compile_timeout ?? 0);
        skip = Number(s.skip ?? 0);
        total = pass + fail + ce + skip;
      } catch {
        return;
      }
    }

    if (total <= 0) total = pass + fail + ce + skip;
    if (total <= 0) return;

    const pct = ((pass / total) * 100).toFixed(1);

    const segments = [
      { value: pass, color: "rgba(255,255,255,1)", label: "Pass" },
      { value: fail, color: "rgba(255,255,255,0.2)", label: "Fail" },
      { value: ce, color: "rgba(255,255,255,0.2)", label: "CE" },
      { value: skip, color: "rgba(255,255,255,0.2)", label: "Skipped" },
    ].filter((segment) => segment.value > 0);

    // Build the conic-gradient donut
    const totalSafe = Math.max(total, 1);
    const passDeg = (pass / totalSafe) * 360;
    const failDeg = passDeg + (fail / totalSafe) * 360;
    const ceDeg = failDeg + (ce / totalSafe) * 360;

    // Orbit stats — positioned around the donut.
    // .gauge-orbit padding box is 380 wide × 380 tall (height:360 + padding-top:20).
    // .gauge-core has inset: var(--_donut-top-inset)=45px 0 0, so it spans y=45..380
    // (height 335); the 250px .gauge-wrap is centered in it → donut center
    // y = 45 + 335/2 = 212.5. Horizontally the ring is centered → center x = 190.
    // NOTE: these constants MUST match the orbit-stat anchor
    // (left:50% = 190, top: calc(50% + topInset/2) = 190 + 22.5 = 212.5) so the
    // label deltas (lp - center) land each label exactly on its computed point.
    // They also feed collision detection via the absolute lp positions, so keep
    // them consistent with the real ring center.
    const centerX = 190;
    const centerY = 212.5;
    const orbitPoint = (angle, radius) => {
      const rad = ((angle - 90) * Math.PI) / 180;
      return { x: centerX + Math.cos(rad) * radius, y: centerY + Math.sin(rad) * radius };
    };

    // Keep every annotation on the same orbit. If labels collide, move their
    // angles apart instead of changing their distance from the ring.
    const labelOrbitRadius = 170;
    // The labels occupy a 100px-wide box and two stacked text lines. Use the
    // box diagonal plus a small cushion so a long label such as "Compile
    // Errors" cannot overlap a neighboring label even when their centers are
    // diagonally separated.
    const minLabelDist = 112;
    const minAngularGap = (2 * Math.asin(Math.min(1, minLabelDist / (2 * labelOrbitRadius))) * 180) / Math.PI;
    const normalizeAngle = (angle) => ((angle % 360) + 360) % 360;
    const signedAngleDelta = (from, to) => {
      let delta = normalizeAngle(to - from);
      if (delta > 180) delta -= 360;
      return delta;
    };
    const stats = [
      { value: pass, label: "Passed", color: "rgba(255,255,255,0.9)", angle: passDeg / 2, id: "pass" },
      { value: fail, label: "Failed", color: "rgba(255,255,255,0.7)", angle: (passDeg + failDeg) / 2 },
      { value: ce, label: "Compile Errors", color: "rgba(255,255,255,0.7)", angle: (failDeg + ceDeg) / 2 },
      { value: skip, label: "Skipped", color: "rgba(255,255,255,0.7)", angle: (ceDeg + 360) / 2 },
    ].filter((stat) => stat.value > 0);

    // Spread colliding labels symmetrically around the orbit. At this radius,
    // minAngularGap is the angular separation that produces minLabelDist in
    // straight-line distance, including across the 0°/360° boundary.
    const placed = stats.map((stat) => ({ ...stat }));
    for (let iteration = 0; iteration < 12; iteration++) {
      let moved = false;
      for (let i = 0; i < placed.length; i++) {
        for (let j = i + 1; j < placed.length; j++) {
          const delta = signedAngleDelta(placed[i].angle, placed[j].angle);
          const separation = Math.abs(delta);
          if (separation >= minAngularGap) continue;

          const direction = delta === 0 ? 1 : Math.sign(delta);
          const adjustment = (minAngularGap - separation) / 2;
          placed[i].angle -= direction * adjustment;
          placed[j].angle += direction * adjustment;
          moved = true;
        }
      }
      if (!moved) break;
    }

    for (const stat of placed) {
      stat.lp = orbitPoint(stat.angle, labelOrbitRadius);
    }

    // Label positions are expressed as deltas from the orbit's actual center
    // (left:50%) so they track the donut when the orbit container is narrower
    // than its 380px design width (i.e. on mobile, min(100%, 380px)).
    const makeOrbitStat = (stat) => {
      const { value, label, color, id, lp } = stat;
      const dataAttr = id ? ` data-stat="${id}"` : "";
      const labelDx = lp.x - centerX;
      const labelDy = lp.y - centerY;
      return `
        <div class="orbit-stat" style="left:50%;top:calc(50% + (var(--_donut-top-inset) / 2));transform:translate(calc(-50% + ${labelDx}px), calc(-50% + ${labelDy}px))">
          <div class="orbit-value"${dataAttr} style="color:${color}">${id === "pass" ? "0" : Number(value).toLocaleString()}</div>
          <div class="orbit-label">${label}</div>
        </div>`;
    };

    const orbitHTML = placed.map(makeOrbitStat).join("");

    // Build legend
    const legendHTML = segments
      .map(
        (s) =>
          `<div class="legend-item">
            <span class="legend-dot" style="background:${s.color}"></span>
            ${s.label}
            <span class="legend-count">${s.value.toLocaleString()}</span>
          </div>`,
      )
      .join("");

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          max-width: 100%;
          /* The desktop orbit is intentionally wider than a compact host: its
             pass-count labels can overhang by a few pixels near the 440px
             breakpoint. Keep those labels and the glow visible; the parent
             page owns the viewport-level overflow policy. */
          overflow: visible;
          --_pass: var(--t262-pass, #3fb950);
          --_fail: var(--t262-fail, #f85149);
          --_ce: var(--t262-ce, #d29922);
          --_skip: var(--t262-skip, #8b949e);
          --_text: var(--t262-text, currentColor);
          --_text-muted: var(--t262-text-muted, rgba(139, 148, 158, 1));
          --_bg: var(--t262-bg, #0d1117);
          /* Single source of truth for the donut's top inset. Used BOTH by
             .gauge-core (which pushes the ring down from the top of the orbit
             box) AND by the orbit-stat vertical anchor, so the labels always
             orbit the ring's real center. Because .gauge-core has an asymmetric
             inset (this value on top, 0 on the bottom), the ring center sits
             exactly topInset/2 below the orbit box's 50% line — so the label
             anchor adds that same topInset/2 to stay on the ring. */
          --_donut-top-inset: 45px;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
          color: var(--_text);
        }
        .gauge-orbit {
          position: relative;
          width: min(100%, 380px);
          height: 360px;
          padding-top: 20px;
          margin: 0 auto;
          overflow: visible;
        }
        .gauge-wrap {
          position: relative;
          display: grid;
          place-items: center;
          transform: translateZ(0);
          backface-visibility: hidden;
          margin: 0 auto;
          width: 250px;
          aspect-ratio: 1 / 1;
          border-radius: 50%;
          background: conic-gradient(
            var(--_bg) 0deg 1deg,
            rgba(255,255,255,0.06) 1deg,
            rgba(255,255,255,0.06) ${failDeg - 1}deg,
            var(--_bg) ${failDeg - 1}deg ${failDeg + 1}deg,
            rgba(255,255,255,0.06) ${failDeg + 1}deg ${ceDeg - 1}deg,
            var(--_bg) ${ceDeg - 1}deg ${ceDeg + 1}deg,
            rgba(255,255,255,0.06) ${ceDeg + 1}deg ${359}deg,
            var(--_bg) ${359}deg 360deg
          );
        }
        .gauge-glow {
          position: absolute;
          inset: -8px;
          border-radius: 50%;
          background: conic-gradient(
            rgba(255,255,255,0) 0deg,
            rgba(255,255,255,0) 1deg 360deg
          );
          filter: blur(6px);
          pointer-events: none;
          z-index: 0;
        }
        .gauge-wrap::before {
          content: "";
          position: absolute;
          inset: 22px;
          border-radius: 50%;
          background: var(--_bg);
          border: 1px solid rgba(255,255,255,0.04);
        }
        .pass-tick {
          position: absolute;
          width: 8px;
          height: 68px;
          background: #fff;
          left: calc(50% - 4px);
          top: calc(50% - 135px);
          transform-origin: 4px 135px;
          transform: rotate(0deg);
          z-index: 3;
          clip-path: polygon(35% 0%, 50% -4%, 65% 0%, 95% 100%, 50% 104%, 5% 100%);
          border-radius: 3px;
          filter: drop-shadow(0 0 8px rgba(0,0,0,1));
        }
        .gauge-core {
          position: absolute;
          inset: var(--_donut-top-inset) 0 0;
          display: grid;
          place-items: center;
        }
        .gauge-center {
          position: absolute;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          text-align: center;
          transform: translateY(8px);
        }
        .gauge-value {
          font-size: 2.5rem;
          font-weight: 800;
          line-height: 1;
          color: #fff;
        }
        .gauge-caption {
          margin-top: 0.35rem;
          display: grid;
          gap: 0.05rem;
          justify-items: center;
          color: var(--_text-muted);
        }
        .gauge-caption-main {
          font-size: 0.86rem;
          letter-spacing: 0.08em;
        }
        .gauge-caption-sub {
          font-size: 0.78rem;
          letter-spacing: 0.08em;
        }
        .orbit-stat {
          position: absolute;
          display: grid;
          gap: 0.1rem;
          text-align: center;
          font-variant-numeric: tabular-nums;
          width: 100px;
          transform: translate(-50%, -50%);
        }
        .orbit-value {
          font-size: 0.85rem;
          font-weight: 700;
        }
        .orbit-label {
          font-size: 0.6rem;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          color: var(--_text-muted);
        }
        .legend {
          display: none;
          grid-template-columns: 1fr 1fr;
          gap: 8px 16px;
          margin-top: 24px;
          /* Only shown <440px (see media query). Constrain + auto-center so the
             two-column legend sits centered under the 250px donut instead of
             stretching the full host width. */
          max-width: 320px;
          margin-left: auto;
          margin-right: auto;
        }
        /* Narrow viewports: orbit labels don't fit; rely on the legend below.
           The donut itself is 250px and fits comfortably in ~360px viewports. */
        @media (max-width: 440px) {
          .gauge-orbit {
            height: 280px;
            /* Orbit labels are hidden on mobile, so the top inset that made room
               for them above the ring is no longer needed. Zero it here so the
               250px ring is CENTERED in the 300px padding box (height 280 +
               padding-top 20). Centered leaves ~25px above and below the ring —
               enough for the .gauge-glow (inset:-8px + blur(6px), ≈14px bleed)
               to fully render even when an ancestor clips overflow. This
               override cascades to .gauge-core (a descendant). */
            --_donut-top-inset: 0px;
          }
          .orbit-stat {
            display: none;
          }
          .legend {
            display: grid;
            margin-top: 30px;
            gap: 8px 10px;
          }
        }
        .legend-item {
          display: flex;
          align-items: center;
          gap: 8px;
          font-size: 13px;
          color: var(--_text-muted);
        }
        .legend-dot {
          width: 10px;
          height: 10px;
          border-radius: 50%;
          flex-shrink: 0;
        }
        .legend-count {
          margin-left: auto;
          font-family: "SF Mono", SFMono-Regular, Consolas, monospace;
          font-size: 12px;
        }
      </style>
      <div class="gauge-orbit">
        ${orbitHTML}
        <div class="gauge-core">
          <div class="gauge-wrap">
            <div class="gauge-glow"></div>
            <div class="gauge-center">
              <div class="gauge-value">0.0%</div>
              <div class="gauge-caption">
                <div class="gauge-caption-main">${captionMain}</div>
                <div class="gauge-caption-sub">${captionSub}</div>
              </div>
            </div>
          </div>
          <div class="pass-tick"></div>
        </div>
      </div>
      <div class="legend">
        ${legendHTML}
      </div>
    `;

    if (this._raf) {
      cancelAnimationFrame(this._raf);
      this._raf = 0;
    }
    this._observer?.disconnect();
    this._observer = null;

    const tick = this.shadowRoot.querySelector(".pass-tick");
    const valueEl = this.shadowRoot.querySelector(".gauge-value");
    const wrap = this.shadowRoot.querySelector(".gauge-wrap");
    const glow = this.shadowRoot.querySelector(".gauge-glow");
    const passCountEl = this.shadowRoot.querySelector('[data-stat="pass"]');
    if (!tick || !valueEl || !wrap) return;

    const targetState = {
      deg: passDeg,
      pct: parseFloat(pct),
      passCount: pass,
      failDeg,
      ceDeg,
    };
    const startState = {
      deg: this._displayState?.deg ?? 0,
      pct: this._displayState?.pct ?? 0,
      passCount: this._displayState?.passCount ?? 0,
    };
    this._applyGaugeState({ tick, valueEl, wrap, glow, passCountEl }, startState, targetState);

    const INTRO_DURATION_MS = 3293;
    const angleDelta = Math.abs(targetState.deg - startState.deg);
    const effectiveIntroMsPerDeg = this._introMsPerDeg ?? INTRO_DURATION_MS / Math.max(Math.abs(targetState.deg), 1);
    const duration = this._hasCompletedIntroAnimation ? angleDelta * effectiveIntroMsPerDeg : INTRO_DURATION_MS;
    let start = null;

    const ease = (t) => 1 - (1 - t) * (1 - t); // ease-out quad

    const animate = (ts) => {
      if (!start) start = ts;
      const elapsed = ts - start;
      const progress = Math.min(elapsed / duration, 1);
      const t = ease(progress);

      const currentState = {
        deg: startState.deg + (targetState.deg - startState.deg) * t,
        pct: startState.pct + (targetState.pct - startState.pct) * t,
        passCount: startState.passCount + (targetState.passCount - startState.passCount) * t,
      };
      this._applyGaugeState({ tick, valueEl, wrap, glow, passCountEl }, currentState, targetState);

      if (progress < 1) {
        this._raf = requestAnimationFrame(animate);
      } else {
        this._raf = 0;
        if (!this._hasCompletedIntroAnimation) {
          this._introMsPerDeg = INTRO_DURATION_MS / Math.max(angleDelta, 1);
        }
        this._hasCompletedIntroAnimation = true;
      }
    };

    if (
      Math.abs(targetState.deg - startState.deg) < 0.01 &&
      Math.abs(targetState.pct - startState.pct) < 0.01 &&
      Math.abs(targetState.passCount - startState.passCount) < 0.5
    ) {
      this._applyGaugeState({ tick, valueEl, wrap, glow, passCountEl }, targetState, targetState);
      return;
    }

    // Start animation when element enters viewport
    this._observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            this._observer?.disconnect();
            this._observer = null;
            this._raf = requestAnimationFrame(animate);
          }
        }
      },
      { threshold: 0.3 },
    );
    this._observer.observe(this);
  }
}

customElements.define("t262-donut", T262Donut);

/* ── Shared edition timeline helpers ──────────────────────────── */

const T262_PROPOSAL_LABEL = "Proposals";
const T262_EDITION_SCOPE_RANK = new Map([
  ["ES1", 0],
  ["ES2", 1],
  ["ES3 / Core", 2],
  ["ES5", 3],
  ["ES2015", 4],
  ["ES2016", 5],
  ["ES2017", 6],
  ["ES2018", 7],
  ["ES2019", 8],
  ["ES2020", 9],
  ["ES2021", 10],
  ["ES2022", 11],
  ["ES2023", 12],
  ["ES2024", 13],
  ["ES2025", 14],
  ["ES2026", 15],
  ["ES2027", 16],
]);
const T262_EDITION_RELEASE_YEAR = new Map([
  ["ES1", 1997],
  ["ES2", 1998],
  ["ES3 / Core", 1999],
  ["ES5", 2009],
  ["ES2015", 2015],
  ["ES2016", 2016],
  ["ES2017", 2017],
  ["ES2018", 2018],
  ["ES2019", 2019],
  ["ES2020", 2020],
  ["ES2021", 2021],
  ["ES2022", 2022],
  ["ES2023", 2023],
  ["ES2024", 2024],
  ["ES2025", 2025],
  ["ES2026", 2026],
  ["ES2027", 2027],
]);
const T262_PUBLISHED_EDITION_RELEASE_MONTH = 6;

// #1777 — The current draft / current-standard edition. Mirrors
// CURRENT_DRAFT_EDITION in scripts/generate-editions.ts: the edition generator
// buckets every not-yet-finalized standard-track feature into this year as the
// draft edition (distinct from `Proposals`, which are scope_official === false).
// The timeline must NOT promote the draft year to a published-edition notch
// just because the wall clock has reached its (mid-year) spec freeze — an
// ECMAScript edition is only ratified by the ECMA General Assembly later in its
// year, so the draft stays in the distinct current-standard/proposal tail until
// the following year. Bumping this constant alongside the generator's
// CURRENT_DRAFT_EDITION is the single intentional switch that turns a draft year
// into a published notch.
const T262_CURRENT_DRAFT_EDITION_YEAR = 2027;

function t262IsEditionScope(edition) {
  return (
    edition === "ES1" ||
    edition === "ES2" ||
    edition === "ES3" ||
    edition === "≤ ES3" ||
    edition === "ES5" ||
    /^ES20\d{2}$/.test(edition)
  );
}

function t262NormalizeEditionLabel(edition) {
  return edition === "≤ ES3" || edition === "ES3" ? "ES3 / Core" : edition;
}

function t262EditionReleaseYear(edition) {
  return T262_EDITION_RELEASE_YEAR.get(t262NormalizeEditionLabel(edition)) ?? null;
}

function t262BuildTimelineLayout(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return { segments: [], totalSpan: 0, hasExplicitLegacyBreakdown: false };
  }

  const hasExplicitLegacyBreakdown = rows.some((row) => row.edition === "ES1" || row.edition === "ES2");
  const segments = rows.map((row, index) => {
    const normalizedEdition = t262NormalizeEditionLabel(row.edition);
    const releaseYear = t262EditionReleaseYear(normalizedEdition);
    const startYear = normalizedEdition === "ES3 / Core" && !hasExplicitLegacyBreakdown ? 1997 : (releaseYear ?? index);
    const nextEdition = rows[index + 1]?.edition ?? null;
    const nextReleaseYear = nextEdition ? t262EditionReleaseYear(nextEdition) : null;
    const endYear = Math.max(nextReleaseYear ?? (releaseYear ?? startYear) + 1, startYear + 1);
    return {
      row,
      startYear,
      endYear,
      span: Math.max(endYear - startYear, 1),
    };
  });

  return {
    segments,
    totalSpan: segments.reduce((sum, segment) => sum + segment.span, 0),
    hasExplicitLegacyBreakdown,
  };
}

function t262LegacyStopDefinitions(layout, firstRow) {
  if (!layout || layout.hasExplicitLegacyBreakdown || !firstRow || firstRow.edition !== "ES3 / Core") {
    return [];
  }
  const legacySegment = layout.segments[0];
  if (!legacySegment) return [];
  const start = legacySegment.startYear;
  return [
    { label: "ES1", value: "ES1", position: 0, rawEdition: "ES1" },
    { label: "ES2", value: "ES2", position: Math.max(1998 - start, 0), rawEdition: "ES2" },
    {
      label: "ES3 / Core",
      value: firstRow.rawEdition,
      position: Math.max(1999 - start, 0),
      rawEdition: firstRow.rawEdition,
    },
  ];
}

function t262LegacyActiveEdition(scope, rows, hasExplicitLegacyBreakdown) {
  if (!hasExplicitLegacyBreakdown && rows?.[0]?.edition === "ES3 / Core" && (scope === "ES1" || scope === "ES2")) {
    return "ES3 / Core";
  }
  return null;
}

function t262LegacyLimitRank(scope, rows, hasExplicitLegacyBreakdown) {
  if (!hasExplicitLegacyBreakdown && rows?.[0]?.edition === "ES3 / Core" && (scope === "ES1" || scope === "ES2")) {
    return T262_EDITION_SCOPE_RANK.get("ES3 / Core") ?? null;
  }
  return null;
}

function t262LatestPublishedEditionYear(referenceDate = new Date()) {
  const date = referenceDate instanceof Date && Number.isFinite(referenceDate.getTime()) ? referenceDate : new Date();
  const calendarYear =
    date.getUTCMonth() + 1 >= T262_PUBLISHED_EDITION_RELEASE_MONTH ? date.getUTCFullYear() : date.getUTCFullYear() - 1;
  // #1777 — never treat the current draft edition (or anything newer) as
  // published. The draft year remains in the distinct current-standard/proposal
  // tail; the latest *published* edition is the year before the draft.
  return Math.min(calendarYear, T262_CURRENT_DRAFT_EDITION_YEAR - 1);
}

function t262ResolveLatestPublishedEdition(rows, referenceDate = new Date()) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const publishedYear = t262LatestPublishedEditionYear(referenceDate);
  const publishedRows = rows.filter((row) => {
    const match = /^ES(\d{4})$/.exec(row.edition || "");
    return match ? Number(match[1]) <= publishedYear : false;
  });
  return publishedRows.at(-1) || rows.at(-1) || null;
}

function t262ConformanceCaptionMain(edition) {
  if (edition === "ES1") return "ECMAScript 1";
  if (edition === "ES2") return "ECMAScript 2";
  if (edition === "ES3" || edition === "≤ ES3") return "ECMAScript 3";
  const match = /^ES(\d+)$/.exec(edition || "");
  return match ? `ECMAScript ${match[1]}` : "ECMAScript";
}

function t262DisplayEditionLabel(edition) {
  if (edition === "ES1") return "ES1 1997";
  if (edition === "ES2") return "ES2 1998";
  if (edition === "ES3 / Core" || edition === "ES3") return "ES3 1999";
  if (edition === "ES5") return "ES5 2009";
  if (edition === "ES2015") return "2015";
  return edition;
}

/* ── <t262-edition-timeline> ──────────────────────────────────── */

class T262EditionTimeline extends HTMLElement {
  static get observedAttributes() {
    return ["src", "reference-timestamp", "value", "show-proposals"];
  }

  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._renderQueued = false;
    this._dataPromise = null;
    this._data = null;
    this._currentScope = this.getAttribute("value") || "overall";
    this._lastEmittedScope = null;
    this._sliderListener = () => this._handleSliderInput();
    this._ensureRoot();
  }

  connectedCallback() {
    this._queueRender();
  }

  attributeChangedCallback(name, _oldValue, newValue) {
    if (name === "value") {
      this._setScope(newValue || "overall", { emit: true, reflect: false });
      return;
    }
    if (name === "src") {
      this._dataPromise = null;
      this._data = null;
    }
    this._queueRender();
  }

  get value() {
    return this._currentScope;
  }

  set value(next) {
    this._setScope(next || "overall", { emit: true, reflect: true });
  }

  _ensureRoot() {
    if (this._root) return;
    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          width: 100%;
          color: var(--t262-edition-text, currentColor);
          --_text: var(--t262-edition-text, currentColor);
          --_text-muted: var(--t262-edition-text-muted, rgba(255, 255, 255, 0.46));
        }
        .section {
          width: 100%;
        }
        .head {
          display: flex;
          align-items: baseline;
          justify-content: space-between;
          gap: 1rem;
          margin-bottom: 1rem;
        }
        .title {
          display: block;
          margin-bottom: 0;
          font-family: var(--t262-edition-font-mono, inherit);
          font-size: 11px;
          font-weight: 500;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: var(--_text-muted);
        }
        .value {
          display: none;
          font-family: var(--t262-edition-font-mono, inherit);
          font-size: 13px;
          font-weight: 600;
          color: var(--_text);
          font-variant-numeric: tabular-nums;
        }
        .track {
          position: relative;
          height: 92px;
          --edition-slider-thumb-size: 16px;
          --edition-progress-scale: 0;
          /* #1777 — single source of truth for thumb position. 0..1 fraction in
             the SAME coordinate system as the tick markers and progress fill, so
             the thumb sits exactly on a tick at every snap. Set from JS as
             sliderPosition / fullTimelineSpan. */
          --edition-thumb-fraction: 0;
        }
        /* #1777 — the native range input is the keyboard / pointer hit target
           only; its thumb is transparent. The visible thumb (.thumb) is a sibling
           positioned from --edition-thumb-fraction in track coordinates, which
           removes the per-browser thumb-inset guesswork that caused the thumb to
           drift right of the ticks (the old bleed-widened input mapped a wider
           travel range than the 0..100% tick coordinate system). */
        .slider {
          appearance: none;
          position: absolute;
          left: 0;
          top: 24px;
          width: 100%;
          height: 28px;
          margin: 0;
          outline: none;
          border: 0;
          background: transparent;
          z-index: 5;
          cursor: pointer;
        }
        .slider::-webkit-slider-runnable-track {
          height: 28px;
          border: 0;
          background: transparent;
        }
        .slider::-webkit-slider-thumb {
          appearance: none;
          width: var(--edition-slider-thumb-size);
          height: var(--edition-slider-thumb-size);
          margin-top: 6px;
          border-radius: 50%;
          border: 0;
          background: transparent;
          cursor: pointer;
        }
        .slider::-moz-range-thumb {
          width: var(--edition-slider-thumb-size);
          height: var(--edition-slider-thumb-size);
          border-radius: 50%;
          border: 0;
          background: transparent;
          cursor: pointer;
        }
        .thumb {
          position: absolute;
          top: 24px;
          /* center the thumb on the fraction position (markers use the same
             translateX(-50%) centering at left: <pct>%). */
          left: calc(var(--edition-thumb-fraction) * 100%);
          margin-top: 6px;
          width: var(--edition-slider-thumb-size);
          height: var(--edition-slider-thumb-size);
          transform: translateX(-50%);
          border-radius: 50%;
          border: 1px solid rgba(255, 255, 255, 0.22);
          background: #ffffff;
          box-shadow:
            0 2px 10px rgba(0, 0, 0, 0.28),
            0 0 0 4px rgba(255, 255, 255, 0.08);
          pointer-events: none;
          z-index: 6;
        }
        .slider:focus-visible ~ .thumb {
          box-shadow:
            0 2px 10px rgba(0, 0, 0, 0.28),
            0 0 0 4px rgba(255, 255, 255, 0.08),
            0 0 0 6px rgba(255, 255, 255, 0.12);
        }
        .slider:disabled ~ .thumb {
          opacity: 0.5;
        }
        .slider::-moz-range-track {
          height: 28px;
          background: transparent;
        }
        .slider:focus {
          outline: none;
        }
        /* #1777 — the native thumb is transparent; the visible focus ring +
           disabled dim are applied to the sibling .thumb (see above). */
        .slider:disabled {
          cursor: wait;
        }
        .progress-glow,
        .progress {
          position: absolute;
          left: 0;
          width: 100%;
          border-radius: 999px;
          pointer-events: none;
          transform-origin: left center;
          /* #1777 — fill ends exactly under the thumb (same fraction). */
          transform: scaleX(var(--edition-thumb-fraction, var(--edition-progress-scale)));
        }
        .progress-glow {
          top: 28px;
          height: 20px;
          background: linear-gradient(
            90deg,
            rgba(255, 255, 255, 0.02) 0%,
            rgba(255, 255, 255, 0.08) 52%,
            rgba(255, 255, 255, 0.22) 82%,
            rgba(255, 255, 255, 0.58) 100%
          );
          filter: blur(10px);
          opacity: 1;
          z-index: 1;
        }
        .progress {
          top: 33px;
          height: 10px;
          background: linear-gradient(
            90deg,
            rgba(255, 255, 255, 0.16) 0%,
            rgba(255, 255, 255, 0.28) 48%,
            rgba(255, 255, 255, 0.56) 82%,
            rgba(255, 255, 255, 0.96) 100%
          );
          border: 1px solid rgba(255, 255, 255, 0.18);
          opacity: 0.92;
          z-index: 2;
        }
        .timeline {
          position: absolute;
          left: 0;
          right: 0;
          top: 33px;
          display: flex;
          height: 10px;
          overflow: hidden;
          border-radius: 999px;
          background: rgba(255, 255, 255, 0.14);
          border: 1px solid rgba(255, 255, 255, 0.06);
          pointer-events: none;
          z-index: 0;
        }
        .segment {
          position: relative;
          min-width: 10px;
          background: transparent;
        }
        .segment.dimmed {
          background: rgba(0, 0, 0, 0.34);
        }
        .segment.proposal-tail::before {
          display: none;
        }
        .segment + .segment::before {
          content: "";
          position: absolute;
          top: 0;
          bottom: 0;
          left: 0;
          width: 1px;
          background: rgba(255, 255, 255, 0.06);
        }
        .scale {
          position: absolute;
          left: 0;
          top: 0;
          width: 100%;
          height: 100%;
          pointer-events: none;
          z-index: 4;
        }
        .marker {
          position: absolute;
          transform: translateX(-50%);
          pointer-events: none;
        }
        .line {
          position: absolute;
          left: 50%;
          transform: translateX(-50%);
          width: 1px;
          height: 10px;
          background: rgba(255, 255, 255, 0.18);
        }
        .marker.above {
          top: 0;
        }
        .marker.above .line {
          top: 20px;
          clip-path: inset(0 0 5px 0);
        }
        .marker.below {
          top: 0;
        }
        .marker.below .line {
          top: 38px;
          clip-path: inset(5px 0 0 0);
        }
        .label {
          position: relative;
          font-family: var(--t262-edition-font-mono, inherit);
          font-size: 11px;
          letter-spacing: 0.04em;
          text-transform: uppercase;
          color: var(--_text-muted);
          white-space: nowrap;
        }
        .marker.above .label {
          position: absolute;
          top: 0;
          left: 50%;
          transform: translateX(-50%);
        }
        .marker.below .label {
          position: absolute;
          top: 54px;
          left: 50%;
          transform: translateX(-50%);
        }
        .marker.active .line {
          background: rgba(255, 255, 255, 0.42);
        }
        .marker.active .label {
          color: rgba(255, 255, 255, 0.92);
        }
        .marker.dimmed .line {
          background: rgba(255, 255, 255, 0.08);
        }
        .marker.dimmed .label {
          color: rgba(255, 255, 255, 0.2);
        }
        .copy {
          min-height: 1.2rem;
          margin: 0.7rem 0 0;
          font-size: 12px;
          line-height: 1.6;
          color: var(--_text-muted);
          text-align: left;
        }
        @media (max-width: 640px) {
          .track {
            height: 58px;
          }
          .label {
            display: none;
          }
          .value {
            display: block;
          }
          .copy {
            margin-top: 0.35rem;
          }
        }
      </style>
      <div class="section">
        <div class="head">
          <div class="title">ECMAScript Editions</div>
          <div class="value">Loading…</div>
        </div>
        <div class="track">
          <div class="progress-glow"></div>
          <div class="progress"></div>
          <input class="slider" type="range" min="0" max="1" step="any" value="0" disabled aria-label="ECMAScript edition timeline filter" />
          <div class="thumb" aria-hidden="true"></div>
        </div>
        <p class="copy">Drag to snap to the nearest ECMAScript edition.</p>
      </div>
    `;

    this._root = {
      value: this.shadowRoot.querySelector(".value"),
      track: this.shadowRoot.querySelector(".track"),
      slider: this.shadowRoot.querySelector(".slider"),
      // .thumb is positioned purely via the --edition-thumb-fraction CSS var on
      // .track, so it needs no JS reference — left in the DOM template only.
      copy: this.shadowRoot.querySelector(".copy"),
    };
    this._root.slider.addEventListener("input", this._sliderListener);
    this._root.slider.addEventListener("change", this._sliderListener);
  }

  _queueRender() {
    if (this._renderQueued) return;
    this._renderQueued = true;
    queueMicrotask(async () => {
      this._renderQueued = false;
      await this._render();
    });
  }

  async _loadData() {
    if (!this._dataPromise) {
      const src = this.getAttribute("src") || "./benchmarks/results/test262-editions.json";
      this._dataPromise = (async () => {
        const resp = await fetch(src);
        if (!resp.ok) throw new Error("edition data unavailable");
        const editions = await resp.json();
        if (!Array.isArray(editions) || editions.length === 0) {
          throw new Error("edition data unavailable");
        }

        const rows = editions
          .filter((edition) => t262IsEditionScope(String(edition?.edition || "")))
          .map((edition) => {
            const rawEdition = String(edition.edition || "");
            const normalizedEdition = t262NormalizeEditionLabel(rawEdition);
            return {
              rawEdition,
              edition: normalizedEdition,
              displayLabel: t262DisplayEditionLabel(normalizedEdition),
              pass: Number(edition.pass ?? 0),
              fail: Number(edition.fail ?? 0),
              ce: Number(edition.ce ?? 0),
              skip: Number(edition.skip ?? 0),
              total: Number(edition.total ?? 0),
              rate: Number(edition.pct ?? 0),
              rank: T262_EDITION_SCOPE_RANK.get(normalizedEdition) ?? Number.MAX_SAFE_INTEGER,
            };
          });

        const cumulativeScopes = [];
        const running = { pass: 0, fail: 0, ce: 0, skip: 0, total: 0 };
        rows.forEach((row) => {
          running.pass += row.pass;
          running.fail += row.fail;
          running.ce += row.ce;
          running.skip += row.skip;
          running.total += row.total;
          cumulativeScopes.push({
            value: row.rawEdition,
            label: row.edition,
            captionMain: t262ConformanceCaptionMain(row.rawEdition),
            summary: { ...running },
          });
        });

        return { rows, cumulativeScopes };
      })();
    }
    return this._dataPromise;
  }

  async _render() {
    try {
      this._data = await this._loadData();
      this._syncUI();
      this.dispatchEvent(
        new CustomEvent("edition-ready", {
          detail: this._detail(),
          bubbles: true,
          composed: true,
        }),
      );
      this._emitChange(true);
    } catch {
      this._data = null;
      this._renderTimeline([]);
      this._root.slider.disabled = true;
      this._root.slider.value = "0";
      this._root.track.style.setProperty("--edition-progress-scale", "0");
      this._root.track.style.setProperty("--edition-thumb-fraction", "0");
      this._root.value.textContent = "Unavailable";
      this._root.copy.textContent = "No ECMAScript edition data available.";
    }
  }

  _setScope(nextScope, { emit = true, reflect = false } = {}) {
    this._currentScope = nextScope || "overall";
    if (reflect && this.getAttribute("value") !== this._currentScope) {
      this.setAttribute("value", this._currentScope);
    }
    if (this._data) {
      this._syncUI();
      this._emitChange(emit);
    }
  }

  _detail() {
    if (!this._data) {
      return {
        scope: this._currentScope,
        rows: [],
        cumulativeScopes: [],
        publishedStop: null,
        proposalStop: null,
        publishedLimitRank: null,
        proposalEditionLabels: new Set(),
        activeEdition: null,
        limitRank: null,
        displayValue: "Unavailable",
        copy: "No ECMAScript edition data available.",
        captionMain: "ECMAScript",
      };
    }

    const rows = this._data.rows;
    const cumulativeScopes = this._data.cumulativeScopes;
    const referenceTimestamp = this.getAttribute("reference-timestamp");
    const referenceDate = referenceTimestamp ? new Date(referenceTimestamp) : new Date();
    const layout = t262BuildTimelineLayout(rows);
    const { hasExplicitLegacyBreakdown } = layout;
    const latestPublishedEdition = t262ResolveLatestPublishedEdition(rows, referenceDate);
    const publishedLimitRank = latestPublishedEdition
      ? (T262_EDITION_SCOPE_RANK.get(latestPublishedEdition.edition) ?? Number.MAX_SAFE_INTEGER)
      : Number.MAX_SAFE_INTEGER;
    const fullLayout = t262BuildTimelineLayout(rows);
    const publishedRows = rows.filter((row) => row.rank <= publishedLimitRank);
    const publishedLayout = t262BuildTimelineLayout(publishedRows);
    const proposalEditionLabels = new Set(
      rows.filter((row) => row.rank > publishedLimitRank).map((row) => row.edition),
    );
    let cumulativeWeight = 0;
    const editionSliderStops = publishedRows.flatMap((row, index) => {
      if (index === 0) {
        const legacyStops = t262LegacyStopDefinitions(publishedLayout, row);
        if (legacyStops.length) {
          cumulativeWeight += publishedLayout.segments[0]?.span ?? 1;
          return legacyStops;
        }
      }
      const segment = publishedLayout.segments.find((candidate) => candidate.row === row);
      const position = cumulativeWeight;
      cumulativeWeight += segment?.span ?? 1;
      return [
        {
          label: row.edition,
          value: row.rawEdition,
          position,
          rawEdition: row.rawEdition,
        },
      ];
    });
    const publishedStop = editionSliderStops.at(-1)
      ? {
          ...editionSliderStops.at(-1),
          rawEdition: latestPublishedEdition?.rawEdition || editionSliderStops.at(-1).value,
        }
      : null;
    const totalTimelineWeight = fullLayout.totalSpan;
    const showProposals = this.hasAttribute("show-proposals");
    const proposalStop =
      showProposals && proposalEditionLabels.size
        ? {
            label: T262_PROPOSAL_LABEL,
            value: "overall+proposal",
            position: totalTimelineWeight,
          }
        : null;
    const scopeMap = new Map(cumulativeScopes.map((scope) => [scope.value, scope]));
    if (!hasExplicitLegacyBreakdown && rows[0]?.edition === "ES3 / Core") {
      const firstScope = cumulativeScopes[0];
      if (firstScope) {
        scopeMap.set("ES1", { ...firstScope, value: "ES1", label: "ES1", captionMain: "ECMAScript 1" });
        scopeMap.set("ES2", { ...firstScope, value: "ES2", label: "ES2", captionMain: "ECMAScript 2" });
      }
    }
    const activeStop = editionSliderStops.find((stop) => stop.value === this._currentScope) || null;
    const limitRank =
      this._currentScope === "overall+proposal"
        ? null
        : this._currentScope && this._currentScope !== "overall"
          ? (t262LegacyLimitRank(this._currentScope, rows, hasExplicitLegacyBreakdown) ??
            T262_EDITION_SCOPE_RANK.get(t262NormalizeEditionLabel(this._currentScope)) ??
            null)
          : publishedStop
            ? (T262_EDITION_SCOPE_RANK.get(publishedStop.label) ?? null)
            : null;
    const activeEdition =
      this._currentScope === "overall+proposal"
        ? (rows.at(-1)?.edition ?? publishedStop?.label ?? null)
        : this._currentScope && this._currentScope !== "overall"
          ? (t262LegacyActiveEdition(this._currentScope, rows, hasExplicitLegacyBreakdown) ??
            t262NormalizeEditionLabel(this._currentScope))
          : (publishedStop?.label ?? rows.at(-1)?.edition ?? null);

    let displayValue = publishedStop ? t262DisplayEditionLabel(publishedStop.label) : "Unavailable";
    let copy = "Drag to snap to the nearest ECMAScript edition.";
    let captionMain = publishedStop?.rawEdition ? t262ConformanceCaptionMain(publishedStop.rawEdition) : "ECMAScript";

    if (this._currentScope === "overall") {
      copy = proposalStop
        ? "Drag to snap through published ECMAScript editions, then move slightly past the latest published edition to include proposals."
        : "Drag to snap through published ECMAScript editions. The final stop is the latest published edition.";
    } else if (this._currentScope === "overall+proposal") {
      displayValue = T262_PROPOSAL_LABEL;
      copy = "Move past the latest published edition to include proposals.";
      captionMain = "ECMAScript + proposals";
    } else if (activeStop) {
      displayValue = t262DisplayEditionLabel(activeStop.label);
      copy = `Showing cumulative conformance through ${t262DisplayEditionLabel(activeStop.label)}.`;
      captionMain = t262ConformanceCaptionMain(activeStop.value);
    }

    return {
      scope: this._currentScope,
      rows,
      cumulativeScopes,
      scopeMap,
      publishedStop,
      proposalStop,
      publishedLimitRank,
      proposalEditionLabels,
      activeEdition,
      limitRank,
      displayValue,
      copy,
      captionMain,
      editionSliderStops,
      // #1777 — full timeline weight (published editions + draft/proposal tail).
      // The tick markers are laid out as position / totalTimelineWeight, so the
      // slider thumb fraction MUST use the same denominator to stay on its tick.
      totalTimelineWeight,
    };
  }

  _emitChange(force = false) {
    if (!force && this._lastEmittedScope === this._currentScope) return;
    this._lastEmittedScope = this._currentScope;
    this.dispatchEvent(
      new CustomEvent("edition-change", {
        detail: this._detail(),
        bubbles: true,
        composed: true,
      }),
    );
  }

  _renderTimeline(
    rows,
    activeEdition = null,
    dimAfterRank = null,
    proposalEditionLabels = new Set(),
    activeScope = null,
  ) {
    this._root.track.querySelectorAll(".timeline, .scale").forEach((node) => node.remove());
    if (!rows || rows.length === 0) return;

    const timeline = document.createElement("div");
    timeline.className = "timeline";
    const scale = document.createElement("div");
    scale.className = "scale";
    const layout = t262BuildTimelineLayout(rows);
    const { segments, totalSpan, hasExplicitLegacyBreakdown } = layout;
    if (!segments.length || totalSpan <= 0) return;
    let cumulativeWeight = 0;

    const scaleLabelFor = (edition) => {
      const displayLabel = proposalEditionLabels.has(edition) ? T262_PROPOSAL_LABEL : t262DisplayEditionLabel(edition);
      return /^ES20\d{2}$/.test(displayLabel) ? displayLabel.slice(2) : displayLabel;
    };
    const appendMarker = (label, leftPercent, placement, isActive = false, isDimmed = false) => {
      const marker = document.createElement("div");
      marker.className = "marker " + placement + (isActive ? " active" : "") + (isDimmed ? " dimmed" : "");
      marker.style.left = `${leftPercent}%`;
      const line = document.createElement("div");
      line.className = "line";
      const text = document.createElement("div");
      text.className = "label";
      text.textContent = label;
      marker.appendChild(line);
      marker.appendChild(text);
      scale.appendChild(marker);
    };

    segments.forEach((timelineSegment, index) => {
      const { row, startYear, span } = timelineSegment;
      const segmentEl = document.createElement("div");
      segmentEl.className = "segment";
      const isActive = row.edition === activeEdition;
      const isMarkerDimmed = dimAfterRank !== null && row.rank > dimAfterRank;
      const isSegmentDimmed = dimAfterRank !== null && row.rank >= dimAfterRank;
      const isProposalTail = proposalEditionLabels.has(row.edition) && index === segments.length - 1;
      if (isActive) segmentEl.classList.add("active");
      if (isSegmentDimmed) segmentEl.classList.add("dimmed");
      if (isProposalTail) segmentEl.classList.add("proposal-tail");
      segmentEl.style.flex = String(span);
      timeline.appendChild(segmentEl);

      const segmentStartWeight = cumulativeWeight;
      const segmentStartPercent = (segmentStartWeight / totalSpan) * 100;
      cumulativeWeight += span;
      const segmentEndPercent = (cumulativeWeight / totalSpan) * 100;
      const yearPercent = (year) =>
        ((segmentStartWeight + Math.max(0, Math.min(year - startYear, span))) / totalSpan) * 100;

      if (row.edition === "ES3 / Core" && !hasExplicitLegacyBreakdown) {
        const normalizedScope = t262NormalizeEditionLabel(activeScope || "");
        appendMarker("ES1 1997", segmentStartPercent, "below", activeScope === "ES1");
        appendMarker("ES2 1998", yearPercent(1998), "above", activeScope === "ES2");
        appendMarker(
          "ES3 1999",
          yearPercent(1999),
          "below",
          normalizedScope === "ES3 / Core" || activeScope === row.rawEdition || isActive,
          isMarkerDimmed,
        );
      } else {
        appendMarker(
          scaleLabelFor(row.edition),
          isProposalTail ? segmentEndPercent : segmentStartPercent,
          index % 2 === 0 ? "below" : "above",
          isActive,
          isMarkerDimmed,
        );
      }
    });

    this._root.track.appendChild(timeline);
    this._root.track.appendChild(scale);
  }

  _syncUI() {
    const detail = this._detail();
    if (!detail.publishedStop) {
      this._root.slider.disabled = true;
      this._root.slider.value = "0";
      this._root.track.style.setProperty("--edition-progress-scale", "0");
      this._root.track.style.setProperty("--edition-thumb-fraction", "0");
      this._root.value.textContent = "Unavailable";
      this._root.copy.textContent = "No ECMAScript edition data available.";
      this._renderTimeline([]);
      return;
    }

    if (detail.scope === "overall+proposal" && !detail.proposalStop) {
      this._currentScope = "overall";
      return this._syncUI();
    }

    // #1777 — the slider operates in the FULL timeline weight coordinate
    // (published editions + draft/proposal tail), the same coordinate the tick
    // markers use (position / totalTimelineWeight). Driving slider.max off the
    // full span — rather than the last published-stop position — means the thumb
    // fraction equals each stop's tick percent, so the thumb lands exactly on its
    // tick. Without proposals shown the slider still spans the full timeline; the
    // snap logic clamps drags to the published stops.
    const maxStop = Math.max(detail.totalTimelineWeight || 0, detail.publishedStop.position || 0, 1);
    const activeStop = detail.editionSliderStops.find((stop) => stop.value === this._currentScope) || null;
    const sliderPosition =
      this._currentScope === "overall+proposal"
        ? (detail.proposalStop?.position ?? detail.publishedStop.position)
        : this._currentScope === "overall"
          ? detail.publishedStop.position
          : (activeStop?.position ?? detail.publishedStop.position);

    this._root.slider.disabled = false;
    this._root.slider.min = "0";
    this._root.slider.max = String(maxStop);
    this._applySliderPosition(sliderPosition, maxStop);
    this._root.value.textContent = detail.displayValue;
    this._root.copy.textContent = detail.copy;
    this._renderTimeline(
      detail.rows,
      detail.activeEdition,
      detail.limitRank,
      detail.proposalEditionLabels,
      detail.scope,
    );
  }

  // #1777 — push a slider value + its 0..1 fraction into the DOM. The fraction
  // drives both the visible thumb (left: fraction * 100%) and the progress fill
  // (scaleX), keeping them pixel-aligned with the tick markers, which live in the
  // same fraction coordinate. `max` is the full timeline weight (see _syncUI).
  _applySliderPosition(position, max) {
    const denominator = max > 0 ? max : 1;
    const fraction = Math.max(0, Math.min(1, position / denominator));
    this._root.slider.value = String(position);
    this._root.track.style.setProperty("--edition-thumb-fraction", String(fraction));
    // keep the legacy progress-scale var in sync as a fallback for any consumer.
    this._root.track.style.setProperty("--edition-progress-scale", String(fraction));
  }

  _handleSliderInput() {
    const detail = this._detail();
    const allStops = detail.proposalStop
      ? [...detail.editionSliderStops, detail.proposalStop]
      : [...detail.editionSliderStops];
    if (!allStops.length) return;
    const rawValue = Number(this._root.slider.value || 0);
    let nearestStop = allStops[0];
    let nearestDistance = Math.abs(rawValue - nearestStop.position);
    for (const stop of allStops.slice(1)) {
      const distance = Math.abs(rawValue - stop.position);
      if (distance < nearestDistance) {
        nearestStop = stop;
        nearestDistance = distance;
      }
    }
    // #1777 — snap the thumb (and fraction) to the nearest stop immediately so
    // the visible thumb rests on the tick rather than wherever the drag ended.
    const max = Math.max(detail.totalTimelineWeight || 0, detail.publishedStop?.position || 0, 1);
    this._applySliderPosition(nearestStop.position, max);
    if (detail.proposalStop && nearestStop.value === detail.proposalStop.value) {
      this._setScope("overall+proposal", { emit: true, reflect: true });
      return;
    }
    if (detail.publishedStop && nearestStop.value === detail.publishedStop.value) {
      this._setScope("overall", { emit: true, reflect: true });
      return;
    }
    this._setScope(nearestStop.value, { emit: true, reflect: true });
  }
}

customElements.define("t262-edition-timeline", T262EditionTimeline);

/* ── <t262-edition-bars> ──────────────────────────────────────── */

class T262EditionBars extends HTMLElement {
  static get observedAttributes() {
    return ["src", "mode"];
  }

  constructor() {
    super();
    this.attachShadow({ mode: "open" });
  }

  connectedCallback() {
    this._render();
  }

  attributeChangedCallback() {
    this._render();
  }

  async _render() {
    const src = this.getAttribute("src") || "./benchmarks/results/test262-editions.json";
    const chartMode = this.getAttribute("mode") || "both";
    let editions;
    try {
      const resp = await fetch(src);
      if (!resp.ok) return;
      editions = await resp.json();
      if (!Array.isArray(editions) || editions.length === 0) return;
    } catch {
      return;
    }

    const eds = editions.filter((ed) => ed && ed.total > 0);
    const n = eds.length;
    if (n === 0) return;

    const W = 500,
      H = 240;
    const PAD = { top: 20, right: 40, bottom: 40, left: 60 };
    const plotW = W - PAD.left - PAD.right;
    const plotH = H - PAD.top - PAD.bottom;

    const maxTotal = Math.max(...eds.map((d) => d.total));

    const x = (i) => PAD.left + (i / (n - 1)) * plotW;
    const y = (val) => PAD.top + plotH - (val / maxTotal) * plotH;

    // Stacked values per edition (pass on bottom, skip on top)
    const cumPass = eds.map((d) => d.pass);
    const cumFail = eds.map((d, i) => cumPass[i] + d.fail);
    const cumCe = eds.map((d, i) => cumFail[i] + d.ce);
    const cumSkip = eds.map((d, i) => cumCe[i] + d.skip);

    const areaPath = (valueFn, baseFn) => {
      let p = `M ${x(0)} ${valueFn(0)}`;
      for (let i = 1; i < n; i++) p += ` L ${x(i)} ${valueFn(i)}`;
      for (let i = n - 1; i >= 0; i--) p += ` L ${x(i)} ${baseFn(i)}`;
      return p + " Z";
    };
    const linePath = (valueFn) => {
      let p = `M ${x(0)} ${valueFn(0)}`;
      for (let i = 1; i < n; i++) p += ` L ${x(i)} ${valueFn(i)}`;
      return p;
    };

    // Grid lines
    const gridSteps = 4;
    const yMax = Math.ceil(maxTotal / 5000) * 5000;
    const yG = (val) => PAD.top + plotH - (val / yMax) * plotH;
    let gridSvg = "";
    for (let i = 0; i <= gridSteps; i++) {
      const val = (yMax / gridSteps) * i;
      const yPos = yG(val);
      gridSvg += `<line x1="${PAD.left}" y1="${yPos}" x2="${W - PAD.right}" y2="${yPos}" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>`;
      gridSvg += `<text x="${PAD.left - 8}" y="${yPos + 4}" text-anchor="end" fill="rgba(255,255,255,0.3)" font-size="10" font-family="monospace">${(val / 1000).toFixed(0)}k</text>`;
    }

    // X-axis labels
    let xLabels = "";
    for (let i = 0; i < n; i++) {
      const label = eds[i].edition.replace("ES20", "'");
      xLabels += `<text x="${x(i)}" y="${H - PAD.bottom + 16}" text-anchor="middle" fill="rgba(255,255,255,0.3)" font-size="10" font-family="monospace">${label}</text>`;
    }

    // Pass rate dots + labels
    let dots = "";
    const maxPassIdx = cumPass.reduce((mi, v, i, a) => (v > a[mi] ? i : mi), 0);
    for (let i = 0; i < n; i++) {
      const cx = x(i);
      dots += `<circle cx="${cx}" cy="${y(cumSkip[i])}" r="2" fill="none"/>`;
      dots += `<circle cx="${cx}" cy="${y(cumCe[i])}" r="2" fill="none"/>`;
      dots += `<circle cx="${cx}" cy="${y(cumFail[i])}" r="2" fill="none"/>`;
      dots += `<circle cx="${cx}" cy="${y(cumSkip[i])}" r="2.5" fill="#4a5060"/>`;
      dots += `<circle cx="${cx}" cy="${y(cumPass[i])}" r="3" fill="rgba(255,255,255,0.9)"/>`;
      if (i === maxPassIdx) {
        dots += `<text x="${cx}" y="${y(cumPass[i]) - 8}" text-anchor="middle" fill="rgba(255,255,255,0.8)" font-size="10" font-family="monospace">${cumPass[i].toLocaleString()}</text>`;
      }
    }

    const svg = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto">
      <defs>
        <linearGradient id="passGrad" x1="0" y1="1" x2="0" y2="0">
          <stop offset="0%" stop-color="white" stop-opacity="0"/>
          <stop offset="25%" stop-color="white" stop-opacity="0.055"/>
          <stop offset="100%" stop-color="white" stop-opacity="0.41"/>
        </linearGradient>
        <linearGradient id="failGrad" x1="0" y1="1" x2="0" y2="0">
          <stop offset="0%" stop-color="#0a0e16" stop-opacity="1"/>
          <stop offset="100%" stop-color="#1a2436" stop-opacity="1"/>
        </linearGradient>
        <linearGradient id="ceGrad" x1="0" y1="1" x2="0" y2="0">
          <stop offset="0%" stop-color="#090d14" stop-opacity="1"/>
          <stop offset="100%" stop-color="#141c2c" stop-opacity="1"/>
        </linearGradient>
        <linearGradient id="skipGrad" x1="0" y1="1" x2="0" y2="0">
          <stop offset="0%" stop-color="#080c12" stop-opacity="1"/>
          <stop offset="100%" stop-color="#0f1520" stop-opacity="1"/>
        </linearGradient>
        <filter id="passLineGlow">
          <feGaussianBlur in="SourceGraphic" stdDeviation="1.2" result="blur"/>
          <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
      </defs>
      ${gridSvg}
      ${xLabels}
      <path d="${areaPath(
        (i) => y(cumSkip[i]),
        (i) => y(cumCe[i]),
      )}" fill="url(#skipGrad)"/>
      <path d="${areaPath(
        (i) => y(cumCe[i]),
        (i) => y(cumFail[i]),
      )}" fill="url(#ceGrad)"/>
      <path d="${areaPath(
        (i) => y(cumFail[i]),
        (i) => y(cumPass[i]),
      )}" fill="url(#failGrad)"/>
      <path d="${areaPath(
        (i) => y(cumPass[i]),
        () => y(0),
      )}" fill="url(#passGrad)"/>
      <path d="${linePath((i) => y(cumSkip[i]))}" fill="none" stroke="#4a5060" stroke-width="1.5"/>
      <path d="${linePath((i) => y(cumCe[i]))}" fill="none" stroke="none"/>
      <path d="${linePath((i) => y(cumFail[i]))}" fill="none" stroke="none"/>
      <path d="${linePath((i) => y(cumPass[i]))}" fill="none" stroke="#fff" stroke-width="2" filter="url(#passLineGlow)"/>
      ${dots}
    </svg>`;

    // Percentage chart (normalized to 100%)
    const yPct = (pct) => PAD.top + plotH - (pct / 100) * plotH;

    const pctPass = eds.map((d) => (d.pass / d.total) * 100);
    const pctFail = eds.map((d, i) => pctPass[i] + (d.fail / d.total) * 100);
    const pctCe = eds.map((d, i) => pctFail[i] + (d.ce / d.total) * 100);

    let gridPct = "";
    for (let i = 0; i <= gridSteps; i++) {
      const pct = (100 / gridSteps) * i;
      const yPos = yPct(pct);
      gridPct += `<line x1="${PAD.left}" y1="${yPos}" x2="${W - PAD.right}" y2="${yPos}" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>`;
      gridPct += `<text x="${PAD.left - 8}" y="${yPos + 4}" text-anchor="end" fill="rgba(255,255,255,0.3)" font-size="10" font-family="monospace">${pct.toFixed(0)}%</text>`;
    }

    let dotsPct = "";
    const maxPctIdx = pctPass.reduce((mi, v, i, a) => (v > a[mi] ? i : mi), 0);
    for (let i = 0; i < n; i++) {
      const cx = x(i);
      dotsPct += `<circle cx="${cx}" cy="${yPct(100)}" r="2" fill="none"/>`;
      dotsPct += `<circle cx="${cx}" cy="${yPct(pctCe[i])}" r="2" fill="none"/>`;
      dotsPct += `<circle cx="${cx}" cy="${yPct(pctFail[i])}" r="2" fill="none"/>`;
      dotsPct += `<circle cx="${cx}" cy="${yPct(pctPass[i])}" r="3" fill="rgba(255,255,255,0.9)"/>`;
      if (i === maxPctIdx) {
        dotsPct += `<text x="${cx}" y="${yPct(pctPass[i]) - 8}" text-anchor="middle" fill="rgba(255,255,255,0.8)" font-size="10" font-family="monospace">${Math.round(pctPass[i])}%</text>`;
      }
    }

    const svgPct = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto">
      <defs>
        <linearGradient id="passGradPct" x1="0" y1="1" x2="0" y2="0">
          <stop offset="0%" stop-color="white" stop-opacity="0"/>
          <stop offset="25%" stop-color="white" stop-opacity="0.055"/>
          <stop offset="100%" stop-color="white" stop-opacity="0.41"/>
        </linearGradient>
        <linearGradient id="failGradPct" x1="0" y1="1" x2="0" y2="0">
          <stop offset="0%" stop-color="#0a0e16" stop-opacity="1"/>
          <stop offset="100%" stop-color="#1a2436" stop-opacity="1"/>
        </linearGradient>
        <linearGradient id="ceGradPct" x1="0" y1="1" x2="0" y2="0">
          <stop offset="0%" stop-color="#090d14" stop-opacity="1"/>
          <stop offset="100%" stop-color="#141c2c" stop-opacity="1"/>
        </linearGradient>
        <linearGradient id="skipGradPct" x1="0" y1="1" x2="0" y2="0">
          <stop offset="0%" stop-color="#080c12" stop-opacity="1"/>
          <stop offset="100%" stop-color="#0f1520" stop-opacity="1"/>
        </linearGradient>
        <filter id="passLineGlowPct">
          <feGaussianBlur in="SourceGraphic" stdDeviation="1.2" result="blur"/>
          <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
      </defs>
      ${gridPct}
      ${xLabels}
      <path d="${areaPath(
        () => yPct(100),
        (i) => yPct(pctCe[i]),
      )}" fill="url(#skipGradPct)"/>
      <path d="${areaPath(
        (i) => yPct(pctCe[i]),
        (i) => yPct(pctFail[i]),
      )}" fill="url(#ceGradPct)"/>
      <path d="${areaPath(
        (i) => yPct(pctFail[i]),
        (i) => yPct(pctPass[i]),
      )}" fill="url(#failGradPct)"/>
      <path d="${areaPath(
        (i) => yPct(pctPass[i]),
        () => yPct(0),
      )}" fill="url(#passGradPct)"/>
      <path d="${linePath(() => yPct(100))}" fill="none" stroke="none"/>
      <path d="${linePath((i) => yPct(pctCe[i]))}" fill="none" stroke="none"/>
      <path d="${linePath((i) => yPct(pctFail[i]))}" fill="none" stroke="none"/>
      <path d="${linePath((i) => yPct(pctPass[i]))}" fill="none" stroke="#fff" stroke-width="2" filter="url(#passLineGlowPct)"/>
      ${dotsPct}
    </svg>`;

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
        }
        .charts { display: flex; flex-direction: column; gap: 24px; }
      </style>
      <div class="charts">
        ${chartMode !== "percentage" ? svg : ""}
        ${chartMode !== "absolute" ? svgPct : ""}
      </div>
    `;
  }
}

customElements.define("t262-edition-bars", T262EditionBars);

// #1777 — named exports for the pure timeline helpers so the published-edition /
// draft-edition classification can be unit-tested without a DOM. Browsers loading
// this file via <script type="module"> simply ignore the unused named exports.
export {
  T262_CURRENT_DRAFT_EDITION_YEAR,
  T262_EDITION_SCOPE_RANK,
  t262IsEditionScope,
  t262LatestPublishedEditionYear,
  t262NormalizeEditionLabel,
  t262ResolveLatestPublishedEdition,
};
