const statusEl = document.getElementById("status");
const resultEl = document.getElementById("result");
const sandboxRoot = document.getElementById("sandbox-root");
const MANIFEST_URL = "./results/loadtime-benchmarks.json";
const WARM_CALLS = 80;
const WARMUP_ROUNDS = 2;
const MEASURED_ROUNDS = 9;

function setStatus(text) {
  if (statusEl) statusEl.textContent = text;
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function stddev(values) {
  if (values.length <= 1) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function timeIt(fn, iterations) {
  const t0 = performance.now();
  for (let i = 0; i < iterations; i++) fn();
  return performance.now() - t0;
}

function calibrate(fn) {
  let iterations = 0;
  const t0 = performance.now();
  while (performance.now() - t0 < 100) {
    fn();
    iterations++;
  }
  return Math.max(10, Math.ceil((iterations / 100) * 300));
}

function snapshotSandboxState() {
  return {
    sandboxHtml: sandboxRoot?.innerHTML ?? "",
    bodyBackground: document.body.style.background,
    bodyColor: document.body.style.color,
  };
}

function restoreSandboxState(state) {
  if (sandboxRoot) sandboxRoot.innerHTML = state.sandboxHtml;
  document.body.style.background = state.bodyBackground;
  document.body.style.color = state.bodyColor;
}

async function importFreshModule(url) {
  const bust = `${url}${url.includes("?") ? "&" : "?"}runtime=${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return import(/* @vite-ignore */ bust);
}

async function measureEntry(entry, runtimeHelpers, manifestUrl) {
  const exportName = entry.exportName || `bench_${entry.name}`;
  const jsUrl = new URL(entry.jsUrl, manifestUrl).href;
  const wasmUrl = new URL(entry.wasmUrl, manifestUrl).href;
  const jsModule = await importFreshModule(jsUrl);
  const jsFn = jsModule?.[exportName];
  if (typeof jsFn !== "function") {
    throw new Error(`JS export ${exportName} missing for ${entry.name}`);
  }

  const imports = runtimeHelpers.buildImports(
    entry.imports ?? [],
    {
      document,
      window,
      performance,
      globalThis,
    },
    entry.stringPool ?? [],
  );
  const wasmBytes = new Uint8Array(await (await fetch(wasmUrl, { cache: "no-store" })).arrayBuffer());
  const wasmResult = await runtimeHelpers.instantiateWasm(
    wasmBytes,
    imports.env,
    imports.string_constants,
    imports.string_constants16,
  );
  imports.setInstance?.(wasmResult.instance);
  const wasmFn = wasmResult.instance.exports?.[exportName];
  if (typeof wasmFn !== "function") {
    throw new Error(`Wasm export ${exportName} missing for ${entry.name}`);
  }

  const bodyState = snapshotSandboxState();
  try {
    for (let i = 0; i < WARM_CALLS; i++) {
      wasmFn();
      jsFn();
    }

    const iterations = calibrate(wasmFn);
    for (let i = 0; i < WARMUP_ROUNDS; i++) {
      timeIt(wasmFn, iterations);
      timeIt(jsFn, iterations);
    }

    const wasmSamplesUs = [];
    const jsSamplesUs = [];
    const ratioSamples = [];
    for (let i = 0; i < MEASURED_ROUNDS; i++) {
      const wasmUs = (timeIt(wasmFn, iterations) / iterations) * 1000;
      const jsUs = (timeIt(jsFn, iterations) / iterations) * 1000;
      wasmSamplesUs.push(wasmUs);
      jsSamplesUs.push(jsUs);
      ratioSamples.push(jsUs / Math.max(wasmUs, 0.000001));
    }

    return {
      name: entry.name,
      path: entry.path,
      wasmUs: median(wasmSamplesUs),
      jsUs: median(jsSamplesUs),
      wasmStdUs: stddev(wasmSamplesUs),
      jsStdUs: stddev(jsSamplesUs),
      ratioStd: stddev(ratioSamples),
      warmupRounds: WARMUP_ROUNDS,
      measuredRounds: MEASURED_ROUNDS,
      runtimeEnvironment: "browser",
    };
  } finally {
    restoreSandboxState(bodyState);
  }
}

// Per-benchmark progress trace exposed so the driving Node script can poll the
// page state between Playwright `eval` invocations (see #1392). Each entry has
// {ts, type: "start"|"done"|"error", name, message?}. The driver uses this to
// detect per-benchmark hangs and identify which entry stalled.
window.__ts2wasmBenchmarkProgress = [];
window.__ts2wasmBenchmarkState = { running: false, done: false, error: null, result: null };

function recordProgress(event) {
  try {
    window.__ts2wasmBenchmarkProgress.push({ ts: Date.now(), ...event });
    if (typeof console !== "undefined") {
      console.log(`[bench-progress] ${event.type} ${event.name ?? ""}`);
    }
  } catch {
    // Never let progress logging break a benchmark run.
  }
}

export async function runBrowserRuntimeBenchmarks() {
  window.__ts2wasmBenchmarkProgress = [];
  window.__ts2wasmBenchmarkState = { running: true, done: false, error: null, result: null };
  recordProgress({ type: "start", name: "__manifest__" });
  setStatus("Loading runtime benchmark manifest...");
  const manifestUrl = new URL(MANIFEST_URL, window.location.href);
  const manifest = await fetch(manifestUrl, { cache: "no-store" }).then((res) => res.json());
  const entries = (manifest?.benchmarks ?? []).filter((entry) => entry?.runtimeEnvironment === "browser");
  const runtimeHelpers = await importFreshModule(new URL("./results/loadtime/runtime.js", window.location.href).href);
  recordProgress({ type: "done", name: "__manifest__", count: entries.length });

  const results = [];
  for (const entry of entries) {
    setStatus(`Measuring ${entry.name}...`);
    recordProgress({ type: "start", name: entry.name });
    try {
      const row = await measureEntry(entry, runtimeHelpers, manifestUrl);
      results.push(row);
      recordProgress({ type: "done", name: entry.name });
    } catch (error) {
      const message = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
      recordProgress({ type: "error", name: entry.name, message });
      window.__ts2wasmBenchmarkState.error = `Benchmark ${entry.name} failed: ${message}`;
      window.__ts2wasmBenchmarkState.running = false;
      window.__ts2wasmBenchmarkState.done = true;
      throw error;
    }
  }

  setStatus(`Done. Measured ${results.length} browser runtime benchmark${results.length === 1 ? "" : "s"}.`);
  const json = JSON.stringify(results, null, 2);
  if (resultEl) resultEl.textContent = json;
  window.__ts2wasmBenchmarkState.result = results;
  window.__ts2wasmBenchmarkState.running = false;
  window.__ts2wasmBenchmarkState.done = true;
  return results;
}

window.__ts2wasmRunBrowserRuntimeBenchmarks = runBrowserRuntimeBenchmarks;

// Fire-and-forget kick-off used by the Node driver. Stores the in-flight
// promise on the window so the driver can poll progress with subsequent eval
// calls without ever blocking inside a single Playwright invocation (#1392).
window.__ts2wasmStartBrowserRuntimeBenchmarks = function startBrowserRuntimeBenchmarks() {
  if (window.__ts2wasmBenchmarkPromise) {
    return "already-running";
  }
  window.__ts2wasmBenchmarkPromise = runBrowserRuntimeBenchmarks().catch((error) => {
    const message = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
    window.__ts2wasmBenchmarkState.error = message;
    window.__ts2wasmBenchmarkState.running = false;
    window.__ts2wasmBenchmarkState.done = true;
  });
  return "started";
};

window.__ts2wasmPollBrowserRuntimeBenchmarks = function pollBrowserRuntimeBenchmarks() {
  return JSON.stringify({
    progress: window.__ts2wasmBenchmarkProgress,
    state: {
      running: window.__ts2wasmBenchmarkState.running,
      done: window.__ts2wasmBenchmarkState.done,
      error: window.__ts2wasmBenchmarkState.error,
      hasResult: window.__ts2wasmBenchmarkState.result != null,
    },
  });
};

window.__ts2wasmCollectBrowserRuntimeBenchmarks = function collectBrowserRuntimeBenchmarks() {
  return JSON.stringify(window.__ts2wasmBenchmarkState.result ?? []);
};
