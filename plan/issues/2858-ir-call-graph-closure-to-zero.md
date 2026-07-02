---
id: 2858
title: "IR: drive call-graph-closure fallback bucket to zero (derivative of body-shape + class-method)"
status: ready
sprint: current
created: 2026-06-30
updated: 2026-07-02
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: feature
area: ir, codegen
language_feature: compiler-internals
goal: ir-full-coverage
parent: 2855
depends_on: [2856, 2857]
related: [1376]
---

# #2858 — IR: `call-graph-closure` → 0

Child of the IR front-end migration epic **#2855**.

## Problem

`call-graph-closure` is raised when a function is _itself_ IR-claimable but one
of its local callees is **not** claimed — to keep the `call $callee` instruction
valid, the caller is demoted alongside the callee
(`src/ir/select.ts:413`). It is therefore a **largely derivative** bucket: most
of these rejections clear automatically once the callee's _own_ rejection reason
(usually `body-shape-rejected` or `class-method`) is fixed.

## Live snapshot (verified `origin/main` @ dc29fd081, 2026-06-30)

`pnpm run check:ir-fallbacks -- --verbose` → **`call-graph-closure: 7`**:

| File                                                | count |
| --------------------------------------------------- | ----- |
| `website/playground/examples/dom/calendar.ts`       | 3     |
| `website/playground/examples/js/builtins.ts`        | 2     |
| `website/playground/examples/benchmarks/helpers.ts` | 1     |
| `website/playground/examples/js/algorithms.ts`      | 1     |

Note these are the **same files** that carry the bulk of `body-shape-rejected`
(#2856) and `class-method` (#2857) — strong evidence the closure rejections are
downstream of those callee rejections.

## Approach

1. **Sequence after #2856 + #2857** (hence `depends_on`). Re-run the gate once
   those land — the `call-graph-closure` count should fall substantially on its
   own.
2. For any **residual** closures that remain after the callees are claimed,
   diagnose why the closure analysis still demotes the caller (e.g. a callee
   that is intentionally legacy-only, an indirect/`return_call` edge the closure
   walk mishandles, or a call to a deferred-bucket callee). Fix the closure
   logic in `src/ir/select.ts` or, where the callee is genuinely unclaimable,
   reclassify the caller's reason so it doesn't masquerade as `call-graph-closure`.
3. At `call-graph-closure: 0`, add `"call-graph-closure"` to `STRICT_IR_REASONS`
   (`src/codegen/index.ts:1013`).

## Acceptance criteria

1. `call-graph-closure` count in `scripts/ir-fallback-baseline.json` is `0`.
2. Any residual (non-derivative) closure rejection is root-caused and either
   fixed in the closure analysis or correctly reattributed.
3. `"call-graph-closure"` added to `STRICT_IR_REASONS` once the bucket is zero.
4. No regression in `tests/ir-*.test.ts` or test262 conformance.

## Files

- `src/ir/select.ts` — the call-graph closure walk (`call-graph-closure` site).
- `scripts/ir-fallback-baseline.json` — ratchet down.
- `src/codegen/index.ts:1013` — `STRICT_IR_REASONS` once at zero.
- `plan/log/ir-adoption.md` — confirms the relevant rows once promoted.

## Banked triage (2026-07-02, dev-2912f — pre-gate prep for the #2856-sequenced dispatch)

`check:ir-fallbacks` snapshot (main `46e390c`-era): `call-graph-closure` is
**7** — `benchmarks/helpers.ts` 1 (bcrd → unclaimed `el`, blocked on the
extern-in-IR/body-shape work), `dom/calendar.ts` 3, `js/algorithms.ts` 1,
`js/builtins.ts` 2. Consistent with this issue's "derivative" framing: most
entries clear as their callees' `body-shape-rejected` /
`vardecl-init-expr:PropertyAccessExpression` (13 instances, extern-in-IR
dependency) causes are fixed by #2856/#2857 — expect this bucket to shrink
substantially without direct work; re-run the gate before triaging what
remains.
