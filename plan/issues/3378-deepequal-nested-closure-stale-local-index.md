---
id: 3378
title: "deepEqual.js fails to compile — stale LOCAL index in deeply-nested format/lazyResult closures (#2043 class, local not funcIdx)"
status: ready
sprint: current
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
