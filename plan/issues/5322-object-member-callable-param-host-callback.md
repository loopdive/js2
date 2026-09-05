---
id: 5322
title: "hono utils/body.test.ts aborts whole-file (0/37) — a member's callable param traps on a host callback, and the async frame strands on a host-raised throw"
status: done
assignee: ttraenkler/claude
sprint: current
# (#5322, 2026-09-05) +28 lines in calls.ts: a 6-line predicate
# (`isHostReachableMemberFunction`) plus its rationale block. The predicate has
# to live beside `calleeMayBeHostCallable` — it IS that gate's classification,
# and the gate is the single place the #1712 host-call arm is decided.
# Splitting a 6-line `ts.is*` test into a new module would separate the rule
# from the only caller that can interpret it. The comment carries the
# four-spellings table because #4616 was the SAME fix applied to one spelling
# only; without the table the next reader repeats that omission.
# +~30 lines in async-frame.ts: the `catch_all` arm for the NON-routed
# dispatcher, mirroring the #3587 arm that already sits ~60 lines above it in
# the routed branch. Both arms belong to one `try` emission; moving either out
# would split a single wasm instruction's assembly across modules.
loc-budget-allow:
  - src/codegen/expressions/calls.ts
  - src/codegen/async-frame.ts
func-budget-allow:
  - src/codegen/async-frame.ts::ensureAsyncResumeFunction
priority: high
horizon: m
goal: correctness
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
requested_by: ttraenkler/claude
created: 2026-09-05
updated: 2026-09-05
completed: 2026-09-05
---

# #5322 — hono `utils/body.test.ts` whole-file abort (0/37)

## Problem

hono's `src/utils/body.test.ts` scored **0/37**: the module aborted before a
single result was recorded. The dogfood harness reported it as a compile
failure with a `null` per-test `wasmError`, because the worker PROCESS died —
the message only exists in `report.compile.details[0].errors[0]`:

```
__JS2WASM_COMPILE_COMPLETE__:5132
RuntimeError: dereferencing a null pointer
    at __closure_375        (wasm-function[984])
    at __call_fn_method_1
    at _applyWithPrefix              (src/runtime.ts:1776)
    at Proxy.wasmClosureDynamicDispatch (src/runtime.ts:2104)
    at <anonymous>                   (src/runtime.ts:14325)   // __extern_method_call
    at __async_resume_fparseFormData (wasm-function[555])
```

The compile SUCCEEDS (`__JS2WASM_COMPILE_COMPLETE__` prints first). Two
independent defects were behind the abort; **both are needed** — see the
ablation matrix below.

## Defect 1 — a member's callable param traps on a host callback

Source-map resolution puts `__closure_375` at the test's own stub:

```ts
vi.spyOn(req, 'formData').mockImplementation(
  async () => ({
    forEach: (cb) => {
      cb(file, 'file', data)   // <- traps here
      cb('hoo', 'file.hoo', data)
    },
  }) as FormData
)
```

hono's published dist is plain JS, so `convertFormDataToBodyData(formData, …)`
has an `any` receiver and `formData.forEach(cb)` leaves through
`__extern_method_call`. The host marshals hono's inline arrow into a
`createNativeFunctionCallbackBridge` function — measured at the boundary, the
value handed back into the compiled `forEach` is `(…args) => body(args)` with
`_isWasmStruct === false` and no entry in `_wasmClosureWrapperTargets`. It is a
genuine host callable; nothing can un-wrap it into a closure struct.

The compiled `forEach` receives it in a **callable parameter** (`cb` has a call
signature — here from the `as FormData` contextual type; an explicit annotation
does it too), so the call takes the callable-param arm in
`src/codegen/expressions/call-identifier.ts` (~L2515), which emits:

```wat
local.get 1                 ;; cb (externref)
local.tee $__callable_raw
any.convert_extern
ref.test (ref $closure)     ;; false for a host bridge
(if … (else ref.null))      ;; guarded cast nulls out
local.set $__callable_param
…
ref.is_null
(if (then                   ;; throws TypeError ONLY when the RAW value was null
      local.get $raw  ref.is_null  (if (then <throw TypeError>))))
struct.get $closure 0       ;; unconditional -> traps on the null local
```

