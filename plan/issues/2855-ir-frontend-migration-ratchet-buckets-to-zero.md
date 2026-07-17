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
