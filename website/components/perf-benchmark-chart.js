/**
 * <perf-benchmark-chart> — animated Wasm vs JS comparison chart.
 *
 * Attributes:
 *   src        — URL to playground-benchmark-sidebar.json
 *   rerun-src  — optional full benchmark manifest used for requested live refresh
 *   rerun-label — optional label for the live benchmark button
 *   title      — chart heading (default: "Benchmark Performance (Wasm vs JS)")
 *   legend     — legend text (default: empty; pass an explicit legend per chart, or render a section-level description in the host page)
 *   mode       — perf | runtime | module-size | size | coldstart | loadtime | absolute-lower-better
 *
 * Usage:
 *   <perf-benchmark-chart src="./benchmarks/results/playground-benchmark-sidebar.json"></perf-benchmark-chart>
 */

class PerfBenchmarkChart extends HTMLElement {
  static get observedAttributes() {
    return [
      "src",
      "rerun-src",
      "rerun-label",
      "title",
      "legend",
      "mode",
      "benchmark",
      "browser-runtime-src",
      "baseline-label",
      "compare-from-baseline",
      "show-delta",
      "delta-kind",
    ];
  }

  static _measurementQueue = Promise.resolve();

  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._rendered = false;
  }

  connectedCallback() {
    if (!this._rendered) {
      this._rendered = true;
      this._render();
    }
  }

  attributeChangedCallback(name, oldVal, newVal) {
    if (oldVal !== newVal && this._rendered) {
      this._rendered = false;
      this.shadowRoot.innerHTML = "";
      this._rendered = true;
      this._render();
    }
  }

  _render() {
    const src = this.getAttribute("src") || "./benchmarks/results/playground-benchmark-sidebar.json";
    const title = this.getAttribute("title") || "Benchmark Performance (Wasm vs JS)";
    // No fallback legend — callers that omit `legend` get no <p>.legend rendered.
    // Avoids stale text leaking into charts (e.g. module-size charts) where
    // the previous default ("runtime performance relative to JS") was wrong.
    const legend = this.getAttribute("legend") || "";
    const baselineLabel = this.getAttribute("baseline-label") || "JS";
    const mode = this.getAttribute("mode") || "perf";

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
        }
        /* Saturated tinting based on the chart's scenario, set via [data-tint] on the host. */
        :host([data-tint="cold"]) .bench-track-bg {
          background: linear-gradient(to right, rgba(50, 120, 240, 0.18), rgba(50, 120, 240, 0.05));
        }
        :host([data-tint="cold"]) .bench-fill,
        :host([data-tint="cold"]) .bench-extra-fill {
          background: linear-gradient(to right, rgba(70, 140, 255, 0.35), rgba(120, 180, 255, 1.0)) !important;
        }
        :host([data-tint="cold"]) .bench-row-baseline {
          background: rgba(120, 180, 255, 0.95);
        }
        :host([data-tint="warm"]) .bench-track-bg {
          background: linear-gradient(to right, rgba(240, 70, 60, 0.18), rgba(240, 70, 60, 0.05));
        }
        :host([data-tint="warm"]) .bench-fill,
        :host([data-tint="warm"]) .bench-extra-fill {
          background: linear-gradient(to right, rgba(250, 100, 85, 0.35), rgba(255, 150, 130, 1.0)) !important;
        }
        :host([data-tint="warm"]) .bench-row-baseline {
          background: rgba(255, 150, 130, 0.95);
        }

        .chart-title {
          font-family: var(--mono, ui-monospace, monospace);
          font-size: 11px;
          font-weight: 500;
          letter-spacing: 0.1em;
          text-transform: uppercase;
          color: var(--fg-faint, rgba(255,255,255,0.35));
          margin: 0 0 28px;
        }

        .chart-title-note {
          letter-spacing: 0;
          text-transform: none;
        }

        .bars-wrap {
          position: relative;
          padding-top: 24px;
        }

        .js-label {
          position: absolute;
          top: 4px;
          display: inline-block;
          font-family: var(--mono, ui-monospace, monospace);
          font-size: 11px;
          color: var(--fg-soft, rgba(255,255,255,0.55));
          letter-spacing: 0.05em;
          white-space: nowrap;
        }

        .js-line {
          position: absolute;
          top: 24px;
          bottom: 0;
          width: 2px;
          background: var(--fg-soft, rgba(255,255,255,0.55));
          opacity: 1;
          z-index: 1;
        }
        .js-line-secondary {
          background: var(--fg-faint, rgba(255,255,255,0.35));
          opacity: 0.75;
          width: 1px;
          border-left: 1px dashed var(--fg-faint, rgba(255,255,255,0.45));
          background: transparent;
        }
        .js-label-secondary {
          color: var(--fg-faint, rgba(255,255,255,0.45));
          font-style: italic;
        }

        .bench-bars {
          display: flex;
          flex-direction: column;
          gap: 16px;
        }

        .bench-row {
          display: grid;
          grid-template-columns: 112px 1fr;
          align-items: center;
          gap: 16px;
        }

        .bench-row-has-factor {
          grid-template-columns: 112px minmax(0, 1fr) var(--bench-factor-width, max-content);
        }

        .bench-name {
          font-family: var(--mono, ui-monospace, monospace);
          font-size: 13px;
          color: var(--fg-soft, rgba(255,255,255,0.55));
          text-align: left;
          min-width: 0;
          white-space: nowrap;
        }

        .bench-track {
          height: 28px;
          background: transparent;
          border-radius: 4px;
          overflow: visible;
          position: relative;
          min-width: 0;
        }

        .bench-track-bg {
          position: absolute;
          left: 0;
          top: 0;
          height: 100%;
          background: var(--surface, rgba(255,255,255,0.04));
          border-radius: 4px;
        }

        .bench-fill {
          height: 100%;
          border-radius: 4px;
          position: absolute;
          top: 0;
          z-index: 2;
        }

        .bench-extra-fill {
          z-index: 2;
        }

        .bench-errorbar {
          display: none;
        }

        .bench-errorbar::before,
        .bench-errorbar::after {
          content: "";
          position: absolute;
          top: -4px;
          width: 0;
          height: 8px;
          border-left: 1px solid rgba(255,255,255,0.5);
        }

        .bench-errorbar::before {
          left: 0;
        }

        .bench-errorbar::after {
          right: 0;
        }

        .bench-row-baseline {
          position: absolute;
          top: -5px;
          bottom: -5px;
          width: 3px;
          border-radius: 999px;
          background: rgba(255,255,255,0.78);
          z-index: 3;
          opacity: 0;
          filter:
            drop-shadow(0 0 1px rgba(0,0,0,0.95))
            drop-shadow(0 0 6px rgba(255,255,255,0.2));
        }

        .bench-row-baseline-label {
          position: absolute;
          top: 50%;
          transform: translate(-50%, -50%);
          font-family: var(--mono, ui-monospace, monospace);
          font-size: 11px;
          font-weight: 600;
          color: rgba(255,255,255,0.78);
          white-space: nowrap;
          text-shadow:
            0 1px 1px rgba(6, 10, 20, 0.9),
            0 0 10px rgba(6, 10, 20, 0.6);
          opacity: 0;
          z-index: 4;
          pointer-events: none;
        }

        .bench-value {
          font-family: var(--mono, ui-monospace, monospace);
          font-size: 12px;
          font-weight: 600;
          color: var(--fg-soft, rgba(255,255,255,0.55));
          position: absolute;
          top: 50%;
          transform: translateY(-50%);
          z-index: 5;
          white-space: nowrap;
          text-shadow:
            0 1px 1px rgba(6, 10, 20, 0.85),
            0 0 10px rgba(6, 10, 20, 0.45);
        }

        .bench-factor {
          font-family: var(--mono, ui-monospace, monospace);
          font-size: 12px;
          font-weight: 600;
          color: rgba(255,255,255,0.62);
          white-space: nowrap;
          text-align: left;
          width: var(--bench-factor-width, auto);
          min-width: var(--bench-factor-width, auto);
        }

        .legend {
          margin-top: 16px;
          font-size: 12px;
          color: var(--fg-faint, rgba(255,255,255,0.35));
        }

        .chart-actions {
          display: flex;
          align-items: center;
          gap: 12px;
          margin-top: 16px;
          flex-wrap: wrap;
        }

        .chart-actions[hidden] {
          display: none;
        }

        .rerun-button {
          appearance: none;
          border: 1px solid rgba(255, 255, 255, 0.18);
          border-radius: 6px;
          background: rgba(255, 255, 255, 0.08);
          color: var(--fg-soft, rgba(255,255,255,0.72));
          font: 600 12px/1 var(--font, ui-sans-serif, system-ui, sans-serif);
          min-height: 34px;
          padding: 0 12px;
          cursor: pointer;
          transition:
            background 0.15s ease,
            border-color 0.15s ease,
            opacity 0.15s ease;
        }

        .rerun-button:hover {
          background: rgba(255, 255, 255, 0.12);
          border-color: rgba(255, 255, 255, 0.28);
        }

        .rerun-button:disabled {
          cursor: progress;
          opacity: 0.58;
        }

        .chart-status {
          font-size: 12px;
          color: var(--fg-faint, rgba(255,255,255,0.35));
        }

        @media (max-width: 720px) {
          .bench-row {
            grid-template-columns: minmax(86px, 30%) minmax(0, 1fr);
            column-gap: 8px;
            row-gap: 6px;
          }

          .bench-row-has-factor {
            grid-template-columns: minmax(86px, 30%) minmax(36px, 1fr) var(--bench-factor-width, max-content);
          }

          .bench-name {
            font-size: 11px;
            line-height: 1.15;
            white-space: normal;
            overflow-wrap: anywhere;
          }

          .bench-factor {
            font-size: 11px;
          }
        }
      </style>

      <h3 class="chart-title">
        <span class="chart-title-label"></span><span class="chart-title-note" hidden> (lower is better)</span>
      </h3>
      <div class="bars-wrap">
        <div class="js-label"></div>
        <div class="js-line"></div>
        <div class="bench-bars"></div>
      </div>
      <p class="legend"></p>
      <div class="chart-actions" hidden>
        <button type="button" class="rerun-button"></button>
        <span class="chart-status" role="status" aria-live="polite"></span>
      </div>
    `;

    // Split the title at the first " (" so the parenthesized sub-text (which
    // typically holds a direction hint like "higher is better") stays in the
    // mixed-case .chart-title-note span instead of being uppercased by the
    // .chart-title-label style.
    const titleLabelEl = this.shadowRoot.querySelector(".chart-title-label");
    const titleNoteEl = this.shadowRoot.querySelector(".chart-title-note");
    const parenIdx = title.indexOf(" (");
    if (parenIdx > 0) {
      titleLabelEl.textContent = title.slice(0, parenIdx);
      titleNoteEl.textContent = " " + title.slice(parenIdx + 1);
      titleNoteEl.hidden = false;
    } else {
      titleLabelEl.textContent = title;
      // No parenthetical in the title; hide the auto-appended note.
      titleNoteEl.hidden = true;
    }
    // Auto-tint speed charts: "cold speed" blue, "warm speed" red. Other titles
    // containing "cold" or "warm" (e.g. "cold start", "warm isolate") stay neutral.
    const titleLower = title.toLowerCase();
    if (titleLower.includes("cold speed")) {
      this.dataset.tint = "cold";
    } else if (titleLower.includes("warm speed")) {
      this.dataset.tint = "warm";
    } else if (this.dataset.tint) {
      delete this.dataset.tint;
    }
    this.shadowRoot.querySelector(".js-label").textContent = baselineLabel;
    const legendEl = this.shadowRoot.querySelector(".legend");
    legendEl.textContent = legend;
    legendEl.hidden = !legend;
    const actions = this.shadowRoot.querySelector(".chart-actions");
    const rerunButton = this.shadowRoot.querySelector(".rerun-button");
    if (this.getAttribute("rerun-src") && actions && rerunButton) {
      actions.hidden = false;
      rerunButton.textContent = this.getAttribute("rerun-label") || "Run browser benchmark";
      rerunButton.addEventListener("click", () => this._rerunBrowserRuntime(src));
    }

    this._load(src);
  }

  _isLowerBetterMode(mode) {
    return mode === "runtime" || mode === "module-size" || mode === "absolute-lower-better";
  }

  async _measureJsModuleLoad(jsUrl, rounds = 3) {
    const samples = [];
    for (let i = 0; i < rounds; i++) {
      const cacheBust = `${jsUrl}${jsUrl.includes("?") ? "&" : "?"}load=${Date.now()}-${i}-${Math.random().toString(36).slice(2)}`;
      const t0 = performance.now();
      const response = await fetch(cacheBust, { cache: "no-store" });
      const source = await response.text();
      const blob = new Blob([source], { type: "text/javascript" });
      const blobUrl = URL.createObjectURL(blob);
      try {
        await import(/* @vite-ignore */ blobUrl);
      } finally {
        URL.revokeObjectURL(blobUrl);
      }
      samples.push(performance.now() - t0);
    }
    samples.sort((a, b) => a - b);
    return {
      samples,
      median: samples[Math.floor(samples.length / 2)] ?? 0,
      stddev: this._stddev(samples),
    };
  }

  async _measureWasmLoad(entry, wasmUrl, instantiateWasmStreaming, buildImports, rounds = 3) {
    const samples = [];
    for (let i = 0; i < rounds; i++) {
      const imports = buildImports(
        entry.imports ?? [],
        {
          document,
          window,
          performance,
          globalThis,
        },
        entry.stringPool ?? [],
      );
      const cacheBust = `${wasmUrl}${wasmUrl.includes("?") ? "&" : "?"}load=${Date.now()}-${i}-${Math.random().toString(36).slice(2)}`;
      const t0 = performance.now();
      const result = await instantiateWasmStreaming(
        fetch(cacheBust, { cache: "no-store" }),
        imports.env,
        imports.string_constants,
        imports.string_constants16,
      );
      imports.setInstance?.(result.instance);
      samples.push(performance.now() - t0);
    }
    samples.sort((a, b) => a - b);
    return {
      samples,
      median: samples[Math.floor(samples.length / 2)] ?? 0,
      stddev: this._stddev(samples),
    };
  }

  _stddev(values) {
    if (!Array.isArray(values) || values.length <= 1) return 0;
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
    return Math.sqrt(variance);
  }

  _median(values) {
    if (!Array.isArray(values) || values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)] ?? 0;
  }

  _timeIt(fn, iterations) {
    const t0 = performance.now();
    for (let i = 0; i < iterations; i++) fn();
    return performance.now() - t0;
  }

  _calibrate(fn) {
    let iterations = 0;
    const t0 = performance.now();
    while (performance.now() - t0 < 100) {
      fn();
      iterations++;
    }
    return Math.max(10, Math.ceil((iterations / 100) * 300));
  }

  _snapshotBodyState() {
    return {
      children: new Set(Array.from(document.body.children)),
      cssText: document.body.style.cssText,
    };
  }

  _restoreBodyState(state) {
    document.body.style.cssText = state.cssText;
    for (const child of Array.from(document.body.children)) {
      if (!state.children.has(child)) child.remove();
    }
  }

  async _loadJsRuntimeFunction(jsUrl, exportName) {
    const cacheBust = `${jsUrl}${jsUrl.includes("?") ? "&" : "?"}runtime=${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const response = await fetch(cacheBust, { cache: "no-store" });
    const source = await response.text();
    const blob = new Blob([source], { type: "text/javascript" });
    const blobUrl = URL.createObjectURL(blob);
    try {
      const mod = await import(/* @vite-ignore */ blobUrl);
      return mod?.[exportName];
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
  }

  async _measureBrowserRuntime(entry, jsUrl, wasmUrl, runtimeHelpers) {
    const exportName = entry?.exportName || `bench_${entry?.name || ""}`;
    const jsFn = await this._loadJsRuntimeFunction(jsUrl, exportName);
    if (typeof jsFn !== "function") {
      throw new Error(`JS benchmark export ${exportName} not found`);
    }

    const imports = runtimeHelpers.buildImports(
      entry.imports ?? [],
      { document, window, performance, globalThis },
      entry.stringPool ?? [],
    );
    const wasmBytes = new Uint8Array(await (await fetch(wasmUrl, { cache: "no-store" })).arrayBuffer());
    if (typeof runtimeHelpers.optimizeWasm !== "function") {
      throw new Error("in-page wasm-opt helper not found");
    }
    const wasmOptStart = performance.now();
    const wasmOptResult = await runtimeHelpers.optimizeWasm(wasmBytes, { level: 4 });
    const wasmOptMs = performance.now() - wasmOptStart;
    if (!wasmOptResult?.optimized) {
      throw new Error(wasmOptResult?.warning || "in-page wasm-opt did not produce an optimized module");
    }
    const optimizedWasmBytes = wasmOptResult.binary;
    const wasmResult = await runtimeHelpers.instantiateWasm(
      optimizedWasmBytes,
      imports.env,
      imports.string_constants,
      imports.string_constants16,
    );
    imports.setInstance?.(wasmResult.instance);
    const wasmFn = wasmResult.instance.exports?.[exportName];
    if (typeof wasmFn !== "function") {
      throw new Error(`Wasm benchmark export ${exportName} not found`);
    }

    const bodyState = this._snapshotBodyState();
    try {
      for (let i = 0; i < 80; i++) {
        wasmFn();
        jsFn();
      }

      const iterations = this._calibrate(wasmFn);
      const warmupRounds = 2;
      const measuredRounds = 9;
      for (let i = 0; i < warmupRounds; i++) {
        this._timeIt(wasmFn, iterations);
        this._timeIt(jsFn, iterations);
      }

      const wasmSamplesUs = [];
      const jsSamplesUs = [];
      const ratioSamples = [];
      for (let i = 0; i < measuredRounds; i++) {
        const wasmUs = (this._timeIt(wasmFn, iterations) / iterations) * 1000;
        const jsUs = (this._timeIt(jsFn, iterations) / iterations) * 1000;
        wasmSamplesUs.push(wasmUs);
        jsSamplesUs.push(jsUs);
        ratioSamples.push(jsUs / Math.max(wasmUs, 0.000001));
      }

      return {
        path: entry.path,
        name: entry.name,
        wasmUs: this._median(wasmSamplesUs),
        jsUs: this._median(jsSamplesUs),
        wasmStdUs: this._stddev(wasmSamplesUs),
        jsStdUs: this._stddev(jsSamplesUs),
        ratioStd: this._stddev(ratioSamples),
        warmupRounds,
        measuredRounds,
        wasmOptMs,
        wasmOptInputBytes: wasmBytes.byteLength,
        wasmOptOutputBytes: optimizedWasmBytes.byteLength,
      };
    } finally {
      this._restoreBodyState(bodyState);
    }
  }

  async _waitForStableLoadBenchmarkStart() {
    if (document.readyState !== "complete") {
      await new Promise((resolve) => window.addEventListener("load", resolve, { once: true }));
    }

    if (document.fonts?.ready) {
      try {
        await document.fonts.ready;
      } catch {
        // Ignore font readiness failures and continue.
      }
    }

    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

    if ("requestIdleCallback" in window) {
      await new Promise((resolve) => {
        window.requestIdleCallback(() => resolve(), { timeout: 500 });
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
  }

  async _runSerialMeasurement(task) {
    const run = PerfBenchmarkChart._measurementQueue.then(async () => {
      await this._waitForStableLoadBenchmarkStart();
      return task();
    });

    PerfBenchmarkChart._measurementQueue = run.catch(() => {});
    return run;
  }

  _shortBenchmarkLabel(row) {
    const raw = row?.label || row?.name || row?.path || "unknown";
    return String(raw)
      .replace(/^examples\/(?:benchmarks|dom)\//, "")
      .replace(/\.ts$/, "");
  }

  _formatMetric(value) {
    if (value >= 100) return String(Math.round(value));
    if (value >= 10) return value.toFixed(1);
    return value.toFixed(2).replace(/\.?0+$/, "");
  }

  // Consistent ratio formatting used everywhere a `<n>x` string is rendered.
  // Strips trailing zeros so "0.10x" never shows next to "0.1x" elsewhere.
  _formatRatio(ratio) {
    if (!Number.isFinite(ratio)) return "0x";
    if (ratio >= 10) return `${Math.round(ratio)}x`;
    if (ratio >= 0.1) return `${ratio.toFixed(1).replace(/\.0$/, "")}x`;
    return `${ratio.toFixed(2).replace(/\.?0+$/, "")}x`;
  }

  _formatBytes(bytes) {
    const value = Number(bytes);
    if (!Number.isFinite(value) || value <= 0) return "0 B";
    if (value >= 1024 * 1024) return `${this._formatMetric(value / (1024 * 1024))} MB`;
    if (value >= 1024) return `${this._formatMetric(value / 1024)} kB`;
    return `${Math.round(value)} B`;
  }

  _formatDurationUs(us) {
    const value = Number(us);
    if (!Number.isFinite(value) || value <= 0) return "0 us";
    if (value >= 1000) return `${this._formatMetric(value / 1000)} ms`;
    return `${this._formatMetric(value)} us`;
  }

  _formatSignedPercent(value) {
    if (!Number.isFinite(value) || value <= 0) return "";
    return Math.round(value).toLocaleString("en-US");
  }

  _formatFactorDelta(value, baseline, kind) {
    const metricValue = Number(value);
    const baselineValue = Number(baseline);
    if (!Number.isFinite(metricValue) || !Number.isFinite(baselineValue) || baselineValue <= 0) return "";
    if (metricValue <= 0) return "";
    if (kind === "factor") {
      return this._formatRatio(metricValue / baselineValue);
    }
    if (Math.abs(metricValue - baselineValue) <= Math.max(0.0001, baselineValue * 0.0005)) {
      return "0%";
    }
    const percentDiff = ((metricValue - baselineValue) / baselineValue) * 100;
    return `${percentDiff > 0 ? "+" : "-"}${this._formatSignedPercent(Math.abs(percentDiff))}%`;
  }

  _valueLabel(label, value) {
    return label || `${Number(value).toFixed(1)}`;
  }

  _factorDeltaLabel(value, baseline, showDelta, kind) {
    if (!showDelta) return "";
    return this._formatFactorDelta(value, baseline, kind);
  }

  _rowBaselineValue(row) {
    return Number(row?.baselineValue ?? row?.jsUs ?? row?.baselineUs ?? 0);
  }

  _renderAbsoluteRows(absoluteRows) {
    const shadow = this.shadowRoot;
    const container = shadow.querySelector(".bench-bars");
    const jsLabelEl = shadow.querySelector(".js-label");
    const jsLineEl = shadow.querySelector(".js-line");
    const baselineLabel = this.getAttribute("baseline-label") || "JS";
    const deltaKind =
      this.getAttribute("delta-kind") || (this.getAttribute("mode") === "module-size" ? "size" : "runtime");

    if (!container || !jsLabelEl || !jsLineEl || !Array.isArray(absoluteRows) || absoluteRows.length === 0) return;

    container.replaceChildren();

    const baselineValues = absoluteRows.map((row) => this._rowBaselineValue(row)).filter((value) => value > 0);
    const firstBaseline = baselineValues[0] ?? 0;
    const hasSharedBaseline =
      firstBaseline > 0 &&
      baselineValues.length === absoluteRows.length &&
      baselineValues.every((value) => Math.abs(value - firstBaseline) <= Math.max(0.001, firstBaseline * 0.001));
    const baselineValue = hasSharedBaseline ? firstBaseline : 0;
    const absoluteMax = Math.max(...absoluteRows.map((row) => row.value + Math.max(0, Number(row.extraValue ?? 0))), 1);
    const baselineMax = Math.max(...baselineValues, 0);
    const maxValue = Math.max(absoluteMax, baselineMax > 0 ? baselineMax * 1.08 : 0, 1);
    const baselinePct = baselineValue > 0 ? (baselineValue / maxValue) * 100 : 0;

    // Ratio-normalised scale: when every row has its own per-row baseline, derive a
    // single scale factor from the worst-case slowdown ratio (max value / baseline).
    // All JS baseline markers then land at the same horizontal position (1/maxRatio),
    // and the slowest row fills 100% of the track width.
    const hasAllPerRowBaselines = !hasSharedBaseline && baselineValues.length === absoluteRows.length;
    const maxRatio = hasAllPerRowBaselines
      ? Math.max(
          ...absoluteRows.map((row) => {
            const bv = this._rowBaselineValue(row);
            return bv > 0 ? (row.value + Math.max(0, Number(row.extraValue ?? 0))) / bv : 1;
          }),
          1,
        )
      : 1;
    const useRatioNorm = hasAllPerRowBaselines && maxRatio > 1;
    const ratioNormBaselinePct = useRatioNorm ? (1 / maxRatio) * 100 : 0;
    // When all rows use per-row scaling (scalePerRow), each row already shows
    // its own baseline marker — the global JS line would be drawn at the
    // chart-wide baselinePct which falls off the visible track whenever a
    // single row's value dominates the global maxValue (e.g. size charts
    // where Engine = 14 MB vs JS source = 1.77 kB makes the global baseline
    // sit at ~0.01%). Suppress the global marker in that case.
    const allRowsScalePerRow = absoluteRows.length > 0 && absoluteRows.every((row) => row.scalePerRow === true);
    // Also suppress the global baseline when its position would land outside the
    // visible track (baselinePct < 3% or > 97%) — typical for shared-scale charts
    // where one row's value dwarfs the baseline (e.g. Engine=14 MB makes JS=1.77 kB
    // land at ~0.01% of track width, which renders in the row-label gutter to the
    // left of the bars). Per-row markers cover those cases instead.
    // Show the chart-wide global JS label/line whenever the baseline position
    // is inside the visible track. When values span orders of magnitude and the
    // baseline lands < 3% or > 97%, the global label would render in the gutter
    // outside the bars — suppress it in that case and rely on per-row markers.
    // Always show the chart-wide global JS label/line when a baseline exists.
    // The positioning code (positionAbsoluteBaseline) clamps the label inside the
    // track edges so even tiny baselinePct values (e.g. 0.012% on module-size
    // charts where JS=1.77 kB vs Engine=14.5 MB) land just inside the left edge.
    const showGlobalBaseline = (baselineValue > 0 || useRatioNorm) && !allRowsScalePerRow;

    if (showGlobalBaseline) {
      jsLabelEl.style.display = "";
      jsLineEl.style.display = "";
      jsLabelEl.textContent = baselineLabel;
    } else {
      jsLabelEl.style.display = "none";
      jsLineEl.style.display = "none";
    }

    const duration = 3293;
    const ease = (t) => 1 - (1 - t) * (1 - t);
    const barData = [];
    const baselineLinePct =
      baselineValue > 0 ? Math.min(100, Math.max(0, baselinePct)) : Math.min(100, Math.max(0, ratioNormBaselinePct));
    const baselineLabelPct =
      baselineValue > 0 ? Math.min(94, Math.max(6, baselinePct)) : Math.min(94, Math.max(6, ratioNormBaselinePct));
    const forceRowBaseline = absoluteRows.some((row) => row.compareFromBaseline);
    const showDelta = this.hasAttribute("show-delta");
    if (forceRowBaseline && baselineValue > 0) {
      jsLabelEl.style.display = "none";
      jsLineEl.style.display = "none";
    }

    const preparedRows = absoluteRows.map((row, index) => {
      const label = row.name || "unknown";
      // Use per-row baseline only when the global JS line/label isn't shown
      // — otherwise the two markers would overlap on the same bar.
      // Per-row baselines also fire when the row explicitly opts in
      // (compareFromBaseline) or when each row carries its own different baseline.
      const usePerRowBaseline =
        !showGlobalBaseline || !hasSharedBaseline || forceRowBaseline || row.scalePerRow === true;
      const rowBaselineValue = usePerRowBaseline ? this._rowBaselineValue(row) : 0;
      const rowExtraValue = Math.max(0, Number(row.extraValue ?? 0));
      const rowTotalValue = row.value + rowExtraValue;
      const scalePerRow = row.scalePerRow ?? !hasSharedBaseline;
      const rowScaleMax =
        rowBaselineValue > 0 && scalePerRow
          ? useRatioNorm
            ? maxRatio * rowBaselineValue
            : Math.max(rowTotalValue, rowBaselineValue, 1)
          : maxValue;
      const rowDeltaBaselineValue = rowBaselineValue > 0 ? rowBaselineValue : baselineValue;
      const targetValueLeft = (rowTotalValue / rowScaleMax) * 100;
      const targetBaselineLeft = rowBaselineValue > 0 ? (rowBaselineValue / rowScaleMax) * 100 : 0;
      const compareFromBaseline = Boolean(row.compareFromBaseline && rowBaselineValue > 0);
      const targetLeft = compareFromBaseline ? Math.min(targetBaselineLeft, targetValueLeft) : 0;
      const targetWidth = compareFromBaseline
        ? Math.abs(targetValueLeft - targetBaselineLeft)
        : (row.value / rowScaleMax) * 100;
      const targetExtraWidth = compareFromBaseline ? 0 : (rowExtraValue / rowScaleMax) * 100;
      const valueIsBelowBaseline = compareFromBaseline && rowTotalValue < rowBaselineValue;
      const gradientDirection = valueIsBelowBaseline ? "to left" : "to right";
      // The vertical line marker (bench-row-baseline) renders at targetBaselineLeft —
      // its true position inside the bar. The label text uses translateX(-50%) so
      // when the position is near the left edge (e.g. 0.012% on a module-size chart
      // where JS=1.77 kB and Engine=14.5 MB) the centered text hangs off the track
      // into the row-label gutter. Clamp the LABEL position only to keep the text
      // visible just inside the track edges (the line itself stays at true pos).
      const targetBaselineLabelLeft = targetBaselineLeft > 0 ? Math.min(97, Math.max(3, targetBaselineLeft)) : 0;
      const rowBaselineLabel = rowBaselineValue > 0 && index === 0 ? row.baselineLabel || baselineLabel : "";
      const valueLabel = this._valueLabel(row.label, rowTotalValue);
      const factorLabel = this._factorDeltaLabel(
        rowTotalValue,
        rowDeltaBaselineValue,
        showDelta || Boolean(row.showDelta),
        row.deltaKind || deltaKind,
      );
      return {
        compareFromBaseline,
        factorLabel,
        gradientDirection,
        label,
        rowBaselineLabel,
        rowBaselineValue,
        rowTotalValue,
        targetBaselineLabelLeft,
        targetBaselineLeft,
        targetExtraWidth,
        targetLeft,
        targetWidth,
        valueIsBelowBaseline,
        valueLabel,
      };
    });

    const factorWidth = Math.max(...preparedRows.map((row) => row.factorLabel.length), 0);
    if (factorWidth > 0) {
      container.style.setProperty("--bench-factor-width", `${factorWidth + 1}ch`);
    } else {
      container.style.removeProperty("--bench-factor-width");
    }

    for (const row of preparedRows) {
      const rowEl = document.createElement("div");
      rowEl.className = row.factorLabel ? "bench-row bench-row-has-factor" : "bench-row";
      rowEl.innerHTML = `
        <span class="bench-name">${row.label}</span>
        <div class="bench-track">
          <div class="bench-track-bg" style="width: 100%"></div>
          <div class="bench-fill" style="left: ${row.compareFromBaseline ? row.targetBaselineLeft : 0}%; width: 0%; background: linear-gradient(${row.gradientDirection}, rgba(255,255,255,0.1), rgba(255,255,255,0.9)); border-radius: 4px; position: absolute; height: 100%; top: 0"></div>
          <div class="bench-extra-fill" style="left: 0%; width: 0%; background: rgba(255,255,255,0.22); border-radius: 0 4px 4px 0; position: absolute; height: 100%; top: 0"></div>
          <div class="bench-row-baseline" style="left: ${row.targetBaselineLeft}%"></div>
          <span class="bench-row-baseline-label" style="left: ${row.targetBaselineLabelLeft}%; transform: ${row.targetBaselineLabelLeft < 10 ? "translate(0, -50%)" : row.targetBaselineLabelLeft > 90 ? "translate(-100%, -50%)" : "translate(-50%, -50%)"}">${row.rowBaselineLabel}</span>
          <div class="bench-errorbar" style="display: none"></div>
          <span class="bench-value" style="left: 10px; color: rgba(255,255,255,0)">${row.valueLabel}</span>
        </div>
        ${row.factorLabel ? `<span class="bench-factor">${row.factorLabel}</span>` : ""}
      `;
      container.appendChild(rowEl);
      barData.push({
        compareFromBaseline: row.compareFromBaseline,
        targetLeft: row.targetLeft,
        targetWidth: row.targetWidth,
        targetExtraWidth: row.targetExtraWidth,
        targetBaselineLeft: row.targetBaselineLeft,
        targetBaselineLabelLeft: row.targetBaselineLabelLeft,
        valueIsBelowBaseline: row.valueIsBelowBaseline,
        showRowBaseline: row.rowBaselineValue > 0 && !useRatioNorm,
        showRowBaselineLabel: Boolean(row.rowBaselineLabel) && !useRatioNorm,
        customLabel: row.valueLabel,
        fillEl: rowEl.querySelector(".bench-fill"),
        extraFillEl: rowEl.querySelector(".bench-extra-fill"),
        rowBaselineEl: rowEl.querySelector(".bench-row-baseline"),
        rowBaselineLabelEl: rowEl.querySelector(".bench-row-baseline-label"),
        valueEl: rowEl.querySelector(".bench-value"),
      });
    }

    function animateAbsoluteBars(ts) {
      if (!animateAbsoluteBars._start) animateAbsoluteBars._start = ts;
      const elapsed = ts - animateAbsoluteBars._start;
      const progress = Math.min(elapsed / duration, 1);
      const t = ease(progress);

      for (const d of barData) {
        const curWidth = t * d.targetWidth;
        const curExtraWidth = t * d.targetExtraWidth;
        const curLeft = d.compareFromBaseline ? d.targetBaselineLeft + t * (d.targetLeft - d.targetBaselineLeft) : 0;
        const curTotalWidth = curLeft + curWidth + curExtraWidth;
        d.fillEl.style.left = `${curLeft}%`;
        d.fillEl.style.width = `${curWidth}%`;
        d.extraFillEl.style.left = `${curLeft + curWidth}%`;
        d.extraFillEl.style.width = `${curExtraWidth}%`;
        d.rowBaselineEl.style.left = `${d.targetBaselineLeft}%`;
        d.rowBaselineEl.style.opacity = d.showRowBaseline ? `${0.25 + 0.65 * t}` : "0";
        d.rowBaselineLabelEl.style.left = `${d.targetBaselineLabelLeft}%`;
        // Position-aware horizontal anchoring + vertical centering (the label now
        // sits inside the bar at the baseline tick).
        d.rowBaselineLabelEl.style.transform =
          d.targetBaselineLabelLeft < 10
            ? "translate(0, -50%)"
            : d.targetBaselineLabelLeft > 90
              ? "translate(-100%, -50%)"
              : "translate(-50%, -50%)";
        d.rowBaselineLabelEl.style.opacity = d.showRowBaselineLabel ? `${0.25 + 0.65 * t}` : "0";
        const valueAnchor = d.valueIsBelowBaseline ? curLeft : curTotalWidth;
        d.valueEl.style.left = d.valueIsBelowBaseline
          ? `max(calc(${valueAnchor}% + 10px), 12%)`
          : `min(calc(${valueAnchor}% + 10px), calc(100% - 12ch))`;
        d.valueEl.style.color = `rgba(255,255,255,${(0.4 + t * 0.6).toFixed(2)})`;
        d.valueEl.textContent = d.customLabel;
      }

      if (progress < 1) requestAnimationFrame(animateAbsoluteBars);
    }

    const positionAbsoluteBaseline = () => {
      const track = container.querySelector(".bench-track");
      const wrap = shadow.querySelector(".bars-wrap");
      if (showGlobalBaseline && track && wrap && jsLabelEl && jsLineEl) {
        const wrapRect = wrap.getBoundingClientRect();
        const trackRect = track.getBoundingClientRect();
        // If the chart hasn't been laid out yet (display:none parent etc.),
        // the track has zero width — bail and let a later call retry.
        if (trackRect.width <= 0) return;
        const lineX = trackRect.left + (trackRect.width * baselineLinePct) / 100 - wrapRect.left;
        const rawLabelX = trackRect.left + (trackRect.width * baselineLabelPct) / 100 - wrapRect.left;
        const labelX = Math.min(
          Math.max(rawLabelX, trackRect.left - wrapRect.left + 8),
          trackRect.right - wrapRect.left - 8,
        );
        jsLabelEl.style.left = `${labelX}px`;
        jsLabelEl.style.transform = "translateX(-50%)";
        jsLineEl.style.left = `${lineX}px`;
      }
    };

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            observer.disconnect();
            // Reposition the global baseline now that the chart has real
            // dimensions, then start the bar animation.
            requestAnimationFrame(() => {
              positionAbsoluteBaseline();
              animateAbsoluteBars(performance.now());
            });
          }
        }
      },
      { threshold: 0.1 },
    );
    observer.observe(this);

    // First attempt — may run while the chart is still display:none in which
    // case it bails and the IntersectionObserver above will re-trigger when
    // the chart actually gains layout.
    requestAnimationFrame(positionAbsoluteBaseline);
    // Re-position on resize (chart may grow/shrink with the viewport).
    window.addEventListener("resize", positionAbsoluteBaseline);
    // Also re-position whenever the chart's size changes (e.g. when a parent
    // panel transitions from display:none to visible after data loads).
    if (typeof ResizeObserver !== "undefined") {
      const resizeObs = new ResizeObserver(() => positionAbsoluteBaseline());
      resizeObs.observe(this);
    }
  }

  _renderRatioRows(ratios) {
    const shadow = this.shadowRoot;
    const container = shadow.querySelector(".bench-bars");
    const jsLabelEl = shadow.querySelector(".js-label");
    const jsLineEl = shadow.querySelector(".js-line");
    const baselineLabel = this.getAttribute("baseline-label") || "JS";

    if (!container || !jsLabelEl || !jsLineEl || !Array.isArray(ratios) || ratios.length === 0) return;

    container.replaceChildren();
    jsLabelEl.style.display = "";
    jsLineEl.style.display = "";
    jsLabelEl.textContent = baselineLabel;

    // Render a secondary baseline (e.g. "+JIT" marker for the warm-JS reference
    // in merge-scenarios charts) if one was computed during ratio building.
    // We inject the secondary marker into the bars-wrap once per render.
    {
      const wrap = shadow.querySelector(".bars-wrap");
      const existing = wrap?.querySelectorAll(".js-line-secondary, .js-label-secondary");
      existing?.forEach((el) => el.remove());
      if (Number.isFinite(this._secondBaselineRatio) && this._secondBaselineRatio > 0 && wrap) {
        const line2 = document.createElement("div");
        line2.className = "js-line js-line-secondary";
        const label2 = document.createElement("div");
        label2.className = "js-label js-label-secondary";
        label2.textContent = this._secondBaselineLabel || "+JIT";
        wrap.appendChild(line2);
        wrap.appendChild(label2);
      }
    }

    // Scale max precedence:
    //   1. max-ratio="<n>" attribute — hardcoded shared scale across charts
    //   2. share-scale="benchmark" — derived from sibling scenarios on the same data file
    //   3. local max from this chart's ratios
    // Exception: live browser rerun ignores the hardcoded max-ratio so the
    // chart re-scales to the user's actual measurements (snapshot value may
    // be wildly different from machine-local results).
    const localMax = Math.max(...ratios.map((r) => r.ratio), 1.5);
    const maxRatioAttr = this._liveRerun ? 0 : Number(this.getAttribute("max-ratio") || 0);
    let maxRatio;
    if (maxRatioAttr > 0) {
      maxRatio = Math.max(maxRatioAttr, 1.5);
    } else if (Number.isFinite(this._sharedMaxRatio) && this._sharedMaxRatio > 0) {
      maxRatio = Math.max(this._sharedMaxRatio, 1.5);
    } else {
      maxRatio = localMax;
    }
    const maxPct = Math.ceil(maxRatio * 100);
    const scaleMax = Math.ceil(maxPct / 100) * 100;
    const jsPos = (100 / scaleMax) * 100; // JS baseline as % of track width

    // Build bar rows (start at 0, animate later)
    const barData = [];
    for (const row of ratios) {
      const ratio = row.ratio;
      const label = row.name || row.path?.replace(/^examples\/benchmarks\//, "").replace(/\.ts$/, "") || "unknown";

      // Speed bars start at 0 (left edge) and extend to where the value lands
      // on the absolute ratio scale. JS baseline marker stays at jsPos.
      const wasmPos = (ratio / (scaleMax / 100)) * 100;
      const targetLeft = 0;
      const targetWidth = wasmPos;

      const dist = Math.abs(ratio - 1) / Math.max(maxRatio - 1, 1);
      const edgeOpacity = (0.1 + dist * 0.9).toFixed(2);
      const baseOpacity = "0.1";
      // Bars now always grow rightward from 0, so the gradient is always "to right".
      const gradDir = "to right";
      const textOpacity = (0.4 + dist * 0.6).toFixed(2);
      // When the row carries an explicit lane colour (4-lane perf mode), use it
      // instead of the default white gradient. baseColor/edgeColor are CSS
      // colour strings with alpha already applied.
      const customBaseColor = row.fillColor || `rgba(255,255,255,${baseOpacity})`;
      const customEdgeColor = row.edgeColor || row.fillColor || null;

      const rowEl = document.createElement("div");
      rowEl.className = "bench-row";
      rowEl.innerHTML = `
        <span class="bench-name">${label}</span>
        <div class="bench-track">
          <div class="bench-track-bg" style="width: ${jsPos}%"></div>
          <div class="bench-fill" style="left: 0%; width: 0%; background: linear-gradient(${gradDir}, rgba(255,255,255,${baseOpacity}), rgba(255,255,255,0.1)); border-radius: 4px; position: absolute; height: 100%; top: 0"></div>
          <div class="bench-errorbar" style="left: 0%; width: 0%"></div>
          <span class="bench-value" style="left: 0%; padding-left: 6px; color: rgba(255,255,255,0)">0.0x</span>
        </div>
      `;
      container.appendChild(rowEl);

      barData.push({
        ratio,
        customLabel: row.label || null,
        targetLeft,
        targetWidth,
        gradDir,
        baseOpacity,
        edgeOpacity,
        textOpacity,
        customBaseColor,
        customEdgeColor,
        ratioStd: Number(row.ratioStd ?? 0),
        fillEl: rowEl.querySelector(".bench-fill"),
        errorEl: rowEl.querySelector(".bench-errorbar"),
        valueEl: rowEl.querySelector(".bench-value"),
      });
    }

    // Animation
    const duration = 3293;
    const ease = (t) => 1 - (1 - t) * (1 - t);
    const formatRatio = (r) => this._formatRatio(r);

    function animateBars(ts) {
      if (!animateBars._start) animateBars._start = ts;
      const elapsed = ts - animateBars._start;
      const progress = Math.min(elapsed / duration, 1);
      const t = ease(progress);

      for (const d of barData) {
        const curWidth = t * d.targetWidth;
        // Bars now always start at 0 (left edge) and animate width only.
        const curLeft = d.targetLeft;
        const curRatio = t * d.ratio;
        const scoreText = d.customLabel ? d.customLabel : formatRatio(curRatio);

        const curEdgeOp = (0.1 + t * (parseFloat(d.edgeOpacity) - 0.1)).toFixed(2);
        const curTextOp = (t * parseFloat(d.textOpacity)).toFixed(2);

        d.fillEl.style.left = curLeft + "%";
        d.fillEl.style.width = curWidth + "%";
        if (d.customEdgeColor) {
          // Lane-coloured bar: animate edge alpha by varying the gradient stop
          // alpha. We keep the colour fixed and let the existing dist→alpha
          // scaling stay visually consistent across lanes.
          d.fillEl.style.background = `linear-gradient(${d.gradDir}, ${d.customBaseColor}, ${d.customEdgeColor})`;
        } else {
          d.fillEl.style.background = `linear-gradient(${d.gradDir}, rgba(255,255,255,${d.baseOpacity}), rgba(255,255,255,${curEdgeOp}))`;
        }

        const stdRatio = Math.min(d.ratioStd || 0, Math.max(d.ratio - 0.01, 0), Math.max(scaleMax / 100 - d.ratio, 0));
        if (stdRatio > 0) {
          const stdLeft = (Math.max(d.ratio - stdRatio, 0.01) / (scaleMax / 100)) * 100;
          const stdRight = (Math.min(d.ratio + stdRatio, scaleMax / 100) / (scaleMax / 100)) * 100;
          const currentStdLeft = jsPos + t * (stdLeft - jsPos);
          const currentStdRight = jsPos + t * (stdRight - jsPos);
          d.errorEl.style.left = `${Math.min(currentStdLeft, currentStdRight)}%`;
          d.errorEl.style.width = `${Math.abs(currentStdRight - currentStdLeft)}%`;
          d.errorEl.style.opacity = `${0.25 + 0.55 * t}`;
        } else {
          d.errorEl.style.opacity = "0";
        }

        const barEnd = d.ratio >= 1 ? curLeft + curWidth : curLeft;
        if (d.ratio >= 1) {
          d.valueEl.style.left = `min(calc(${barEnd}% + 10px), calc(100% - 3.6ch))`;
          d.valueEl.style.removeProperty("right");
          d.valueEl.style.paddingLeft = "0";
          d.valueEl.style.paddingRight = "";
        } else {
          d.valueEl.style.left = `max(calc(${barEnd}% + 10px), 12%)`;
          d.valueEl.style.removeProperty("right");
          d.valueEl.style.paddingLeft = "0";
          d.valueEl.style.paddingRight = "";
        }
        d.valueEl.style.color = `rgba(255,255,255,${curTextOp})`;
        d.valueEl.textContent = scoreText;
      }

      if (progress < 1) requestAnimationFrame(animateBars);
    }

    // Trigger animation on scroll into view
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            observer.disconnect();
            requestAnimationFrame(animateBars);
          }
        }
      },
      { threshold: 0.3 },
    );
    observer.observe(this);

    // Position JS baseline line/label
    const positionBaseline = () => {
      const track = container.querySelector(".bench-track");
      const wrap = shadow.querySelector(".bars-wrap");
      if (track && wrap && jsLabelEl && jsLineEl) {
        const wrapRect = wrap.getBoundingClientRect();
        const trackRect = track.getBoundingClientRect();
        const jsX = trackRect.left + (trackRect.width * jsPos) / 100 - wrapRect.left;
        jsLabelEl.style.left = jsX + "px";
        jsLabelEl.style.transform = "translateX(-50%)";
        jsLineEl.style.left = jsX + "px";
        // Secondary baseline (+JIT) — positioned at jsPos * secondBaselineRatio
        const secondaryLine = wrap.querySelector(".js-line-secondary");
        const secondaryLabel = wrap.querySelector(".js-label-secondary");
        if (
          secondaryLine &&
          secondaryLabel &&
          Number.isFinite(this._secondBaselineRatio) &&
          this._secondBaselineRatio > 0
        ) {
          const secondaryPos = jsPos * this._secondBaselineRatio;
          const secX = trackRect.left + (trackRect.width * secondaryPos) / 100 - wrapRect.left;
          secondaryLine.style.left = secX + "px";
          secondaryLabel.style.left = secX + "px";
          secondaryLabel.style.transform = "translateX(-50%)";
        }
      }
    };
    requestAnimationFrame(positionBaseline);
    window.addEventListener("resize", positionBaseline);
  }

  async _rerunBrowserRuntime(snapshotSrc) {
    if (this._rerunInFlight) return;
    this._rerunInFlight = true;
    const rerunSrc = this.getAttribute("rerun-src") || snapshotSrc;
    const rerunButton = this.shadowRoot.querySelector(".rerun-button");
    const status = this.shadowRoot.querySelector(".chart-status");
    if (rerunButton) rerunButton.disabled = true;
    if (status) status.textContent = "Running full browser benchmark with in-page wasm-opt...";
    try {
      const measuredRows = await this._runSerialMeasurement(async () => {
        const manifestUrl = new URL(rerunSrc, window.location.href);
        const resp = await fetch(manifestUrl.href, { cache: "no-store" });
        if (!resp.ok) return [];

        const json = await resp.json();
        const benchmarks = json?.benchmarks ?? json;
        if (!Array.isArray(benchmarks) || benchmarks.length === 0) return [];

        const runtimeUrl = new URL("./loadtime/runtime.js", manifestUrl).href;
        const runtimeHelpers = await import(/* @vite-ignore */ runtimeUrl);
        const measured = [];
        for (const bench of benchmarks) {
          if (!bench?.jsUrl || !bench?.wasmUrl) continue;
          try {
            const jsUrl = new URL(bench.jsUrl, manifestUrl).href;
            const wasmUrl = new URL(bench.wasmUrl, manifestUrl).href;
            const row = await this._measureBrowserRuntime(bench, jsUrl, wasmUrl, runtimeHelpers);
            if (row.wasmUs <= 0 || row.jsUs <= 0) continue;
            measured.push({
              ...row,
              ratio: row.jsUs / row.wasmUs,
              ratioStd: Number(row.ratioStd ?? 0),
              label: `${(row.jsUs / row.wasmUs).toFixed(1)}x`,
            });
            await new Promise((resolve) => setTimeout(resolve, 80));
          } catch (error) {
            console.warn("[perf-benchmark-chart] browser runtime benchmark skipped", bench?.name, error);
          }
        }
        return measured;
      });

      if (this.isConnected && measuredRows.length > 0) {
        this.style.display = "";
        // Mark this as a live rerun so the renderer skips the hardcoded
        // max-ratio attribute and re-scales to the measured data.
        this._liveRerun = true;
        try {
          if ((this.getAttribute("mode") || "perf") === "runtime") {
            this._renderAbsoluteRows(
              measuredRows.map((row) => ({
                name: this._shortBenchmarkLabel(row),
                value: row.wasmUs,
                baselineValue: row.jsUs,
                label: this._formatDurationUs(row.wasmUs),
              })),
            );
          } else {
            this._renderRatioRows(measuredRows);
          }
        } finally {
          this._liveRerun = false;
        }
        if (status)
          status.textContent = `Updated with ${measuredRows.length} live browser benchmarks after in-page wasm-opt.`;
      } else if (status) {
        status.textContent = "No live browser benchmarks completed after in-page wasm-opt.";
      }
    } catch (error) {
      console.warn("[perf-benchmark-chart] browser runtime rerun failed", error);
      if (status) status.textContent = "Live browser benchmark failed.";
    } finally {
      if (rerunButton) rerunButton.disabled = false;
      this._rerunInFlight = false;
    }
  }

  async _load(src) {
    try {
      const resp = await fetch(src, { cache: "no-store" });
      if (!resp.ok) {
        this.style.display = "none";
        return;
      }
      const json = await resp.json();
      const mode = this.getAttribute("mode") || "perf";
      const benchmarkFilter = (this.getAttribute("benchmark") || "").trim();

      // Transform data based on mode into chart rows.
      let ratios;
      let absoluteRows = null;
      if (mode === "benchmark-runtime") {
        const rows = Array.isArray(json) ? json : [];
        if (rows.length === 0 || !benchmarkFilter) {
          this.style.display = "none";
          return;
        }
        const filtered = rows.filter((row) => row?.name === benchmarkFilter);
        const jsRow = filtered.find((row) => row?.strategy === "js");
        if (!jsRow || !(jsRow.medianMs > 0)) {
          this.style.display = "none";
          return;
        }
        // (#3904) A strategy the benchmark deliberately skips produces no row
        // at all and stays off the chart. A strategy that *failed* is recorded
        // with `status: "failed"` and zero timings — render it as a named,
        // zero-length "failed" bar so a broken lane is visible instead of
        // silently indistinguishable from an inapplicable one.
        //
        // (#3898) A third state: the lane ran and produced a number, but
        // `report.ts` proved that number physically impossible (below its
        // per-operation floor) and marked it `implausible`. Publishing it as a
        // speedup is the exact failure this issue is about — the page showed
        // "16,598x slower" for a JS baseline that TurboFan had hoisted out of
        // its own loop. Render it as a named "unverified" bar instead of a
        // ratio. If the JS baseline itself is implausible, it is the
        // denominator of every bar in the chart, so no bar here is meaningful.
        const baselineBad = jsRow.implausible === true;
        ratios = filtered
          .filter((row) => row?.strategy && row.strategy !== "js" && (row.medianMs > 0 || row.status === "failed"))
          .map((row) => {
            if (row.status === "failed") return { name: row.strategy, ratio: 0, label: "failed" };
            if (baselineBad || row.implausible === true) {
              return { name: row.strategy, ratio: 0, label: "unverified" };
            }
            return {
              name: row.strategy,
              ratio: jsRow.medianMs / row.medianMs,
              label: (jsRow.medianMs / row.medianMs).toFixed(1) + "x",
            };
          });
      } else if (mode === "runtime") {
        let rows = Array.isArray(json) ? json : [];
        if (benchmarkFilter) {
          rows = rows.filter((row) => {
            const path = String(row?.path || "");
            const shortPath = path.replace(/^examples\/benchmarks\//, "").replace(/\.ts$/, "");
            const shortName = String(row?.name || "");
            return shortPath === benchmarkFilter || shortName === benchmarkFilter || path === benchmarkFilter;
          });
        }
        if (rows.length === 0) {
          this.style.display = "none";
          return;
        }
        absoluteRows = rows
          .map((row) => ({
            name: this._shortBenchmarkLabel(row),
            value: Number(row?.wasmUs ?? 0),
            baselineValue: Number(row?.jsUs ?? 0),
            label: this._formatDurationUs(row?.wasmUs),
          }))
          .filter((row) => row.value > 0);
      } else if (mode === "module-size") {
        const benchmarks = json?.benchmarks ?? json;
        if (!Array.isArray(benchmarks) || benchmarks.length === 0) {
          this.style.display = "none";
          return;
        }
        absoluteRows = benchmarks
          .map((b) => ({
            name: b.label || b.name,
            value: Number(b.wasmSizeGzip ?? 0),
            baselineValue: Number(b.jsSizeGzip ?? 0),
            scalePerRow: false,
            label: this._formatBytes(b.wasmSizeGzip),
          }))
          .filter((row) => row.value > 0);
      } else if (mode === "size") {
        const benchmarks = json?.benchmarks ?? json;
        if (!Array.isArray(benchmarks) || benchmarks.length === 0) {
          this.style.display = "none";
          return;
        }
        ratios = benchmarks.map((b) => {
          const wasmBytes = b.wasmSizeGzip;
          const jsBytes = b.jsSizeGzip;
          const ratio = wasmBytes / Math.max(jsBytes, 1);
          return { name: b.label || b.name, ratio, label: ratio.toFixed(1) + "x" };
        });
      } else if (mode === "coldstart") {
        const benchmarks = json?.benchmarks ?? json;
        if (!Array.isArray(benchmarks) || benchmarks.length === 0) {
          this.style.display = "none";
          return;
        }
        ratios = benchmarks.map((b) => {
          const wasmMs = b.wasmCompileMs;
          const jsMs = b.jsParseMs;
          const ratio = jsMs / Math.max(wasmMs, 0.0001);
          return { name: b.name, ratio };
        });
      } else if (mode === "loadtime") {
        const benchmarks = json?.benchmarks ?? json;
        if (!Array.isArray(benchmarks) || benchmarks.length === 0) {
          this.style.display = "none";
          return;
        }
        ratios = await this._runSerialMeasurement(async () => {
          const manifestUrl = new URL(src, window.location.href);
          const runtimeUrl = new URL("./loadtime/runtime.js", manifestUrl).href;
          const { buildImports, instantiateWasmStreaming } = await import(/* @vite-ignore */ runtimeUrl);
          const measured = [];
          for (const bench of benchmarks) {
            if (!bench?.jsUrl || !bench?.wasmUrl) continue;
            try {
              const jsUrl = new URL(bench.jsUrl, manifestUrl).href;
              const wasmUrl = new URL(bench.wasmUrl, manifestUrl).href;
              await this._measureJsModuleLoad(jsUrl, 1);
              await this._measureWasmLoad(bench, wasmUrl, instantiateWasmStreaming, buildImports, 1);
              const jsMetrics = await this._measureJsModuleLoad(jsUrl, 7);
              const wasmMetrics = await this._measureWasmLoad(
                bench,
                wasmUrl,
                instantiateWasmStreaming,
                buildImports,
                7,
              );
              if (jsMetrics.median <= 0 || wasmMetrics.median <= 0) continue;
              const ratioSamples = jsMetrics.samples.map((jsSample, index) => {
                const wasmSample = wasmMetrics.samples[index] ?? wasmMetrics.median;
                return jsSample / Math.max(wasmSample, 0.0001);
              });
              const ratio = jsMetrics.median / wasmMetrics.median;
              measured.push({
                name: bench.name,
                ratio,
                ratioStd: this._stddev(ratioSamples),
                label: ratio.toFixed(1) + "x",
              });
              await new Promise((resolve) => setTimeout(resolve, 80));
            } catch (error) {
              console.warn("[perf-benchmark-chart] loadtime benchmark skipped", bench?.name, error);
            }
          }
          return measured;
        });
      } else if (mode === "absolute-lower-better") {
        let rows = Array.isArray(json) ? json : (json?.benchmarks ?? []);
        if (!Array.isArray(rows) || rows.length === 0) {
          this.style.display = "none";
          return;
        }
        // Apply the same benchmark + src-filter the perf-mode path uses, so
        // per-test absolute charts (e.g. module size / cold start per test)
        // narrow down to one benchmark's rows instead of rendering all of them.
        if (benchmarkFilter) {
          rows = rows.filter((row) => {
            const path = String(row?.path || "");
            const shortPath = path.split("/").pop() || "";
            const shortName = String(row?.name || "");
            return shortPath === benchmarkFilter || shortName === benchmarkFilter || path === benchmarkFilter;
          });
        }
        const srcFilterAbs = (this.getAttribute("src-filter") || "").trim().toLowerCase();
        if (srcFilterAbs) {
          rows = rows.filter((row) =>
            `${row?.scenario ?? ""} ${row?.name ?? ""} ${row?.label ?? ""} ${row?.path ?? ""}`
              .toLowerCase()
              .includes(srcFilterAbs),
          );
        }
        absoluteRows = rows
          .map((row) => ({
            name: row.name,
            value: Number(row?.wasmUs ?? row?.value ?? 0),
            extraValue: Number(row?.extraValue ?? row?.sharedValue ?? 0),
            jsUs: Number(row?.jsUs ?? row?.baselineUs ?? 0),
            compareFromBaseline: this.hasAttribute("compare-from-baseline") || Boolean(row?.compareFromBaseline),
            scalePerRow: typeof row?.scalePerRow === "boolean" ? row.scalePerRow : undefined,
            label: row.label || null,
          }))
          // Keep rows with value > 0 (real measurements) AND rows with a
          // descriptive label (e.g. "n/a (compile-error)") so missing-data lanes
          // stay visible as zero-width bars with the explanatory label.
          .filter((row) => row.value > 0 || (typeof row.label === "string" && row.label.length > 0));
      } else {
        // Default perf mode: ratio = jsUs / wasmUs (higher = wasm faster)
        let rows = Array.isArray(json) ? json : [];
        if (benchmarkFilter) {
          rows = rows.filter((row) => {
            const path = String(row?.path || "");
            const shortPath = path.replace(/^examples\/benchmarks\//, "").replace(/\.ts$/, "");
            const shortName = String(row?.name || "");
            return shortPath === benchmarkFilter || shortName === benchmarkFilter || path === benchmarkFilter;
          });
        }
        // Capture rows after benchmark filter but BEFORE src-filter (scenario)
        // so charts with `share-scale="benchmark"` can compute a max from all
        // scenarios of the same test — making cold/warm charts share a scale.
        const shareScale = (this.getAttribute("share-scale") || "").trim();
        const scopeRows = shareScale === "benchmark" ? [...rows] : null;
        const srcFilter = (this.getAttribute("src-filter") || "").trim().toLowerCase();
        if (srcFilter) {
          rows = rows.filter((row) =>
            `${row?.scenario ?? ""} ${row?.name ?? ""} ${row?.label ?? ""} ${row?.path ?? ""}`
              .toLowerCase()
              .includes(srcFilter),
          );
        }
        if (rows.length === 0) {
          this.style.display = "none";
          return;
        }
        ratios = [];
        // Lane definitions: when any of these alternate fields are present we
        // fan a row out into multiple lanes (one bar per lane). Labels are
        // generic execution-model categories (AOT / Interpreter / Engine) —
        // bars are monochrome and distinguished by their label, not by color,
        // so the comparison doesn't visually privilege any one lane.
        const LANES = [
          { key: "wasmUs", label: "AOT" },
          { key: "javyUs", label: "Interpreter" },
          { key: "starlingMonkeyUs", label: "Engine" },
        ];
        const anyHasExtraLanes = rows.some(
          (row) => Number(row?.javyUs ?? 0) > 0 || Number(row?.starlingMonkeyUs ?? 0) > 0,
        );
        // When the caller has filtered to a single benchmark AND there are
        // multiple distinct scenarios in the row set, prefix each bar with the
        // scenario so cold/warm bars stay distinguishable inside the same chart.
        // When the chart has already been narrowed to one scenario (cold OR warm),
        // the prefix is redundant.
        const distinctBenchNames = new Set(rows.map((row) => String(row?.name ?? "")));
        const distinctScenarios = new Set(rows.map((row) => String(row?.scenario ?? "")).filter(Boolean));
        const showScenarioInLabel = distinctBenchNames.size === 1 && distinctScenarios.size > 1;
        // merge-scenarios mode: when set, fan rows by lane AND by scenario, so a
        // single chart shows AOT/Interpreter/Engine × cold/warm = 6 bars. The
        // ratio uses the COLD jsUs across all bars (so warm bars show the
        // speedup over cold-JS, not their own scenario's JS), and the cold-row
        // jsUs becomes the primary baseline while the warm-row jsUs becomes a
        // secondary "+JIT" baseline.
        const mergeScenarios = this.hasAttribute("merge-scenarios");
        // Find the cold jsUs and warm jsUs (per row scenario) used for the two baselines
        let coldJsUs = 0;
        let warmJsUs = 0;
        for (const row of rows) {
          const js = Number(row?.jsUs ?? 0);
          const sc = String(row?.scenario ?? "").toLowerCase();
          if (sc === "cold" && js > 0) coldJsUs = js;
          else if (sc === "warm" && js > 0) warmJsUs = js;
        }
        // Stash the secondary baseline ratio so the renderer can draw a "+JIT" marker.
        this._secondBaselineRatio = mergeScenarios && coldJsUs > 0 && warmJsUs > 0 ? coldJsUs / warmJsUs : null;
        this._secondBaselineLabel = this.getAttribute("second-baseline-label") || "+JIT";

        for (const row of rows) {
          // Default: each chart uses its row's own jsUs (cold-speed vs cold-JS,
          // warm-speed vs warm-JS). Charts that need a cross-scenario shared
          // baseline opt in via baseline-source="cold" — they then prefer
          // row.coldJsUs as the denominator. In merge-scenarios mode the chart
          // always uses cold jsUs so cold and warm bars share a denominator.
          const rowScenario = String(row?.scenario ?? "").toLowerCase();
          const baselineSource = this.getAttribute("baseline-source");
          const jsUs = mergeScenarios
            ? coldJsUs > 0
              ? coldJsUs
              : Number(row?.jsUs ?? 0)
            : baselineSource === "cold"
              ? Number(row?.coldJsUs ?? row?.jsUs ?? 0)
              : Number(row?.jsUs ?? 0);
          if (jsUs <= 0) continue;
          if (anyHasExtraLanes) {
            let baseName = "";
            if (mergeScenarios && rowScenario) {
              // Bars carry the lane label; the scenario goes into color/tag, not the label.
              baseName = "";
            } else if (showScenarioInLabel) {
              baseName = String(row?.scenario ?? "");
            } else if (distinctBenchNames.size > 1) {
              baseName = String(row?.name ?? "");
            }
            for (const lane of LANES) {
              const us = Number(row?.[lane.key] ?? 0);
              if (us <= 0) continue;
              // Assign per-scenario fill/edge colors when merging.
              const isCold = rowScenario === "cold";
              const isWarm = rowScenario === "warm";
              const fillColor = isCold ? "rgba(70, 140, 255, 0.35)" : isWarm ? "rgba(250, 100, 85, 0.35)" : null;
              const edgeColor = isCold ? "rgba(120, 180, 255, 1.0)" : isWarm ? "rgba(255, 150, 130, 1.0)" : null;
              const scenarioSuffix = mergeScenarios ? ` (${rowScenario})` : "";
              ratios.push({
                ...row,
                name: (baseName ? `${baseName} — ${lane.label}` : lane.label) + scenarioSuffix,
                ratio: jsUs / us,
                ratioStd: 0,
                lane: lane.key,
                scenario: rowScenario,
                fillColor,
                edgeColor,
              });
            }
          } else {
            const wasmUs = Number(row?.wasmUs ?? 0);
            if (wasmUs <= 0) continue;
            ratios.push({ ...row, ratio: jsUs / wasmUs, ratioStd: Number(row?.ratioStd ?? 0) });
          }
        }
        // share-scale="benchmark": compute the max ratio across all scenarios
        // of this benchmark so e.g. a cold-speed chart and a warm-speed chart
        // for the same test share an identical x-axis scale.
        if (scopeRows && scopeRows.length > 0) {
          let scopeMax = 0;
          for (const row of scopeRows) {
            const jsUs = Number(row?.jsUs ?? 0);
            if (jsUs <= 0) continue;
            if (anyHasExtraLanes) {
              for (const lane of LANES) {
                const us = Number(row?.[lane.key] ?? 0);
                if (us > 0) scopeMax = Math.max(scopeMax, jsUs / us);
              }
            } else {
              const wasmUs = Number(row?.wasmUs ?? 0);
              if (wasmUs > 0) scopeMax = Math.max(scopeMax, jsUs / wasmUs);
            }
          }
          this._sharedMaxRatio = scopeMax > 0 ? scopeMax : null;
        } else {
          this._sharedMaxRatio = null;
        }
      }
      const isAbsoluteMode = mode === "absolute-lower-better" || mode === "runtime" || mode === "module-size";
      if (isAbsoluteMode) {
        if (!absoluteRows || absoluteRows.length === 0) {
          this.style.display = "none";
          return;
        }
      } else if (!ratios || ratios.length === 0) {
        this.style.display = "none";
        return;
      }

      if (isAbsoluteMode) {
        this._renderAbsoluteRows(absoluteRows);
        return;
      }

      this._renderRatioRows(ratios);
    } catch (error) {
      console.error("[perf-benchmark-chart] render failed", error);
      this.style.display = "none";
    }
  }
}

customElements.define("perf-benchmark-chart", PerfBenchmarkChart);
