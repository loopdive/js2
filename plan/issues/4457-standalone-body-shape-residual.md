---
id: 4457
title: "Standalone lane: attribute and drive down the select/body-shape-rejected residual"
status: done
sprint: 78
created: 2026-08-15
updated: 2026-08-18
completed: 2026-08-15
assignee: ttraenkler/opus-4457
priority: high
horizon: l
feasibility: medium
reasoning_effort: high
task_type: refactor
area: ir
goal: ir-full-coverage
related: [3518, 2856, 4555, 4461, 4462]
loc-budget-allow:
  - src/ir/select.ts
  - src/codegen/index.ts
func-budget-allow:
  - src/ir/select.ts::isPhase1Expr
---

<!--
Budget-gate justifications (#3102 LOC / #3400 func)

Both gates fired; the growth was first REDUCED structurally, then granted only
for the irreducible remainder.

func-budget-allow — src/ir/select.ts::isPhase1Expr (+6)
  The first cut grew this +13 and `planIrCompilation` +1. Extracting two
  module-level helpers (`armHostGlobalResolvers`, `namesDeferredHostSurface`)
  took `planIrCompilation` back UNDER its baseline and `isPhase1Expr` down to
  +6 — 3 comment lines and 3 code lines (`if` / `return` / `}`), which is the
  irreducible cost of adding one reject arm. The arm cannot move out of
  `isPhase1Expr`: it must sit next to the host-global ACCEPT arm it mirrors,
  since separating a claim decision from its matching reject is exactly the
  selector/capability-table drift #2135 exists to prevent.

loc-budget-allow — src/ir/select.ts (+68), src/codegen/index.ts (+12)
  Neither can move to a subsystem module, and most of the lines are prose:
  - `select.ts`: the `host-surface-unavailable` member must live on the
    `IrFallbackReason` union itself. ~45 of the +68 are comment, carrying the
    measured rationale and — the part a future reader must not get wrong —
    that the bucket is MIXED: DOM is permanent, `console.*` is fixable via
    #4462. The rest is the two helpers above plus one guarded `capabilityNo`.
    The file is net +14 lines longer than the un-refactored first cut because
    the helpers carry their own doc comments; that is the intended trade.
  - `codegen/index.ts`: the `[ir-fallback-unit]` line sits inside the existing
    `if (logFallbacks && selection.fallbacks)` block that already owns the
    `[ir-fallback]` histogram. Moving it would mean re-plumbing `selection`
    out of the driver purely to print one diagnostic line. Silent unless
    `JS2WASM_IR_SHAPE_DIAG=1`.
-->


# #4457 — standalone lane `select/body-shape-rejected` residual

## Problem

The `check:ir-only` reference corpus has the **standalone** lane at **17/37**
IR-emitted, with `select/body-shape-rejected: 11` as the dominant blocker (see
`scripts/ir-only-baseline.json`). A further 3 `call-graph-closure` units
(calendar `onDay`, builtins `crd`/`rw`) unblock automatically once their callees
(`el`, `renderCal`, `updFoot`) claim, per the measured table in the #3518 issue
file (2026-08-15 session).

The `body-shape-rejected` reason string is **uniform**: 11 units share one
label, so the bucket could not be attributed to specific reject arms, and
therefore could not be grouped into coherent fixes. Step 1 of this issue is to
make it attributable; everything else follows from what the measurement says.

## Measurement (2026-08-15, base `602aee7c`)

Method: `select.ts` already carries an opt-in reject-arm recorder (`shapeNo`,
`JS2WASM_IR_SHAPE_DIAG=1`, #2856 Step-1) that stores the proximate arm on
`IrFallback.detail`. Nothing consumed it for the **standalone** lane, so this
issue adds a per-unit `[ir-fallback-unit]` stderr line in `src/codegen/index.ts`
next to the existing `[ir-fallback]` histogram, printed only under that same env
var. The histogram names the bucket; the new line names **which unit hit which
arm**.

Reproduce:

```bash
JS2WASM_IR_SHAPE_DIAG=1 JS2WASM_LOG_IR_FALLBACKS=1 pnpm run check:ir-only 2>&1 \
  | grep ir-fallback-unit
```

### Per-unit arm table

The identifier text in the `not-in-scope` rows was obtained with a temporary
`expr-ident-not-in-scope[<text>]` label (probe only, not committed).

| # | unit | reject arm | root cause |
|---|------|-----------|------------|
| 1 | `dom/calendar.ts::el` | `expr-ident-not-in-scope[document]` | DOM host surface |
| 2 | `dom/calendar.ts::main` | `expr-ident-not-in-scope[document]` | DOM host surface |
| 3 | `dom/calendar.ts::renderCal` | `expr-module-storage-unrepresentable` | `gridEl: HTMLElement \| null` module binding |
| 4 | `dom/calendar.ts::updFoot` | `expr-module-storage-unrepresentable` | `HTMLElement` module binding |
| 5 | `js/builtins.ts::el` | `expr-ident-not-in-scope[document]` | DOM host surface |
| 6 | `js/builtins.ts::main` | `expr-ident-not-in-scope[document]` | DOM host surface |
| 7 | `js/algorithms.ts::fibMemo` | `expr-module-storage-unrepresentable` | `fibCache = new Map<number, number>()` module binding |
| 8 | `js/algorithms.ts::<module-init>` | `body-shape-rejected` | the same `new Map<number, number>()` initializer |
| 9 | `js/algorithms.ts::main` | `expr-ident-not-in-scope[console]` | `console.log` |
| 10 | `js/classes.ts::main` | `expr-ident-not-in-scope[console]` | `console.log` |
| 11 | `js/async.ts::delay` | `expr-new-type-args` | `new Promise<number>(…)` + `setTimeout` |

For contrast, the **host** lane rejects **none** of these (37/37, zero
fallbacks) — every row above is a standalone-only asymmetry.

### Grouping, and why the ≥5-unit target is not reachable in this slice

**7 of the 11 are host-surface units with no standalone lowering to claim
against.** This is not a shape-coverage gap:

- Rows 1–6 are DOM. Compiling `dom/calendar.ts` with `--target standalone`
  shows legacy's own body is **not host-free** — the finished binary still
  imports `env.Document_createElement`, `env.Node_appendChild`,
  `env.HTMLElement_get_style`, `env.Element_set_innerHTML`,
  `env.Element_set_textContent`, `env.CSSStyleDeclaration_set_cssText`,
  `env.HTMLElement_addEventListener`, `env.CSSStyleDeclaration_set_background`,
  `env.Document_get_body`, each raising the #2961 import-leak warning. The IR
  selector deferring here is **correct** (`hostExternCapability(jsHost=false)`
  → `"defer"`, `src/ir/capability.ts`); there is nothing for it to lower to.
- Row 11 is host async (`setTimeout`), same story.

Counting those 7 in `body-shape-rejected` — an **unintended** bucket, i.e. one
whose ratchet target is zero — overstates what better shape coverage can fix.
That mis-bucketing is the finding, and correcting it is the honest deliverable
here.

**The remaining 4 are genuinely in play but each needs real lowering work, not
gate widening:**

- **Rows 7+8 (native `Map`)** — standalone lowers `Map` to the WasmGC native
  `$Map` struct (#1103a); the IR models only the **host-extern** Map storage
  (`allowBuiltinMapExtern: jsHostExterns && !ctx.nativeStrings`, false in
  standalone). Claiming needs native-`$Map` storage modelling in the IR plus
  `.get`/`.set` lowering.
- **Rows 9+10 (`console`)** — `console` is only the **first-wins** arm. Probing
  past it (temporary selector opening) shows the chain continues:
  1. `console.log` → standalone has a host-free sink (`__stdout_append` /
     `ensureStandaloneStdoutSink`, #3469), but the IR's console arm emits
     `irImportFuncRef("env", "console_log_<variant>")` — an **import**, which
     does not exist in standalone;
  2. behind it, number `.toString()` — `supportsHostNumberToString:
     options.allowHostExterns` is false in standalone even though standalone
     **does** have a native `number_toString` (#3912);
  3. behind that, `js/algorithms.ts::main` reaches `call-graph-closure` on
     `joinNums`, and `js/classes.ts::main` reaches
     `invariant/build/unexpected-internal-throw`.

  So opening the console gate alone claims **zero** units and would break the
  build — a textbook selector-claim ⇔ lowering-parity violation.

### Conclusion

Maximum newly-claimable in this slice is 4, not ≥5, and all 4 sit behind
multi-step lowering chains that are each their own slice (#4461, #4462).

## Acceptance criteria

> **Superseded — original target.** This issue was opened with "at least 5 of
> the 11 `body-shape-rejected` units claim, and verify how many of the 3
> `call-graph-closure` units cascade". That target was written before the
> bucket was attributable, and the measurement above retires it: **7 of the 11
> are host-surface or host-async units with no standalone lowering to claim
> against** (verified, not inferred — legacy's own `--target standalone` body
> for the DOM units still leaks `env.Document_createElement` & co. past the
> #2961 import-leak gate). The reachable maximum is 4, each behind its own
> lowering chain. Hitting "≥5" was never possible in this slice; pursuing it
> would have meant widening selector gates without lowerings, which the
> capability guard rejects by design (see #4462's verbatim
> `assertNotDeferred` evidence). Re-scoped 2026-08-15, same pattern as
> #3583/#2951.

The deliverable of this slice is **attribution and honesty**, not a claim-count
increase:

1. **Per-unit attribution lands.** `body-shape-rejected` is attributable to a
   specific reject arm per unit, reproducibly, for the standalone lane.
   *(Done — `[ir-fallback-unit]` line in `src/codegen/index.ts`, printed under
   the existing `JS2WASM_IR_SHAPE_DIAG=1`; per-unit table above.)*
2. **Host-surface rejections carry a typed, deferred reason.** The standalone
   lane's unintended `body-shape-rejected` bucket drops **11 → 5**, with the 6
   ambient-host-global units moved to `host-surface-unavailable`, classified
   `deferred` (not `unintended`) in `scripts/gen-ir-adoption.mjs`.
   *(Done.)*
3. **Pure re-bucketing.** Standalone `emitted` (17) and total `unsupported`
   (20) are unmoved, and no `invariant` outcome appears — pinned by
   `tests/issue-4457.test.ts`. *(Done.)*
4. **Standalone-lane-only ratchet.** `scripts/ir-only-baseline.json` changes
   only the `standalone` lane; `single-host` stays 37/37 READY. *(Done.)*
5. **The two real chains are filed with the evidence, not left implicit.**
   *(Done — #4461, #4462.)*

Explicitly **out of scope**, and deliberately not attempted: any increase in
IR-emitted units. Per rule 5 (and #3518's "no corpus-zero shortcuts"), a
re-bucketing that added no claims must not be dressed up as claim progress —
which is exactly why the criteria above are written as attribution criteria.

## Lane numbers (before → after)

| lane | entries | terminal units | emitted | IR body emitted | unsupported |
|------|---------|----------------|---------|-----------------|-------------|
| single-host | 5/5 | 37 | 37 | 37 | 0 (unchanged) |
| standalone | 5/5 | 37 | 17 | 17 | 20 (unchanged) |

Standalone `unsupportedByCode`:

| code | before | after |
|------|--------|-------|
| `select/body-shape-rejected` | 11 | **5** |
| `select/host-surface-unavailable` | — | **6** |
| `select/call-graph-closure` | 3 | 3 |
| `select/async-function` | 4 | 4 |
| `select/date-constructor-unsupported` | 1 | 1 |
| `select/primitive-method-unsupported` | 1 | 1 |

Note the committed baseline in `scripts/ir-only-baseline.json` was stale in the
shared checkout at the start of this session (`emittedFloor` 16 /
`unsupportedCeiling` 21 / `call-graph-closure` 4) versus the measured 17 / 20 /
3; current `main` already carried the corrected figures.

## Gates

| gate | result |
|------|--------|
| `pnpm run check:ir-only` | READY (both lanes) |
| `pnpm run check:ir-fallbacks` | OK — no unintended/post-claim/module-level growth |
| `node scripts/gen-ir-adoption.mjs --check` | up to date |
| `tests/issue-4457.test.ts` | 4/4 pass |

## Follow-ups

- **#4461** — native-`$Map` storage modelling in the IR, so a module-level
  `new Map<K, V>()` and its `.get`/`.set` claim in standalone (rows 7+8).
- **#4462** — standalone `console.log` lowering to the `__stdout_append` sink
  (#3469) plus native `number_toString` (#3912) for the selector's
  `supportsNumberToString` (rows 9+10). Carries the verbatim
  `assertNotDeferred` capability-violation output as evidence for the required
  order of work.
