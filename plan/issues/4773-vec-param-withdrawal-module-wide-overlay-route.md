---
id: 4773
title: "acorn driver loses 5 IR claims: the #4491 vec-param narrowing withdrawal is module-wide, not per-argument"
status: ready
sprint: current
created: 2026-08-27
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: ir
language_feature: compiler-internals
goal: backend-agnostic-ir
parent: 2949
related: [4491, 4612, 4159, 4160, 3251]
origin: "#4612 close-out re-measurement (2026-08-27): the #2949 acorn runtime-dynamic driver dropped from 31/43 to 26/43 emitted between the #4612 merge (9bccce8d70, 2026-08-22) and main 7e0b03ebb7, with zero post-claim withdrawals throughout"
# id 4773 reserved via claim-issue.mjs --allocate --allow-unscanned on
# 2026-08-27 (gh CLI offline in this container; pr_scan=degraded). MCP
# open-PR scan at reservation: the 4 open PRs on loopdive/js2 (#5057, #5056,
# #5049, #5048) introduce or modify only issue files 4768, 4770, 4771 and
# 1609 — no plan/issues/4773-* is in flight.
---

# #4773 — the vec-param narrowing withdrawal is module-wide, so acorn loses 5 IR claims it can prove safe

## Problem

The #2949 acorn runtime-dynamic driver (npm-compat `--only acorn --lane
standalone-dynamic`, inline form) emits **26/43** units on current main. At the
#4612 merge five days earlier it emitted **31/43**. Post-claim withdrawals are
**0** at both endpoints — the #4612 guarantee holds; this is purely a loss of
*pre-claim* selection coverage.

The five lost units are **one dependency chain with a single head**, not five
independent regressions:

| unit | acorn.mjs line | at `9bccce8d70` | main `7e0b03ebb7` |
| --- | --- | --- | --- |
| `isInAstralSet` | 48 | EMITTED | select / **`param-type-not-resolvable`** |
| `isIdentifierStart` | 61 | EMITTED | select / `body-shape-rejected` |
| `isIdentifierChar` | 73 | EMITTED | select / `body-shape-rejected` |
| `isRegExpIdentifierStart` | 4613 | EMITTED | select / `call-graph-closure` |
| `isRegExpIdentifierPart` | 4641 | EMITTED | select / `call-graph-closure` |

`isInAstralSet(code, set)` is the head domino. It has exactly three call sites
in the whole bundle (acorn.mjs:68 and the two in the `||` at acorn.mjs:82), all
inside `isIdentifierStart` / `isIdentifierChar`, and all passing a module-level
literal `number[]`. Its two callers then fail `body-shape-rejected` because
their callee is unclaimable, and *their* two callers fail `call-graph-closure`
one level further up. The two "extra" buckets are downstream noise — there is
one cause.

Bucket-level view of the same measurement:

| bucket | `9bccce8d70` | main today |
| --- | --- | --- |
| emitted | 31/43 | **26/43** |
| post-claim withdrawals | 0 | 0 |
| `body-shape-rejected` (select) | 8 | 10 |
| `call-graph-closure` (select) | 0 | 2 |
| `param-type-not-resolvable` (select) | 0 | 1 |
| `return-type-not-resolvable` (select) | 3 | 3 |
| `logical-value-unsupported` (select) | 1 | 1 |

## Root cause — a correct guard applied at module granularity

**Bisect**: binary search over the 319-commit first-parent window
`9bccce8d70..7e0b03ebb7`, 9 steps, one measurement per step ("is `isInAstralSet`
EMITTED"). The harness swaps only `src/` and reproduces the base census exactly
(31/43), and the pinned acorn is constant across the window
(`tests/dogfood/acorn-pin.json` and `setup-acorn.mjs` are untouched), so the
move is purely compiler-side.

```
d821d96188  GOOD  31/43 emitted · isInAstralSet EMITTED    (last good)
8949b907e8  BAD   26/43 emitted · param-type-not-resolvable ← first bad commit
7e0b03ebb7  BAD   26/43 emitted · param-type-not-resolvable (main, 2026-08-27)
```

**`8949b907e8` = PR #4808, issue #4491 wave-4** — *"vec identity at a narrowed
param, freeze on array/arguments elements, `var x = undefined`, Date statics"*.
The load-bearing hunk is the new withdrawal in
`inferParamTypeFromCallSites` (`src/codegen/declarations/param-return-inference.ts`):

```ts
if (
  type !== null &&
  (type.kind === "ref" || type.kind === "ref_null") &&
  overlayRouteActive(ctx) &&
  getVecInfo(ctx, (type as { typeIdx: number }).typeIdx) !== null
) {
  type = null;
}
```

**The guard is CORRECT and must not be reverted.** Its rationale is soundness,
and it is measured: narrowing a callee's parameter to a concrete `$__vec_f64`
carrier turns the argument boundary into a carrier conversion, which
`emitVecToVecBody` implements as an element-wise copy into a fresh
`struct.new`. The #3251 overlay side table is keyed by vec **identity**
(`ref.eq`), so the callee would receive a brand-new array with no descriptors —
accessor get/set, `writable: false` enforcement and companion values all
silently vanish. That is the whole test262 `propertyHelper.js` verification
family (`verifyEqualTo` / `verifyWritable` / `verifyProperty`). The previous
acorn claims were therefore resting on a narrowing that is **unsound in a
descriptor-dirty module** — they were wrongly claimed before, and the −5 is the
guard's collateral, not a defect it introduced.

**The imprecision is the granularity, not the rule.** `overlayRouteActive(ctx)`
is a **module-wide** pre-scan flag (`src/codegen/typed-lane-overlay-route.ts`):

```ts
return ctx.standalone === true &&
  (ctx.vecAccessorDescriptorDirty === true || ctx.vecIndexDeleteDirty === true || ctx.protoIndexDirty === true);
