---
id: 2855
title: "IR front-end migration: ratchet unintended fallback buckets to zero + promote to STRICT_IR_REASONS"
status: ready
sprint: current
created: 2026-06-30
updated: 2026-06-30
priority: high
horizon: xl
feasibility: hard
model: fable
reasoning_effort: high
task_type: feature
area: ir, codegen
language_feature: compiler-internals
goal: ir-full-coverage
model: fable
fable_role: spec
depends_on: [2856, 2857, 2858, 2859]
related: [1376, 2089, 1923]
---

# #2855 — IR front-end migration: drive the unintended fallback buckets to zero

> **Tracking epic — not a single dev task.** This is the narrative anchor for
> the direct-AST→Wasm → typed-IR front-end migration. The actionable work is in
> the per-bucket child issues (`depends_on`). Kept `status: backlog` so it stays
> visible in planning without being offered as a code task in the TaskList; the
> children carry `status: ready` and are the queued, dev-claimable slices.

## Why this exists / supersedes the stale `#1530` reference

The compiler has two front-ends: the legacy direct AST→Wasm path (accumulated
hacks under `src/codegen/`) and the typed IR (`src/ir/`). **IR is meant to
replace the hacks, adopted per-AST-kind.** A `FunctionDeclaration` (the IR claim
unit) that the selector cannot fully lower demotes to the legacy path via the
demote-to-warning channel (`src/codegen/index.ts`), bucketed by an
`IrFallbackReason` (`src/ir/select.ts`).

