---
id: 3742
title: "tsc bundle: `log` emitted with a corrupt body — local index 2 in a 1-slot frame plus an out-of-range callee index (2097200)"
status: ready
created: 2026-07-28
updated: 2026-07-28
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
task_type: bugfix
area: codegen, emit
goal: self-hosting-dogfood
sprint: Backlog
related: [1058, 1579, 2043]
labels: [self-host, typescript, codegen, index-shift]
---

# #3742 — `log` emitted with a corrupt body (bad local index + bad callee index)

## Symptom

Compiling a prefix of TypeScript's shipped `tsc` bundle fails in **binary emit**:

```text
Binary emit error: RangeError: Codegen error: local index out of range — 2
(valid: [0, 1)) at function 'log'. This is the late-import index-shift class (#2043):
a captured index went stale across a deferred flushLateImportShifts/addUnionImports/
addStringImports shift, or a map lookup failed and baked -1/undefined.
```

The `#2043` text is the emitter's generic guess for this error family, not a
confirmed diagnosis — see "What the evidence actually shows" below.

## Reproduction

Bounded and deterministic. The input is a prefix of
`node_modules/typescript/lib/_tsc.js` (TypeScript 5.9.3) cut at a top-level
statement boundary:

```ts
import ts from "typescript";
import fs from "node:fs";
import { compileProject } from "../src/index.js";

const src = fs.readFileSync("node_modules/typescript/lib/_tsc.js", "utf8");
const sf = ts.createSourceFile("f.js", src, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
fs.writeFileSync("/tmp/b148.js", src.slice(0, sf.statements[147].end)); // first 148 statements
await compileProject("/tmp/b148.js", { allowJs: true });
```

- **148 statements (68 KB) reproduces. 147 does not.** Bisected.
- Statement 148 is the `((Debug2) => {` IIFE at `_tsc.js:1212` — TypeScript's
  `Debug` namespace, which contains the `log` function.
- Requires the **#3714** `debugger;` fix to be reachable at all; before that,
  the compile died earlier on `Unsupported statement: LastStatement`.

**Hand-reduction did not reproduce.** Three standalone reductions of the
namespace/function-merge shape (function reassigned to an object via an IIFE
argument, with and without the inner IIFE) all compile cleanly. This is
consistent with the failure needing enough surrounding module context — the
68 KB slice is currently the smallest known input.

## What the evidence actually shows

Instrumenting `emitBinaryWithSourceMapUnguarded` (`src/emit/binary.ts:508-513`)
to dump the offending function at emit time:

```text
name=log  typeIdx=7  params=1  locals=0  maxLocalUsed=2  bodyLen=5
type  = {kind:"func", params:[{kind:"externref"}], results:[]}
body  = [ {op:"local.get", index:2},
          {op:"f64.const", value:3},
          {op:"call", funcIdx:23},
          {op:"local.get", index:0},
          {op:"call", funcIdx:2097200} ]
```

The source being compiled is:

```js
function logMessage(level, s) {
  if (Debug2.loggingHost && shouldLog(level)) {
    Debug2.loggingHost.log(level, s);
  }
}
function log(s) {
  logMessage(3 /* Info */, s);
}
Debug2.log = log;
```

Three separate observations, which together suggest this is **not** simply a
shifted index:

1. **The body is genuinely `log`'s.** The `f64.const 3` is the
   `3 /* Info */` argument to `logMessage`. So the body was not swapped in
   from some other function.
2. **`local.get 2` cannot be right for this frame.** `log(s)` has 1 parameter
   and 0 declared locals, and `typeIdx=7` correctly resolves to
   `func(externref) -> ()`. The signature and the body disagree about the
   frame size: the body was built expecting **≥3 slots**.
3. **`call funcIdx=2097200` is wildly out of range** and is the more alarming
   half. `2097200 = 0x200030`. It does not match any obvious sentinel
   (`-1`, `undefined`, `2^21 = 2097152` is 48 short). The local-index error is
   simply the one the validator happens to reach first — fixing only the local
   indices would leave a garbage callee index behind it.

Only **one** `log`-prefixed function reaches emit at all (`logMessage`,
`log2`, `_log.log`, `_log.error` etc. are absent), so entry
reservation/dedup around the merged function-plus-namespace binding is the
natural place to look first.

## Why the `#2043` attribution is unconfirmed

`failIndex` (`src/emit/binary.ts:221`) hard-codes the late-import-shift
explanation into every index-range message. That may be right here, but the
corrupt callee index and the ≥3-slot frame point at least as strongly at the
**reserved-bodyless-entry** path in `compileStatement`
(`src/codegen/statements.ts:255-266`, `hasReservedBodylessEntry` /
`compileNestedFunctionDeclaration(..., { reuseReservedEntry })`), where a body
can be compiled against one frame/entry and attached to another. Confirm
before assuming the shift is the cause.

## Suggested next steps

1. Dump the module immediately **before** and **after** each
   `flushLateImportShifts` / `addUnionImports` / `addStringImports` pass and
   diff `log`'s body. If the body is already corrupt before any shift, #2043
   is ruled out and the reserved-entry path is the culprit.
2. Identify what `funcIdx=2097200` is — a real shifted index, an
   uninitialized read, or an encoder-side corruption. This is the strongest
   single lead.
3. Determine which calling convention produced a ≥3-slot frame for a 1-param
   function (closure `env` + `this` prepended is the obvious candidate) and
   why the registered type index describes the plain form.

## Acceptance criteria

- [ ] The 148-statement slice compiles to a **validating** Wasm module.
- [ ] A regression test pins the shape (ideally a reduced case; the slice
      itself is too large to commit — a fixture-generating test that slices
      the installed `typescript` package is acceptable).
- [ ] No new equivalence or test262 regressions.
- [ ] If the root cause is _not_ the late-import shift, `failIndex`'s
      hard-coded `#2043` message is amended so it stops mis-attributing this
      family.

## Context

Found while measuring how far the compiler gets on the `typescript` npm
package (#1058 self-host stress test, #1579 Tier-0 survey). Walls cleared so
far on that path: the TS2345 JS-default-inferred-param false positive
(#3695), and `debugger;` as an unsupported statement (#3714). This is the
next one.
