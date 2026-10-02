---
id: 6749
title: "S3-h: npm-compat regime lane parity — packages that measure on the host lane must measure, with the same checksum, on the native regime"
status: ready
created: 2026-09-29
updated: 2026-09-29
priority: critical
horizon: l
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen, runtime, host-interop, testing
language_feature: npm-compat
goal: architecture
sprint: current
parent: 5385
depends_on: [6686, 6707]
related: [3988, 4398, 4401, 6708]
---

# #6749 — S3-h: npm-compat parity for the native regime

Slice S3-h of the #5385 "Implementation Plan v2" and the **product bar**
for S6 (#6708 evidence item 3). `benchmarks/results/npm-compat.json`
generated 2026-09-28T23:58Z (after S5 made the regime the default for
native-first) — perf lanes `jsHost` (host-assisted) vs `jsHostNative`
(regime):

| package | host lane | regime lane | diagnostic |
| --- | --- | --- | --- |
| clsx | measured | **measured** | — |
| uuid | measured | compile-error | policy rejected `env::__crypto_get_random_values`, `env::__crypto_random_uuid` (unknown, #4401) |
| moment | measured | runtime-error | `WebAssembly.instantiate(): Import #20 "js2wasm:runtime-eval": module is not an object or function` |
| react | measured | runtime-error | `ReferenceError: require is not defined` |
| cookie | measured | **result-mismatch** | `cookie checksum mismatch: 0 !== 1` |
| hono | measured | **result-mismatch** | `checksum mismatch: Wasm 1, Node 9` |
| redux | measured | **result-mismatch** | `checksum mismatch: Wasm NaN, Node 7` |
| acorn | measured | runtime-error | `TypeError: Cannot access property on null or undefined at 438:67` |
| marked | measured | runtime-error | `[object WebAssembly.Exception]` |
| lit | measured | runtime-error | `[object WebAssembly.Exception]` |

test262 is not representative of these packages' shapes (dynamic
`require`, crypto, checksum workloads over real object graphs); this slice
is where the "merge, don't lose capability" promise is actually tested.
Order by kind, cheapest and most diagnostic first:

## A. Wiring and classification (mechanical, do first)

1. **uuid** — `__crypto_get_random_values` / `__crypto_random_uuid` are
   platform capabilities (randomness), not semantics: classify them in
   `src/host-import-policy.ts` as `platform-capability`/`randomness`
   (owner 4398, no native fallback), like `Math.random` and WASI
   `random_get`. Verify the runtime binds them through the capability
   adapter under native-first.
2. **moment** — the npm perf harness instantiates the regime module
   without attaching `js2wasm:runtime-eval`; reuse the test262 seam's
   feature-detected attachment (`scripts/test262-import-object.mjs`
   `attachConditionalImportNamespaces`) in
   `scripts/generate-npm-compat-report.mjs`'s regime lane, linking the
   same QuickJS provider the test262 lane uses.
3. **react** — `require` under the regime: the host lane satisfies it via
   the `node_builtin` capability; find why the regime build resolves
   `require` as a bare global read instead of the declared Node capability
   (a `ctx.standalone`-gated arm in the CJS rewrite / `declared_global`
   path, probably `src/cjs-rewrite.ts` or `src/codegen/expressions/identifiers.ts`)
   and re-key it to `hostFreeEnvironment(ctx)`.

## B. Wrong results (correctness — the serious ones)

4. **cookie**, **hono**, **redux** produce a *different value* than Node
   (`0 !== 1`, `1 vs 9`, `NaN vs 7`). For each: run the perf workload's
   sample operation (`perf.sampleOp` in the JSON) under the regime and
   under host-assisted, bisect the divergence to the first differing
   intermediate (print statements in a copy of the workload are fine),
   and fix the provider arm. Expect the #5385 v2 "which provider" arms
   that the standalone lane never exercised with these shapes (string
   coercion in `cookie`'s parser, `hono`'s router map/regex, `redux`'s
   reducer arithmetic → `NaN` suggests a boxed-number unbox miss on the
   admitted-object path from S2). File a child issue per root cause if it
   is not a one-liner; do not batch three unrelated fixes in one PR.

## C. Runtime throws

5. **acorn** null-deref at `438:67`, **marked** and **lit** uncaught Wasm
   exceptions: render the exception (`__exn_render_*`, hostBridge is on),
   name the throw site, and route to the owning family; these are likely
   the same class as the test262 `Cannot access property on null or
   undefined` bucket (47 rows) and may share a fix.

## Acceptance

- [ ] Every package that is `measured` on `jsHost` is `measured` on
      `jsHostNative` with an identical checksum, in the CI-generated
      `npm-compat.json` after the refresh (no hand-committed artifact).
- [ ] Byte-identity for default `gc`/`standalone`/`wasi` output; host-lane
      npm numbers unchanged.
- [ ] Each B-item fix has a focused test with the exact diverging value.
- [ ] #6708's evidence item 3 can be ticked with the run id.
