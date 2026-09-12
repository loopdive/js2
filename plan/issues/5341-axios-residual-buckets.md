---
id: 5341
title: "axios residual: 31 failures across nine files after the three landed blockers — prioritised by bucket"
status: done
sprint: current
created: 2026-09-05
updated: 2026-09-12
completed: 2026-09-12
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: correctness
---

## Problem

axios is **200/231** on clean main `c9a8b48616`, up from 108 at the start of
this effort (#5295 eval-mirror attributes, #5301/#5320 capture cells, #5332
census). What remains is diffuse — no bucket larger than 4 — so this issue
orders them and asks for the biggest two or three, not all nine.

## Evidence (grouped by first error line + file, from the suite report)

```
 4  Expected values to be strictly equal:             transformResponse.test.js   (1/6)
 3  TypeError: Cannot access property on null or undefined   buildURL.test.js   (14/20)
 3  assertion 1 toEqual mismatch                       isX.test.js                (11/14)
 2  assertion 1 instance mismatch                      validator.test.js          (0/2)
 2  Expected values to be strictly equal:              fromDataURI.test.js        (8/12)
 2  The validation function is expected to return "true". Received 1   fromDataURI.test.js
 2  randomFillSync is not a function                   platform.test.js           (0/2)  ← host shim gap
 1  assertion 1 toBe: object:null != boolean:true       canceledError.test.js
 1  RuntimeError: dereferencing a null pointer          composeSignals.test.js
 1  assertion 1 instance mismatch                       AxiosError.test.js
```

Notes that narrow the work:

- **`platform.test.js` (2) is not a compiler bug.** `randomFillSync` is a
  Node `crypto` builtin the host shim does not expose. Record, do not fix
  here.
- **`transformResponse` (4) + `fromDataURI` (2+2) = 8 tests** share the
  package's data-transform path (`utils.js` `forEach`/`isPlainObject`/
  `toJSONObject`, and the `AxiosHeaders` normalisation). Diagnose these first;
  one cause may cover all eight.
- **`validator` (2) "instance mismatch"** is an `instanceof` against a class
  that crossed the host boundary — the same family as #5325's residual (a
  compiled class instance answering the wrong prototype). Check #5347 before
  fixing here; if it is the same defect, fix there once.
