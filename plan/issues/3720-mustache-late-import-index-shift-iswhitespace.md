---
id: 3720
title: "Late-import index-shift crash compiling mustache@4.2.0's isWhitespace (RegExp.prototype.test.call indirection) — new #2043-class occurrence"
status: ready
sprint: current
created: 2026-07-27
updated: 2026-07-27
priority: medium
horizon: m
feasibility: hard
reasoning_effort: medium
task_type: bugfix
area: codegen, emit
language_feature: compiler-internals
goal: core-semantics
origin: "ad-hoc probe of 3 more single-bundled-file npm packages (dayjs/mustache/diff), same shape as the acorn/marked dogfood pattern"
related: [2043, 1710, 3716]
---

# #3720 — mustache compile crash: late-import index-shift in `isWhitespace`

## Repro

Pin: `mustache@4.2.0`, entry `mustache.js` (single self-contained UMD
bundle, zero runtime deps, 772 lines — same "single pre-bundled dist file"
shape as acorn/marked).

```bash
npm pack mustache@4.2.0
tar -xzf mustache-4.2.0.tgz
```

```ts
import { compile } from "./src/index.js";
import { readFileSync } from "node:fs";
const src = readFileSync("package/mustache.js", "utf-8");
const result = await compile(src, { fileName: "mustache.js", skipSemanticDiagnostics: true });
```

Throws (does not return `success: false` — the emit step itself throws):

```
Binary emit error: RangeError: Codegen error: local index out of range — 3
(valid: [0, 2)) at function 'isWhitespace'. This is the late-import
index-shift class (#2043): a captured index went stale across a deferred
flushLateImportShifts/addUnionImports/addStringImports shift, or a map
lookup failed and baked -1/undefined. Re-resolve the index by name AFTER
the last shift, or make the producer refuse loudly.
```

Stack: `emitBinaryWithSourceMapUnguarded` → `emitBinary` → `runPipeline` →
`compileSourceSync` (`src/compiler.ts:1452`).

## Offending source (mustache.js:61-64)

```js
var regExpTest = RegExp.prototype.test;
function testRegExp (re, string) {
  return regExpTest.call(re, string);
}

var nonSpaceRe = /\S/;
function isWhitespace (string) {
  return !testRegExp(nonSpaceRe, string);
}
```

`isWhitespace` calls `testRegExp`, which invokes `RegExp.prototype.test`
indirectly via `.call()` (a module-level `var` capturing the unbound
method) rather than `re.test(string)` directly. That indirection is likely
what triggers a late-added import (regex test intrinsic, or a `.call`
dispatch helper) whose function index gets captured before a later
shift (`addUnionImports`/`addStringImports`/`flushLateImportShifts`) moves
it, and nothing re-resolves it by name afterward — exactly the failure
mode #2043's own emit-time validation was built to catch loudly instead of
silently emitting corrupt Wasm (see `CLAUDE.md` "addUnionImports": late
import addition shifts function indices, and `ctx.currentFunc.body` must
also be shifted).

## Relationship to #2043

**#2043 is `status: done`** — it added the always-on emit-time index
validation that makes this failure LOUD (a clear `RangeError` naming the
function and the bug class) instead of silently producing an invalid
binary. It did not, and could not, retroactively fix every future producer
that captures a stale index — this is a **new occurrence of the bug
class** in a producer #2043 didn't touch, caught live by real-world code
(mustache) exercising an indirect-`.call()`-through-a-captured-unbound-
method pattern that the existing equivalence/test262 suites apparently
don't cover.

## Scope

- [ ] Identify which specific late import (or emitter/temp-local
      allocation) inside the codegen path for `isWhitespace`
      (`RegExp.prototype.test.call(re, string)` pattern) captures a
      pre-shift index.
- [ ] Fix the producer to re-resolve by name after the last shift, per
      #2043's own prescribed remedy, rather than caching the raw index
      across a shift boundary.
- [ ] Minimal repro reduced from the above (a standalone `.ts`/`.js` file
      with just the `testRegExp`/`isWhitespace` pattern) for a fast
      regression test.
- [ ] Re-run mustache compile — expect `compile.success: true` (or a clean
      `success: false` with real diagnostics, not a thrown `RangeError`).

## Acceptance criteria

- [ ] Minimal repro (isolated `.call()`-indirection-through-captured-
      unbound-prototype-method pattern) compiles without throwing.
- [ ] mustache@4.2.0's `mustache.js` compiles (`compile()` does not throw;
      `success` is `true` or a clean diagnostic-only failure).
- [ ] No regression in existing #2043-related pins
      (`tests/issue-2043-*.test.ts` if present, or equivalent).
