---
id: 3576
title: "deepEqual.js `format` closure fails Wasm validation — call_ref arity mismatch (need 4, got 3)"
status: done
assignee: ttraenkler/sdev-3576
sprint: 77
created: 2026-07-24
updated: 2026-07-30
completed: 2026-07-24
priority: high
feasibility: hard
model: opus
horizon: l
reasoning_effort: high
task_type: bugfix
area: codegen, closures, string-ops, nested-declarations
language_feature: compiler-internals
goal: test262-conformance
related: [3378, 3559, 3560, 3563, 2873, 2043]
# (#3102/#3131) The fix adds logic intrinsic to the tagged-template
# known-function dispatch (string-ops.ts) and the nested-function param loop
# (nested-declarations.ts) — the arity/rest-param handling belongs exactly in
# those functions; extracting it to a subsystem module would add indirection
# for a targeted bugfix. Allow the small net growth in both god-files.
loc-budget-allow:
  - src/codegen/string-ops.ts
  - src/codegen/statements/nested-declarations.ts
# (#3400 / R-FUNC) Same rationale as loc-budget-allow: the added arity/rest-param
# handling lives inside these two functions by construction.
func-budget-allow:
  - src/codegen/string-ops.ts::compileTaggedTemplateExpression
  - src/codegen/statements/nested-declarations.ts::compileNestedFunctionDeclaration
---

# #3576 — `deepEqual.js` `format` closure: `call_ref` arity mismatch (need 4, got 3)

## How this was found

Surfaced by #3378 (PR #3559). #3378 fixed a stale-LOCAL-index binary-emit crash
in `deepEqual.js` (a spurious property-name capture). That crash **masked** a
SECOND, independent defect: once compilation proceeds past binary emit, the
module fails **WebAssembly validation**:

```
CompileError: WebAssembly.compile(): Compiling function #NN:"__closure_6"
failed: not enough arguments on the stack for call (need 4, got 3) @+15349
```

