---
id: 4773
title: "acorn driver loses 5 IR claims: the #4491 vec-param narrowing withdrawal is module-wide, not per-argument"
status: done
sprint: current
created: 2026-08-27
completed: 2026-08-27
assignee: ttraenkler/opus-4612
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
#
# 2026-08-27 implementation: the reachability ANALYSIS went to a new subsystem
# module (src/codegen/declarations/provenance-closed-arrays.ts). What remains at
# the guard is irreducible: the import, the one added condition clause, and a
# 6-line pointer comment — a withdrawal rule's condition cannot live anywhere
# but the withdrawal. +9 lines on the file, +8 on the function.
loc-budget-allow:
  - src/codegen/declarations/param-return-inference.ts
func-budget-allow:
  - src/codegen/declarations/param-return-inference.ts::inferParamTypeFromCallSites
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

## Acceptance criteria

- [x] The acorn runtime-dynamic driver returns to **≥ 31/43 emitted** with
      **zero** post-claim withdrawals, with `isInAstralSet`,
      `isIdentifierStart`, `isIdentifierChar`, `isRegExpIdentifierStart` and
      `isRegExpIdentifierPart` all EMITTED.
- [x] The #4491 identity guarantee still holds: a vec parameter whose reaching
      arguments CAN be descriptor-dirty still has its narrowing withdrawn, with
      a test pinning the accessor survival across the argument boundary.
- [x] `tests/issue-4491-wave4.test.ts` and the descriptor suites are
      unregressed.
- [x] `check:ir-fallbacks` / `check:ir-only` unchanged or improved.

## Implementation (2026-08-27)

### Dispatch adjudication, recorded verbatim

`pre-dispatch-gate.mjs 4773` returned **STOP**: `BLOCKER ACTIVE idiom overlap —
4491-es5-defineproperty-mop-residual.md (status: ready, CLAIMED by
ttraenkler/dev-4491) shares [4491, withdrawal]`. The guard being made precise is
#4491's own, installed by that lane in wave-4, and #4491 was live (claim held
since 2026-08-23, `updated: 2026-08-25`).

The coordinator adjudicated **override**, on the record, after establishing that
`ttraenkler/dev-4491` is not an addressable session (local or cloud), so
brokering was impossible and re-routing would strand the issue behind an
unreachable lane. The override was made sound by **narrowing the scope**: only
the provenance-closed literal case is implemented, never general reachability,
so the soundness argument no longer needs #4491's descriptor-MOP context. If the
literal case had not recovered the five units, the instruction was to stop and
report rather than widen.

### The rule

A `__vec_*` parameter narrowing survives a descriptor-dirty module **only** when
both hold:

1. **Every** argument reaching that parameter, at **every** call site, is a bare
   identifier naming a *provenance-closed module-level array literal*:
   declared once at module level (not exported, not shadowed by any parameter,
   binding element or function of the same name), initialised to an array
   literal whose every element is a primitive literal (a hole, an identifier, a
   nested array/object all disqualify), and referenced **nowhere** except as a
   direct argument of a call whose callee is a plain identifier — which by
   construction excludes `Object.defineProperty(a, …)`, `Object.create(a)`,
   `Reflect.defineProperty(a, …)` (callee is a property access), `a.push(…)`,
   `a[i] = …`, `delete a[i]`, `a = x`, `f(...a)`, `new F(a)` and `export { a }`.
   Closure: each such array must be passed **only** to this exact
   `(funcName, paramIndex)`, so it cannot also flow into a function that might
   descriptor-touch it.
2. The callee only **reads** the parameter — no element or property store, no
   `delete`, no onward pass, no reassignment.

Anything unrecognised returns false and withdraws exactly as before; the default
is unchanged behaviour. The soundness claim is deliberately small: **a
descriptor cannot reach an object nothing else can reference.**

`new funcName(…)` sites fail closed (constructor provenance is not modelled).
A parameter with no call sites fails closed. A file containing `eval` or `with`
has **no** closed names at all — both can reach a binding without naming it in a
position any identifier scan can see.

### Where it lives

- `src/codegen/declarations/provenance-closed-arrays.ts` — **new**, the whole
  analysis plus the proof obligation, cached per source file (`WeakMap`), pure
  AST (no checker queries — `check:oracle-ratchet` reports +0).
- `src/codegen/declarations/param-return-inference.ts` — the wave-4 condition
  gains one clause, `!paramReceivesOnlyProvenanceClosedArrayLiterals(...)`. The
  rule, its comment and its measured rationale are otherwise untouched.

### Measured — acorn runtime-dynamic driver

All numbers in this section and the next were re-measured on the final head
**`bcd5403051`** — the merge of `origin/main` at `842ea5ca0b` into this branch,
which brought 12 changed `src/codegen` files, so the earlier run against
`2d72807370` could not be carried forward. Same reduced driver as the diagnosis
above.

