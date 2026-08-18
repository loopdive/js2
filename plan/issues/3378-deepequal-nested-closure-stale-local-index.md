---
id: 3378
title: "deepEqual.js fails to compile — stale LOCAL index in deeply-nested format/lazyResult closures (#2043 class, local not funcIdx)"
status: done
completed: 2026-07-24
assignee: sendev-3378
sprint: 78
created: 2026-07-17
priority: high
feasibility: hard
model: opus
horizon: l
reasoning_effort: high
task_type: bugfix
area: codegen, closures, emit
language_feature: compiler-internals
goal: test262-conformance
related: [2043, 3349]
loc-budget-allow:
  - src/codegen/closures.ts
---

# #3378 — `deepEqual.js` fails to compile: stale LOCAL index in nested closures

## How this was found

Split out of #3349. #3349's primary target (`propertyHelper.js` /
`verifyEnumerable`) is fixed on current main, but its "Related, likely-same-class
finding" section flagged a **second, separate** confirmation target that is
still live: the real, unmodified `test262/harness/deepEqual.js` fails to
compile.

`deepEqual.js` `includes:`-count is large (it backs `assert.deepEqual` across
many built-ins/language tests), so this is a meaningful raw-harness conformance
blocker in its own right.

## Confirmed repro (current main, 2026-07-17)

`deepEqual.js` alone compiles. It only fails once `assert` is a **real local
callable** (so `deepEqual.js`'s `assert.deepEqual.format = function(){…}`
closures are actually compiled, rather than treated as dynamic/host writes):

```ts
import { compile } from "./src/index.ts";
import { readFileSync } from "fs";
const rd = (f: string) => readFileSync("test262/harness/" + f, "utf8");
// A tiny local `assert` function is enough — it is NOT assert.js's size.
const stub = `function assert(x, m){ if(!x) throw new Error(m); }\nassert.x=1;\n`;
const src = `export function test() {\n${stub + rd("deepEqual.js")}\nconsole.log("x");\n}`;
const r = await compile(src, { target: "gc", fileName: "test.ts",
  skipSemanticDiagnostics: true, emitWat: false } as any);
// r.success === false
```

Errors observed (the second is the fatal one):

```
Cannot access 'contents' before initialization        (x4, severity: warning)
Binary emit error: RangeError: Codegen error: local index out of range — 8
(valid: [0, 5)) at function '__closure_15'. This is the late-import index-shift
class (#2043): a captured index went stale ...
```

## Root-cause direction (narrowed, not yet fixed)

- The fatal error is a **stale LOCAL index**, NOT a function-index shift. The
  encoder (`src/emit/binary.ts:vIdx`/`failIndex`) rejects a `local.get`/`.set`
  whose index (`8`) exceeds the synthesized closure's own local count (`5`).
  The generic #2043 message ("re-resolve the funcIdx by name after the last
  shift") is therefore **misleading for this instance** — no import shift is
  involved; a captured-variable slot is being emitted against the WRONG
  function's local numbering.
- Trigger shape: `assert.deepEqual.format` contains **3 levels of nested named
  functions** (`format` → `lazyResult` → `acceptMappers` → `toString`) plus
  `.map(arrow)` closures and tagged-template literals, with inner closures
  capturing outer locals (`usage`, `subs`, `strings`, `mappers`). One of the
  synthesized `__closure_NN` bodies emits a `local.get` for a captured variable
  using the ENCLOSING function's local index instead of its own
  captured-struct-field / remapped-local index.
- The `Cannot access 'contents' before initialization` warnings come from the
  early-error TDZ checker (`src/compiler/early-errors/tdz.ts`,
  `severity: "warning"`) mis-flagging block-scoped shadowing (`let contents` in
  sibling `if`-blocks at lines 125/129 vs. the function-body `let contents` at
  line 137). These are non-fatal warnings and likely a **separate, smaller**
  bug from the fatal local-index one — but worth fixing together since both
  surface on this file. (A minimal 2-if-block shadowing repro did NOT reproduce
  the warning in isolation, so the TDZ path is only reached via some additional
  structure in `format`; confirm the exact trigger before touching tdz.ts.)

## Why this is `feasibility: hard` / senior-dev candidate