`__closure_6` is `assert.deepEqual.format` (locals `join`,
`getOwnPropertyDescriptor`, `basic`, `usage`, `format`, `contents`, `tag`,
`keys` — format's body). The failing instruction is a `call_ref` whose target
funcref TYPE has **4 params** but only **3** values are on the stack. The
4-param types in play are the array-callback wrapper ABI
(`(ref null <closure_struct>) externref externref externref` — i.e.
`env, value, index, array`), so the most likely shape is a `.map`/`.filter`
callback trampoline calling a callback closure with `env + value + index`
(3) where the callback's funcref type expects `env + value + index + array`
(4) — or the inverse mismatch between how the callback closure's type is built
vs. how it is invoked.

## Proven INDEPENDENT of #3378 (controlled experiment)

This is NOT a regression from #3378 and NOT caused by the `join` property-name
collision. Controlled experiment (2026-07-24), 4 cells:

| capture-fix | harness `join` var | result |
| ----------- | ------------------ | ------ |
| ON  | original | `need 4, got 3` (validation fail) |
| ON  | renamed (`joinFn`, collision removed) | `need 4, got 3` |
| OFF (main) | original | stale-local crash (#3378) — aborts before validation |
| **OFF (main)** | **renamed** | **`need 4, got 3`** |

The bottom-right cell is decisive: with the #3378 fix OFF and the `join`
VARIABLE renamed so the member-name collision cannot occur, the stale-local
crash disappears (nothing to crash on) but the `need 4, got 3` arity error
**still reproduces**. So the arity bug is pre-existing on `main` and was simply
never reached — the stale-local `RangeError` aborted binary emit before
`WebAssembly.compile` could run.

## Repro (current main OR #3559 branch)

```ts
import { compile } from "./src/index.ts";
import { readFileSync } from "fs";
const rd = (f) => readFileSync("test262/harness/" + f, "utf8");
const stub = `function assert(x, m){ if(!x) throw new Error(m); }\nassert.x=1;\n`;
const src = `export function test() {\n${stub + rd("deepEqual.js")}\nconsole.log("x");\n}`;
const r = await compile(src, { target: "gc", fileName: "test.ts",
  skipSemanticDiagnostics: true } as any);
// r.success === true  (compiler emits a binary)
await WebAssembly.compile(r.binary); // throws: need 4, got 3 at __closure_6
```

On `main` the same input throws the #3378 stale-local RangeError first; on the
#3559 branch (or after #3559 merges) it reaches the arity failure. The full
real-harness combo (`assert.js + sta.js + propertyHelper.js + compareArray.js +
deepEqual.js` + a trivial `Object.entries` body) fails identically at
`__closure_28`.

## Why `feasibility: hard` — resists minimization

The arity mismatch did NOT reproduce in any of 6 targeted minimal snippets
(plain `.map`, nested-fn `.map`, tagged-template-basic, a mapper-in-`.map`
pattern, `.map` with a 3-arg callback, `filter+map` over an object) NOR in a
faithful `format → lazyResult → acceptMappers → toString → stringFromTemplate`
skeleton (with and without outer-frame padding) — all compile to valid
binaries. So the trigger needs most of `format`'s real structure (the
tagged-template `lazyResult`/`lazyString` machinery returning a mapper-accepting
function, the `subs.map((sub,i) => (mappers[i]||String)(sub))` mapper
application, the `.filter(...).map(...)` over `Reflect.ownKeys`, the
TDZ-flagged `usage`/`format` captures, etc.). Localizing needs a WAT/`call_ref`
trace of the specific failing site in `format` (the byte offset is `@+15349`),
then determining whether the arity is wrong on the callback CONSTRUCTION side
(funcref type built with too many params) or the INVOCATION side (trampoline
pushing too few args). Likely lives in `src/codegen/array-methods.ts`
(callback-wrapper / trampoline ABI) and/or `src/codegen/closures/*`
(funcref-as-closure wrapper types).

## Mechanism analysis + fix candidate (dev-opus-arrayhof, 2026-07-24)

**Read-only source trace — NOT yet verified against the live repro (blocked on
#3559; see blockers). Documented durably so the fix survives a fresh re-spawn.**

### The 4-param funcref IS the array-callback ABI → it is a .map/.filter callback

`(env, value, index, array)` = `(ref null <closure_struct>) externref externref
externref` is *exactly* the spec-arity-3 array-callback ABI (map/filter/forEach
callbacks receive `value, index, array`; +1 for the closure env). A plain
`(mappers[i]||String)(sub)` call would be a 1-user-arg funcref (2 params), not
4. So the failing `call_ref` is an **array-method callback invocation**, and
"got 3" = `env + value + index` pushed with the trailing **`array`** arg missing.

### Where the under-push happens: `buildClosureCallInstrs` (array-methods.ts:~4957)

That trampoline pushes the callback args **gated on `numParams`**
(`= closureInfo.paramTypes.length`):

- `value` if `numParams >= 1` (~line 5015)
- `index` if `numParams >= 2` (~line 5033)
- **`array` if `numParams >= 3` (~line 5040)**  ← the skipped slot

and the `call_ref` uses `closureInfo.funcTypeIdx` (~line 5055). So it pushes
`numParams + 1` values but the call_ref demands `arity(funcTypeIdx)`. These
match **only when `arity(funcTypeIdx) === paramTypes.length + 1`**.

### The divergence: shared canonical-wrapper closureInfo (closures.ts:~2155, #2873-adjacent)

`setupArrayCallback` (array-methods.ts:~4804) resolves
`closureInfo = ctx.closureInfoByTypeIdx.get(closureTypeIdx)` off the callback
value's **struct type**. Per `closures.ts:~2155`, that struct can be a **shared
"canonical wrapper root"** used by multiple closures with the same param
*types* (e.g. all-externref params) but different declared *arities*. So a
2-declared-param callback (`(sub, i) => …`) can resolve to a `closureInfo`
whose `funcTypeIdx` is a **4-param** wrapper (inherited from a 3-user-param
sibling that shares the canonical wrapper) while its `paramTypes.length` is 2.
Result: `buildClosureCallInstrs` pushes `env + sub + i` = 3, the shared
`funcTypeIdx` needs 4 → **`need 4, got 3`**. Same shared-wrapper / RTT-arity
hazard family as #2873. (`ClosureInfo` sets `funcTypeIdx: liftedFuncTypeIdx`
and `paramTypes: arrowParams` *together* at construction — closures.ts:~2142 —
so the divergence is NOT a single arrow's own registration; it is introduced by
the **shared-struct lookup** returning a sibling's `closureInfo`.)

### Fix candidate — arity-pad to the funcref's ACTUAL arity (mirrors #3563)

In `buildClosureCallInstrs`, push callback args up to the **actual arity of
`closureInfo.funcTypeIdx`**, not `numParams`. For each param slot beyond
`numParams` (the `array` slot = `loop.vecTmp`, then any tail), emit the spec
value if known else the **missing-trailing-arg default** per param type —
exactly dev-d-1's `padMissingArg` helper in PR #3563 (`fix(#3024)`,
`src/codegen/index.ts emitMethodDispatch`): `__get_undefined` /
`ref.null.extern` for externref, sNaN / typed-zero otherwise. A `call_ref` MUST
push exactly the funcref's declared arity, so padding-to-`funcTypeIdx`-arity is
**always correct** and byte-inert whenever `arity == paramTypes.length + 1`
(the common case). Alternative (heavier): make `setupArrayCallback` reconcile
the resolved `closureInfo` so a shared-wrapper lookup can't return a sibling's
higher-arity `funcTypeIdx` — prefer the trampoline arity-pad first.

### Verification still needed (do these when unblocked)

1. **Reproduce** with #3559 applied (the repro above). Dump WAT
   (`emitWat:true`); locate the failing `call_ref` at `__closure_6 @+15349`;
   read its `funcTypeIdx` arity and the callback's `closureInfo.paramTypes.length`
   at that site — **confirm** the `4 vs 3` divergence and that it is the shared
   canonical-wrapper lookup (not a construction-side over-build).
2. Apply the `buildClosureCallInstrs` arity-pad; re-run repro →
   `WebAssembly.compile` passes (no `need 4, got 3`).
3. Full real-harness combo (`assert.js + sta.js + propertyHelper.js +
   compareArray.js + deepEqual.js` + trivial body) validates (`__closure_28`).
4. Equivalence suite (broad closure/array-method surface) + no test262 JS-host
   regression.

### Blockers (both in the merge queue 2026-07-24)

- **REPRODUCE → #3559** (#3378 stale-local fix): OPEN. On plain `main` the
  #3378 `RangeError` aborts binary emit before `WebAssembly.compile` runs.
- **EDIT → #3560** (array-methods.ts, a #3200 flatMap slice): OPEN in queue.
  Branch/edit `array-methods.ts` from a `main` that includes #3560 (and #3561,
  already merged) to avoid a rebase.

