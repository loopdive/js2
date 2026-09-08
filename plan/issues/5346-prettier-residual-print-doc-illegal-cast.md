---
id: 5346
title: "prettier residual (101/151): `print-doc-to-string` illegal cast, `doc-builders`' last 6, `is-empty-doc` 7/16 — and which four files are deliberate refusals"
status: in-progress
assignee: ttraenkler/senior-dev-5346
sprint: current
created: 2026-09-05
updated: 2026-09-06
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
task_type: bug
area: compiler
goal: correctness
---

## Problem

prettier is **101/151** on clean main `c9a8b48616` (51 at the start; #5321
resolution of package.json `imports`, #5327 array element carrier, #5332
census). The 50 remaining split into three kinds, and only two are ours:

```
get-parser-plugin-by-parser-name.js   0/11 ┐ deliberate refusal — #3587
get-printer-plugin-by-ast-format.js   0/11 │ `async shape not supported … inside
massage-ast.js                        0/1  │  a try`, and the `--allow-fs` gate
resolve-parser.js                     0/1  ┘ (24 tests — NOT this issue)
doc-builders.js                      40/46   6 left after #5327
is-empty-doc.js                       7/16   9
print-doc-to-string.js                0/3    `illegal cast` in printDocToString
errors.js                             0/3
traverse-doc.js                       1/2  · get-descendants.js 1/2 · doc-printer.js 0/1
ast-path.js                           3/4  · whitespace-utilities.js 45/46
```

