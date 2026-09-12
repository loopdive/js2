---
id: 5375
title: "prettier `printDocToString` never terminates on an array doc: the `DOC_TYPE_ARRAY` arm's `commands.push({ indent, mode, doc: doc[index] })` loops when the object literal is inline in the push argument"
status: done
sprint: current
created: 2026-09-06
updated: 2026-09-12
completed: 2026-09-12
assignee: ttraenkler/sendev-5375
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
task_type: bug
area: compiler
goal: correctness
# 2026-09-12 (#5375): the mechanism lives in src/codegen/callback-ctor-bridge.ts
# (`hostFacingCallbackReturnType`, +27 lines in a 64-line module). closures.ts
# grows by exactly the biome-split import (+4) and one comment line at the call
# site (+1); compileArrowAsCallback grows by that one comment line. No smaller
# form: the callback's result type is decided inside that function.
loc-budget-allow:
  - src/codegen/closures.ts
func-budget-allow:
  - src/codegen/closures.ts::compileArrowAsCallback
---

## Problem

prettier's `tests/unit/print-doc-to-string.js` (0/3, #5346) times out in the
dogfood worker — on `50c81e5487` and equally with #5356 fixed. Every one of
its three tests passes an **array** doc, and `printDocToString(["a"])` alone
never returns. Instrumenting a copy of `src/document/printer/printer.js`
(markers written with `console.error`, which the worker surfaces in its
timeout detail) localises it to one statement of the `DOC_TYPE_ARRAY` arm:

```js
case DOC_TYPE_ARRAY:
  for (let index = doc.length - 1; index >= 0; index--) {
    commands.push({ indent, mode, doc: doc[index] });   // never returns
  }
  break;
```

Markers placed immediately before the `push` fire (`doc.length` is 1, the
element is a string, `commands.length` is 0); a marker immediately after it
never does. Two source-level variants of the same statement both terminate
and then print `"a"` correctly (with #5356 in place):

```js
const __el = doc[index];
const __cmd = { indent, mode, doc: __el };
commands.push(__cmd);                                  // terminates
```

while keeping the literal inline and only hoisting the element read
(`const __el = doc[index]; commands.push({ indent, mode, doc: __el })`) still
loops. So the trigger is the **object literal inline as the `push` argument**,
in this function. `commands` is initialised as
`[{ indent: ROOT_INDENT, mode: MODE_BREAK, doc }]` (an `Indent` object, a
`Symbol`, and an untyped `doc`), and the loop body pushes that same three-key
shape from a dozen sites with differently-typed `doc` values (`doc.contents`,
`mostExpanded`, `hardlineWithoutBreakParent`, spread `...lineSuffix.reverse()`).

### What does NOT reproduce

A standalone two-file `.js` copy of the loop with one push site — numeric or
Symbol `mode`, numeric or object `indent`, inline literal or hoisted — passes
in Wasm (`.tmp`-style probe through `compileAndRunUpstreamModule`, control
assertion failing both lanes). The hang needs more of the real function than
one literal shape; the next step is to bisect the real `printer.js` by
deleting push sites / `case` arms until the loop disappears, then reduce.

### Why it matters

It is the last blocker for prettier's `print-doc-to-string` (0/3). #5356
(the `output` cell) is fixed; #5357 (`x === false` on a nullish reference —
`traverseDoc` visits 1 node instead of 2) is confirmed present and separate.
With #5356 in place and the `push` split by hand, `printDocToString(["a"])`
returns `"a"`.

## Acceptance criteria

1. `printDocToString(["a"], options).formatted` returns `"a"` on the pinned
   prettier 3.8.1 tree without source changes; the three `print-doc-to-string`
   tests then score against #5357's state, not against a timeout.
2. A standalone reduction (two-file untyped `.js`) that loops on the parent
   commit and terminates with the fix, with a regression test and counts
   both ways.
3. A/B at one head over the 17 dogfood suites: nothing else regresses.

## Implementation Plan

What was executed (2026-09-12, base `upstream/main` `c645a7627e`):

1. **Reproduce in the dogfood lane.** Full prettier suite on the base:
   105/151, `print-doc-to-string.js` 0/3 and `doc-printer.js` 0/1, both
   `worker execution timeout after 240000ms`. A standalone probe through
   `compileAndRunUpstreamModule` (`.tmp`, three tests incl. a control that
   fails in both lanes) against the unmodified `printer.js`: compile 32 s,
   then `timeoutStage: "execution"` — a **runtime** loop, not compile time.
