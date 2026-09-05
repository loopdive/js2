---
id: 4754
title: "module-global Proxy externref widening bypasses the binding escape gate"
status: in-progress
sprint: current
created: 2026-08-26
updated: 2026-08-26
priority: critical
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen, conformance
es_edition: 2015
language_feature: proxy, array-methods, module-globals
goal: test262-zero-regressions
related: [4707, 2615, 3189, 3335]
origin: "PR #4931 merge-group run 32903525074 and post-merge Test262 promotion: illegal_cast 19 -> 21"
files:
  - src/codegen/analysis/proxy-binding-escape.ts
  - src/codegen/declarations.ts
  - src/codegen/statements/variables.ts
  - tests/issue-4754-module-global-proxy-escape.test.ts
  - plan/issues/4754-module-global-proxy-escape-gate.md
---

# #4754 — module-global Proxy widening bypasses the escape gate

## Incident and exact attribution

Merged PR #4931, "ES2015 for-of iterator-as-proxy dispatch", fixed the exact
`language/statements/for-of/iterator-as-proxy.js` target but also changed every
module-global `new Proxy(...)` and `Proxy.revocable(...)` binding to an
`externref` slot. The PR's own
[merge-group Test262 run 32903525074](https://github.com/loopdive/js2/actions/runs/32903525074)
measured the uncatchable `illegal_cast` category growing from **19 to 21**. That failed
result existed before merge; a later speculative group inherited the same rows
and the stale baseline eventually let the change reach `main` as merge commit
`8da62deddc17ac9a60d67d4ca2b0684ba5c02ff2`.

Adjacent-commit attribution is exact:

- before: `9efc8e766b5fd5e52ae9ac1719692fb232b886bc`;
- causal PR head: `03783ae5d3510b9c1905be0bb3e9743c09896eb9`;
- causal merge: `8da62deddc17ac9a60d67d4ca2b0684ba5c02ff2`;
- current planning base: `6eb910d3f47ec7c0c4c21792f873a74c7a1b3d6f`.

The oracle version and error classification did not change. The two rows are
therefore compiler behavior, not a scoring or baseline-policy reclassification:

| Test262 row | before #4931 | after #4931 | interpretation |
| --- | --- | --- | --- |
| `built-ins/Array/prototype/concat/is-concat-spreadable-proxy.js` | host `fail`: expected length 0, got 1; standalone **`pass`** | host and standalone `illegal_cast` at `__module_init` | real supported-lane regression plus a worse host failure mode |
| `built-ins/Array/prototype/splice/create-species-undef-invalid-len.js` | host `runtime_error`: cannot convert Symbol to number; standalone `assertion_fail`: expected RangeError | host `illegal_cast` in `__cb_1 ← __closure_51 ← __call_fn_method_3`; standalone `illegal_cast` in `__closure_70 ← __closure_63 ← __call_fn_method_3 ← __apply_closure` | newly exposed uncatchable trap; not a new conformance pass target |

The failed gate job is **97990564492**. Its immutable evidence is retained in
the `test262-merged-report` artifact **9584870517**, grouped commit artifact
**9584871298**, and `test262-regressions-report` artifact **9584891604**. The
last artifact explicitly records `illegal_cast 19 → 21` and both paths above.

Do not grant, document, or promote an `illegal_cast +2` allowance. The
standalone concat row was passing immediately before the causal change, and the
splice row's old failure is still safer than an uncatchable Wasm cast.

## Root cause

The local-binding Proxy path already contains the necessary representation
boundary. `src/codegen/statements/variables.ts::proxyResultEscapesToCall`
keeps a Proxy target structurally typed when its binding escapes as a call/new
argument or as the `this` argument of `.call`/`.apply`. This preserves the
existing generic-method and host-array consumers, which cannot safely consume
the bare `externref` Proxy carrier.

PR #4931 added a parallel unconditional arm in
`src/codegen/declarations.ts::moduleInitForcesExternref`. It recognizes the
Proxy initializer but never asks whether the module binding escapes. Both
failing Test262 bindings do:

- concat passes the Proxy through concat/species inputs; and
- splice supplies the Proxy as argument zero of an
  `Array.prototype.splice.call(...)` generic dispatch.

The unconditional module-global widening then makes
`moduleGlobalWasmType` publish an `externref` global. The consumer routes still
trust checker-derived Array shapes:

- `compileArrayConcat` enters the typed `$Vec` path and casts the externref
  global to its checker-selected vec type; and
- `compileArrayPrototypeCall` recognizes the borrowed externref receiver, but
  the splice arm still invokes typed `compileArraySplice` and performs the same
  impossible cast.

The repair belongs at the producer-side representation decision. Hardening
every static Array consumer or implementing a new generic standalone Proxy
splice runtime would be a much larger feature and would not restore the shared
local/module policy that already exists.

## Implementation plan

### P1. Extract one binding-identity-aware escape analysis

Move the reusable logic out of `statements/variables.ts` into the narrow,
dependency-light module
`src/codegen/analysis/proxy-binding-escape.ts`. Export a predicate shaped around
the exact declaration and codegen oracle, not a display name:

- the candidate declaration must have a simple identifier binding;
- every identifier reference must satisfy
  `ctx.oracle.valueDeclarationOf(reference) === declaration`;
- scan only the declaration's enclosing function or SourceFile;
- do not descend into an unrelated nested executable unless that executable
  actually captures the same binding; and
- unwrap only transparent expression wrappers already recognized by the local
  slot analysis.

Return true only when that exact binding is used:

- as a by-value argument to a call or `new` expression; or
- as argument zero of a `.call`/`.apply` generic-method dispatch.

Member reads/calls on the Proxy itself (`p.x`, `p[k]`, `p.method()`, `delete
p.x`, `k in p`) remain non-escaping. A same-spelled shadow in a nested function
must never classify the outer binding. Preserve every existing #2615 control's
classification by making `statements/variables.ts` consume the shared predicate
before deleting its private name-based copy; the intended observable refinement
is only that a same-spelled shadow no longer creates a false escape.

### P2. Gate only the module-global Proxy arm

In `src/codegen/declarations.ts::moduleInitForcesExternref`, preserve the exact
`new Proxy` / `Proxy.revocable` initializer recognition added for #4707, but
return true only when the exact module binding does **not** escape according to
P1. All non-Proxy arms in `moduleInitForcesExternref` remain unchanged.

Put only this new conjunction behind the default-on, one-variable kill switch
`JS2WASM_PROXY_MODULE_ESCAPE_GATE`; unset means enabled and the exact token `0`
restores #4931's unconditional module-Proxy widening. Read the switch once per
compile/collector invocation, not once per identifier visit. It exists for
same-tree attribution and emergency rollback, not as a second policy mode; no
other Proxy, Array, iterator, or module-global behavior may consult it.

This gives the two representations their existing bounded roles:

- a local-only/member-only module Proxy stays `externref`, preserving dynamic
  Proxy MOP reads; and
- a Proxy handed to a generic or statically typed consumer retains the
  checker-derived structural slot, avoiding an impossible externref-to-vec
  cast.

Do not change `array-methods.ts`, `array-prototype-borrow.ts`, Proxy runtime
semantics, iterator dispatch, the Test262 oracle, or any baseline/tolerance in
this checkpoint. If the shared analysis cannot distinguish one of the exact
bindings, it must conservatively report escape and decline the widening.

This checkpoint proves direct binding flow only. It does not claim alias flow
such as `const q = p; consume(q)`, nor a declaration initialized from
`Proxy.revocable(...).proxy`; both remain separate representation-analysis
families. Transparent wrappers around the same identifier are not aliases and
remain in scope. Do not silently treat an out-of-scope alias as positive proof
for either representation.

### P3. Pin the boundary and its non-vacuity

Add `tests/issue-4754-module-global-proxy-escape.test.ts` with structural and
runtime controls for both `new Proxy` and `Proxy.revocable`:

1. module-global Proxy passed as an ordinary call argument retains a non-
   externref global slot;
2. module-global Proxy passed as `.call`/`.apply` argument zero retains that
   structural slot;
3. module-global Proxy passed through transparent parentheses, `as`, type
   assertion, non-null, and `satisfies` wrappers is still the same escaping
   binding;
4. module-global Proxy passed to `new Consumer(p)` is an escaping by-value
   argument just like `consume(p)`;
5. member-only module-global Proxy remains externref and its get trap is
   observable;
6. same-spelled nested shadow references do not classify the outer binding;
7. a genuine closure capture and escape of the outer binding does classify it;
8. function-local controls from `tests/issue-2615.test.ts` remain exact; and
9. the #4707 returned `proxiedIterator` shape remains externref and the exact
   iterator-as-Proxy Test262 row remains passing in both lanes.

Make the tests mutation-sensitive: deleting the new module escape gate must
restore both illegal casts; changing binding identity to text equality must
fail the shadow control; removing the call/new or transparent-wrapper arms must
fail their exact controls; inverting the predicate must fail the member-only
Proxy and #4707 controls.

Run a same-tree kill-switch A/B before accepting the implementation. With the
switch unset, all P3 controls and the restored Test262 classifications below
must hold. With `JS2WASM_PROXY_MODULE_ESCAPE_GATE=0`, the two selected rows must
reproduce #4931's `illegal_cast` cells while iterator-as-Proxy remains green.
This is the causal proof that the narrow gate, rather than unrelated drift,
removes the regression.

### P4. Reproduce and clear the queue regression

Run the exact two Test262 rows through the same authoritative runner in both
host and standalone lanes, first on the causal state and then on the repair.
Acceptance is classification-specific:

- concat standalone returns from `illegal_cast` to **pass**;
- concat host returns exactly to its pre-#4931 assertion failure (expected
  length 0, observed 1), not another error class;
