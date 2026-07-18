---
id: 3349
title: "propertyHelper.js fails to compile at all (verifyEnumerable index-shift, #2043 class) — blocks up to 9.8% of test262 by inclusion count"
status: done
completed: 2026-07-17
sprint: current
created: 2026-07-17
priority: high
feasibility: medium
model: opus
horizon: m
reasoning_effort: high
task_type: bugfix
area: codegen, emit
language_feature: compiler-internals
goal: test262-conformance
related: [2043, 3284, 3285, 3378]
---

> **Resolution (2026-07-17):** the primary target — `propertyHelper.js` /
> `verifyEnumerable` compiling — is **fixed on current main** (verified: the
> exact minimal repro below compiles to a `WebAssembly.validate`-clean binary,
> and representative propertyHelper-including test262 files run end-to-end and
> pass). A regression guard lives in `tests/issue-3349.test.ts`.
> The `verifyEnumerable` index-shift was resolved by an earlier merge in the
> #2043-class / late-import line (widening-map + funcIdx-repoint fixes).
> The separately-flagged "second confirmation target" (the `deepEqual.js`
> nested-closure **stale-local-index** instance — a different mechanism, a
> captured-local slot vs. a funcIdx shift) is **not** part of this issue's
> acceptance criteria and is tracked as **#3378**.

# #3349 — `propertyHelper.js` (the real, unmodified test262 harness file) fails to compile entirely

## How this was found

