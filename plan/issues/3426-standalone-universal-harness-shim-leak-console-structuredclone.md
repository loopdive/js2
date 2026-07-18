---
id: 3426
title: "Standalone: authoritative Test262 harness leaks env::console_log_externref + env::structuredClone into every module (37,369 records, 32,245 with no other cause)"
status: ready
sprint: current
created: 2026-07-18
updated: 2026-07-18
priority: critical
horizon: l
feasibility: hard
task_type: bug
area: codegen, standalone, test262-runner
language_feature: n/a
es_edition: n/a
goal: standalone-mode
related: [1781, 2961, 2860, 3178, 3370, 3393]
origin: "2026-07-18 oracle-v8 harvest (fable harvest agent): standalone leak-class census of test262-standalone-current.jsonl @ oracle 8 (baseline_sha 6ae06435, 4,312/43,106 pass)."
---

# #3426 — Standalone universal harness shim leak (console_log_externref + structuredClone)

## Problem

The 2026-07-18 oracle-v8 standalone census (`test262-standalone-current.jsonl`,
4,312/43,106 pass, 38,772 compile_error) shows the standalone corpus is
dominated by a **single universal host-import leak**, not by per-feature gaps:

| Leak set | Records |
| --- | ---: |
| `env::console_log_externref` | 37,369 |
| `env::structuredClone` | 37,369 |
| records leaking **ONLY** those two (no other host import) | **32,245** |
| records leaking those two **plus** a real feature import | 5,124 |
| records with a real feature leak but **no** shim leak | **0** |