```

One non-provably-data-only descriptor anywhere in the module sets it, and the
withdrawal then fires at **every** vec-typed parameter in that module. acorn
trips it at **acorn.mjs:685**:

```js
Object.defineProperties( Parser.prototype, prototypeAccessors );
```

where `prototypeAccessors` (acorn.mjs:600) receives `.get = function () {…}`
assignments at lines 608–626 — genuine accessor descriptors, correctly not
provably data-only. (acorn also has `Object.create` ×7 and two
`delete this.undefinedExports[name]` sites, so more than one trigger is
available.)

But `isInAstralSet`'s `set` parameter only ever receives
`astralIdentifierStartCodes` and `astralIdentifierCodes` — two module-level
array literals of numbers, never passed to `Object.defineProperties`,
`Object.create` or `delete`. **No descriptor can reach them.** The withdrawal
buys nothing for these units and costs five IR claims.

Once the narrowing is withdrawn, `set` falls back to `externref`, the IR
resolves it as `dynamic`, `dynNames` becomes non-empty, and
`dynamicUsesAreMoveOnly` fails on the `set.length` / `set[i]` / `set[i + 1]`
reads (they feed arithmetic, not a move), so the combined gate at
`src/ir/select.ts` reports `param-type-not-resolvable`. That combined gate is
byte-identical between the two endpoints — it is not the cause, it is the
reporter.

## Evidence: single-cause A/B on current main

The guard alone accounts for the entire −5. One-line probe on main
(`process.env.JS2WASM_PROBE_4773_DISABLE_VEC_WITHDRAWAL` short-circuiting the
new condition), same driver, same process, file-copy revert afterwards:

| run | result |
| --- | --- |
| guard ON (control, unmodified main) | `emitted=26/43 postClaim=0 isInAstralSet=select:param-type-not-resolvable` |
| guard OFF (probe) | `emitted=31/43 postClaim=0 isInAstralSet=EMITTED` |

The probe was a measurement only and is **not** proposed as a fix — disabling
the guard re-opens the #4491 identity hole.

**Context sensitivity, worth stating because it misdirects diagnosis:** a
30-line minimal repro containing exactly `isInAstralSet`, `isIdentifierStart`,
`isIdentifierChar` and the two astral arrays compiles with **all of them
EMITTED**. The loss appears only in the full 6,266-line bundle, because only
there does something set the module-wide dirty flag. Any attempt to reduce this
to a local shape rejection will fail to reproduce.

## Proposed direction (not yet implemented)

Make the withdrawal **per-argument-reachability** instead of module-wide: keep
the vec narrowing when every argument that reaches this parameter is provably
un-dirty (e.g. a module-level array literal never used as a receiver of
`defineProperty`/`defineProperties`/`Object.create`/`Reflect.defineProperty`,
never `delete`d at an index, and never escaping to a site that could do either).
Withdraw exactly as today otherwise.

This is deliberately left unimplemented here. The guard protects a measured
test262 correctness family, and a precision change to it must be validated
against the #4491 array-descriptor suites, not just against this driver.

## Acceptance criteria

- [ ] The acorn runtime-dynamic driver returns to **≥ 31/43 emitted** with
      **zero** post-claim withdrawals, with `isInAstralSet`,
      `isIdentifierStart`, `isIdentifierChar`, `isRegExpIdentifierStart` and
      `isRegExpIdentifierPart` all EMITTED.
- [ ] The #4491 identity guarantee still holds: a vec parameter whose reaching
      arguments CAN be descriptor-dirty still has its narrowing withdrawn, with
      a test pinning the accessor/`writable:false` survival across the argument
      boundary.
- [ ] `tests/issue-4491-wave4.test.ts` and the test262 `propertyHelper.js`
      verification family are unregressed.
- [ ] `check:ir-fallbacks` / `check:ir-only` unchanged or improved.

## Coordination

`getLineInfo` and `buildUnicodeData` (the units #2949's selector-arm work is
targeting) are `select:body-shape-rejected` at **both** endpoints of this
window — they are not part of this −5 and that lane's baseline is unaffected.

## Reproduction

```bash
# per-unit census of the #2949 acorn runtime-dynamic driver
node scripts/generate-npm-compat-report.mjs --only acorn --lane standalone-dynamic --inspect-ir
```

The measurements above used a reduced driver mirroring
`perfAcornStandaloneDynamic` → `compileStandaloneLane({ inlineDriver: true })`
(pinned acorn dist + the runtime-dynamic benchmark driver compiled as one
standalone unit with `deferTopLevelInit` and `trackIrOutcomes`), with
`optimize` off — `optimize` runs after codegen and cannot move an IR outcome.
Denominator 43 vs the #2949 notes' 42 is the same off-by-one those notes
already flag.
