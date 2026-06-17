---
id: 1918
title: "Stack-balance strict mode + fixup ratchet — stop silently patching emitter bugs into wrong runtime values"
status: done
assignee: ttraenkler/tld-2139
sprint: 63
created: 2026-06-10
updated: 2026-06-16
completed: 2026-06-16
priority: high
feasibility: medium
reasoning_effort: high
task_type: infrastructure
area: codegen
language_feature: compiler-internals
goal: correctness
---
# #1918 — Stack-balance strict mode + fixup ratchet

## Problem

`src/codegen/stack-balance.ts` (2,524 LOC) is a partial reimplementation of
the Wasm validator used to **repair** the emitter's own output. Every repair
it applies is a masked emitter bug, and some repairs are *silently lossy*:

- Wrong-typed branch values are patched with `drop; f64.const 0` or
  `drop; ref.null` (`stack-balance.ts:709-755`) — a compile-time bug becomes
  a silently wrong runtime value.
- `fixBranch` appends drops/defaults for arity mismatches (`:773+`).
- Heuristic inference: `fixCallArgTypesInBody` admits it "only handles the
  common case where the argument-producing instruction is directly before
  the call" (`:1306-1310`); interleaved control flow defeats it silently.
- The pass **returns fixup counts that are computed and then discarded**
  (`src/codegen/index.ts:1571`). Nothing reports, gates, or ratchets them.
- Test coverage of the safety net itself: 176 lines / 10 e2e tests for a
  2,524-line pass; 36 issue files reference stack-balance — it is a
  recurring defect locus.

## Proposed approach

Phase 1 (S — instrumentation):
1. Thread fixup events out of `stackBalance` with location info (function
   name, op offset, fixup kind, from→to types).
2. `JS2WASM_STRICT_BALANCE=1` promotes each fixup to a located warning;
   `=error` makes it fail the compile (for CI experiments / new code).
3. Record per-corpus fixup totals (playground examples — same corpus as
   `check:ir-fallbacks`) into a baseline JSON.

Phase 2 (M — burn-down):
4. CI gate: fail when any fixup bucket **grows** (same ratchet mechanics as
   `scripts/check-ir-fallbacks.ts`, `--update-on-decrease` mode).
5. Fix the top buckets at the emitter; when a fixup kind hits zero, its
   repair arm becomes `throw` (strict by construction).

## Acceptance criteria

- Fixup counts visible per compile (debug) and per corpus (CI artifact).
- `scripts/stack-balance-baseline.json` ratchet wired into ci.yml quality job.
- At least the lossy `drop; const-default` branch arms are warning-visible.

## Source

Compiler quality review 2026-06. Direct child of #1858 (fail-loud audit).
Related: #1917 (the lossy arms it instruments), #1921.

## Resolution (2026-06-16) — Phase 1 complete

Phase 1 (instrumentation) is implemented. Phase 2 (per-emitter burn-down of
the top buckets to zero + flipping the repair arms to `throw`) is intentionally
deferred to follow-up issues — the ratchet now *protects* the current floor and
makes every future regression visible, which is the gating prerequisite for the
burn-down work.

### What landed

**`src/codegen/stack-balance.ts`** — fixup telemetry:
- New `FixupKind` union (7 kinds) + `FixupEvent` (`kind`, `func`, `detail`,
  `lossy`). A module-scoped `fixupEvents` collector (mirrors the existing
  `#2090` `inventedValueSites` pattern), reset per `stackBalance(mod)` run.
- `recordFixup(kind, detail, lossy?)` instrumented at all 7 leaf
  body-mutating sites: `drop-excess`, `default-value-lossy` (the LOSSY
  const/null-default arms — flagged `lossy: true`), `branch-type-coerce`,
  `branch-type-cast`, `call-arg-coerce`, `struct-field-coerce`,
  `local-set-coerce`.
- Exposed `getFixupEvents()`, `summarizeFixups(events)`, and
  `strictBalanceDiagnostics(events)`.

**`JS2WASM_STRICT_BALANCE`** env (read in `strictBalanceDiagnostics`):
- unset/`0`/`off` → silent (default; no behaviour change)
- `1`/`true`/`warn` → each fixup becomes a located severity-`warning`
- `error`/`strict` → each fixup becomes a severity-`error` prefixed
  `Codegen error:` so the WasmGC success gate (compiler.ts:736) actually
  fails the compile. (Necessary because `mod.codegenErrors` is NOT read on
  the WasmGC path — only `ctx.errors` is — so the diagnostics are pushed onto
  `ctx.errors` from `index.ts`, where `ctx` is in scope.)

**`src/codegen/index.ts`** — `drainStackBalanceTelemetry(ctx, fileLabel)`
called immediately after both `stackBalance(mod)` sites (`generateModule` and
`generateMultiModule`). Logs a one-line per-kind histogram under
`JS2WASM_LOG_STACK_BALANCE=1` (per-compile debug visibility) and pushes
strict-mode diagnostics onto `ctx.errors`.

**`scripts/check-stack-balance.ts`** + **`scripts/stack-balance-baseline.json`**
— corpus ratchet over `website/playground/examples/` (same corpus as
`check:ir-fallbacks`), mechanics mirror `check-ir-fallbacks.ts`
(`--update` / `--update-on-decrease` / `--json` / `--verbose`). Baseline at
landing: `default-value-lossy=78, call-arg-coerce=6, drop-excess=2` (86 total).
Wired into `ci.yml` `quality` job as **"Stack-balance fixup ratchet (#1918)"**;
`pnpm run check:stack-balance`.

### Acceptance criteria — verified

- **Fixup counts visible per compile (debug) and per corpus (CI artifact)** ✓
  — `JS2WASM_LOG_STACK_BALANCE=1` prints `[stack-balance] file=… fixups=N …`
  per compile; `check:stack-balance` prints/ratchets the per-corpus table.
- **`scripts/stack-balance-baseline.json` ratchet wired into ci.yml quality
  job** ✓ — new gate step; verified locally it PASSES at baseline and FAILS
  (exit 1) when a bucket exceeds baseline.
- **At least the lossy `drop; const-default` branch arms are warning-visible**
  ✓ — the `default-value-lossy` arms carry `lossy: true` and surface as
  located warnings under `JS2WASM_STRICT_BALANCE=1` / errors under `=error`.

### Tests — `tests/issue-1918.test.ts` (7 tests, all pass)

Unit: `getFixupEvents` records a located lossy event; resets per run;
`summarizeFixups` zero-fills every kind and counts by kind. E2E via `compile`:
default mode silent (`success:true`, no stack-balance diagnostics);
`=1` surfaces warnings without failing; `=error` fails the compile with
`Codegen error:`-prefixed error-severity diagnostics.

### Regression check

The instrumentation is behaviour-neutral on the default (silent) path — only
`recordFixup` calls were added; no body-mutation logic changed. Verified the 2
pre-existing failures in `tests/stack-balance.test.ts` (try/catch/finally) and
the 4 pre-existing `tests/equivalence/` IR-path "duplicate SSA def" failures
reproduce identically on `origin/main` source, so they are not introduced here.

### Deferred to follow-up (Phase 2)

Burn down the top buckets at the producing emitter and, once a kind hits zero,
replace its repair arm with a `throw` (strict by construction). The
`default-value-lossy=78` bucket (#1917 territory) is the highest-value target.