- splice host returns exactly to its pre-#4931 runtime error (`Cannot convert a
  Symbol value to a number`);
- splice standalone returns exactly to its pre-#4931 assertion failure
  (expected RangeError, no exception); and
- iterator-as-Proxy stays **pass/pass**.

Also retain #4707's two published known-good controls, each in both lanes:

- `language/statements/for-of/generic-iterable.js`; and
- `language/statements/for-of/head-expr-obj-iterator-method.js`.

Then run the smallest complete Proxy-to-Array/generic-call population that
contains the two selected rows plus #2615's documented proxy-array,
copyWithin, `getPrototypeOf`, `getOwnPropertySymbols`, and
`Object.prototype.toString` escape controls. Report the exact denominator and
per-lane transitions. A larger pass count does not offset any new wrong answer,
trap, compile error, or timeout.

## Landing and verification gates

### Implementation checkpoint (2026-08-26)

The bounded repair is implemented locally on
`codex/4754-proxy-module-global-escape` atop `6eb910d3f47e`, pending independent
review, signed commit hooks, push hooks, and the PR's own merge-group Test262
run. The change extracts one shared binding-identity-aware direct-flow
predicate, makes both function-local and module-global Proxy slot decisions
consume it, and snapshots the default-on module gate once per declaration
collector. The exact token `JS2WASM_PROXY_MODULE_ESCAPE_GATE=0` restores the
#4931 module-global widening arm; no Array, iterator, runtime, oracle, or
Test262 baseline file changes.

Current source growth is a measured net **+58 LOC**. Both LOC and function
ratchets pass without an allowance. Focused #4754 coverage is **10/10**, and
TypeScript 7, TypeScript 5, Prettier, scoped Biome, oracle-use, and verdict
ratchets pass. The final-byte same-tree Test262 matrix produced the required
classifications:

- gate on: concat host returns to its prior length assertion and standalone
  passes; splice host returns to its prior Symbol-to-number runtime error and
  standalone returns to its prior missing-RangeError assertion;
- gate on: iterator-as-Proxy, generic-iterable, and head-expression iterator
  controls remain pass/pass; and
- gate `=0`: both affected rows return to illegal-cast/illegal-cast while the
  iterator-as-Proxy target remains pass/pass with identical output hashes.

The existing #2615 suite is **6/8** in the current local Node environment: its
two set/delete runtime cases stop at Node's `WebAssembly objects are opaque`
host limitation. An exact detached-base replay at `6eb910d3f47e` reproduces
the same error classes, messages, frames, line numbers, and Wasm module IDs.
The two compiled binaries are byte-identical between base and this branch:
the set case is 2,791 bytes with SHA-256
`89c427bf3e091a0af4882a0d294e77eabd484b96c1046fe86a6584669e0301d6`, and
the delete case is 1,244 bytes with SHA-256
`e9d5cbeb83588507320edd19ec660dc0b14e0fb1ab9d4cd5e8822ecc07f7ba15`.
The exact representation branches affected by this refactor pass, and the new
focused suite separately pins the local member-only versus escaping split.
These two pre-existing host-runtime failures are not suppressed or counted as
acceptance evidence. Final acceptance remains blocked until the unskipped
hooks, independent audit, and authoritative PR queue run all pass.

This is one bounded regression-repair PR based on fresh `main`. It may land
independently of the IR migration, but it is queue-critical because the stale
19-count trap baseline prevents unrelated PRs from promoting while `main`
contains 21 rows. Do not promote a 21-row baseline before this repair lands.

Before commit and again after merging current `main`, run:

- the focused #4754 and existing #2615 suites;
- the exact four Test262 executions for the two affected rows, plus all six
  #4707 executions (target and two controls in both lanes), **10 total**;
- TypeScript 7 and TypeScript 5 checks;
- scoped Prettier/Biome and the relevant representation/oracle checks;
- `pnpm run check:loc-budget` immediately before the signed commit; and
- the complete unskipped pre-commit and pre-push hooks.

Measure source and function growth before adding any issue-scoped allowance;
never raise a global LOC/function or Test262 baseline speculatively. Every
heavy command and commit/push boundary requires a fresh finite, non-negative
one-minute load strictly below **logical cores - 2**.

## Acceptance

- The exact causal source hunk is narrowed; no array consumer or Test262 policy
  is weakened to hide it.
- `illegal_cast` returns from 21 to at most 19 with the two named rows absent
  from every uncatchable-trap category.
- The four selected row/lane cells exactly match their pre-#4931
  classifications; concat standalone is restored to pass.
- The #4707 iterator-as-Proxy target and its two published iterator controls
  remain pass in host and standalone.
- The default-on kill-switch A/B is non-vacuous: `=0` restores the exact two
  illegal casts, while unset removes them with no unrelated transition.
- Local and module Proxy decisions use one binding-identity-aware escape
  predicate, including shadow/capture mutations.
- No unrelated Proxy, Array, iterator, or module-global row regresses.
- The PR receives independent read-only review and is shepherded through its
  own merge-group Test262 run; a failed required run is never treated as
  acceptance evidence.

## Process follow-up

The code repair does not explain why a PR whose own required merge-group
Test262 workflow failed was nevertheless merged. Queue recovery must retain
run 32903525074 and the later speculative-group ancestry as evidence. If the
existing merge-queue hardening backlog does not already cover this exact
failure mode, file a separate CI issue; do not expand this compiler checkpoint
into workflow surgery.
