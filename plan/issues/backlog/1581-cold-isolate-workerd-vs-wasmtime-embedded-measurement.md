---
id: 1581
title: "Add cold-isolate scenario alongside cold-process: measure via workerd (V8) and wasmtime-as-library (Wasm)"
status: ready
created: 2026-05-21
priority: medium
feasibility: medium
reasoning_effort: high
task_type: benchmark
area: benchmarks, methodology
goal: benchmark-credibility
related: [1125, 1210]
origin: methodology gap surfaced 2026-05-21 while wiring cold/warm + size + cold-start per-test charts
---

# #1581 — Cold-isolate measurement (workerd + wasmtime-as-library)

## Context

The landing-page benchmark group currently has four charts per program:

- cold process (fresh OS process per request) ← renamed from "cold isolate"
  to match what's actually measured: `node script.js` / `wasmtime run script.cwasm`
  start-to-finish wall time
- warm isolate (instance reused)
- module size
- cold start (also process-level)

The "cold process" numbers conflate two scenarios that the deployment model
distinguishes:

1. **Cold OS process** — `node` starts, parses, JITs, runs. ~20–25 ms baseline
   from process startup alone, regardless of program complexity. Realistic for
   AWS Lambda's classic VM-per-invocation model and `npx`-style CLI use.
2. **Cold isolate inside a long-lived host** — workerd (Cloudflare Workers)
   or wasmtime-as-library (Fastly Compute, Shopify Functions). The host is
   already running; per-request the host spawns a fresh V8 isolate or wasmtime
   instance. ~5 ms or less because process startup is amortized to zero.

For edge-serverless framing (Workers / Fastly / Shopify Functions), cold
isolate is the more honest metric. Today's chart shows cold process numbers
under a header that suggests an edge-serverless story, which overstates the
V8 cold-start cost and understates the per-isolate startup story for AOT.

## Goal

Add a second cold-start chart per program: `cold isolate (fresh instance inside
running host)`, alongside the existing `cold process` chart. Keep both — they
model different deployments.

## Implementation outline

### V8 lane

Use **workerd** (`@cloudflare/workerd` from npm or build from source). Driver:

```javascript
// run-workerd-coldstart.mjs
import { startWorker, stopWorker } from "@cloudflare/workerd"; // pseudocode

const workerCode = await fs.readFile("benchmarks/competitive/programs/fib.js", "utf8");
await startWorker({ entryPoint: workerCode });

// Measure: per-iteration, create a fresh isolate context and run.
for (let i = 0; i < runs; i++) {
  const t0 = performance.now();
  await createIsolateAndInvoke(workerCode, args);
  results.push(performance.now() - t0);
}
```

Alternative: Node.js `vm.createContext({})` is a poor man's isolate proxy
(same V8 process, fresh context). Faster to wire than workerd, but doesn't
match workerd's exact tier-up policy. Useful as a sanity check.

### Wasm lanes (AOT / Interpreter / Engine)

Use **wasmtime-as-library** via `@bytecodealliance/wasmtime` (Node.js binding)
or the Rust `wasmtime` crate from a driver process. The driver stays alive;
each "request" creates a fresh `wasmtime::Instance` from the pre-compiled
.cwasm:

```javascript
import { Engine, Module, Linker, Store } from "@bytecodealliance/wasmtime";

const engine = new Engine();
const module = Module.fromFile(engine, "fib.cwasm");

for (let i = 0; i < runs; i++) {
  const t0 = performance.now();
  const store = new Store(engine);
  const linker = new Linker(engine);
  const instance = linker.instantiate(store, module);
  instance.exports.run(args);
  results.push(performance.now() - t0);
}
```

For the Interpreter / Engine lanes, preload the same plugin / component the
existing harness uses.

### Data + chart wiring

- New JSON: `benchmarks/results/wasm-host-wasmtime-cold-isolate-per-test.json`
  (same schema as the existing per-test cold-start file)
- New chart panel per test: `<perf-benchmark-chart src="...cold-isolate..."
  title="cold isolate (fresh instance in running host)" ...>`
- Keep the existing `cold process` chart unchanged (different scenario)
- Update the per-test section subcopy to explain the two scenarios

## Acceptance criteria

- [ ] `cold isolate` measurements gathered for V8 (workerd) and Wasm
      (wasmtime-as-library) for the four benchmark programs
- [ ] Per-test data file committed
- [ ] Per-test panels added under each `bench-test-group` in `index.html`
- [ ] Legend / `lanesProvenance` documents:
      - The host process being warm (not in measurement)
      - Per-isolate setup steps included in the measurement
      - The V8 tier policy used (workerd default is Ignition→Liftoff→Sparkplug→Turbofan;
        for cold-isolate we want first-call latency, which means Ignition only)
- [ ] No regression of existing `cold process` numbers (different scenario, both kept)

## Notes

- workerd is open source and ships precompiled binaries. The npm package
  `@cloudflare/workerd` provides Linux/macOS binaries.
- The wasmtime Node binding is `@bytecodealliance/jco` for components or
  `wasmtime` (Rust) via a Node bridge for raw modules. Pick whichever exposes
  the lowest-friction "create instance from pre-compiled .cwasm" call path.
- This is benchmark-credibility work, not a feature change. The chart will
  show a more honest "edge serverless" comparison that better matches what
  Cloudflare / Fastly / Shopify Functions actually do per request.
