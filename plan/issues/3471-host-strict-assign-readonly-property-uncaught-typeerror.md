---
id: 3471
title: "Host lane: polymorphic comparator (isSameValue) param unsoundly narrowed to f64, corrupting string compares → false isWritable revert → uncaught TypeError (~433 test262 name/length tests)"
status: done
assignee: ttraenkler/senior-dev
completed: 2026-07-19
sprint: 72
created: 2026-07-19
priority: high
feasibility: hard
reasoning_effort: high
task_type: bug
area: codegen
goal: test262-conformance
related: [3470, 3417, 2017]
origin: "Discovered while implementing #3470 (host verifyProperty name/length restore) — the cited sample tests still failed after #3470's fix landed, on a DIFFERENT, deeper signature. Cross-checked against the real CI baseline (loopdive/js2wasm-baselines test262-current.jsonl, fetched 2026-07-19) to confirm this is the actual dominant CI failure mode for this test family, not a local artifact."
---

# #3471 — strict-mode write to a non-writable host property: TypeError thrown but not caught as `instanceof TypeError`

## Problem

test262's `propertyHelper.js` (`includes: [propertyHelper.js]`) has an
`isWritable(obj, name)` helper used by essentially every `verifyProperty`
call that checks `writable` in the descriptor (i.e. nearly every
`built-ins/**/name.js` and `built-ins/**/length.js` test — the standard
"every built-in function has a non-writable `.name`/`.length`" conformance
check):

```js
try {
  obj[name] = newValue;
} catch (e) {
  if (!(e instanceof TypeError)) {
    throw new Test262Error("Expected TypeError, got " + e);
  }
}
```

In **strict mode** (the auto-generated strict rerun every normal test262
script record gets), assigning to a non-writable data property MUST throw
a catchable `TypeError` per `PutValue` (§6.2.5.6 step 3.e /
`OrdinarySetWithOwnDescriptor` step 2.a). `src/runtime.ts:3975-3979`
(`_safeSet`) **correctly implements this** — it's intentional, added for
#2017:

```ts
} else if (desc.writable === false) {
  // OrdinarySetWithOwnDescriptor step 2.a returns false for a
  // non-writable data descriptor; PutValue turns that false into a
  // TypeError for a strict Reference (§6.2.5.6 step 3.e).
  throw new TypeError(`Cannot assign to read only property '${String(key)}' of object`);
```

But when this exact pattern runs inside the **compiled** `try { obj[name]
= newValue } catch (e) { if (!(e instanceof TypeError)) throw ... }`, the
thrown `TypeError` is **not correctly caught/classified** — it propagates
out of the compiled function as an uncaught runtime error instead of being
swallowed by the `catch` block (the expected/spec-correct outcome). The
test then fails with:

```
strict rerun: Cannot assign to read only property 'name' of object
```

## Why this matters (scale)

Cross-checked the REAL CI baseline (`loopdive/js2wasm-baselines`
`test262-current.jsonl`, fetched via `scripts/fetch-baseline-jsonl.mjs`,
2026-07-19):

- 1,444 `built-ins/**` + `annexB/built-ins/**` tests ending in `name.js` or
  `length.js` (the `verifyProperty(fn, "name"/"length", {writable:false,
...})` conformance-check family).
- Of the 987 that currently FAIL: **433 fail with exactly this signature**
  (`"Cannot assign to read only property"` in `error`) — by far the single
  largest bucket (vs. 13 for `"should have an own property"`, which turned
  out to be an UNRELATED bug in synthetic Promise-executor/resolve/reject
  function naming, not this one; the remaining 541 are heterogeneous other
  failures).
- Confirmed via `error_signature` field:
  `runtime_error:strict rerun: Cannot assign to read only property 'name' of object`
  (and the `'length'` variant) appear on `Array.prototype.slice`,
  `Date.prototype.toISOString`, `Number.prototype.toExponential`,
  `Math.atan2`, `Promise.race`, `String.prototype.charAt`, and dozens more
  — this is a single, well-isolated, systemic gap, not per-feature noise.

This is the **actual, currently-observed dominant blocker** for the
`name.js`/`length.js` conformance-check family — much bigger than the
~370-test estimate #3470 was scoped against (which assumed a DIFFERENT,
narrower root cause — see "Relationship to #3470" below).

## Repro

Any of hundreds of test262 files reproduce this on current `main`:

```bash
npx tsx -e "
import { runTest262File } from './tests/test262-runner.ts';
const r = await runTest262File('test262/test/built-ins/Array/prototype/slice/name.js', 'built-ins');
console.log(r.status, r.error);
"
# fail  strict rerun: TypeError: Cannot assign to read only property 'name' of object
```

Sample files (pick any):

- `built-ins/Array/prototype/slice/name.js`
- `annexB/built-ins/Date/prototype/getYear/name.js`
- `annexB/built-ins/RegExp/prototype/compile/name.js`
- `annexB/built-ins/String/prototype/substr/name.js`
- `built-ins/DataView/prototype/getFloat64/name.js`

