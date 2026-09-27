---
id: 6710
title: "S3-f: Promise reaction handlers trap with `illegal cast` in `__call_fn_method_N` under the native regime in a JS environment"
status: ready
created: 2026-09-27
updated: 2026-09-27
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
