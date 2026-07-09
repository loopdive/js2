---
id: 3084
title: "RegExp @@match/@@replace/@@split eager lastIndex coercion during protocol violates §22.2.6.8 (fires valueOf on non-empty match)"
status: ready
sprint: current
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
task_type: research+bugfix
area: codegen
language_feature: regexp, symbol-protocol, lastIndex, host-runtime
model: fable
related: [3051, 2777, 2671]
blocks: [2777]
created: 2026-07-07
origin: "2026-07-07 — surfaced by PR #2777 (#3051 accessor-only exec-result marshaling). Verified on main f426ef61 (PASS) vs #2777 branch (FAIL) via runTest262File."
---

# #3084 — RegExp protocol eagerly coerces `lastIndex` during a user-overridden `exec`, firing `valueOf` when the spec does not

## Problem

`src/runtime.ts` (the `RegExp.lastIndex` `set` handler, currently ~L7838-7847)
**eagerly coerces** a WasmGC-struct `lastIndex` assignment that happens *during*
a regex protocol call (`_regexProtocolDepth > 0`):

```ts
// intent.className === "RegExp" && intent.member === "lastIndex", action "set":
} else if (_regexProtocolDepth > 0) {
  // Set during a regex protocol method (overridden exec): the native
  // protocol won't coerce the JS-visible lastIndex, so fire valueOf
  // eagerly (a throw surfaces as the program's own error) and store the number.
  _safeSet(self, "lastIndex", Number(_hostToPrimitive(v, "number", callbackState)));
} else {
  _safeSet(self, "lastIndex", _makeLastIndexShim(v, callbackState));  // deferred (correct)
}
```

Per ECMA-262 §22.2.6.8 `RegExp.prototype [ @@match ]` (and the sibling
§22.2.6.11 `@@replace`, §22.2.6.14 `@@split`), assigning `lastIndex` **stores
the value verbatim** — it is a plain data property. `lastIndex` is only *read*
as `ToLength(? Get(rx, "lastIndex"))`, and in the global `@@match` loop that
read happens **only in the empty-match branch** (step 8.g.iv.5: *"If matchStr is
the empty String, then … Let thisIndex be ToLength(Get(rx, "lastIndex"))"*). So
for a **non-empty** match the engine must never coerce `lastIndex`, and a
throwing `valueOf` on the assigned object must **not** fire.

The eager branch fires `valueOf` unconditionally at assignment-time whenever a
protocol is on the stack — spec-incorrect for the non-empty-match case.

## Repro (fails on the #2777 branch; passes on main only because the bug is masked)

`test/built-ins/RegExp/prototype/Symbol.match/g-match-no-coerce-lastindex.js`:

```js
var r = /./g;
var nextMatch;
r.exec = function() {
  var thisMatch = nextMatch;
  if (thisMatch === null) return null;
  nextMatch = null;
  return {
    get 0() {
      r.lastIndex = { valueOf: function() { throw new Test262Error('This function should not be invoked.'); } };
      return thisMatch;   // 'a non-empty string' → matchStr is NON-empty
    }
  };
};
nextMatch = 'a non-empty string';
r[Symbol.match]('');       // must NOT invoke the throwing valueOf
```

- **On current `main`**: the compiled overridden `exec` returns an accessor
  object literal that #3051 marshals to `null` (the bug #2777 fixes), so
  `RegExpExec` sees `null`, the `@@match` loop is a no-op, `get 0()` never runs,
  `r.lastIndex` is never set to the throwing object — the test passes
  **vacuously**.
- **On the #2777 branch** (#3051 fix applied → `exec` returns the real accessor
  object): `Get(result, "0")` runs `get 0()`, which sets
  `r.lastIndex = {throwing valueOf}` while `_regexProtocolDepth > 0`; the eager
  branch coerces it → `valueOf` throws → **fail** (`This function should not be
  invoked.`).

Verified 2026-07-07 with `runTest262File` on main `f426ef61` (PASS) and the
re-merged #2777 branch (FAIL).

## Why the obvious fix (delete the eager branch) is wrong

`tests/issue-2671-regexp.test.ts:108` — *"propagates a throwing lastIndex
valueOf set during @@replace (overridden exec)"* — **depends** on the eager
firing. There the match is **empty** and V8's native `@@replace` empty-match
advance reads its own internal `lastIndex`, **not** the JS-visible property, so
a deferred shim would never fire `valueOf` and the throw the test asserts would
be lost. i.e.:

| case | match | spec reads JS-visible lastIndex? | eager coercion |
| --- | --- | --- | --- |
| #2671 `@@replace` empty-advance | empty | yes (empty-match branch) | currently the *only* thing that fires valueOf |
| #3084 `@@match` non-empty (this test) | non-empty | **no** | spurious — must NOT fire |

The distinguishing factor (match emptiness) is **not known at assignment-time**
(the set happens inside `get 0()` while `matchStr` is still being computed).

## Correct fix (Fable)

Make the eager branch **deferred** (always store `_makeLastIndexShim`), and make
the **native protocol loops** (`@@match` / `@@replace` / `@@split`, in the
user-overridden-`exec` path) read the **JS-visible** `lastIndex` via
`ToLength(Get(rx, "lastIndex"))` **in the empty-match branch** per spec — which
unwraps and fires the shim's `valueOf` exactly when (and only when) the spec
mandates. Then:

- non-empty `@@match`: no lastIndex read → shim never fires → **#3084 passes**;
- empty `@@replace` advance: the loop's ToLength read fires the shim →
  **#2671 still passes** without the eager hack.

Requires spec-careful work across the three protocol loops and thorough RegExp
protocol-suite validation (regression risk on the `@@replace`/`@@split`
throwing-getter/coerce-lastindex families). Substrate-adjacent; **`model:
fable`**.

## Acceptance criteria

- `g-match-no-coerce-lastindex.js` passes (throwing `valueOf` not invoked for a
  non-empty match).
- `tests/issue-2671-regexp.test.ts` (all cases, incl. the `@@replace`
  empty-advance throw) still passes.
- No net RegExp `Symbol.{match,replace,split}` test262 regression.
- Unblocks **#2777** (its sole "regression" is this bug's un-masking).

## Notes

- This is a **vacuity-unmask**, not a #2777-introduced bug: #2777 is +8 net (9
  genuine `@@replace`/`@@split` throwing-getter flips, 1 fake-pass→honest-fail
  that is *this* pre-existing bug). #2777 is held (option B, cluster-gated with
  #2774/#3076 on the owner's vacuity-metric decision), not excused, until this
  lands.
