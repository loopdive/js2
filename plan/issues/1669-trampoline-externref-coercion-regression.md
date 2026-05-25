---
id: 1669
title: "codegen: object-method trampoline forwards args without coercion → invalid wasm (regressed by #1602)"
status: done
created: 2026-05-25
updated: 2026-05-25
priority: high
feasibility: hard
task_type: bugfix
area: codegen
language_feature: type-coercion, object-method-closures, generators, async
goal: compiler-correctness
sprint: 55
es_edition: multi
test262_count: 217
related: [1602, 595, 608]
---
# #1669 — Object-method trampoline externref coercion (regression from #1602)

## Problem

PR #595 / commit `47a9a32b1` ("fix(#1602): call-site argument coercion emits
valid wasm") introduced a ~217-test test262 regression. Diffing the #593 (peak)
report against #595 showed **235 regressions, 213 of them (91%) one root cause**,
**209/235 under `language/expressions`**. The shared failure is invalid Wasm
inside object-method-as-closure trampolines (`__obj_meth_tramp_*`):

```
__obj_meth_tramp___anon_1_m_5 failed:
  call[0] expected type externref, found ref.cast null of type (ref null 26)
__obj_meth_tramp___anon_0_method_1 failed:
  type error in fallthru[0] (expected externref, got (ref null 18))
```

The first form is a **param-type drift**; the second is a **result-type drift**.
The other ~84 regressions are the runtime knock-on (`null pointer` / "reading
'next'") of the same mis-typed trampoline producing a malformed closure value.

This is a targeted fix — #1602's own valid-wasm fix (its acceptance tests in
`tests/issue-1602.test.ts`) must stay; this repairs the collateral damage.

## Root cause

#1602 added `finalizeMethodTrampolines` (`src/codegen/closures.ts`). An
object-method read as a value (`var f = obj.m;`, `({m(){}}).m`) is lowered to a
closure struct whose funcref points at a **trampoline**: it drops the
closure-self arg, pushes `ref.null <objStruct>` for the method's `this`, forwards
the user params, then `call methodFuncIdx`. The trampoline's OWN signature (its
wrapper func type) is the closure-value ABI, fixed when the closure value is
emitted; the forwarded `local.get`s have those wrapper param types.

`emitObjectMethodAsClosure` builds the trampoline body eagerly, but the method's
`func.typeIdx` can be **re-resolved later** during body compilation —
default-param / generator / async methods finalize their param types and order
then. #1602 correctly noticed this and added a post-pass that rebuilds the
forwarding body against the method's FINAL signature. **But it forwarded each
param verbatim** (`local.get i` straight into `call methodFuncIdx`) with **no
coercion**. When the wrapper param type and the method's final param type drift,
the rebuilt `call` is invalid:

- `name-length-dflt.js`: sibling literals `{m(x=42)}` / `{m(x,y=42)}`
  structurally dedupe; the wrapper params are `[externref, f64]` while the
  method's final params are `[f64, externref]` (a position swap). Forwarding the
  `externref` `local.get` into a `f64` param slot (and vice versa) is invalid.
- generator / super-prop methods: the wrapper declares an `externref` result
  while the method now returns `(ref null N)` → `fallthru` type error.

The cached method-closure path (`emitCachedMethodClosureAccess`, #1394) has the
same structural vulnerability and was never enrolled in the finalize pass.

## Fix

In `finalizeMethodTrampolines`, re-emit the forwarding with a coercion per arg
and on the result:

- Capture the wrapper's user-param types and result **at emit time**
  (`wrapperUserParams` / `wrapperResult` on the pending record). Re-deriving them
  from `trampolineFuncIdx` is unsafe — late-import index shifting can move that
  index relative to the recorded value, returning a *different* function's
  signature (observed for async methods, which was the cause of a transient
  self-introduced regression during development).
- For each forwarded param, coerce `wrapperUserParams[i] → methodUserParams[i]`
  via `coercionInstrs` (handles externref↔f64, ref/ref_null→externref,
  externref→ref/ref_null guarded cast, same-kind different-struct re-cast).
- After the `call`, coerce the method result back to the wrapper result (and
  `drop` when the method now returns a value the void wrapper must discard).
- Coercions that need a scratch local allocate one through a minimal synthetic
  `FunctionContext`; the allocated locals are attached to the registered
  trampoline function (located by body-array identity, again to avoid the stale
  index).
- Also enroll the cached singleton trampoline (`emitCachedMethodClosureAccess`)
  in the finalize pass so the same drift can't survive there.

Files: `src/codegen/closures.ts` (`finalizeMethodTrampolines`,
`emitObjectMethodAsClosure`, `emitCachedMethodClosureAccess`),
`src/codegen/context/types.ts` (extend `pendingMethodTrampolines` record).

## Failed approaches avoided

- A first attempt derived the wrapper signature from `getFuncSignature(ctx,
  trampolineFuncIdx)` inside finalize. That index is stale after late-import
  shifting and returned the wrong function's type for async methods, *adding* two
  invalid modules (`async-gen-yield-star-*`, `async-meth-dflt-params-ref-self`).
  Fixed by capturing wrapper param/result types at emit time instead.

## Verification

Scoped validate-scan of `language/expressions/object`:

| metric          | clean HEAD (#595) | with fix |
|-----------------|-------------------|----------|
| valid modules   | 784               | 930      |
| invalid modules | 170               | 24*      |

\* the remaining 24 are pre-existing `dstr/` destructuring-param bugs
(`__anon_0_method__litNN` "not enough arguments on the stack"), unrelated to
trampolines.

`language/expressions/object/method-definition` alone: 195→198 valid, **3→0
invalid** wasm modules; CE count unchanged (105).

- `tests/issue-1669-trampoline-externref-coercion.test.ts` — new; all 4 cases
  fail on clean HEAD, pass with the fix.
- `tests/issue-1602.test.ts` — still green.
- `tsc --noEmit` clean; `biome lint` clean.
- `closures` / `classes` / `class-method-calls` / `class-expressions` /
  `async-await` suites: same pass/fail set as clean HEAD (no new failures; the
  pre-existing failures need host runtime imports the bare harness doesn't
  provide).

## Acceptance criteria

- [x] The three canonical regressors compile to valid wasm:
  `name-length-dflt.js`, `gen-yield-identifier-spread-non-strict.js`,
  `generator-super-prop-body.js`.
- [x] #1602's valid-wasm fix preserved (its tests pass).
- [x] No new invalid-wasm modules introduced.
- [ ] CI merge-group full test262 shows a large net-positive (~+200 pass).