The `__call_function` fallback that exists for this case (#1712/#2928) is gated
by `calleeMayBeHostCallable`. #4616 already opened that gate for a callable
param of a **`MethodDeclaration`**, on exactly this reasoning — but it matched
only that one spelling:

| spelling                             | before | after |
| ------------------------------------ | ------ | ----- |
| `{ forEach(cb) {…} }`                | works  | works |
| `{ forEach: function (cb) {…} }`     | TRAPS  | works |
| `{ forEach: (cb) => {…} }`           | TRAPS  | works |
| `class C { forEach = (cb) => {…} }`  | TRAPS  | works |

**Fix**: `src/codegen/expressions/calls.ts` — replace the
`ts.isMethodDeclaration` predicate with `isHostReachableMemberFunction`, which
also accepts an arrow / function expression initializing an object-literal
`PropertyAssignment` or a class `PropertyDeclaration`. Standalone/WASI stays
gated exactly as before (#1941 keeps its no-host-import guarantee), and the arm
can only be *taken* where the code previously trapped.

**Negative controls (both pass before AND after — do not mistake them for
coverage):** a `cb: any` parameter has no call signature and never reaches this
dispatch arm; `as unknown as LocalIface` gives the arrow no contextual type and
does the same.

## Defect 2 — the async frame strands on a host-raised throw

With the trap gone the file still scored 0/37: the worker now died on an
**unhandled rejection**, and the awaited test promise never settled.

Reduced to three lines (standalone, `compileAndRunUpstreamModule`):

```js
it("t", async () => {
  await new Promise((r) => setTimeout(r, 0));
  expect(1).not.toBe(1);            // fails
});
```

- `expect(1).not.toBe(1)` → **worker death**. `positive.not` is assigned
  dynamically, so `.toBe` dispatches through `__extern_method_call` and the
  throw is raised by a compiled function the HOST invoked.
- Same await, `throw new Error("boom")` → clean per-test failure.
- Same await, `expect(1).toBe(2)` (positive matcher, wasm-internal throw) →
  clean per-test failure.

`ensureAsyncResumeFunction` wraps the dispatch in `try`/`catch $exn` → reject the result
promise. #3587 noticed that a FOREIGN JS exception is not `$exn`-tagged and
added a host `catch_all` arm that reads `__get_caught_exception` — but only to
the **routed** dispatcher (the branch taken when the body has its own
try/catch region). A body with no try/catch takes the other branch, which had
no `catch_all`, so the exception escaped the state machine: the result promise
STRANDS PENDING and the throw resurfaces as an unhandled rejection that kills
the process.

The await has to be HOST-driven to reproduce; `await Promise.resolve(1)`
resumes without a host promise reaction and the throw stays inside wasm, where
the `$exn` arm already caught it.

**Fix**: `src/codegen/async-frame.ts` — give the non-routed branch the same
host `catch_all` arm, and register `__get_caught_exception` for `info.host`
rather than `info.host && routedDispatch` (same early registration point, so
the late-import index-shift ordering the surrounding comment protects is
unchanged).

## Ablation — both fixes are required

hono `src/utils/body.test.ts`, measured one file at a time:

| `calls.ts` | `async-frame.ts` | result |
| ---------- | ---------------- | ------ |
| base       | base             | 0/37 — null-pointer trap kills the worker |
| **fix**    | base             | 0/37 — trap gone; unhandled rejection kills the worker |
| base       | **fix**          | 0/37 — the trap is uncatchable, `catch_all` cannot see it |
| **fix**    | **fix**          | **27/37**, compile succeeds and validates |

## Regression tests

- `tests/object-member-callable-param-host-callback.test.ts` — untyped `mod.js`
  (the package half, giving the `any` receiver) plus an `entry.ts` supplying the
  member function. Three previously-trapping spellings, the #4616 method
  shorthand, and the `any`-typed negative control.
  Parent: **3 failed | 2 passed** → with the fix: **5 passed**.
- `tests/async-frame-host-throw-rejects.test.ts` — a host-driven await followed
  by a throw from a host-invoked member; the promise is raced against a 3s
  timeout so a stranded frame reports `"STRANDED"` instead of hanging.
  Parent: **1 failed | 1 passed** plus one unhandled error, and the failure
  message is literally `expected 'STRANDED' to be 'rejected:kaboom'` → with the
  fix: **2 passed**, no unhandled error.

## Corpus A/B (one head, per test file)

`webpack three clsx cookie lodash redux axios stylelint tailwindcss jsdom
styled-components uuid marked moment prettier jest hono`, each suite run once
per side, compared per test file: **0 packages with any per-file delta**.
57 async/promise unit-test files: base 24 failed / 399 passed → 23 failed /
400 passed, the single delta being this issue's own new test. The
`equivalence-gate` script reports no new regressions on any of its 8 shards.

**hono's SUITE headline cannot show the +27 yet, and that is a separate,
pre-existing break.** The suite stops after 4 of its 20 selected files, exit 0
and no `admitted` headline, on BOTH sides of the A/B — the harness's NATIVE
lane strands on test #2 of `src/helper/dev/index.test.ts` ("should return
correct data" and "…also for sub app" pass, then the process exits 0 with an
unsettled promise), so `src/utils/body.test.ts` is never reached in a full-suite
run. It was reached in a diagnosis run earlier the same day on an older main,
so this is a regression on `main` between `ef5b5d335b` and `f2c9f1ab07`, not
something this change caused. `utils/body.test.ts` 0/37 → 27/37 is therefore
reported from running that file alone through `compileAndRunUpstreamModule`.

## What still blocks the remaining 10 tests (named deliberately)

A **callback passed to a host method is silently never invoked** in certain
nesting shapes. Reduced: inside one untyped `.js` function,
`Object.entries(f).forEach(([k, v]) => { n++ })` fires twice, but the same call
whose callback body also does `delete f[k]` or calls another module-level
function fires **zero** times — no error, no missing `__cb_<id>` dispatcher.
Adding one more capture level (building `f` in a nested arrow) makes *every*
`forEach` in that function fire zero times, including one over a plain array
literal. That is why hono's `options.dot` post-processing never runs, so
`parseBody` answers `{"file": <File>, "file.hoo": "hoo"}` instead of
`{file:{hoo:'hoo'}}`. The emitter is `src/codegen/closures.ts`, owned by
another lane at the time of writing; probes are in `.tmp/fdprobe/gen{8,9,10,11}.mjs`.