The fatal is deep closure-lowering: a captured-local slot computed against the
wrong function's local space in a 3-deep nested-closure chain. It resists quick
minimization (the trigger needs most of `format`'s structure), so the fix needs
a WAT/codegen trace of the failing `__closure_NN` body to see which captured
variable's slot is emitted with the enclosing function's index, then a remap at
the capture-emission site (`src/codegen/closures.ts` /
`src/codegen/closures/*`). Follow the prior #2043-class point-fixes
(#1809/#1839/#2029) for the "resolve the slot in the closure's own frame"
pattern.

## Acceptance criteria

- The repro above (`stub-assert + deepEqual.js`) compiles to a valid binary.
- The full real-harness combo `assert.js + sta.js + propertyHelper.js +
  compareArray.js + deepEqual.js` (+ a trivial `Object.entries` body) compiles
  to a valid binary.
- The `Cannot access 'contents' before initialization` warnings on this file
  are gone (or confirmed a legitimate spec TDZ and intentionally kept).
- No regression in the existing JS-host test262 pass rate.

## Root cause (CONFIRMED 2026-07-24, sendev-3378) + fix

The filed root-cause direction ("a captured-local slot computed against the
wrong function's local space", pointing at `closures.ts` / call-site
capture-emission) was a symptom description. The ACTUAL root cause is one level
up, in the **free-variable analysis** itself:

`src/codegen/closures.ts::collectReferencedIdentifiers` walked the AST with a
generic `forEachChild` and added **every** `Identifier` it saw — including the
NAME side of a member access. `deepEqual.js` has a module-scope
`let join = arr => arr.join(', ')`, and `stringFromTemplate` contains
`parts.join('')`. The property name `join` in `parts.join('')` was therefore
mis-collected as a free-variable reference, so `stringFromTemplate` recorded a
**SPURIOUS capture** of the outer `join` local. That capture's
`outerLocalIdx` (the index of `join` in the IIFE frame that declares it, `6`)
is only meaningful in that declaring frame. When `stringFromTemplate` is
invoked from the deeply-nested `toString` closure (`__closure_12`, a different,
smaller frame with 5 locals), the capture-prepend
(`call-identifier.ts` non-mutable branch, `local.get cap.outerLocalIdx`) baked
`local.get 6` into a 5-local function ⇒ the binary-emit
`local index out of range — 6 (valid: [0, 5))` fatal.

**Why the naive `localMap`-first fix (reverted, 100+ regressions) was the wrong
layer:** that change altered the *emission* (which slot to read) for
IN-RANGE, valid-Wasm captures that were load-bearing. The real defect is that
the capture *should never have existed*. A non-computed member/property name is
never a variable reference; removing it from the free-var set is the canonical
free-variable-analysis rule and can only drop semantically-impossible
captures (no valid-Wasm behavior can depend on a spurious property-name
capture). This is a strictly-narrower, lower-risk change than touching the
emission site.

**Fix** (`collectReferencedIdentifiers`): recurse only into the
reference-bearing children of member/property nodes, skipping the NAME —
`PropertyAccessExpression` → `.expression` only; `QualifiedName` → `.left`
only; `PropertyAssignment` → `.initializer` (+ computed key). Shorthand
(`{ x }`, a real reference) and element access (`a[b]`, `b` a real reference)
are untouched.

Regression test: `tests/issue-3378.test.ts` (compiles the real
`test262/harness/deepEqual.js` + stub assert; asserts the stale-local-index
fatal is gone). Verified to FAIL on main (`local index out of range — 6 …
__closure_12`) and PASS on branch.

**Regression floor (the #1177-minefield gate):** full local equivalence suite
= **1608 passing, 0 new regressions** (35 pre-existing baseline failures
unchanged); the fix additionally flips **1** prior baseline failure to PASS
(`math-pow-test262-pattern`). `tsc --noEmit`, prettier, biome all clean. The
naive `localMap`-first *emission* fix regressed 100+; this narrower
*analysis* fix regresses 0, confirming the layer choice.

## SEPARATE, INDEPENDENT bug surfaced by this fix (NOT #3378)

Once the stale-local-index crash is fixed, `deepEqual.js` compilation proceeds
to binary emit and now fails **WebAssembly validation** with a DIFFERENT,
pre-existing defect:

```
CompileError: … function '__closure_6' (format): not enough arguments on the
stack for call (need 4, got 3)   — a call_ref arity mismatch
```

Proven independent of both this fix and the `join` collision by a controlled
experiment: with the fix OFF and the harness `join` VARIABLE renamed (so the
member-name collision cannot occur), the stale-local crash disappears but the
`need 4, got 3` arity error **still** reproduces. It was simply MASKED before —
the stale-local RangeError aborted binary emit before Wasm validation could
run. It resists minimization (6 targeted snippets + a faithful
format→lazyResult→acceptMappers→toString→stringFromTemplate skeleton all
compile cleanly), so it needs its own investigation.

**Consequence for AC #1/#2**: this fix is *necessary but not sufficient* for a
fully-valid deepEqual binary — the arity bug still blocks it. The `call_ref`
arity mismatch is now tracked as **#3576** (filed 2026-07-24 with the
controlled-experiment evidence). deepEqual.js → valid binary (this issue's AC
#1/#2) needs **both #3378 (this, landed via PR #3559) AND #3576**. This issue
stays `in-progress` until #3576 lands. The `Cannot access 'contents'` warnings
are pre-existing, non-fatal (severity: warning), present on main, and
orthogonal to this fix.

**Status:** bug #1 (stale-local crash) FIXED via PR #3559 (fork branch
`issue-3378-spurious-property-name-capture`); remaining AC blocker = #3576.
