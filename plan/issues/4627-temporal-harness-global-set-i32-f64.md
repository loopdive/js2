---
id: 4627
title: "TemporalHelpers harness: global.set expects f64, finds local.get of i32 → invalid Wasm (1,477 test262 CEs)"
status: done
sprint: current
created: 2026-08-23
updated: 2026-08-23
completed: 2026-08-23
assignee: ttraenkler/opus-dev-4627
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen, closures, type-coercion
language_feature: closures, global-set, type-coercion
goal: correctness
test262_fail: 1477
related: [1745, 1734, 661]
---

# #4627 — TemporalHelpers harness `global.set` expects f64, finds `local.get` of i32 → invalid Wasm

## Problem

**1,477 test262 `compile_error` rows — 32 % of the entire Temporal bucket — are
a single codegen bug in a *harness* helper, not in Temporal itself.**

Every one of them fails with the same signature:

```
L1:5 invalid Wasm binary (WebAssembly.instantiate():
  Compiling function #135:"__anon_6_checkThisValueNotCalled" failed:
  global.set[0] expected type f64, found local.get of type i32 @+140230)
  [in __anon_6_checkThisValueNotCalled()]
```

`checkThisValueNotCalled` is a `TemporalHelpers.js` harness function, so it is
compiled into essentially every Temporal test — which is why one defect
accounts for 1,477 rows. The tests never run at all: the module fails
`WebAssembly.instantiate()`, so nothing about the test body is exercised.

## Measured impact

From `test262-current.jsonl` (fetched fresh 2026-08-23, 48,735 entries),
filtered to paths containing `Temporal`:

| Bucket | Count |
| --- | --- |
| Total Temporal tests | 4,611 |
| `pass` | 207 |
| `compile_error` | 1,487 |
| `fail` | 2,917 |