Per tech-lead decision 2026-07-24: **defer, single clean pass on main once both
land** (don't predecessor-stack at low budget).

## Acceptance criteria

- The `stub-assert + deepEqual.js` repro compiles to a binary that PASSES
  `WebAssembly.compile` / `WebAssembly.validate` (no `need 4, got 3`).
- The full real-harness combo (`assert.js + sta.js + propertyHelper.js +
  compareArray.js + deepEqual.js` + trivial body) validates.
- Together with #3378 this closes deepEqual.js's AC (`deepEqual.js` → valid
  binary); update #3378 accordingly.
- No regression in the JS-host test262 pass rate; validate on the full
  equivalence suite (broad closure/array-method codegen surface).

## RESOLUTION — verified mechanism + fix (sdev-3576, 2026-07-24)

**dev-c-1's read-only writeup above (buildClosureCallInstrs / array-callback
trampoline / shared canonical wrapper) is DISPROVEN by measurement.** Once the
repro was runnable (post #3559), instrumenting `buildClosureCallInstrs` showed
all 4 array-callback dispatches in `__closure_6` are consistent
(`funcArity=2, numParams=1, pushed=2`) — the failing `call_ref` is NOT an
array-method callback at all. The real mechanism, WAT-traced + instrument-
confirmed:

### Root cause — tagged-template call to a nested REST function

`__closure_6` is `assert.deepEqual.format`. Its body calls the nested function
`lazyResult(strings, ...subs)` as a **tagged template** (`lazyResult`...``) at
9 sites with VARYING substitution counts (1 sub at lines 106/110/113/…, 2 subs
at 119/138). `lazyResult` has a rest param `...subs` AND a TDZ-flagged capture
(`usage`, a `let`). Its lifted wasm signature is 4 params:
`[usageVal, usageTdzFlag, strings, subsVec]`.

Two independent gaps made the tagged-template call under-push the stack:

1. **`nested-declarations.ts` never registered the rest param in
   `ctx.funcRestParams`** (the top-level `declarations.ts:801` path does; the
   nested path was missing the `dotDotDotToken` arm). So `restInfo` was absent
   and the tagged-template dispatch treated the single `subsVec` param as
   positional sub slots — dropping the vec-packing and under-arity-ing.
2. **`string-ops.ts` tagged-template KNOWN-FUNC dispatch** pushed only the VALUE
   captures (never the TDZ-flag boxes) and computed `captureCount` as the value
   count only — so `strings`/substitutions landed at the wrong wasm slots and
   the TDZ-flag param was never supplied. → `call ... need 4, got 3`.

The naive "pad-to-arity" candidate from the writeup is **semantically wrong
here**: padding the `subsVec` slot with `undefined` produces a valid binary that
silently renders a spurious trailing element in `subs`.

### Fix (3 coupled parts)

- `src/codegen/statements/nested-declarations.ts` — add the `dotDotDotToken`
  arm to the param loop: lower `...args` to one `(ref null $vec)` param **and**
  register it in `ctx.funcRestParams` (mirrors `declarations.ts`).
- `src/codegen/string-ops.ts` KNOWN-FUNC tagged-template path — push the boxed
  TDZ-flag capture refs after the value captures (minimal replication of
  `call-identifier.ts`, gated on `tdzFlaggedNested.length > 0` so the common
  no-TDZ tag stays byte-inert), set `captureCount = values + tdzFlags`, and
  offset `strings` / positional-subs / rest-packing by that captureCount.

### Verification (measured, not extrapolated)

- `stub-assert + deepEqual.js` repro → `WebAssembly.compile` **OK** (arity error
  gone). ✓ (primary acceptance criterion)
- Isolation battery (`.tmp`): nested rest tag with no / const / let(TDZ) capture
  all render byte-correct vs node; **direct** calls to nested rest functions
  (`f("p",1,2,3)`) now render correctly — these were **BROKEN on `main`**
  (`undefined` / null-deref), so the fix is a strict improvement across the
  whole nested-rest-function surface, not just deepEqual.
- Equivalence suite (changed paths: tagged templates, rest params, closures,
  array callbacks, nested recursion): no NEW failures. The 2 failures observed
  (`optional-direct-closure-call`, an unrelated `?.()` IR-slice-11 fallback)
  reproduce identically on `main` — pre-existing, not this change.

### Known-orthogonal follow-up (NOT #3576, pre-existing on main)

A nested rest tag whose BODY uses the rest param as an ARRAY (`subs.map(...)` /
`subs[i]`) — as `lazyResult`'s `acceptMappers` does — mis-reads the tagged-
template `strings` param (a template-object struct coerced to externref):
`strings.join(...)` returns `undefined`. This reproduces on `main` too (worse:
null-deref), is independent of the arity fix (direct calls with `.map` render
correctly — only the tagged-template-strings path is affected), and blocks the
full runtime RENDERING of `format`. It does not affect the #3576 acceptance
criterion (validation). Carve a separate issue for the template-struct /
late-import interaction.
