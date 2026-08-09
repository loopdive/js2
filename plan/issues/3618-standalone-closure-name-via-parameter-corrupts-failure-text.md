---
id: 3618
title: "Standalone closure .name via a parameter is undefined — corrupts test262 failure text and makes message-derived bucket labels mislead (standalone twin of #3429)"
status: ready
sprint: current
created: 2026-07-25
updated: 2026-07-25
priority: high
horizon: m
feasibility: medium
task_type: bug
area: codegen, test262-runner
language_feature: functions, error-constructors
es_edition: multi
goal: standalone-mode
related: [3429, 3486, 3614, 3592, 2962, 2870]
origin: "Triage of the post-#3592 standalone assertion_fail bucket: one of three independent mechanisms found corrupting standalone failure TEXT, which is why root-cause bucket labels are unreliable in this area."
---

# #3618 — standalone closure `.name` via a parameter is `undefined`

## Problem

Reading `.name` off a compiled function value works when the receiver is a
**static identifier** but not when it arrives through a **parameter** — which
is the shape every harness helper uses.

Measured in standalone (`nativeStrings: true`, probe `.tmp/probes/ctor2.js` via
the CI-equivalent pool path):

| Probe                                                | result |
| ---------------------------------------------------- | ------ |
| `Test262Error.name === 'Test262Error'` (static read) | `true` |
| `expected.name === undefined` (same fn, as a param)  | `true` |
| `expected === Test262Error` (same fn, as a param)    | `true` |

So the value's **identity** survives the parameter passing but its `.name`
does not.

This flips no verdicts by itself. What it does is **corrupt the recorded
failure text**, because upstream `harness/assert.js` builds its messages from
exactly that read:

```js
expectedName = expectedErrorConstructor.name;
actualName = thrown.constructor.name;
if (expectedName === actualName) {
  message += "Expected a " + expectedName + " but got a different error constructor with the same name";
}
```

With both sides `undefined`, 924 heterogeneous-looking rows collapsed onto the
single string `Expected a undefined but got a different error constructor with
the same name` (see #3614). The real constructor names — the thing you need to
route the failure — were erased.

## Why this is worth fixing beyond cosmetics

Three **independent** mechanisms currently corrupt standalone failure text.
Together they are why message-derived root-cause bucket labels are unreliable
in this lane and why cross-checking against the JS-host lane is necessary:

1. **This issue.** Closure `.name` via a parameter is `undefined`, so harness
   messages name no constructor.
2. **`runTest262File` is not the CI path** (`tests/test262-runner.ts`). It
   renders thrown payloads via `originalHarnessThrownText`, which does not call
   `tryNativeExnRender`, so every standalone `Test262Error` surfaces locally as
   `uncaught Wasm-GC exception (non-stringifiable payload)` instead of its real
   assertion message. The CI shard path is `assembleOriginalHarness` →
   `CompilerPool(n, "unified")` → `scripts/test262-worker.mjs`.
3. **`compareArray.format` masking** (from the `type_error` lane, verified with
   real repros): ~235 rows render as `Array.prototype.<m> is not yet callable
as a value`, but the call site is `harness/assert.js:140`
   `compareArray.format`, which `assert.compareArray` reaches **only on its
   failure branch** (line 121 early-returns on success). Those tests had
   already failed their content comparison; the missing `map`-as-value merely
   replaced the honest `Test262Error` text with a `TypeError`. Consequence:
   fixing the callable-as-a-value gap yields **zero** passes and simply
   relocates ~235 rows from `type_error` into `assertion_fail`.

## Root cause

The JS-host lane hit the same class of bug and fixed it in #3429:
`maybeStampCompiledFunctionArgName` (`src/codegen/expressions/helpers.ts`)
stamps the statically-resolved declared name onto a compiled-closure argument
before it crosses into a host-delegated call. That helper is gated off for this
lane:

```ts
// (#3429) JS-host only. `wasmClosureDynamicBridge` — the bug this fixes —
// is a JS-host runtime.ts construct; standalone/WASI have no JS host to
// bridge into, so the bug this fixes cannot occur there.
if (ctx.standalone || ctx.wasi) return false;
```

The _stated reason_ for the gate is sound — `wasmClosureDynamicBridge` really is
a host construct. But standalone has its **own**, distinct reason for
`.name` being `undefined`: there is no host sidecar at all, and the dynamic
`__extern_get(closure, "name")` read has no arm for a compiled closure struct.
So the gate is correct about the host bug and simply leaves the standalone bug
unowned. Fixing it is NOT "un-gate #3429" — standalone needs a native
`.name` answer, not a host-sidecar stamp.

## Suggested direction

Answer `name` (and probably `length`) in the dynamic reader for a compiled
closure struct, keyed the same way #3614 keys `.constructor`: the compiler
already interns the declared name as a string constant, and
`ctx.funcClosureGlobals` already provides the identity-stable per-name
singleton. Prefer a reader arm over a construction-time stamp so no
enumerable own property appears on function values.

Beware the finalize-time hazard #3614 documents: do not mint `ref.func`
trampolines from a finalize-phase filler.

## Acceptance criteria

- [ ] Standalone: for a compiled `function MyError() {}` passed as an argument,
      `fn.name === 'MyError'` inside the callee.
- [ ] `Object.keys(MyError)` unchanged — no new enumerable own property.
- [ ] A test262 `assert.throws` mismatch on a wrong-but-real error constructor
      records a message naming BOTH constructors, not `undefined`.
- [ ] JS-host lane byte-identical (do not disturb the #3429 stamp).
- [ ] No standalone floor regression.

## Follow-on value

Once landed, re-cluster the standalone `assertion_fail` bucket: the 924-row
collapse in #3614's triage was an artifact of this bug, and other clusters are
likely similarly merged. Until then, treat message-derived buckets as a
starting point only and confirm each cluster against a real repro and the
JS-host lane's text.
