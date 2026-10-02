---
id: 6710
title: "S3-f: Promise reaction handlers trap with `illegal cast` in `__call_fn_method_N` under the native regime in a JS environment"
status: done
completed: 2026-09-29
assignee: ttraenkler/opus-6710
created: 2026-09-27
updated: 2026-09-29
loc-budget-allow:
  # 2026-09-29 (#6710): +20 lines for the dispatcher param-type resolver
  # and its predicate twin, shared by __call_fn_N and __call_fn_method_N.
  - src/codegen/closure-exports.ts
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen, runtime
language_feature: promise
goal: architecture
sprint: current
parent: 5385
depends_on: [6686]
related: [2867, 3178, 4397, 6685, 6687]
---

# #6710 — S3-f: `__call_fn_method_N` illegal cast on Promise reactions

Slice S3-f of the #5385 "Implementation Plan v2". Nightly 36305955119
(regime lane, JS environment): **82 host-passing rows** fail with

```
async continuation threw before completion: illegal cast [in __call_fn_method_N(…)]
```

all under `built-ins/Promise/*`: `prototype/then` 47 (e.g.
`rxn-handler-fulfilled-next.js`, `rejected-observable-then-calls-argument.js`),
`race` 10, `allSettled` 6, `all` 6, and the rest of the combinators. The same
rows pass in the host lane and in the standalone lane, so this is a
regime-in-JS-environment defect, not a Promise-provider gap.

## Shape

`rxn-handler-fulfilled-next.js`: three `promise.then(onFulfilled, onRejected)`
registrations with plain function-expression handlers, then a fourth whose
handler calls `$DONE`. The continuation runs from the native microtask queue
(`__drain_microtasks`, S1) and invokes the handler through the class-method
dispatch trampoline `__call_fn_method_N` (`src/codegen/object-runtime.ts`
≈ L7579, one per arity, also used by accessor drivers), which `ref.cast`s
its callee to a closure struct type. Under the regime in a JS environment the
handler value reaching the trampoline is not that closure struct — most
likely a host-facade / admitted-callback carrier (S2 introduced
`__boundary_callback_call_N` for caller-owned JS functions and a
Wasm-owned-test in `calls.ts`; the Promise reaction path did not get the
same "is this Wasm-owned?" test) or the `$__bound_fn` carrier — and the cast
traps instead of dispatching.

## Method

1. Reproduce through the assembled harness (pattern:
   `tests/fixtures/issue-6687-regime-probe.mts`) on
   `test/built-ins/Promise/prototype/then/rxn-handler-fulfilled-next.js`
   under (a) native-first (regime is default after S5), (b) standalone,
   (c) default `gc`; run (a) with the runner
   (`TEST262_SEMANTIC_PROVIDERS=native-first TEST262_PATH_FILTER="Promise/prototype/then/rxn-handler-fulfilled-next" TEST262_WORKERS=1 pnpm run test:262`)
   to see the trap; dump the WAT of `__call_fn_method_N` and the reaction
   job that calls it in (a) vs (b) and name the operand that differs.
2. Fix at the reaction-dispatch site, not by widening the trampoline's cast:
   the reaction job must route a callee through the same classification the
   S2 dynamic-call path uses — Wasm-owned closure → `__call_fn_method_N` /
   `call_ref`; admitted JS function → `__boundary_callback_call_N`; bound
   carrier → the native bind driver — and `ref.test` before any cast
   (#2863/#2868 rule). If the differing operand is instead the `this`
   argument (a host facade for the promise), unwrap via the boundary's
   `_unwrapForHost` equivalent on the Wasm side before the cast.
3. Do not change the Promise carrier's state machine or the standalone
   output (byte-identity for (b) and (c) in the focused test).

## Acceptance

- [ ] The 82 rows' representative set (`prototype/then/rxn-handler-*`,
      `race/reject-ignored-deferred.js`, `allSettled/reject-immed.js`,
      `all/reject-deferred.js`) pass under the regime in the scoped run;
      before/after recorded.
- [ ] Focused test with the assembled repro under the three profiles;
      (b)/(c) hashes unchanged.
- [ ] `tests/issue-4397-native-semantic-js-host.test.ts` "presents a native
      async result as a JavaScript Promise only at the boundary" and
      `tests/issue-6686-js-value-boundary-regime.test.ts` stay green;
      `check:host-import-policy` green.
- [ ] 321-row sample ≥ 227.

## Resolution (2026-09-29)