Every single standalone `compile_error` that carries a host-import-leak verdict
also carries `env::console_log_externref` + `env::structuredClone`. There are
zero records where a feature import leaks without these two. In other words the
`#2961` `strictNoHostImports` leak-scan is tripping corpus-wide on two imports
that the **authoritative Test262 harness prelude (#3370) emits unconditionally**
— including in tests that never call `console.log` or `structuredClone`:

```
test/language/expressions/optional-chaining/iteration-statement-for.js
  standalone target emitted host imports: env::console_log_externref, env::structuredClone (#2961)
test/language/expressions/less-than/bigint-and-symbol.js
  standalone target emitted host imports: env::console_log_externref, env::structuredClone (#2961)
test/language/expressions/compound-assignment/11.13.2-5-s.js
test/language/expressions/class/accessor-name-inst/literal-string-hex-escape.js
test/language/expressions/assignment/S11.13.1_A7_T4.js
```

None of these tests use console or structuredClone — the imports come from the
harness/runtime prelude, not the test body.

## Why this matters (burndown lever)

This is the #1 standalone burndown lever. The standalone pass collapsed from the
pre-v8 high-water of ~24,946 to 4,312 when #3370 made the literal upstream
harness authoritative (#3393 re-seeded the floor to 4,508 full-corpus and
documented the collapse as intended-at-the-metric-level). But the *cause* of the
collapse — the harness prelude leaking two host imports into every module — has
no fix issue. Eliminating these two universal leaks would let up to **~32,245
tests** (the shim-only set, which have no other refusal reason) re-enter
standalone, and would unmask the true per-feature census for the remaining 5,124.

## Root-cause hypothesis

`env::console_log_externref` and `env::structuredClone` are pulled by the
assembled standalone prelude (runtime shim + `assert.js`/`sta.js` harness
reporting path), not tree-shaken when the test body doesn't reference them. Two
candidate mechanisms to confirm:

1. The harness's `print` / Test262Error reporting path lowers to
   `console_log_externref`; the authoritative-harness assembly (#3370) now
   always includes it.
2. A value-copy / deep-compare helper (or the runtime prelude) references
   `structuredClone` unconditionally.

Either way the fix is a **standalone-native lowering or dead-import elimination**
of the two prelude imports so the leak-scan sees a genuinely host-free module.
Per the dual-mode principle, standalone needs a Wasm-native `print`/report path
(or no report import at all) and must not depend on host `structuredClone`.

## Implementation Plan (opus-dev-a, 2026-07-18)

Root cause CONFIRMED (not just hypothesis). Both host imports originate in the
authoritative-harness runtime shim `scripts/test262-fyi-runtime.js`, which
`tests/test262-original-harness.ts` (#3370) prepends VERBATIM before every
assembled test (`RUNTIME_PATH`, line 25):

- **`console_log_externref`** ← the shim's `var print = function (value) { console.log(value); };`
  (lines 4–6). Every module compiles this `print` definition, so every module
  emits a `console.log` externref import.
- **`structuredClone`** ← the shim's `$262.detachArrayBuffer` body:
  `structuredClone(buffer, { transfer: [buffer] })` (lines 22–27). The `$262`
  object literal is always compiled, so the `structuredClone(...)` call site is
  always emitted → an ambient-global host import.

(The `structuredClone(...)` hits in `src/codegen/*.ts` — expressions.ts,
exceptions.ts, loops.ts — are the compiler's OWN Node.js `structuredClone` used
to deep-clone `Instr[]`; RED HERRING, not emitted into wasm.)

### Fix 1 — `console_log_externref` (the import-collector gate)

`src/codegen/declarations/import-collector.ts`, `finalizeUnifiedCollector`,
**line 1316**:

```ts
// In WASI mode, console.log/error use fd_write — skip JS host console imports
if (!ctx.wasi) {                       // <-- BUG: standalone has ctx.wasi === false
  for (const method of CONSOLE_METHODS) { ... addImport(ctx,"env",`console_${method}_externref`,...) }
}
```

Standalone (`ctx.standalone === true`, `ctx.wasi === false`) falls into the
`!ctx.wasi` branch and emits the console host imports. **WASI is the only lane
that currently skips them.**

Change the gate to `if (!ctx.wasi && !ctx.standalone)` so standalone ALSO skips
the host console imports. But skipping the import is not sufficient on its own:
the **call site** for `console.log`/`print` must lower to something valid in
standalone (else a dangling funcMap reference). Two acceptable lowerings per
dual-mode:

- **(preferred, simplest) native no-op**: in standalone, lower a `console.*`
  call to `drop` its args and produce nothing. test262 NEVER checks `print`
  output (verdicts come from thrown `Test262Error`), so a silent console is
  semantically correct for the lane, and a standalone browser embedder can wire
  a real sink later without a host import in the module.
- (alternative) a wasm-native console sink mirroring the WASI `fd_write` path
  (`src/codegen/wasi.ts:825`), if a visible standalone console is desired.

Find the `console.*` call-site lowering (grep `console_` / `consoleNeededByMethod`
in `src/codegen/` — the emit is driven by `state.consoleNeededByMethod`) and add
the standalone no-op arm alongside the existing WASI handling. Keep the JS-host
lane byte-identical (only the `ctx.standalone` arm is new).

### Fix 2 — `structuredClone` (ambient-global host import)

In standalone, an unresolved ambient global like `structuredClone` must NOT
materialize an `env::` host import — it should resolve to `undefined`, so the
shim's own guard `if (typeof structuredClone !== "function") throw` fires and
`$262.detachArrayBuffer` becomes a throw-stub (correct: standalone has no
structuredClone; only the handful of detach tests hit it, and they SHOULD report
unsupported rather than leak an import corpus-wide).

Follow the **exact precedent already in this file at line ~1611** (the #3063/#3064
`escape`/`unescape` handling):

```ts
for (const name of state.escapeNeeded) {
  if (ctx.funcMap.has(name)) continue;
  if (ctx.standalone || ctx.wasi) { emitNative...(ctx); continue; }  // no host import
  addImport(ctx, "env", name, ...);                                   // JS-host only
}
```

Apply the same shape to the ambient-global call path that currently emits the
`structuredClone` import (trace from the generic unresolved-identifier-call →
`addImport(ctx,"env",name,...)` site; grep the collector for where a bare called
global with no funcMap/native handler registers an `env` import). In standalone,
route `structuredClone` (and, defensively, any ambient global with no
standalone-native handler that the harness references but tests don't require —
scope tightly to `structuredClone` first) to **no import**; the identifier reads
as `undefined` and `typeof` yields `"undefined"`.

### Sequencing / collision

- Land this issue's PR **after** the docs PR #3364 (which carries this file) so
  the impl PR MODIFIES this file rather than re-adding it (avoids the
  `check:issue-ids:against-main` dup-id wedge).
- Collision-clear on the code path: the only in-flight #3370 PR (#3351,
  `codex/fix-baseline-trap-scope`) touches `refresh-baseline.yml`,
  `test262-sharded.yml`, `plan/issues/3370-*.md`, `tests/issue-3303.test.ts` —
  NOT `import-collector.ts`, the runtime shim, or the console/structuredClone
  codegen. Stay out of those two workflow files and there is no conflict.

### Scoped verify

```bash
# should print an imports list with ZERO env:: entries after the fix
node -e 'import("./src/index.js").then(async ({compile})=>{ \
  const src = require("fs").readFileSync("scripts/test262-fyi-runtime.js","utf8") + "\nexport function test(){return 1;}"; \
  const r = await compile(src,{target:"standalone"}); \
  console.log("success",r.success,"imports",JSON.stringify(r.imports)); })'
# and a real corpus member that never calls console/structuredClone:
#   test/language/expressions/optional-chaining/iteration-statement-for.js --target standalone → 0 imports
```

Add a standalone regression test (`tests/issue-3426-*.test.ts`) asserting a
trivial standalone module + the raw runtime-shim source both compile with an
empty `imports` array (or at least zero `env::console_log_externref` /
`env::structuredClone`).

## Acceptance criteria

- A standalone compile of a trivial test that uses neither `console.log` nor
  `structuredClone` emits **zero** host imports (no `env::console_log_externref`,
  no `env::structuredClone`).
- The standalone shim-only leak set (32,245 records) drops to ~0; standalone pass
  count recovers materially above 4,312 (target: unmask and re-measure — the
  remaining leaks are the per-feature census in #3178 / #1472 / #1474 / #2046).
- No regression in the default (JS-host) lane.

## Cross-reference

Leak-scan mechanism: #2961 (done). Standalone umbrella: #1781. Host-async
machinery family (the 5,124 feature-plus-shim residual): #3178. Metric collapse
already documented: #3393, #3370.