**Note for the next investigator:** a _minimal_ isolated repro (a small
standalone TS snippet doing `try { obj.name = "x" } catch (e) { return e
instanceof TypeError }` against `Date.prototype.getYear`, compiled with
`inferModuleStrictArguments: true`) did **NOT** reproduce the bug — it
correctly returned `instanceof TypeError === true`. Neither did a version
using a computed key (`obj[name] = newValue`) inside a separately-declared
non-exported helper function with the same shape as `propertyHelper.js`'s
`isWritable`. So the trigger is more specific than "compiled catch can't
classify a host-thrown TypeError" in general — something about the FULL
harness assembly (`assembleOriginalHarness` bundling `propertyHelper.js` +
the test body into one compilation unit, or the specific
`"use strict"`-prologue-based strict rerun vs. `inferModuleStrictArguments`
module-strictness) changes the behavior. **Use `runTest262File` on a real
test262 file as the repro**, not a hand-rolled snippet — my hand-rolled
attempts (see `.tmp/probe-readonly-catch*.mts` pattern) undersell the bug.

## Relationship to #3470 (important — do not conflate root causes)

#3470 targeted a DIFFERENT bug: `verifyProperty`'s `isConfigurable()` probe
(`delete obj[name]`, no restore) leaking across the auto strict rerun via
shared host-realm builtins, observable ONLY when the sloppy and strict
phases share the same process/fork. That bug is real (confirmed, fixed in
#3470) but:

- In the **in-process runner** (`tests/test262-runner.ts`, 100%
  same-process guarantee), fixing #3470 does clear the "obj should have an
  own property" masking — but then EVERY affected test hits THIS bug
  (readonly-assign) underneath, since virtually all `name.js`/`length.js`
  tests specify `writable: false`.
- In the **real CI sharded worker pool** (`scripts/test262-worker.mjs` via
  `scripts/compiler-pool.ts`), the sloppy/strict phases of a single test
  essentially never land on the same fork in a live pool (many concurrent
  tests interleaved), so #3470's masking condition rarely if ever
  triggers there — meaning THIS bug (unconditional: it fires on a
  perfectly fresh, never-mutated realm too, since it's a pure compiled-code
  defect) is and was already the REAL, dominant, CI-observed failure mode
  for this whole test family, independent of #3470.

**#3470 is still worth having** (in-process-runner correctness — matters
for local dev, `pnpm run test:262:validate-baseline`, `/smoke-test-issue`)
but its real CI-flip impact is near-zero until THIS bug is also fixed.
Fixing #3471 first (or with #3470) should flip the ~433 tests currently
failing on this signature (module a small number that hit yet other
issues underneath once this layer clears — same caution as always:
signature-addressed ≠ guaranteed flip count, verify on CI).

## Handoff note (2026-07-19)

Routed by tech lead to a senior-dev (Opus) — `feasibility: hard` +
`area: codegen` is out of the originating dev's (runner-only #3470) lane.
Preliminary narrowing already done (see "Repro" above): the bug does
**not** reproduce in small hand-rolled snippets, even ones matching
`isWritable()`'s shape closely (tried: static key access, computed key
access via a separately-declared helper function, both with
`inferModuleStrictArguments: true` AND with a literal `"use strict";`
prologue + `deferTopLevelInit: true` matching the real
`runOriginalHarnessVariant` compile options exactly). It DOES reproduce
via the full `assembleOriginalHarness`-bundled harness + test body
(`propertyHelper.js`'s real `verifyProperty`/`isWritable`, not a
simplified copy) compiled and run through `runTest262File`/the unified
worker. Next step for whoever picks this up: bisect the REAL assembled
source (`assembleOriginalHarness(source, meta).strictRerun.source`,
dumped to a scratch file) by trimming sections and recompiling, to find
the minimal diff between "reproduces" and "doesn't" — likely something
about the specific `verifyProperty` call chain (2 levels of nesting:
test body → `verifyProperty` → `isWritable`), or the `__isArray`/
`nonIndexNumericPropertyName` branches in the real `isWritable`, or
something about compiling the ~19KB bundled harness specifically (WASM
exception tag identity across many more functions/closures than a small
snippet has). Not yet isolated further — ran out of scope for a
runner-only issue before finishing the bisection.

## Task

1. Trace the compiled catch site: for a `try { obj[name] = newValue; }
catch (e) { if (!(e instanceof TypeError)) ...}` pattern reachable via
   `assembleOriginalHarness`'s bundled compile, determine why the thrown
   `TypeError` from `_safeSet`'s `__extern_set_strict` host import path
   (`src/runtime.ts:3979`) is not recognized by the compiled `instanceof
TypeError` check, or does not reach the `catch` block at all (trap vs.
   catchable exception — family of #581/#2025's exception-catchability
   issues, worth checking those for a shared root cause first).
2. Fix so the exception is a genuine catchable WASM exception classified
   correctly as `TypeError` by compiled `instanceof` checks.
3. Regression guard: a compiled `try { nonWritableProp = x } catch (e) { e
instanceof TypeError }` returns `true` in a harness-bundle-shaped
   compilation (not just a trivial single-function snippet).

## Acceptance criteria