**The spec's hypothesis was wrong; the callee is a genuine Wasm-owned
closure.** WAT/byte diff of the trap (`rxn-handler-fulfilled-next.js`, regime,
trap offset in `__call_fn_method_1` decoded to `fb 16 06`):

- Stack: `__then_fulfill_14` → handler `__closure_110` → `__dyn_call_0` →
  `__apply_closure` → `__runtime_eval_call_aot` → `__apply_closure` →
  `__call_fn_method_1`. The reaction job dispatches the handler fine; the trap
  is the handler's own `$DONE()` call. In a JS environment the harness global
  resolves through the runtime-eval dynamic scope, and the AOT bridge widens
  the zero-argument call to the closure's declared arity 1.
- **Differing operand: user argument 1, not the callee and not `this`.** The
  arm emits `local.get 2; call $__unwrap_for_wasm; any.convert_extern;
  ref.cast (ref $AnyString)` — a NON-null cast of the padded JS `undefined`.
- Why that arm: `__consolePrintHandle__(msg)` lifts to
  `(self, (ref $AnyString))`, `$DONE(error)` to `(self, (ref null $AnyString))`.
  `widenNonDefaultableTypes` (`src/compiler/output.ts`) rewrites every func-type
  `ref` param to `ref null` AFTER codegen, so the two become one canonical type
  and the `__consolePrintHandle__` arm (ordered first) `ref.test`-matches
  `$DONE`'s funcref. That arm had been built from the pre-widening `ref`
  formal, so it skipped the omitted-argument (`__argc`) and explicit-undefined
  `ref.null` guards the `ref_null` path has.
- Standalone has the same arm bytes but calls `$DONE()` directly (no dynamic
  scope), so it never reaches the dispatcher; default `gc` lowers `string` to
  `externref`, so no cast exists.

**Fix** (`src/codegen/closure-exports.ts`, `closureDispatchParamType` +
`hasNullableRefFormal`): both closure dispatchers (`__call_fn_N`,
`__call_fn_method_N`) convert a host argument to the type the callee actually
declares after widening (`ref` → `ref null`), so the padded/undefined argument
takes the existing `ref.null` arm. The callee cast is untouched; the Promise
state machine is untouched. Scoped to `ctx.standalone && jsValueBoundary(ctx)`
so default and standalone stay byte-identical — the same latent trap exists in
those lanes for any dynamically dispatched non-null ref formal, but they are
out of this slice's byte-identity contract.

## Test Results

- Scoped regime run (runner, `JS2WASM_EVAL_ENGINE=interpreter`), the 17
  representative rows (`prototype/then/rxn-handler-*` ×14,
  `race/reject-ignored-deferred`, `allSettled/reject-immed`,
  `all/reject-deferred`): **before 0/17** (16 × `illegal cast [in
  __call_fn_method_N]`, 1 timeout) → **after 16/17**.
- Residual `allSettled/reject-immed.js`: a DIFFERENT defect. `checkSettledPromises`'s
  `settleds` formal is typed from the TS lib's 1-tuple result of
  `Promise.allSettled([thenable])` and lowers to `$__tuple_0`
  (`struct {externref}`); the native allSettled produces an array, and the arm's
  `ref.cast null (ref null $__tuple_0)` traps (`__call_fn_method_3`). A
  representation/inference issue for tuple-typed Promise combinator results, not
  dispatch — needs its own issue.
- Focused test `tests/issue-6710-native-regime-promise-reaction-dispatch.test.ts`
  (out-of-process probe `tests/fixtures/issue-6710-regime-probe.mts`): regime
  repros reach `Test262:AsyncTestComplete`; standalone/default run clean.
  Hashes of the `rxn-handler-fulfilled-next.js` repro, base → after: regime
  `212e4338…` → `2797bdb5…`; standalone `6b85ff8c…` = `6b85ff8c…`; default
  `c8365f6a…` = `c8365f6a…`. Three small default/standalone closure-dispatch
  programs also hash-identical base vs after.
- `issue-4397` 29/30 (the known `assignmentRest` red), `issue-6686` 5/5,
  `issue-4396` 12/12, `check:host-import-policy` green (0 legacy / 0 unknown).
- 321-row sample: **before 191 / after 186**, both measured on this box under
  load averages 110–190, so 58/65 rows were 10 s compile timeouts. Per row: 0
  pass→fail; the 236 rows that completed in both runs pass 170 = 170; of the 21
  pass→timeout rows, 9 passed on a retry and the other 12 compile to
  byte-identical regime binaries base vs after. The S5 figure (227) was measured
  on an unloaded box; this change cannot move the sample.