- **`buildURL` (3) "Cannot access property on null"** — a compiled function
  returned `null` where an object was expected; same signature as the hono
  ipaddr bucket (#5338, a string) — check whether it is the
  `call-tail-dispatch.ts` fall-through (#5343).
- **`composeSignals` (1) null-pointer trap** — the one remaining trap in
  axios; `AbortSignal` composition via `addEventListener` callbacks; likely a
  capture cell (#5320/#5323 family).

## Acceptance criteria

1. axios ≥ 208/231 (the eight transform/fromDataURI tests, or an equivalent
   gain from the next buckets if that cause turns out to be non-compiler).
2. Regression test per fixed cause, failing on parent, passing with fix,
   untyped `.js` two-file fixtures, anti-vacuity control.
3. A/B at one HEAD, 17 suites, per test file — axios improves, nothing else
   moves (anchors in #5338).
4. All ratchet gates green including `pnpm run check:dogfood-validation`.

## Implementation Plan

1. Run the suite; read the report **immediately** (it is overwritten by the
   next suite). For each of the three target files pull the full `wasmError`
   (not just line 1) and the assertion's `actual`/`expected`.
2. Start with `transformResponse.test.js` (1/6): find which transform in
   `lib/defaults/index.js` `transformResponse` and `lib/core/transformData.js`
   produces the wrong value. `Expected values to be strictly equal` with a
   string/JSON body strongly suggests the JSON parse-or-passthrough branch
   (`utils.isString(data) && … JSON.parse`) taking the wrong arm — check the
   `typeof`/`isString` lowering on a value that crossed the host boundary
   (`responseType`, `data` arriving as externref).
3. Reduce with a negative control (standalone `.mjs`,
   `compileAndRunUpstreamModule`, harness sanity-checked). Dump WAT.
4. Fix; land as **one PR per cause**. If a cause is shared with #5338/#5343/
   #5347, fix it in that issue's PR and record the axios gain there instead
   of duplicating.
5. Regression tests, A/B.

## Dispatch

Model: **opus**. Nine small buckets need triage judgement to find the shared
cause rather than nine local patches.


## Resolution

**Mechanism — `.call`/`.apply`/`bind` DROPPED the receiver at any arity but an
exact one.** The receiver-correct trampoline (#3796) is reached only through
`resolveNamedThisCallTarget` (`src/codegen/named-this-call.ts`), whose
admission gate required
`userArguments.length === declaration.parameters.length`. Every other arity
fell through to the ordinary `.call` lowering in
`src/codegen/expressions/calls.ts`, which evaluates `thisArg` and then
literally `drop`s it. That is a silent wrong answer, not a refusal: the callee
read the AMBIENT receiver.

axios `lib/core/transformData.js` is exactly that shape —

```js
export default function transformData(fns, response) {
  const config = this || defaults;      // `this` was lost …
  const context = response || config;
  let data = context.data;              // … so this read `defaults.data`
  utils.forEach(fns, function transform(fn) { data = fn.call(config, data, …); });
  return data;
}
```

called as `transformData.call({ data: '' }, fns)` — one argument into two
formals. `data` started as `undefined` instead of `''`, so three appending
transformers produced `'undefinedfoo'` instead of `'foo'`, and every
`transformResponse` case that reads its body out of `this` answered
`undefined`.

Reduced to a two-file untyped `.js` fixture, the whole defect is arity:

| call (callee declares 2 formals, reads `this`)  | native      | wasm before      | wasm after |
| ----------------------------------------------- | ----------- | ---------------- | ---------- |
| `f.call(t, 1, 2)`                               | `T\|1\|2`   | `T\|1\|2`        | `T\|1\|2`  |
| `f.call(t, 1)`                                  | `T\|1\|und` | `NO-THIS\|1\|und` | `T\|1\|und` |
| `f.call(t, 1, 2, 3)`                            | `T\|1\|2`   | `NO-THIS\|1\|2`  | `T\|1\|2`  |
| `f.apply(t, [1])`                               | `T\|1\|und` | `NO-THIS\|1\|und` | `T\|1\|und` |
| `f.bind(t)(1)`                                  | `T\|1\|und` | `NO-THIS\|1\|und` | `T\|1\|und` |

**Fix.** The arity clause is removed from the admission gate. It is sound to
admit every arity because the operand stack the caller builds is ALWAYS
`paramTypes.length` wide: under-application pads (optional-param sentinels,
then `pushDefaultValue`), over-application either marshals the overflow
through the extras-argv global or compiles-and-drops it, and a rest
declaration packs its trailing arguments into the single vec parameter. The
trampoline's signature is `[externref this, ...targetParams]`, so that stack
fits it unchanged; the only thing admission changes is that the receiver is
INSTALLED instead of discarded. One file, one clause.

**Counts.** axios `202/231 → 208/231` at one HEAD (`upstream/main`
`cf82f78d6d`). Six flips, all `failed → passed`, no regressions in the suite:

| file                             | before | after |
| -------------------------------- | ------ | ----- |
| `core/transformData.test.js`     | 2/4    | 4/4   |
| `transformResponse.test.js`      | 1/6    | 5/6   |

**Regression test.** `tests/issue-5341-under-applied-call-receiver.test.ts` —
15 cases on untyped `.js` two-file fixtures: 11 fail on the parent and pass
with the fix; 4 controls pass both ways; plus an anti-vacuity control that
proves the harness can still see an absent receiver.

**Also refreshed:** `tests/issue-3796-named-this-call.test.ts` was RED on
`upstream/main` before this change, for two reasons unrelated to it — it
asserted `catch_all`/`rethrow 0` in a standalone module that has emitted
`try_table` since standardized EH (#4620) landed, and it asserted
`$__named_this_call_readsThis_` is absent when #3983 legitimately emits it for
the `.apply` site. Both assertions were refreshed to the behaviour that
actually holds; its over-arity negative moved to a positive per this change,
with the runtime answer unchanged at `2116`.

## Residuals (deliberately not taken here)

- **`arguments.length` is still the FORMAL count inside an under-applied
  target** — `f.call({}, 1)` into `function f(a, b)` reports `2`. Independent
  of the receiver, reads identically before and after this fix. Filed as
  **#6416**.
- **The other 23 axios failures** — `buildURL` (6), the `instance mismatch`
  cluster (4, → #5347), the `validator returned 1` cluster (3), `isX` (3),
  `isNativeError` (2), `composeSignals` (1), and `platform` (2, a
  `randomFillSync` host-shim gap that is not a compiler bug). Re-measured
  after this fix and filed as **#6417**.
