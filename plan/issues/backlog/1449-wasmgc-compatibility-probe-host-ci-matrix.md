---
id: 1449
title: "WasmGC compatibility probe + serverless host CI matrix"
status: backlog
created: 2026-05-20
updated: 2026-05-20
priority: high
feasibility: easy
reasoning_effort: medium
task_type: infrastructure
area: tooling
language_feature: n/a
depends_on: []
related: [1448]
---

# #1449 — WasmGC compatibility probe + serverless host CI matrix

## Problem

WasmGC support across serverless and WASI host runtimes is **not the same
thing as stable**. The underlying Wasm engine (Wasmtime) classifies WasmGC
as Tier 2: feature-complete from the spec perspective, on-by-default in
`Config`, but spec-stability and backward-compat are not yet committed
upstream and fuzzing/hardening is ongoing.

The hosts that embed Wasmtime inherit this status — and additionally each
host pins to a specific Wasmtime version, applies its own `Config`
choices, and may or may not enable the GC proposal in production. Verified
version pins as of 2026-05-20:

- Fermyon Spin / Cloud: `wasmtime = "44.0.0"`
- Fastly Viceroy (local dev runtime): `wasmtime = "39.0.2"`
- Fastly production Compute@Edge runtime: proprietary, not publicly
  documented

Other production runtimes (Microsoft Hyperlight, AWS Lambda Wasm, custom
embedded Wasmtime in vertical-specific products) have similar opacity.

We compile WasmGC. **If the target host doesn't enable the proposal,
nothing js2wasm produces will instantiate.** Today there is no
operational discipline that catches this before the customer does.

## Proposed approach

1. **A small WasmGC probe module** — a 200-byte `.wasm` artefact that
   uses `struct.new`, `struct.get`, `i31.new` and one `ref.cast`. If a
   host instantiates and runs it, WasmGC is enabled; if instantiation
   fails with `LinkError` / `CompileError` / `unsupported feature`,
   it is not.

   ```wat
   (module
     (type $box (struct (field $v i32)))
     (func (export "probe") (result i32)
       (struct.get $box $v
         (struct.new $box (i32.const 42)))))
   ```

2. **A CI matrix** that deploys the probe to each supported serverless
   / WASI host and reports pass/fail. Targets to cover initially:

   - Cloudflare Workers (workerd)
   - Fastly Compute@Edge (`fastly compute publish` to a free-tier
     account)
   - Fermyon Cloud (`spin deploy`)
   - Wasmer Edge
   - wasmCloud (if accessible)
   - Local Wasmtime (`wasmtime run probe.wasm` — known-good baseline)
   - Local Spin (`spin up probe.wasm` — known-good baseline)

3. **Result publication.** Per-host pass/fail + Wasmtime version
   detected, on a public status page (small static page in
   `public/website/` or similar). Honest, reproducible, refreshes
   nightly.

4. **Regression alerting.** When a host that previously passed starts
   failing — they bumped their Wasmtime to a version with breaking
   GC changes, or they disabled the proposal — surface the regression
   automatically.

## Acceptance criteria

- Probe module artefact (`.wat` source + built `.wasm`) committed to the
  repo.
- CI workflow runs the probe against each listed host and records
  pass/fail.
- Public status page (or `benchmarks/results/`-style JSON) records the
  matrix.
- Regression on any host's WasmGC support surfaces in CI within 24h.
- The matrix is referenced from the host docs (`labs/docs/hosts/*.md`
  and the public `public/website/docs/`-side host targeting page).

## Notes

This is the **single highest-leverage operational discipline** for our
WASI / serverless deployment story. The architectural pitch ("KB-scale
WasmGC modules, no engine") assumes the target host *runs* WasmGC. The
probe + matrix turns that assumption into a verified, monitored
property. Without it, every "supports WasmGC" claim in our public
materials is a posture, not a measurement.

Pairs naturally with #13 (public benchmark methodology RFC) — the
benchmark methodology and the compatibility probe both belong to the
"measurement before marketing" discipline.