Of the 1,487 compile errors, **1,477 carry this exact signature**. The
remaining Temporal failures split into 2,206 × `Temporal is not defined`
(see #4628) and ~711 genuine semantic failures.

The same signature appears on only **12 non-Temporal tests** (9 under
`test/built-ins/Array`, 3 under `test/built-ins/Iterator`), so this is
overwhelmingly a Temporal-harness unblock — but it is a *generic* codegen
defect and the fix belongs in the coercion path, not in anything
Temporal-specific.

Reproduce the buckets with:

```bash
node scripts/fetch-baseline-jsonl.mjs --force
# then filter .test262-cache/test262-current.jsonl on
#   path contains "Temporal" && error matches
#   /global\.set\[0\] expected type f64, found local\.get of type i32/
```

## Root cause (hypothesis — to confirm)

A value computed as **i32** is written into a module global declared **f64**
without a coercion. The failing function is a lifted closure
(`__anon_6_*`), so the suspected path is the same one that produced #1745:
the closure-global store site does not route its operand through
`coerceType` before emitting `global.set`.

This is the **i32 arm** of the defect family #1745 closed. #1745 was
`global.set[0] expected type f64, found if of type (ref null 3)` — a
conditional-result reaching an f64 global as a *reference*; that fix landed
2026-05-31 and covered the `if`-block-result case. The i32-scalar case is
still open, which suggests the #1745 fix was applied at the specific
`if`-result site rather than at the shared `global.set` emission point.

Likely culprits:

- a comparison / `typeof` / boolean-valued expression (natural i32) assigned
  to a captured variable whose global was declared f64, or
- an i32-typed native local flowing into a captured-variable global,

with the coercion missing on the store rather than on the producer.

## Where to look

- `src/codegen/closures.ts` / `src/codegen/closure-exports.ts` — closure
  global declaration + store sites
- `src/codegen/type-coercion.ts` — `coerceType`; the i32 → f64 direction is
  `f64.convert_i32_s`, which already exists and is used elsewhere
- `#1745`'s fix commit — apply the same treatment at the shared emission
  point rather than per-producer-shape

## Acceptance criteria

1. `checkThisValueNotCalled` compiles to a **valid** module — the emitted
   `global.set` is preceded by an `f64.convert_i32_s` (or the global is
   declared with the correct type).
2. The 1,477 Temporal rows carrying this signature no longer report
   `compile_error`. They are **not** expected to all pass — most will convert
   to `Temporal is not defined` (#4628) or to real semantic failures. The
   success condition is *the compile error is gone*, not a pass-count target.
3. No net regression on the overall test262 baseline.
4. A regression test under `tests/` covering an i32-valued expression stored
   into an f64-declared closure global.

## Notes

Fixing this is a prerequisite for measuring anything else about Temporal
conformance: while 1,477 tests fail before instantiation, any change to
Temporal semantics is invisible in those rows.


## Implementation Plan

**Status of this plan: root cause CONFIRMED by local reproduction, and a
candidate fix was applied and verified to make the harness module validate.
The hypothesis section above (a `coerceType` gap at the mint site) was the
right family but the WRONG site — read this section, not that one.**

### Reproduction (deterministic, ~90s)

The failure needs the *real* harness; no reduced snippet reproduces it. Three
minimal shapes were tried first and all compiled cleanly: a captured `let
called = false` written from a nested `function`, from an arrow passed to a
host call, and from a derived-class constructor inside an exported function.

```bash
# 1. fetch the harness files the failing tests include
SP=.tmp
for f in assert.js sta.js compareArray.js temporalHelpers.js; do
  curl -sS https://raw.githubusercontent.com/tc39/test262/main/harness/$f -o $SP/$f
done

# 2. probe (goes in tests/probe-*.test.ts — gitignored; vitest only scans tests/**)
```

```ts
// tests/probe-4627.test.ts
import fs from "node:fs";
import { describe, it } from "vitest";
import { compile } from "../src/index.js";

const read = (f: string) => fs.readFileSync(`.tmp/${f}`, "utf8");

describe("probe 4627", () => {
  it("compiles + validates temporalHelpers.js", async () => {
    const src = [read("assert.js"), read("sta.js"), read("compareArray.js"),
      read("temporalHelpers.js"), "var __probe = TemporalHelpers;"].join("\n");
    const result: any = await compile(src, {
      allowJs: true, fileName: "probe.js", sourceMap: true, emitWat: true,
      skipSemanticDiagnostics: true, deferTopLevelInit: true,
    } as any);
    if (result.wat) fs.writeFileSync(".tmp/harness.wat", result.wat);
    try { await WebAssembly.compile(result.binary); console.log("### validate: OK"); }
    catch (e: any) { console.log("### validate: FAIL", String(e?.message).slice(0, 400)); }
  }, 600000);
});
```

Those `compile` options are copied from `tests/test262-runner.ts:4233` — the
`allowJs` / `skipSemanticDiagnostics` / `deferTopLevelInit` combination is what
makes this match the runner's path. Without them the probe dies on TypeScript
diagnostics (`Cannot find name 'Test262Error'`) and never reaches codegen.

Before the fix:

```
### validate: FAIL WebAssembly.compile(): Compiling function
  #132:"__anon_6_checkThisValueNotCalled" failed:
  global.set[0] expected type f64, found local.get of type i32 @+75307
```

### What the emitted module actually contains

The source is `temporalHelpers.js` ~L890:

```js
checkThisValueNotCalled(construct, method, methodArgs, resultAssertions) {
  let called = false;                    // ← captured, boolean
  class MySubclass extends construct {
    constructor(...args) { called = true; super(...args); }
  }
  ...
}
```

In the WAT, the local and the global disagree:

```wat
(global $__captured_called (mut f64) (f64.const 0))   ;; global 582 — f64

(func $__anon_6_checkThisValueNotCalled (type 52)
  (local $called i32)                                  ;; ← i32
  (local $__tdz_called i32)
  ...
  i32.const 0
  local.set 5          ;; called = false
  i32.const 1
  local.set 6          ;; __tdz_called = 1
  local.get 5          ;; i32
  global.set 582       ;; ← expects f64. INVALID.
```

Every other `__captured_*` global in that module is `externref`; `called` is
the only `f64` one, because it is the only captured **boolean**.

### Root cause — the two-pass class re-compile, not the mint site

`promoteAccessorCapturesToGlobals` (`src/codegen/closures.ts:466`) mints the
global. Its type comes from the frame's local
(`src/codegen/closures.ts:636-641`), falling back to `{ kind: "f64" }` when the
index does not resolve. Instrumenting that site shows it running **once** for
`called`, in a frame reporting `params=6 locals=4`, resolving `f64`.

But the emitted function has `called` at local index **5**, typed **i32**. The
frame changed between the two — which is the #4618 two-pass class re-compile.
`compileNestedClassDeclaration` (`src/codegen/statements/nested-declarations.ts`)
compiles the enclosing body twice (discovery + final emission), and
`ctx.capturedGlobals` is cleared in between. Re-running the promotion on pass 2
would mint fresh globals the already-compiled method bodies never see, so
#4618 added a **re-bind** path instead — `nested-declarations.ts:227-241`:

```ts
const recorded = ctx.classMemberCaptureGlobals?.get(className);
if (recorded !== undefined) {
  for (const [name, entry] of recorded) {
    ...
    const localIdx = fctx.localMap.get(name);
    if (localIdx !== undefined) {
      fctx.body.push({ op: "local.get", index: localIdx });     // pass-2 local: i32
      fctx.body.push({ op: "global.set", index: entry.globalIdx }); // pass-1 global: f64
```

**The re-bind syncs pass 2's fresh local into pass 1's global with no type
check and no coercion.** Pass 1 typed the global `f64`; pass 2 allocates the
local as `i32` (correctly, from `let called = false`). `promotedRecord`'s entry
carries only `{ globalIdx, widened }` — the ValType is not recorded, so the
re-bind has nothing to compare against and blindly stores.

This is a *different site* from #1745. #1745 fixed a coercion gap where the
value was an `if`-block result of `(ref null 3)`; this is a cross-pass type
disagreement in the #4618 re-bind, which post-dates it. That is why the family
looks familiar but the earlier fix does not cover it.

### The fix (verified)

Applied at `src/codegen/statements/nested-declarations.ts:234-238`, this makes
the harness module validate:

```ts
const localIdx = fctx.localMap.get(name);
if (localIdx !== undefined) {
  fctx.body.push({ op: "local.get", index: localIdx });
  const localType =
    localIdx < fctx.params.length
      ? fctx.params[localIdx]!.type
      : fctx.locals[localIdx - fctx.params.length]?.type;
  const globalType = ctx.mod.globals[entry.globalIdx - ctx.numImportGlobals]?.type;
  if (localType && globalType && localType.kind !== globalType.kind) {
    coerceType(ctx, fctx, localType, globalType);
  }
  fctx.body.push({ op: "global.set", index: entry.globalIdx });
```

Needs `import { coerceType } from "../type-coercion.js";`. Global index →
`ctx.mod.globals` index is `entry.globalIdx - ctx.numImportGlobals`
(`nextModuleGlobalIdx`, `src/codegen/registry/imports.ts:169`).

Result: `### validate: OK`, WAT grows by 44 bytes (the inserted
`f64.convert_i32_s`).

**Treat this as a verified starting point, not the finished change.** Decide
these before shipping:

1. **Read side.** The store now coerces, but a read of `__captured_called`
   yields `f64` where the frame's local is `i32`. For a boolean, `0.0`/`1.0`
   round-trips correctly *if* every read coerces back. Audit the
   `capturedGlobals` read sites (`src/codegen/expressions/identifiers.ts`, and
   the write sites in `assignment.ts` / `unary-updates.ts` referenced in the
   `closures.ts:679-700` comment) and confirm — or add the symmetric coercion.
   The probe only proves the module *validates*; it does not prove `called`
   reads back as `false`.
2. **Record the type instead.** The cleaner fix is to extend `promotedRecord`'s
   entry to `{ globalIdx, widened, type: ValType }` (`nested-declarations.ts:267`,
   `closures.ts:670`, and the type at `src/codegen/context/types.ts:2742`), so
   the re-bind coerces against the recorded type rather than re-deriving it
   from `ctx.mod.globals`. Prefer this if it does not balloon the diff.
3. **Consider the mint-site default too.** `closures.ts:636-641` silently
   defaults to `f64` when the local index does not resolve. That default is
   what gave pass 1 the wrong type in the first place. Making it resolve
   correctly — or making a miss loud — may fix this at the source and is worth
   one investigation pass before settling for the store-side coercion.
4. **`coerceType` may emit more than a convert** for kind pairs other than
   i32→f64 (it can route through `__box_number`, which needs a host import).
   Guard the call to the scalar cases you actually expect, or verify the
   externref paths do not fire here.

### Acceptance criteria (supersedes the list above where they differ)

1. The probe above prints `### validate: OK`.
2. A regression test under `tests/` — not `.tmp/`, not `tests/probe-*` — that
   compiles a captured boolean mutated from inside a nested class constructor
   and asserts both that the module validates **and** that the value reads back
   correctly (`called === false` after a static-method call that never runs the
   subclass constructor).
3. The 1,477 Temporal rows carrying this signature no longer report
   `compile_error`. **They are not expected to pass** — most will convert to
   `Temporal is not defined` (#4628) or to real semantic failures. The success
   condition is that the compile error is gone.
4. No net regression on the overall test262 baseline. Note that the 12
   non-Temporal tests sharing this signature (9 `built-ins/Array`, 3
   `built-ins/Iterator`) should also clear.

### Files

- `src/codegen/statements/nested-declarations.ts` — the fix (L227-241)
- `src/codegen/closures.ts` — `promoteAccessorCapturesToGlobals`, mint site
  (L466, L636-641, L664-670)
- `src/codegen/context/types.ts:2742` — `classMemberCaptureGlobals` entry shape
- `src/codegen/type-coercion.ts:1958` — `coerceType`

## Resolution — fixed on `main` by 569d78f7; this PR adds the missing coverage

**Do not implement the plan above. It was overtaken while it was being
written.** `569d78f7` ("heal the post-#4728 Temporal merge_group regression")
landed on `main` on 2026-08-23 and fixes this defect at a better place than
the plan's candidate patch. This entry records the independent verification and
the one gap that remained.

### Verified: reproduced, then confirmed fixed

Reproduced on `a09006d2` (the last `main` before the fix) using the plan's
recipe verbatim:

```
### validate: FAIL WebAssembly.compile(): Compiling function
  #132:"__anon_6_checkThisValueNotCalled" failed:
  global.set[0] expected type f64, found local.get of type i32 @+75307
```

Re-run against `37faca28` (`main` after `569d78f7`), same probe, same harness
files: `### validate: OK`.

### The root cause was NOT the two-pass re-compile alone

Instrumenting the mint and re-bind sites against the real harness shows the
plan's account is half right, and the missing half is what `569d78f7` fixes:

```
[MINT]   called fn=__anon_6_checkSubclassConstructorUndefined  type=f64  gidx=534
[REBIND] called class=MySubclass fn=__anon_6_checkSubclassConstructorNotCalled  localType=f64
[REBIND] called class=MySubclass fn=__anon_6_checkSubclassSpeciesNull           localType=f64
[REBIND] called class=MySubclass fn=__anon_6_checkSubclassSpeciesUndefined      localType=f64
[REBIND] called class=MySubclass fn=__anon_6_checkThisValueNotCalled  localType={"kind":"i32","boolean":true}  gtype=f64
```

The global is minted **exactly once**, and legitimately as `f64` — the first
helper declares `let called = 0`. The other four never mint anything: all five
helpers declare a class named `MySubclass`, and `classMemberCaptureGlobals`
(like `structMap`) was keyed by class NAME, so helpers 2–5 hit the
early-return re-bind against helper 1's record. `checkThisValueNotCalled` is
the only one of the five declaring `let called = false` — a branded-boolean
`i32` — so it is the only one whose carriers disagreed, and one blind
`local.get; global.set` pair took the whole module down.

So the defect is a **cross-function collapse**, not a cross-pass one.
`569d78f7` re-keys the record from class name to the `ts.Node` declaration, so
the re-bind fires only for a true pass-2 re-compile of the SAME declaration,
plus a `valTypesMatch` guard that skips the sync on any residual mismatch.
That is strictly better than coercing at the store, which is what the plan
proposed and what this branch first implemented: coercing would have *kept*
the wrong cross-function binding and merely made it type-legal.

**Plan open decision 3 (the mint-site `f64` default at `closures.ts:636-641`)
— investigated, NOT implicated.** It resolved the type correctly from a real
`let called = 0`; the silent default never fired. Changing it would have been
pure regression risk.

### What this PR contributes

Only `tests/issue-4627-captured-global-coercion.test.ts`. `main` already
carries `tests/issue-4787-temporal-merge-group-regressions.test.ts`, which
covers the same class of defect with a boolean/string pair and plain (non-
derived) classes. This test covers what that one does not, and is the exact
shape from the failing harness:

- the **numeric-`f64` vs boolean-`i32`** carrier pair (the one that actually
  produced the reported `expected type f64, found local.get of type i32`);
- a **dynamic `extends construct`** heritage, as `TemporalHelpers` uses;
- **runtime read-back**, not just module validity.

It fails on `a09006d2` (both assertions: `CompileError`) and passes on
`37faca28`.

### Read-back is asserted four ways, and that is deliberate

The second assertion scores four independent reads of the captured boolean
rather than one, because they do not all have the same sensitivity. Measured
against an intermediate build that coerced at the store instead of avoiding
the bad binding:

| read of `called` | store-coercion only | correct binding (`main`) |
| --- | --- | --- |
| `called === false` | ✅ | ✅ |
| `typeof called === "boolean"` | ✅ | ✅ |
| `!called` | ✅ | ✅ |
| `("" + called) === "false"` | ❌ `"0"` | ✅ `"false"` |

Comparison, `typeof` and truthiness all survive an f64 widening unaided. The
**boxing boundary does not**: `ValType`'s `boolean` field is a
structural-only brand consulted at the box site to pick `__box_boolean` over
`__box_number` (`src/ir/types.ts:227`), so a widened boolean crosses to the
host as the NUMBER 0. That is precisely the boundary test262's
`assert.sameValue(called, false)` crosses — so a test asserting only
`=== false` would have passed on a build that still got the harness wrong.

### Not claimed

**No test262 delta is claimed — none was measured here.** Per the acceptance
criteria the success condition is that the compile error is gone; those 1,477
rows are expected to convert to `Temporal is not defined` (#4628) or to real
semantic failures, not to passes.

### Still open, out of scope (worth its own issue)

`structMap` is still keyed by class name, so those five distinct `MySubclass`
declarations still share ONE compiled class body —
`checkThisValueNotCalled`'s subclass constructor is actually the first
helper's (`++called` rather than `called = true`). That is a real semantic
defect, independent of this one: it produces no invalid Wasm, and fixing it
means un-collapsing another name-keyed registry.