The four refusal files were **confirmed** as intentional by two independent
agents (#5321, #5327). Do not force them; they need the #3587 lane.

The `print-doc-to-string` `illegal cast` was localised by #5321 to
`printDocToString` and confirmed by #5327 as a **`ref.cast`** (not the
`ref.test`→null shape #5327 fixed) — a genuinely different defect at a known
location.

Also **known, deliberately not fixed in #5327, still observable**: when a
later array element's field names are a *superset* of element zero's
(`{type, contents}` then `{type, n, contents}`), the **binding slot**
re-narrows on store and silently drops `n`
(`Object.keys(docs[1]).length` → 2). That is a binding-slot defect with a
large blast radius (widening the declared vec carrier for every array-literal
global/local); it is pinned as a failing anchor in the #5327 test. It may be
behind some of `doc-builders`' last 6 and `is-empty-doc`'s 9 — **measure
before assuming**.

## Acceptance criteria

1. prettier ≥ 110/151 with the four refusal files untouched.
2. `print-doc-to-string.js` ≥ 2/3.
3. Regression test per fixed cause, failing on parent, passing with fix,
   untyped `.js` two-file fixtures, anti-vacuity control. If the superset
   binding-slot defect is fixed, the pinned anchor in
   `tests/issue-5327-call-produced-array-element-carrier.test.ts` flips to
   its correct expectation in the same PR.
4. A/B at one HEAD, 17 suites, per test file — prettier improves, nothing
   else moves (anchors in #5338).
5. All ratchet gates green including `pnpm run check:dogfood-validation`.

## Implementation Plan

1. `print-doc-to-string` first (0/3, located). Reproduce via the generated
   entry; get the exact `illegal cast` frame from `wasmError`; dump WAT
   around the `ref.cast` in `printDocToString`'s lowering. The doc printer
   walks a heterogeneous union of doc node shapes (`{type:"group"…}`,
   `{type:"indent"…}`, strings) — the cast is almost certainly a **union
   member** being cast to the *first* member's struct. Check the struct
   carrier decision in `src/codegen/struct-carrier-inhabits.ts` (#5327's new
   module) — this may be the same predicate needing to admit a union, not a
   new mechanism.
2. `doc-builders` last 6 and `is-empty-doc` 9: pull each failing assertion's
   `actual`/`expected`. If they read like a dropped field, that is the
   superset binding-slot defect; decide then whether to take it on (widen the
   declared carrier only for bindings whose initializer is an array literal
   with heterogeneous object elements — the narrowest sound scope) or record
   it and stop.
3. `errors.js` 0/3: custom `Error` subclass identity across the host boundary
   (`instanceof`/`.name`). Probe the eight basic shapes first — they all pass
   on main — then find what prettier does differently (likely the error
   crossing a *linked-module* boundary).
4. One PR per independent cause; regression tests; A/B.

## Dispatch

Model: **opus**. One located defect, one known large-blast-radius decision,
and one open question; needs judgement about scope.

## Findings (2026-09-06, base `01ce47aba7`)

prettier reproduced at **101/151** on this base, matching the numbers above.
The residue is **four independent defects**, not one. Two are fixed here; two
are recorded with full diagnoses because fixing them is a separate, riskier
change. **Acceptance criteria 1 and 2 are NOT met by this work** — see the
scoreboard at the end.

### The spec's hypothesis for `print-doc-to-string` was wrong

The plan predicted "a union member being cast to the *first* member's struct",
and pointed at `src/codegen/struct-carrier-inhabits.ts` (#5327's module). It is
neither. Byte-level evidence: the trap is at module offset `0x15b8d` in
function #158 `printDocToString`, decoded as

```
global.get <"length">   call __extern_get   call __unbox_number
local.get <indent>      global.get <"queue">   call __extern_get
any.convert_extern      ref.cast_null $2        ;; $2 = the vec carrier
```

That is `buildRecordFromExternref` (#5243) — the recovery that rebuilds a
`__anon_*` record from a HOST object property by property — casting the
`queue` property to the vec carrier with a BARE `ref.cast`. Its own comment
claimed the arm made a mismatch "land as null on that ONE field"; a
`ref.cast null` traps instead. `struct-carrier-inhabits.ts` has exactly one
caller (`compileArrayLiteral`) and is not on this path at all.

Emission census for the reduced module (23 sites in `printDocToString` alone):
`__anon_9{value,length,queue,root}.queue -> __vec_externref` ×24,
`__anon_13{indent,doc,mode}.indent -> __anon_9` ×2,
`__anon_20{…}.queue -> __tuple_1` ×3.

### A — record-from-host-object field recovery (FIXED, PR 1)

Fixed by routing each `ref_null` field through the same `externref -> ref_null`
coercion arm its enclosing value took, so a vec field is rebuilt by element
copy. Test: `tests/issue-5346-record-from-host-object-field-recovery.test.ts`
(parent 2 failed / 2 passed → 4 passed).

**A plain guarded cast is NOT sufficient, and this is worth recording**: `ref.test`
→ `ref.null` also stops the trap, but hands `queue: []` back as `null`, and
prettier's printer then spins **forever** instead of crashing. Measured. Any
future change here must assert the recovered field's CONTENTS.

A/B, 17 suites at one head: **zero movement anywhere**, prettier included.
The fix removes a trap on a path that is still blocked downstream by cause C.

### B — `fn?.(…)` never called a callee that is a VALUE (FIXED, PR 2)

`compileOptionalDirectCall` resolves the callee through `ctx.closureMap` /
`ctx.funcMap`, both keyed by the callee's NAME. A parameter holding a callback
is in neither, and the unresolved arm pushed `defaultValueInstrs`. The call
never happened; the arguments were never evaluated either. Every
`onEnter?.(x)` written as a parameter was a silent no-op.

prettier **101 → 105** (`is-empty-doc` 7 → 10, `doc-builders` 40 → 41).
Test: `tests/issue-5346-optional-call-value-callee.test.ts`
(parent 3 failed / 3 passed → 6 passed).

Two things fell out of it that are part of the fix:

* the re-entry must pass the **real** AST node — a
  `ts.factory.createCallExpression` twin has no parent, so `getSourceFile()` is
  `undefined` and the func-value-wrapper registration crashes on `.fileName`;
* this form never tested for host `undefined` (only `ref.is_null`), which was
  invisible while the arm skipped the call and became
  `TypeError: undefined is not a function` the moment it performed one.

### C — the ref-cell for a mutable `let` capture is minted at the first CALL site → #5356

`printDocToString`'s `output` reads as `null` after the loop, so `formatted`
is the string `"null"` and all three tests fail on their assertion (the trap is
gone). `output` is a `let` mutated by the hoisted `function trim()`; #2692's
eager-boxing pass fixes exactly this bug for `var`/params and **deliberately
skips `let`/`const`** (`if (cap.hasTdzFlag) continue;`).

Minimal repro (no loop, no closure construction), Node `"a"` / Wasm `null`:

```js
export function probe() {
  let output = "";
  output += "a";
  if (output === "zzz") { trim(); }   // never taken
  return "v=" + JSON.stringify(output);
  function trim() { output = ""; }
}
```

**Do not just delete the skip.** Measured: it fixes every variant of the repro
and makes `printDocToString("hi")` return `"hi"`, then miscompiles prettier —
any array-valued doc becomes a non-terminating loop with the popped command's
`doc` reading as `[object Object]`. That is the shadowing race #2692's comment
predicts. Full write-up, table and suggested narrowing in **#5356**.

### D — `x === false` is TRUE when `x` is a nullish reference → #5357

The second defect on `traverseDoc`'s `if (onEnter?.(doc) === false) continue;`.
The operands are collapsed to f64 and `Number(null) === Number(false)`, so the
traversal `continue`s at the root and visits exactly one node. With B fixed but
not this, `traverseDoc` visits 1 node instead of 3, which is why `is-empty-doc`
stops at 10/16.

Emitter located exactly (`binary-ops-typed-dispatch.ts`, the `__unbox_number`
tail of the externref-equality block, immediately before its
`f64.eq`/`f64.ne`), with the reason the correct arm above it is unreachable and
the reason a static §7.2.16 fold does **not** fix prettier. Full write-up in
**#5357**.

### Answering the plan's open question about the superset binding-slot defect

**It is not behind the `doc-builders` / `is-empty-doc` residue.** Measured from
the failing assertions rather than assumed: all nine `is-empty-doc` failures
are the identical `true != false` and are explained by C+D; `doc-builders`'
remaining five are four "expected matching throw" and two
"dereferencing a null pointer". So the widening was correctly left alone, and
the pinned anchor in
`tests/issue-5327-call-produced-array-element-carrier.test.ts` stays as-is.

Two further defects were measured while reducing and are recorded here rather
than filed, because neither is on prettier's path:

* pushing a value into an array literal's inferred element carrier COERCES it
  instead of widening — `[["a","b"]]` then `push("a")` reads the string back as
  an array (`typeof "object"`, `Array.isArray` true); `[1]` then `push("b")`
  reads back `NaN`. Same family as #5327's known limitation, different symptom.
* a class FIELD initialiser on an `Error` subclass is ignored:
  `class ConfigError extends Error { name = "ConfigError" }` reads
  `.name === "Error"`, and so does `Klass.prototype.name = "…"`. Assigning
  `this.name` in a constructor works. This is all three of prettier's
  `errors.js` failures.

### Scoreboard

| criterion | target | measured |
| --- | --- | --- |
| 1. prettier | ≥ 110/151 | **105/151** (101 → 105) |
| 2. `print-doc-to-string.js` | ≥ 2/3 | **0/3** (blocked on #5356) |
| 3. regression test per fixed cause | — | done, both |
| 4. A/B at one head, 17 suites | no other movement | done |
| 5. ratchet gates | green | green |

Criteria 1 and 2 need #5356 and #5357. The four refusal files were not touched.