Measuring js2wasm against the **real, unmodified `test262/harness/*.js`
files** (no `wrapTest()`/`buildPreamble()` rewriting — see #3284/#3285 for
that context) via [test262.fyi](https://test262.fyi)'s js2wasm integration.
A fresh full-suite run against current `main` scored **14,988 / 53,406
(28.06%)**, up from 7.48% before the #3284 `__setExports` fix landed. To
find the next-highest-leverage gap, I ran a 2,544-test stratified sample
(28.46% pass — closely matches the full-suite rate, so representative) with
full stderr capture and bucketed failures by root cause. The single largest
bucket by far:

```
340 / 1820 failures (18.7% of all sampled failures, 13.4% of the full sample)
Binary emit error: RangeError: Codegen error: local index out of range — 7
(valid: [0, 7)) at function 'verifyEnumerable'. This is the late-import
index-shift class (#2043): a captured index went stale across a deferred
flushLateImportShifts/addUnionImports/addStringImports shift, or a map
lookup failed and baked -1/undefined.
```

## Minimal repro — confirmed independent of any test body

```js
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { compile } = require('./compiler-bundle.cjs'); // esbuild --bundle --format=cjs of src/index.ts

const assertJs = readFileSync('test262/harness/assert.js', 'utf8');
const staJs = readFileSync('test262/harness/sta.js', 'utf8');
const propHelper = readFileSync('test262/harness/propertyHelper.js', 'utf8');

// No call to verifyEnumerable at all — just DEFINING it is enough to break the compile.
const body = assertJs + staJs + propHelper + '\nconsole.log("hello");\n';
const src = `export function test() {\n${body}\n}`;
const result = await compile(src, { target: 'gc', fileName: 'test.ts', skipSemanticDiagnostics: true, emitWat: false, inferModuleStrictArguments: false });
console.log(result.success); // false, every time
```

**Merely including `propertyHelper.js` in the compiled unit — without ever
calling `verifyEnumerable` — is sufficient to break compilation of the
entire file.** This is not test262-specific plumbing: `propertyHelper.js` is
the real, unmodified upstream harness file every test262 consumer uses
verbatim, and `verifyEnumerable` (`test262/harness/propertyHelper.js:423`)
is about as ordinary as JS gets:

```js
function verifyEnumerable(obj, name) {
  assert(__getOwnPropertyDescriptor(obj, name).enumerable,
       "Expected obj[" + String(name) + "] to have enumerable:true.");
  if (!isEnumerable(obj, name)) {
    throw new Test262Error("Expected obj[" + String(name) + "] to be enumerable, but was not.");
  }
}
```

## Blast radius

```
grep -rl "includes:.*propertyHelper" test262/test/ | wc -l
5229
```

**5,229 of 53,406 test262 files (9.8%) `includes: [propertyHelper.js]`.**
Since this is a hard compile-time failure of the whole compiled unit (not a
runtime failure of just the one function), every one of those 5,229 files
currently fails outright — regardless of what the individual test actually
checks. Not all 5,229 will necessarily pass once this is fixed (some fail
for unrelated reasons too), but this is very likely the single
highest-leverage fix available against the raw-harness measurement right
now.

## This is a recurrence of #2043, not a new bug class

#2043 (`status: done`, completed 2026-06-10) is titled "retire the late-import
function-index-shift bug class" — but its own scope section is explicit that
the shipped fix **converts future instances into named, located compile-time
errors**, it does not claim to eliminate the underlying index-corruption
bug itself:

> "it converts every future instance into a named, located codegen error at
> compile time (#2029 proves the current walker's coverage is insufficient)"

#2043's own history table lists 6 prior point-fixes for this same class
(#1809, #1839, #1602, #1886, #1666, #1677) plus #2029 as "current" at the
time. `verifyEnumerable` is **another live instance** of the same class,
now correctly caught by the always-on validator #2043 shipped, but not yet
fixed at the source. Re-resolve `verifyEnumerable`'s captured index by name
after the last `flushLateImportShifts`/`addUnionImports`/`addStringImports`
shift (per the error message's own suggested remedy), or trace why its
`funcMap` lookup goes stale specifically for this function.

## Related, likely-same-class finding: TDZ-shaped symptom in a different location

A second bucket (99/1820 failures, 5.4%) reads `Cannot access 'X' before
initialization` — a TypeScript-level TDZ diagnostic, not the emit-time
`RangeError` above. Sampled across unrelated features (`Temporal`,
`TypedArray`, `Object.entries`), so likely a shared underlying mechanism
rather than 99 independent bugs. Concretely, `staging/sm/object/entries.js`
(no Temporal, no exotic features — a plain `Object.entries` test using
`deepEqual.js`) produces **both** symptoms in the same compile:

```
Cannot access 'contents' before initialization   (x4)
Binary emit error: RangeError: Codegen error: local index out of range — 11
(valid: [0, 5)) at function '__closure_16'. This is the late-import
index-shift class (#2043): ...
```

Note the captured identifier differs by call site (`'instance'` in the
`Temporal` failures, `'contents'` here) and the codegen error names a
different function (`__closure_16`, a compiler-synthesized closure, not a
harness function this time) — consistent with the same index-shift
mechanism corrupting different captured-index sites depending on what the
source triggers, rather than one single fixable line. Worth triaging
alongside the `verifyEnumerable` fix in case the two share a root cause in
the shift-walker itself, but treat as a second, separate confirmation
target — don't assume the `verifyEnumerable` fix silently resolves this one
too.

## Suggested approach

1. Reproduce `verifyEnumerable` standalone (repro above — no test262 test
   runner needed, just the three harness files) and get a WAT/codegen diff
   before vs. after the point where `flushLateImportShifts` (or
   `addUnionImports`/`addStringImports`) runs, isolating exactly which
   captured index goes stale for this function.
2. Apply the same "re-resolve by name after the last shift" remedy #2043's
   validator message already suggests, following the pattern of the prior
   point-fixes (#1809, #1839, #2029) rather than re-deriving it from
   scratch.
3. Separately triage the `__closure_16`/`'contents'` TDZ-symptom instance
   (`staging/sm/object/entries.js`) — confirm whether it's the same root
   cause or a distinct instance of the class.
4. Given the recurrence count (this is instance #8+ of the same class since
   #2043 shipped detection), consider whether #2043's "Scope" alternatives
   beyond always-on validation (it lists evaluating a layered combination)
   are worth revisiting — the point-fix cadence suggests detection alone
   isn't closing the class as fast as new instances surface.

## Acceptance criteria

- The minimal repro above (`assert.js` + `sta.js` + `propertyHelper.js`,
  wrapped, no call needed) compiles successfully.
- A representative sample of the 5,229 `propertyHelper.js`-including test262
  files, run against the real unmodified harness, shows a material pass-rate
  jump (not just "compiles" — verify a few now actually reach and correctly
  evaluate `verifyEnumerable`/`verifyProperty`/etc.).
- No regression in the existing (rewritten-harness) JS-host test262 pass
  rate.