- The 5 sample repro files above pass end-to-end via `runTest262File`.
- Broad sweep of the 433-signature bucket shows a large net-positive flip
  on CI/merge_group (verify actual count — this issue's estimate is
  signature-based, not a guaranteed flip count per the usual caution).
- No regressions in the existing exception/try-catch/strict-mode test
  suites.

---

## RESOLUTION (senior-dev, 2026-07-19) — the reported premise was WRONG

**The bug is NOT in try/catch / `instanceof TypeError` / the readonly-write
throw.** Verified on current `origin/main` by running ONLY the strict-rerun
variant of the real harness (fresh realm, so the sloppy phase's `delete
obj[name]` #3470 masking does not apply — that masking is why the *same-process*
`runTest262File` shows `should have an own property`; in the CI sharded pool the
two phases land on different forks so #3471's signature is the dominant one, as
the analysis above predicted). Instrumenting `isWritable` inside the real bundle
showed:

1. The strict readonly write **is** caught correctly — `e instanceof TypeError`
   is `true`. The `catch` fires. So the issue's stated mechanism does not occur.
2. The real defect: `writeSucceeded = isSameValue(obj[verifyProp || name],
   newValue)` returns **`true`** after a *failed* write (`obj[name]` is still
   `"slice"`, `newValue` is `"unlikelyValue"` — clearly unequal).
3. That wrong `true` runs `isWritable`'s **revert** (`obj[name] = oldValue`) — a
   SECOND strict write to the non-writable property — which throws **outside any
   try** → the uncaught `Cannot assign to read only property` that fails the test.

### Root cause: unsound f64 parameter narrowing

`isSameValue(a, b)` — `if (a === 0 && b === 0) return 1/a === 1/b; if (a !== a &&
b !== b) return true; return a === b;` — was compiled with **`(param f64 f64)`**
(confirmed in the WAT of a genuinely-reproducing module). Both string args
coerce to `NaN` at the call boundary, so `a !== a && b !== b` becomes `true &&
true` → `isSameValue("slice","unlikelyValue") === true`.

The f64 came from `inferParamTypeFromBody` (`src/codegen/declarations/param-
return-inference.ts`), which narrows an untyped param to f64 on a **single**
numeric body use (`1 / a`). It was invoked as a fallback whenever
`inferParamTypeFromCallSites` returned `null` — but `null` conflates **"no call
sites"** (an exported/host-only entrypoint; body is the only signal — sound)
with **"called internally with `any`/polymorphic args"** (unsound: one numeric
use does not prove the param is always a number). `isSameValue` has 8 internal
call sites, all passing `any` args (`obj[name]`, `desc.value`, …) → call-site
inference `null` → body fallback misfired → f64.

### Fix (Option C — advisor-reviewed)

`inferParamTypeFromCallSites` now also reports `sawCallSite`; the caller
(`declarations.ts` `lowerParamType`) runs the body-usage fallback **only when
`!sawCallSite`** (a genuinely-uncalled function). A polymorphic helper keeps its
boxed `externref` params, so non-number args survive.

- Rejected "bail on all non-ToNumber-invariant uses" — regresses `return n`
  numeric entrypoints.
- Rejected "bail on `===`/`!==`" — regresses `n === 0` base-case kernels.
- Option C fixes `isSameValue` (has any-arg call sites) while keeping `fib`/
  `fact` (recursive → numeric call sites → f64) and host-only numeric
  entrypoints (zero call sites → body fallback → f64). Verified: `fact` param
  stays f64 (result 120); `dbl` (host-only) stays f64; polymorphic comparator
  called with strings is now `externref` and compares by value.

### Verification

- `isSameValue` in the real strict harness: `(param f64 f64)` → shared-type
  boxed `externref` params after the fix.
- All 5 sample repro files pass via the strict-only harness runner.
- New `tests/issue-3471.test.ts` (7 cases): minimal reproducer returns 1 (BUG)
  on `origin/main`, 0 (CORRECT) with the fix; numeric-kernel guards; the
  isWritable-shape false-revert case.
- No regressions in `#684`, `#2795`, `#3055` (isSameValue numeric), ir-numeric-
  bool-equivalence, function-name-length, comparison/equality suites.
- Full test262 delta measured on CI (broad-impact: param inference touches every
  function). Local same-process `runTest262File` still shows the #3470 masking
  until #3470 also lands; #3470 and #3471 are complementary.

### Files

- `src/codegen/declarations/param-return-inference.ts` — `inferParamTypeFromCallSites`
  returns `{ type, sawCallSite }`.
- `src/codegen/declarations.ts` — gate body fallback on `!sawCallSite`.
- `tests/issue-3471.test.ts` — regression tests.

## 2026-10-18 S6 lane normalization

This issue and its guard are explicitly host-lane work. When S6 changed the
omitted provider policy to native-first, the raw-export string assertion began
observing the native string carrier (`{}`) instead of the host-assisted JS
string. The guard now names `semanticProviders: "host-assisted"` at every
compile site. Its inference/signature assertions are unchanged; native-first
boundary behavior is owned by #4397/#6708 and must not be inferred from this
legacy-provider regression guard.