2. **Bisect the real `printer.js`** in a scratch copy of the tree, one probe
   per variant:

   | variant | result |
   | --- | --- |
   | all arms, ARRAY push hoisted into a `const` (the issue's control) | terminates, prints |
   | only the STRING + ARRAY arms | **loops** |
   | minimal two-arm loop, everything else deleted | **loops** |
   | … without the `/** @type Command[] */` annotation | **loops** |
   | … with `mode` a number instead of a Symbol | **loops** |
   | … with a local `{ value, length, queue }` instead of the imported `ROOT_INDENT` | terminates |
   | … local object WITH the `get root()` self-cycle, no JSDoc type | terminates |
   | imported `ROOT_INDENT`, `get root()` removed, `@type {RootIndent}` kept | terminates |
   | imported `ROOT_INDENT`, `@type {RootIndent}` removed, getter kept | terminates |

   So the other dozen push sites, the `Command[]` annotation and the Symbol
   are all exonerated; the loop needs exactly two ingredients on the imported
   object — the recursive JSDoc type AND the self-returning accessor.
3. **Two-file untyped reduction** (`indent.js` with the typedef + getter,
   `printer.js` with the two-arm loop): loops on the parent in BOTH the
   inline-literal and the hoisted-literal form. The hoisting "control" holds
   only in prettier's full file; in the reduction the cycle starts at the
   command stack's initializer, before any push. A `steps > 1000` guard in the
   `while` loop never fired: the loop is inside one record conversion.
4. **Locate.** WAT dump of the reduction plus a host-import trace with every
   `env.*` import wrapped (`.tmp/probe-5375/trace-imports.mjs`) — see
   Resolution for what it showed.
5. **Fix at the two sites**, regression test with counts both ways, A/B over
   the 17 suites.

## Resolution

Fixed. The hang was one recursion made endless by one retry:

**(A) The recursion — compiler.** `ROOT_INDENT` is an object literal with an
accessor, so it is lowered as a HOST object (`__new_plain_object` +
`__defineProperty_accessor`), while its JSDoc `@type {RootIndent}` registers a
compiler struct `{value, length, queue, root}` for the same shape. The printer's
`commands = [{ indent: ROOT_INDENT, mode, doc }]` is a vec of records whose
`indent` field is that struct, so storing the host object rebuilds it property
by property (`buildRecordFromExternref`, #5243/#5346). Reading `root` runs the
getter. The getter's compiled callback (`compileArrowAsCallback`, `needsThis`,
the `__make_getter_callback` bridge) took its result type from the checker —
`RootIndent`, i.e. the same struct — so `return ROOT_INDENT` rebuilt the same
host object again, read `root` again, and recursed through the host. Trace of
the parent, first three levels:

```
__extern_is_object(ROOT_INDENT)
__extern_get(ROOT_INDENT, "value") / ("length") / ("queue")
__extern_get(ROOT_INDENT, "root")
    __extern_is_object(ROOT_INDENT)          ← the getter's callback, converting again
    __extern_get(ROOT_INDENT, "value") …
    __extern_get(ROOT_INDENT, "root")
        __extern_is_object(ROOT_INDENT) …
```

Fix: `hostFacingCallbackReturnType` (new, `src/codegen/callback-ctor-bridge.ts`,
next to the `needsThis → __make_getter_callback` decision it belongs with),
applied in `compileArrowAsCallback`: a callback the host invokes as an accessor
or method returns reference results as an **externref**. The host can only
receive an externref anyway — a struct result crosses as `extern.convert_any`
(same object, the bridge's `_isWasmStruct` still sees it and still re-wraps it
for the host), a host object crosses untouched — so the struct type bought
nothing but the rebuild. Numbers, booleans and void keep their representation.
With it, `printDocToString(["a"])` reads `root` exactly once (traced).

**(B) The retry — runtime.** Unbounded host↔Wasm recursion should have died as
a `RangeError` within milliseconds. It did not, because the intent-resolved
`extern_get` provider (`src/runtime.ts`, `case "extern_get"`) wrapped the direct
read in `try { obj[key] } catch { /* fall through to the generic path */ }`, and
the generic path (`_safeGet`) re-runs the same read. The overflow was caught a
few frames up, the read re-descended, overflowed again slightly higher, and so
on. Measured with the trace: pinned at depth ~335, `maxDepth` never above 342,
34,871 unwind/re-descend cycles in 25 s, never back to depth 0. Fix: that catch
now re-throws a `RangeError` (stack exhaustion or a throwing accessor is an
abrupt completion, never a shape mismatch). One line, `src/runtime.ts` stays at
19,725 lines. Observable on its own: a getter that throws a `RangeError` now runs
once instead of twice before the error reaches the compiled `catch`.

The by-name `__extern_get` (the `#2617` variant with `_rethrowIfProxyOrRevoked`)
is NOT the one compiled modules run — the trace's stack showed the intent
provider; a debug print in the by-name helper never fired. It is untouched.

### Regression test

`tests/issue-5375-host-getter-struct-return-cycle.test.ts` — untyped `.js`
two-file fixture with exactly the two ingredients (JSDoc `RootIndent` typedef +
`get root()` returning the object), dogfood-worker compile options. The bound
is inside the getter (throws after 64 reads), because no step counter in the JS
loop can see a loop that lives inside one `push`; with the fix the read count
is asserted exactly (`1` for `["a"]`, measured). Inline and hoisted pushes are
both pinned. A getter-less `ROOT` with the same typedef is the control that the
record rebuild itself still runs (passes on the parent too). Fix B has its own
pin: a `RangeError`-throwing getter runs once and reaches the `catch`.

**Parent 5 failed / 2 passed** (`RangeError: root getter re-entered 64 times`
×4, `range:2` ×1; the two controls pass) → **fix 7 passed / 0 failed**.

Sibling net (accessor/callback pins #1382, #1888 ×3, #2128, #3051, #4394 ×2,
#5346 ×2, #5361): 73 passed both ways; the 7 `#3051` failures are identical on
the parent (pre-existing, not touched here).

### Probe table (dogfood lane, `compileAndRunUpstreamModule`)

| probe | native | wasm parent | wasm fix |
| --- | --- | --- | --- |
| unmodified `printer.js`, `printDocToString(["a"]).formatted` | `"a"` | execution timeout | `"a"` |
| same, `["a","b"]` | `"ab"` | execution timeout | `"ab"` |
| two-file reduction, inline push | `"a"` | execution timeout | `"a"` |
| two-file reduction, hoisted push | `"ab"` | execution timeout | `"ab"` |
| `RangeError`-throwing getter, reads before the catch | 1 | 2 | 1 |
| control (`expect(1).toBe(2)`) | fails | fails | fails |

### A/B — 17 dogfood suites at one HEAD (`c645a7627e` + this change), per test file

Base measured from a pristine `git archive` of the same HEAD, fix from the
worktree; every suite exit 0 on both sides; `admitted` headline present on
both sides.

| suite | base | fix |
| --- | --- | --- |
| prettier | 105/151 | **107/151** |
| webpack | 16/16 | 16/16 |
| three | 17/18 | 17/18 |
| clsx | 32/32 | 32/32 |
| cookie | 63740/63740 | 63740/63740 |
| lodash | 59/62 | 59/62 |
| redux | 67/82 | 67/82 |
| axios | 208/231 | 208/231 |
| stylelint | 108/108 | 108/108 |
| tailwindcss | 13/13 | 13/13 |
| jsdom | 6/6 | 6/6 |
| styled-components | 9/9 | 9/9 |
| uuid | 75/75 | 75/75 |
| marked | 16/30 | 16/30 |
| moment | 10/10 | 10/10 |
| jest | 335/356 | 335/356 |
| hono | 257/324 | 257/324 |

Total **+2, no regressions**. Per-file movers, both in prettier and both off
the 240 s timeout: `tests/unit/doc-printer.js` **0/1 → 1/1**,
`tests/unit/print-doc-to-string.js` **0/3 → 1/3**. Every other test file in
every suite is identical on both sides. (axios 208 and hono 257 differ from
the 2026-09-12 anchors because main moved between the anchor and this base;
they are identical base vs fix.)

### Residuals

- `print-doc-to-string.js` 1/3: the two remaining tests fail on their
  assertion (`"   Prettier"` where `"\nPrettier\n"` is expected — the
  `hardline`s emit nothing and `trim()` never runs). Filed as **#6431** with
  the exact strings and two exonerated hypotheses (Symbol `mode` dispatch,
  untyped and with prettier's JSDoc typing, both pass in probes).
- The by-name `__extern_get` keeps its `#2617` gate (`_rethrowIfProxyOrRevoked`)
  while the intent-resolved `extern_get` provider — the one compiled modules
  actually run — has no user-Proxy re-throw at all, only the `RangeError` one
  added here. Not touched: widening it is a Proxy-semantics change that needs
  its own measurement.
- The record rebuild (`buildRecordFromExternref`) still invokes host getters
  while copying and still has no runtime cycle guard; the accessor's RETURN
  no longer feeds the cycle, which is what prettier needed. A host object
  whose getter reaches the same object through a *data*-typed path would
  still copy it once per level, bounded by the type's depth.
- The issue's "hoisting the literal terminates" control holds only in
  prettier's full file; in the two-file reduction both forms looped. Whatever
  makes the full file's hoisted form escape the initializer conversion was
  not chased — the fix removes the cycle for both forms.