| | main (without the change) | this branch `bcd5403051` |
| --- | --- | --- |
| emitted | 26/43 | **31/43** |
| post-claim withdrawals | 0 | **0** |
| `param-type-not-resolvable` | 1 | 0 |
| `body-shape-rejected` | 10 | 8 |
| `call-graph-closure` | 2 | 0 |
| `return-type-not-resolvable` | 3 | 3 |
| `logical-value-unsupported` | 1 | 1 |

The per-unit diff is **exactly** the five units of the regression flipping to
EMITTED and nothing else — identical to what the blunt guard-OFF probe produced,
i.e. the precise whitelist recovers everything the disable did and no more.

### Validation

Every suite was run **both** with and without the change (file-copy A/B on head
`bcd5403051`, swapping only `param-return-inference.ts` so the base is exactly
"this head minus the change"), because several of these suites are already red
on main and a raw failure count would have been unreadable. Failing-test **name
sets** were compared, not just counts — equal counts could hide a swap. All
three groups: identical names, identical counts.

| suite | with change | on base | verdict |
| --- | --- | --- | --- |
| `issue-4491-wave4` + `wave7` + `t4-add-parity` + `function-binding-widening` + `proto-index-constructor-shadow` | 4 failed / 50 passed | 4 failed / 50 passed | **byte-identical**, all pre-existing |
| `issue-3251` + `-s2` + `-s3`, `issue-4159`, `issue-4159-4160-prescan-flags`, `issue-4160-*` | 13 failed / 67 passed | 13 failed / 67 passed | **byte-identical**, all pre-existing |
| `es5-standalone-descriptors`, `-descriptor-bags`, `-getownpropertydescriptor`, `issue-2874`, `issue-3661-*` ×2, `issue-3663`, `issue-3037` | 9 failed / 36 passed | 9 failed / 36 passed | **byte-identical**, all pre-existing |
| `issue-4773-provenance-closed-vec-param` (new) | 9 passed | 1 failed (the must-pass) | pins the fix |

### For the #4491 lane (`ttraenkler/dev-4491`) — two pre-existing reds on main

Recorded here rather than passed along in conversation, because #4491's lane was
not reachable while this landed. **Neither is caused by this change** — both
fail identically with and without it, measured by the file-copy A/B above.

1. **The wave-4 invariant's own pin is red on main.**
   `tests/issue-4491-wave4.test.ts > #4491 wave-4 — vec identity at a
   monomorphic parameter > reads an array-index ACCESSOR through a narrowed
   parameter` fails on current main. That is the test asserting the very
   property the wave-4 withdrawal exists to protect, so the guard's regression
   coverage is currently not green. #4773 did not touch it and does not fix it;
   it is called out because a red invariant pin is easy to mistake for
   collateral from a later change.
2. **`tests/issue-4159-4160-prescan-flags.test.ts` fails 13 of 22** with
   `Cannot read properties of undefined (reading 'add')` — a harness/setup
   error (sub-millisecond failures), not a behaviour change in the pre-scan.

The three suites #4773 leaned on for validation are otherwise stable, and the
six MUST-WITHDRAW tests added here (below) are additional protection for the
wave-4 rule — they pass on the parent commit too.

| gate | result |
| --- | --- |
| `check:ir-fallbacks` | OK — no unintended/post-claim/module-level increases |
| `check:ir-only` | READY — 38 IR bodies, 0 legacy, `{"wasmgc/standalone":38}` |
| `check:linear-ir` | OK — files=13, compiled=10, buckets unchanged |
| `check-loc-budget` / `check-func-budget` | OK with the frontmatter grant above |
| `check-coercion-sites` / `check:oracle-ratchet` / `check:dead-exports` | OK (oracle +0, dead-exports 0 new) |
| `typecheck` | clean |
| `biome lint` (3 changed files) | clean |
| equivalence gate, 8 shards, separate processes | see below |

### Tests

`tests/issue-4773-provenance-closed-vec-param.test.ts` — 9 tests, both
directions, every one asserted by EXECUTING the operation rather than by
inspecting a type. All fixtures carry the same unrelated accessor descriptor and
assert `hostHidden() === 42`, so the module is provably descriptor-dirty in every
case — otherwise the must-withdraw tests would be vacuous.

- **must-pass** — the closed literal keeps its narrowing (`EMITTED`) and still
  computes `[1,1,1,0,1]`, which is what Node computes. Fails on the parent
  commit with `select:param-type-not-resolvable`.
- **must-withdraw ×7** — a descriptor on the array, an alias, an EXPORTED
  binding, a second callee, a store through the parameter, a non-literal
  element, and an `eval` anywhere in
  the file (`eval("Object.defineProperty(a, …)")` names a binding inside a
  string, where no identifier scan can see it; `with` is excluded on the same
  grounds). Each withdraws. The
  descriptor case additionally asserts the accessor is **honoured through the
  parameter** (`[1,1,1,1,1]`, matching Node): a carrier copy would answer the
  raw backing slot and give the descriptor-free `[1,1,1,0,1]`. That assertion is
  the #4491 invariant, and it passes on the base too — these five tests add
  protection for the wave-4 rule, they do not merely describe this change.
- **JS-host lane** — untouched; `overlayRouteActive` requires `ctx.standalone`.

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