The retirement is governed by the **IR fallback budget gate** (`pnpm run
check:ir-fallbacks`, built in **#1376**, the ratchet mechanism) which counts
each rejection reason against `scripts/ir-fallback-baseline.json`. The direction
is to drive every **unintended** bucket to zero, then add the retired reason to
`STRICT_IR_REASONS` (`src/codegen/index.ts:1511`, currently the **empty set** —
no reason promoted yet) so any future regression becomes a hard compile error
instead of a silent legacy fallback. **Corpus-zero is NOT the promotion
trigger** — see the re-scoped #3341 for why a reason may only be promoted once
it is genuinely *unreachable* in the IR.

**Stale-reference note (#1530):** `CLAUDE.md`, `docs/architecture/codegen-axes.md`,
and `plan/log/ir-adoption.md` all cite **#1530** as "the issue that phases out
the demote-to-warning channel / drives the unintended buckets to zero."
**`#1530` is actually a WASI Native-Messaging host example** — an unrelated,
already-`done` issue. The real ratchet _mechanism_ is **#1376** (the telemetry
gate, done) + **#2089** (silent-fallback ratchet, done) + **#1923** (post-claim
demotion metering, done). This epic (#2855) is the live tracking owner for the
remaining _content_ work — driving the buckets to zero. `plan/log/ir-adoption.md`
has been repointed to #2855; **`CLAUDE.md` and
`docs/architecture/codegen-axes.md` still carry the stale `#1530` citation and
need a one-line repoint to #2855 by an agent that may edit non-`plan/` files**
(PO is plan-only).

## Live bucket snapshot (verified against `origin/main` @ dc29fd081, 2026-06-30)

`pnpm run check:ir-fallbacks -- --verbose`:

| Bucket                      | Count | Category     | Child issue      | Priority |
| --------------------------- | ----- | ------------ | ---------------- | -------- |
| `body-shape-rejected`       | 31    | unintended   | **#2856**        | high     |
| `call-graph-closure`        | 7     | unintended   | **#2858**        | medium   |
| `class-method`              | 6     | unintended   | **#2857**        | medium   |
| `param-type-not-resolvable` | 1     | unintended   | **#2859**        | low      |
| `async-function`            | 4     | **deferred** | #1373b (blocked) | —        |

`async-function` is a **deferred** bucket (documented decision, not a TODO) —
the CPS lowering is gated on standalone microtask drain and tracked in **#1373b**
(`status: backlog`, blocked on #1326c). **Not queued here.** All other
unintended buckets that previously had values (`external-call`,
`param-shape-rejected`, `return-type-not-resolvable`, `type-resolution-failure`,
`destructuring-param-complex`) are **already at zero** — retired by #1371 / #1372
/ #1374 / #1375 / #1370 (all done) — so they are **not** queued.

## Acceptance criteria

This epic is `done` when, for every unintended bucket:

1. The bucket count in `scripts/ir-fallback-baseline.json` is `0`.
2. The corresponding `IrFallbackReason` is added to `STRICT_IR_REASONS`
   (`src/codegen/index.ts:1511`), so a regression hard-errors. **Bucket-zero
   alone does NOT satisfy this** (re-scoped #3341): corpus-zero is measured on
   the playground corpus only, so a reason may be promoted only once it is
   genuinely *unreachable* in the IR — i.e. the IR is expected to always
   claim+lower the construct, making a rejection a bug rather than a legitimate
   fallback. `tests/issue-3341.test.ts` locks this: it keeps a valid program
   per reason compiling, so a premature promotion fails loudly.
3. The matching row in `plan/log/ir-adoption.md` is promoted `mixed → ir-owned`
   (regenerate via `pnpm run gen:ir-adoption`).
4. Once all unintended buckets are zero + strict, the demote-to-warning channel
   (`~1889` selector-claimed unresolvable-types fallback / `~2390` IR-build
   throw in `src/codegen/index.ts`) can be removed for the affected kinds — the
   final goal the stale #1530 citation referred to.

## Children

- **#2856** — `body-shape-rejected` (31) → 0. Dominant bucket. high / horizon L.
- **#2857** — `class-method` (6) → 0. #1370 Phase C/D/E residual. medium / horizon M.
- **#2858** — `call-graph-closure` (7) → 0. Derivative of #2856 + #2857. medium / horizon M.
- **#2859** — `param-type-not-resolvable` (1) → 0. TypeMap propagation. low / horizon S.

## References

- Gate mechanism: #1376 (telemetry gate), #2089 (silent-fallback ratchet),
  #1923 (post-claim demotion metering) — all done.
- `docs/architecture/codegen-axes.md` — the two-axis codegen model.
- `plan/log/ir-adoption.md` — per-AST-kind adoption status (selector-bucket
  table at the bottom maps reasons → promotable rows).
- `src/ir/select.ts` — `IrFallbackReason` union + the per-function claim checks.

## Audit note 2026-07-17 (IR audit 01)

Bucket-zeroing half is ahead of plan: `call-graph-closure`, `class-method`,
`param-type-not-resolvable` all hit 0 since 07-02 (baseline now only
`body-shape-rejected` 14 + deferred `async-function` 4 + moduleLevel 2).
But the PROMOTION half has not started: `STRICT_IR_REASONS`
(`src/codegen/index.ts:1511`) is still the empty set — none of the ~8
zeroed reasons has been promoted, so the demote-to-warning channel still
silently covers all of them. This is now the cheapest hardening step in
the program. Caveat: baseline zero is corpus-zero (13 playground files),
not strict-zero — per-reason promotion needs the corpus-vs-strict check
the `class-method` row in `ir-adoption.md` flags. See
`plan/log/analysis-2026-07/01-ir-audit-2026-07-17.md` §2. Also untracked
post-#2953 residue for a follow-up slice here or a new issue: 5 GC-op
literals left in `lower.ts` (`class.get`/`class.set`/instanceof-tag via
pushRaw at ~1797/1815/1908 — should use the existing
`emitFieldGet`/`emitFieldSet` primitives like `obj.get` does) plus
`forof.str` pushing `struct.get` on the RAW sink (`lower.ts:2614/2674`),
invisible to the `check:pushraw` ratchet (§3).

## Implementation Plan (Fable, 2026-07-18)

> Program-level plan for the umbrella. Grounded against this branch (=
> `upstream/main` merged 2026-07-18) with a fresh
> `JS2WASM_IR_SHAPE_DIAG=1 pnpm run check:ir-fallbacks -- --shape-diag` and
> `-- --verbose` run. Per-cluster capability specs for the last
> `body-shape-rejected` functions live in **#2856's Fable plan** (same date);
> this section owns sequencing, the promotion half, and the two side-slices
> (#2953 residue, Slice-A re-spec for #3341).

### Verified program state (2026-07-18)

| Bucket | Count | Where it retires |
| --- | --- | --- |
| `body-shape-rejected` (function-level) | **14** | #2856 — three capabilities (A imported-callee calls, B first-class fn/arrow values, C module-scope mutable bindings); see #2856 plan |
| `body-shape-rejected` (moduleLevel, #3142) | **2** (calendar.ts 9 stmts, algorithms.ts 1 stmt) | same capability C + DOM extern chains at module level; retire together with #2856's calendar cluster |
| `async-function` (deferred) | 4 | #1373b (IR async CPS lowering — **in flight**; do not spec here) |
| all other unintended reasons | 0 | zeroed by #1370/#1371/#1372/#1374/#1375/#2857/#2858/#2859 |

`STRICT_IR_REASONS` (`src/codegen/index.ts:1415`) is still the **empty set**;
`STRICT_IR_BUILD_ERRORS` is **active** with the three `ir/integration: unknown
{function,global,type} ref` name-repoint invariants (#3341 Slice B, done
2026-07-17). Post-claim demotions: none. Module-level: 0 claimable / 11 empty.

### Sequencing DAG (what blocks what)

1. **#2856 capability C (module-scope mutable bindings)** — self-contained,
   clears the calendar 4 + likely the moduleLevel 2. No dependency on A/B.
   First executable slice.
2. **#2856 capability A (imported-callee calls) + B (first-class function /
   arrow values)** — the 8 benchmark `main`s need **both** (they call imported
   `el`/`addBenchCard` AND pass function references / arrows as args). A and B
   are separate PRs only if each proves net-unintended-negative on the gate
   alone; otherwise land together (the Step-2 bucket-shuffle lesson).
3. **async `delay`** — rides B (arrow executor) + extern-Promise machinery;
   last, and MAY be re-bucketed `deferred` (flag to PO) if the
   executor-capture arm proves out of scope — see #2856 plan.
4. **`async-function` 4** — retires with #1373b. Not scheduled here.
5. **Promotion work is independent of 1–4** and can proceed in parallel
   (below).

### The promotion half — corrected acceptance criterion

AC #2's original "bucket zero ⇒ add reason to `STRICT_IR_REASONS`" is
**superseded** by the #3341 re-scope: corpus-zero is necessary but not
sufficient; promote per-reason only when a rejection is *genuinely a bug*.
Per-reason verdicts (recorded so nobody re-litigates):

| Reason | Promotable? | Why |
| --- | --- | --- |
| name-repoint build errors | **promoted** (#3341 B, done) | builder↔finalize desync is always a bug |
| `position-type-internal-desync` (to be peeled, below) | **yes, after the peel** | annotation-accepted-then-unmaterializable is a resolver bug |
| `body-shape-rejected` | **not in this program's horizon** | legitimately fires on any shape from-ast can't lower yet; promotable only at IR-completeness endgame (IR-first sole path). At corpus-zero: bank the floor, keep the reason demoted, write the rationale at the `STRICT_IR_REASONS` comment |
| `external-call`, `call-graph-closure`, `class-method`, `*-not-resolvable`, destructuring buckets | **no (as whole reasons)** | legitimate non-claimability; `call-graph-closure` additionally still fires by design in standalone/wasi (#2858 residual — caller arm is host-gated) |

The epic's AC #2 should be read as: *for every unintended bucket, either the
reason is promoted, or a recorded verdict explains why demote-to-warning is
the permanent contract for that reason.* AC #4 (demote-channel removal at
`index.ts` ~1889/~2390) applies per-kind once the covering reason is either
strict or verdict-recorded.

### Slice-A re-spec (input for #3341 — dev-h flagged the original as vacuous)

dev-h proved `resolveParamType` (`src/ir/select.ts:1159–1207`) never returns
`null` for an annotated primitive/class — the select-side peel is unreachable.
The REAL desync seam is **cross-layer**: `resolveParamType` answers `"object"`
for *every* TypeReference/TypeLiteral/ArrayType (`select.ts:1192`), but the
codegen-side `resolvePositionType` (`src/codegen/index.ts:673`) /
`objectIrTypeFromTsType` (`:931`) may then fail to materialize the `IrType`
(e.g. method-carrying interfaces — `:815` comment), failing the overrideMap
build (`:1764–1812`) → demote at ~1889 with an externally-set
`type-resolution-failure`. Some of those misses are legitimate (the IR really
can't represent the type); some violate the implicit contract "what select
claims, index can materialize". Opus-executable steps:

1. **Measure first.** Opt-in recorder on the overrideMap-build bail path
   (`index.ts:1764–1812`), mirroring the `shapeNo`/`JS2WASM_IR_SHAPE_DIAG`
   pattern (byte-inert when off): record `(position, annotation SyntaxKind,
   tsType flags, objectIrTypeFromTsType bail arm)` for every `null`
   `resolvePositionType` on a selector-claimed function. Run the corpus + a
   STRIDE-50 test262 sample; produce the legitimate-vs-desync split.
2. **Peel.** Mint `position-type-internal-desync` for the arms where the
   select-side `"object"` answer implies materialization must succeed
   (primitive keywords, `ArrayType` of primitives, class refs present in
   `classShapes`). State the cross-layer contract as a table in the code
   comment. Everything else keeps `type-resolution-failure`.
3. **Promote** the new reason into `STRICT_IR_REASONS` + full CI. Note the
   global reach: a non-empty set flips `trackFallbacks` on for every compile
   (`index.ts:1715`) — validate on `merge_group`, not locally.

### #2953 residue slice (S, dev-lane) — the raw-sink GC ops the ratchet can't see

Anchors re-verified 2026-07-18 (they drifted from the audit's citations):
`src/ir/lower.ts:1796` (`class.get`), `:1813` (`class.set`) with raw
`{op:"struct.get"}` literals at `:1807`/`:1918`, and the `forof.str` lowering
pushing `{op:"struct.get", …}` onto `wasmOut`/`loopBody` raw arrays at
`:2636`/`:2696`. These bypass `emitter.pushRaw` entirely, so `check:pushraw`
cannot count them. Fix: route `class.get`/`class.set` through the existing
`emitFieldGet`/`emitFieldSet` primitives (the `(a2)` pattern already used at
`:1632`/`:1746` — byte-identical on WasmGC by construction); for the
`forof.str` sites, either add the same field-get primitive over the
`$AnyString` typeIdx or convert to `emitter.pushRaw` with a
`// pushraw-ok(#2855)` tag so the ratchet at least sees them. Proof:
`scripts/prove-emit-identity.mjs` (56-record byte oracle) + golden-Instr tests
in `tests/ir-backend-emitter.test.ts`. Do NOT reopen #2953 (done) — this is an
umbrella side-slice.

### Ratchet mechanics (unchanged, restated for executors)

- Gate: `pnpm run check:ir-fallbacks` (CI `quality`); shape attribution:
  `JS2WASM_IR_SHAPE_DIAG=1 … -- --shape-diag`; per-file: `-- --verbose`.
- Bank a decrease in the slice PR: `pnpm run check:ir-fallbacks --
  --update-on-decrease` + commit `scripts/ir-fallback-baseline.json`.
- A slice that only *moves* count between unintended buckets fails the gate —
  the unit of landability is net-unintended-negative (Step-2 lesson in #2856).
- After promoting rows: `pnpm run gen:ir-adoption` (the generator
  cross-checks the reason union; skipping it fails `quality`).
