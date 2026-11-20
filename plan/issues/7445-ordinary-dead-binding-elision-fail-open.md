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

The same rows fail on main. F0's two detector fixes catch the label rows once the detector sees the statement:
labels in function bodies, and `checkRestrictedGlobalLexicals`. The elision runs first, so the detector never
sees it.

Rows the shared pass now keeps (F0 (b), (c) and the duplicate-lexical rule) but the ordinary compile still
compiles wrongly, independent of the elision. They are also wrong on main:

| program | node |
|---|---|
| `let undefined = 1;`, `const NaN = 1;`, `let Infinity;`, `const undefined = 1;` | SyntaxError |
| `"use strict"; var NaN = 1;`, `"use strict"; var undefined = 2;`, `"use strict"; var Infinity = 1;` | TypeError |
| `var x = -({ valueOf() { throw 7; } });` | throws |
| `function f(){ throw 7; } var x = true ? f() : 1;` | throws |

Of these, `let`/`const` of a restricted name is caught by the new early-error rule only when the caller states a
Script goal (`scriptGoal: true`, as the test262 runner does). The strict `var` rows need a run-time TypeError from
the global-var store. The last two are ordinary codegen bugs, not elision.

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
