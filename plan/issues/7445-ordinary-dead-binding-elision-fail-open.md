---
id: 7445
title: "Ordinary compile: dead-binding elision drops the only evidence of an error, and global-object reflection sees dropped vars"
status: ready
sprint: current
created: 2026-11-20
updated: 2026-11-20
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler, frontend
goal: core-semantics
related: [3418, 6898, 7354]
---

# Ordinary compile: dead-binding elision fails open

## Problem

The #3418 pass `elideDeadTopLevelBindings` (`src/deadcode-elide.ts`) blanks a dead top-level `var`/`let`/`const`
statement before the ordinary compile (`compileSourceSync` in `src/compiler.ts`) parses the program. That
compile is every standalone/WASI compile and every native-regime JS compile. Two classes of wrong answer remain
there after #7354 F0 (PR 7362) fixed what the shared pass could fix alone.

**1. A dropped statement takes its error with it.** The Prepared front door now decides on the analysis of the
UNELIDED program and keeps every statement that holds a frontend error (`src/test262/prepared-dead-bindings.ts`).
The ordinary compile decides blind: it elides before its only analysis. Measured with the reviewer's probe
(`/home/user/js2/.tmp/rv-f0/probe-rv-f0.test.ts`, lanes `ordinary standalone` and `ordinary default`, both
skipSemanticDiagnostics). These compile and return where node throws:

| program | node |
|---|---|
| `var g = function () { l: l: ; };` | SyntaxError |
| `var g = function () { l: { l: ; } };` | SyntaxError |
| `var g = function () { class C { constructor() {} constructor() {} } };` | SyntaxError |
| `var g = function () { return import.meta; };` (Script) | SyntaxError |

The same rows fail on main. F0's detector fix (duplicate labels inside function bodies, also inside a class static
block) would catch the label rows, but the elision runs first, so the detector never sees the statement.

**Restricted global declarations on the ordinary compile.** F0's never-elide rule keeps a dead declaration of
`undefined`/`NaN`/`Infinity` (`GLOBAL_CONSTANTS`). Kept, it meets the ordinary compile's existing trap for such
a declaration. Per goal, for a dead `let undefined = 1;` / `const NaN = 1;` / `let Infinity;`
(skipSemanticDiagnostics):

| goal | node | main (statement dropped) | PR 7362 (statement kept) |
|---|---|---|---|
| Script (`scriptGoal`, the runner) | SyntaxError at start | compiles, returns (wrong) | throws at start (right) |
| unstated | (Script) SyntaxError | compiles, returns | throws at instantiation |
| Module (`inferModuleStrictArguments: true`) | ok | ok | throws at instantiation (**wrong**) |

The Module row is a new wrong answer only for a dead declaration; the live form already throws on main.
Fixing it at the elision means making the never-elide rule apply only where the names are restricted (a Script, or
an unstated goal). That needs the goal threaded through `elideWithIrIds` and `elideDeadTopLevelBindings` from both
callers. The better fix is in the trap: a Module's `let undefined` is an ordinary module binding.

Wrong on main and on the PR alike, independent of the elision:

| program | node |
|---|---|
| `"use strict"; var NaN = 1;`, `"use strict"; var undefined = 2;`, `"use strict"; var Infinity = 1;` | TypeError |
| `var x = -({ valueOf() { throw 7; } });` | throws |
| `function f(){ throw 7; } var x = true ? f() : 1;` | throws |

The strict `var` rows need a run-time TypeError from the global-var store. The last two are ordinary codegen
bugs, not elision.

**2. Global-object reflection sees a dropped `var`.** The pass sees names, not computed lookups on the global
object. These programs observe a dropped binding and give the wrong answer on the ordinary path, on main and on
PR 7362 alike:

```js
var hidden = 1; var k = "hid" + "den"; if (globalThis[k] !== 1) throw 1;
var hidden = 1; if (Object.keys(globalThis).indexOf("hid" + "den") < 0) throw 1;
var hidden = 1; if (globalThis.eval("hid" + "den") !== 1) throw 1;
var hidden = 1; if (this.eval("hid" + "den") !== 1) throw 1;
var hidden = 1; var F = (function () {}).constructor; if (F("return hid" + "den")() !== 1) throw 1;
var hidden = 1; var c = 0; for (var k in this) { if (k === "hid" + "den") c = 1; } if (c !== 1) throw 1;
var toJSON = function () { return 5; }; if (JSON.stringify(globalThis) !== "5") throw 1;
var name = "N"; var message = "M"; if (Error.prototype.toString.call(globalThis) !== "N: M") throw 1;
var value = 5; var o = {}; Object.defineProperty(o, "p", globalThis); if (o.p !== 5) throw 1;
```

The Prepared path is safe today only because it refuses all of these: `globalThis`, `this` at the top level,
`Object`, for-in. The first slice that admits global-object reflection on the Prepared path inherits this hazard.

## Acceptance criteria

- The ordinary compile keeps every statement that holds a frontend error of the unelided program, as the
  Prepared front door does. The candidate design is to reuse `elideDeadTopLevelBindings`'s `pinnedOffsets` with
  the early-error detector run on a parse of the unelided source. That costs one extra parse and detector walk;
  the Prepared door's full second analysis cost ~8 ms median on the 411-row sample. Measure the cost.
- A program that can reach the global object by computed name keeps every candidate, or the pass proves the
  reach absent. Candidates for "can reach": `globalThis`/top-level `this` outside a member access with a literal
  name, `.eval`, `.constructor` on a function value, `Object.keys`/`getOwnPropertyNames`/for-in over the global
  object, the global object passed to a builtin that reads its properties. Each probe above is a test against
  node on the ordinary standalone and default lanes.
- Ordinary bytes stay identical for programs with neither shape (the F0 byte proof: 50 test262 files × 2 targets
  plus 10 Temporal rows).

## Notes from #7354 F0 review round 2 (2026-11-20)

- **Prepared path, independent of elision (main = PR 7362):** in runner mode (`skipSemanticDiagnostics`,
  `scriptGoal`), `let undefined = 1;`, `const NaN = 1;` and `const undefined = 1;` compile and return; node throws
  a SyntaxError at GlobalDeclarationInstantiation.
  - This is a run-time error of the Script (test262 `decl-lex-restricted-global.js` is `negative: phase:
    runtime`), so it does not belong in the early-error detector. A detector rule for it regressed that row in
    round 1 and was removed.
  - It needs a declaration-instantiation check in the Script's start code.
- **Accepted on both paths, main and PR alike:** `let {undefined} = {};`, `let [NaN] = [];` and
  `function NaN() {}` at the Script top level (restricted names through destructuring or a function declaration;
  the never-elide rule sees only plain identifier declarators).
- **Dead duplicate:** `IMMUTABLE_GLOBAL_PROPERTY_NAMES` in `src/codegen/expressions/runtime-eval-provider.ts` is an
  unused copy of `GLOBAL_CONSTANTS` (`src/shared/ambient-intrinsics.ts`); delete it.
