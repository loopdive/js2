---
id: 3035
title: "for-await/async-gen iterator-close side-effect invisible: two closure-capture bugs (NOT async-CPS versioning)"
status: blocked
blocked_on: [3036]
assignee: ttraenkler/dev-asynccps
created: 2026-07-04
updated: 2026-07-04
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
task_type: bugfix
area: codegen
language_feature: closures, for-await-of, async-generator, iterators, destructuring
goal: spec-completeness
related: [3023, 2664, 3036]
---

# #3035 — for-await/async-gen iterator-close side-effect invisible

## Context

Blocks the #2664 (issue #3023 `.next`-callability slice, +68 test262) merge:
#2664's runtime `_walkWasmIterator` diversion (`src/runtime.ts`) makes the
JS-host iterator-close (`IteratorClose` → `return()`) actually fire for
WasmGC-struct iterators. Its `merge_group` re-validation surfaced **19
"regressions"** (mostly `language/statements/for-await-of/*ary-init-iter-close`
+ `async-generator/dstr` files) where the test asserts
`doneCallCount === 1` (the close's side-effect) in the loop/generator body and
reads **0**.

dev-3023 root-caused this as an "async-CPS variable-versioning" bug in
`async-cps.ts`/`async-frame.ts`. **That characterisation is incorrect.** The
real root causes are two pre-existing **closure-capture** defects (verified sync
too — nothing to do with the async state machine). `doneCallCount` is a captured
variable shared between the iterator's `return()` closure (writer) and the
loop/gen body (reader); the capture representation desyncs.

## Critical reframing: the "regressions" are VACUOUS passes on main

Measured (instrumented `bodyRan` flag): on **main**, the async-generator
`for await (var [x] of [iter])` body **never runs** (`bodyRan=0`) — the
async-gen for-await is effectively a no-op there, so these files pass
**vacuously** (the harness scores `pass` without the assertion ever executing).
#2664 makes the iterator-close actually run, which makes the body run and hit
the real capture bugs. So #2664 is **not** regressing working behaviour; it is
converting dead/vacuous passes into real executions that expose long-standing
capture bugs. This matters for how #2664 is unblocked (see Recommendation).

## Repro (faithful, `.tmp/`)

Compile + run with `setExports` wired (host `__iterator` bridge), the way the
test262 worker/equivalence harness do. Minimal, host-lane:

```ts
export function test(): number {
  let dcc = 0;
  const iter: any = {};
  iter[Symbol.iterator] = function () {
    return {
      next() { return { value: 7, done: false }; },
      return() { dcc += 1; return {}; },   // METHOD SHORTHAND
    };
  };
  const [x] = iter;   // IteratorClose → return() → dcc should be 1
  return dcc;         // reads 0  (BUG #2)
}
```

- `return: function () { dcc += 1; }` (fn-expr property) → **1 (correct)**.
- `return() { dcc += 1; }` (method shorthand) → **0 (BUG #2)**.

## Root cause #1 — nested-fn-decl reader captured BY VALUE (FIXED)

`src/codegen/statements/nested-declarations.ts`: a nested **function
declaration** that only READS a captured variable computed `isMutable` from
`writtenInBody` **only** (does THIS fn write it). When the variable is MUTATED
by a *sibling* closure (which boxes it into a `struct (field $value (mut T))`
ref-cell), the read-only nested-fn-decl captured it **by value** — a stale
snapshot of the now-dead plain outer local — so it never observed the sibling's
writes. The arrow/fn-expr path (`closures.ts` `writtenInOuter`) already handles
this; the nested-fn-decl path did not.

**Fix (landed on this branch):** mirror `writtenInOuter` —
`collectNamesMutatedInNestedFunctions(enclosingBody)` collects names written
inside ANY nested function scope of the enclosing function (respecting
per-boundary shadowing via `collectWrittenIdentifiers`), and
`isMutable = writtenInBody.has(name) || mutatedInSiblingScope.has(name)`.
Verified: minimal repro matrix (sync/async × var/let × for-of/for-await) all
flip BUG→OK; `tests/equivalence/` capture/async/generator/iterator subset shows
**zero new failures** (the 8 failures in that subset are pre-existing on main:
`tdz-reference-error` ×6, `optional-direct-closure-call` ×2 — confirmed against
main). This fix alone flips the `async-generator/dstr/ary-init-iter-close.js`
(fn-expr-property writer) test PASS. It does **not** fix the method-shorthand
cluster (that is bug #2).

## Root cause #2 — object/class method captured-write to a BOXED transitive var (PARKED → #3036)

`return() {}` (object-literal **method shorthand**) — and equally **class
methods and class get/set accessors** — that write a variable captured
**transitively** from a grandparent scope, when that variable is BOXED (a
sibling mutates it), emit **garbage**. WAT of the method body for `dcc += 1`:

```
global.get 11   ;; __captured_doneCallCount — holds the ref-cell BOX
drop
f64.const 0     ;; read of dcc: WRONG — never derefs the box (struct.get)
f64.const 1
f64.add
drop            ;; the computed 1 is discarded
ref.null 20
global.set 11   ;; write of dcc: WRONG — NULLS the box global
```

Mechanism: method shorthand routes through
`emitObjectLiteralMethodFn` → `compileArrowAsCallback` →
`promoteAccessorCapturesToGlobals` (`closures.ts`). For a BOXED captured local
it promotes the **box** into a `capturedGlobals`/`capturedBoxGlobals` entry
whose global holds the ref-cell — but `identifiers.ts` (read) and
`assignment.ts` (write) resolve `capturedGlobals`/never consult
`capturedBoxGlobals` and treat the global as holding the VALUE, not the box, so
they never `struct.get`/`struct.set`-deref it. The fn-expr-property form works
because it routes through `compileArrowAsClosure` (closure-struct captures,
box-aware).

**Scope of bug #2 (verified):** direct object-method captured writes WORK
(`const o = { bump() { c += 1 } }; o.bump()` → 2). The bug is specifically the
**transitive** shape (method nested inside another closure, capturing a
grandparent var that is boxed). Class methods (`= 0`) and class getters
(`= NaN`) hit it too → **broad-impact** (`promoteAccessorCapturesToGlobals` is
shared by object-literal methods + class methods + class accessors). Must be
validated via full CI / `merge_group`, not a scoped sweep
([[project_broad_impact_validate_full_ci]]).

**Why parked (per the senior-dev STOP-AND-FLAG guard):** bug #2 is a broad
capture-subsystem fix touching a heavily-accumulated area (`#2029`/`#2669`
lineage: `capturedGlobals` / `capturedBoxGlobals` / `boxedCaptures`), affecting
ALL class methods/accessors + object-literal methods that capture boxed
transitive vars. A correct fix cannot be adequately verified with local scoped
checks — it needs the full test262/`merge_group` regression signal — and a
subtly-wrong capture fix silently miscompiles closures/methods. Split out as
**#3036, Fable-reserved**, with a complete spec.

## Recommendation for unblocking #2664

Two viable paths:

1. **Land #3036 (bug #2 fix) + this branch's bug #1 fix, stacked on #2664.**
   That makes the 13 method-shorthand `*ary-init-iter-close` tests GENUINELY
   pass (a real conformance win), and the fn-expr ones via bug #1, clearing the
   `merge_group` regressions so #2664 merges. Preferred.
2. **Vacuity route.** Because these files pass **vacuously** on main (body never
   runs), the #2940 vacuity/reclassification mechanism arguably should excuse
   them (the merge_group report showed "Excused vacuous reclassifications: 0",
   i.e. it did NOT excuse them — a harness-vacuity-detection gap for the
   async-gen-for-await-no-op shape). This is a PO/lead call, not a codegen fix.

Do NOT blind-remove #2664's `hold`. Its 19 regressions are real (the assertion
does execute under #2664) until #3036 lands or the vacuity route is chosen.

## Branch / state

Branch `issue-3035-async-cps-iterclose-version` (worktree
`/workspace/.claude/worktrees/agent-a86d11230e58881bf`), stacked on #2664's
`origin/issue-3023-iterator-next-callable` (predecessor-stacking; #2664's
`src/runtime.ts` fix is required to EXPOSE — and to test — this cluster).
Contains: bug #1 fix (`nested-declarations.ts`) + this doc + #3036. Not a merge
candidate until #3036 lands on top.
