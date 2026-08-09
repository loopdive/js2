---
id: 4277
title: "ES2015 IR: preserve dynamic default-parameter values and initialize only undefined (143 current same-file failures)"
status: ready
sprint: current
created: 2026-08-09
updated: 2026-08-09
priority: high
horizon: xl
feasibility: hard
reasoning_effort: max
model: gpt-5.6-sol
task_type: bugfix
area: ir, functions, dynamic-values
language_feature: default-parameters
es_edition: 2015
goal: es6
parent: 4273
related: [869, 2106, 2121, 2669, 2713, 2949, 3949]
assignee: "ttraenkler/codex-es6-default-param-ir"
test262_count: 143
origin: "2026-08-09 exact-ES2015 default-parameters audit: the frozen #4273 baseline has 144 same-file non-passes; the latest oracle-v13 rows have 143. A stable 15-file family fails both lanes because supplied false/string/NaN/zero/null/object values lose dynamic identity, while prepared IR rejects every initializer-bearing parameter."
---

# #4277 — prepared IR default-parameter presence and dynamic carrier

## Exact opportunity

The authoritative frozen #4273 census contains **1,552** exact ES2015 files
tagged `default-parameters`:

| Lane | Pass | Fail | Compile error | Timeout | Total |
| --- | ---: | ---: | ---: | ---: | ---: |
| GC/host | 1,376 | 157 | 4 | 15 | 1,552 |
| standalone | 1,322 | 170 | 58 | 2 | 1,552 |

That snapshot has 144 same-file non-passes. A fresh oracle-v13 read on
2026-08-09, after main advanced, contains 143:

| Lane | Pass | Fail | Compile error | Timeout | Same-file non-pass |
| --- | ---: | ---: | ---: | ---: | ---: |
| GC/host | 1,375 | 157 | 4 | 16 | 143 |
| standalone | 1,324 | 170 | 58 | 0 | 143 |

The one-row aggregate movement is not evidence that one mechanism was fixed:
host timeout jitter and two standalone flips changed independently. The
root-cause slices below therefore use sorted path hashes and file-level
outcomes, not the rounded aggregate.

Fresh-input authority:

- Test262 gitlink: `b363f29d3c43c626dc852744ad64a0b48a003693`;
- edition map SHA-256:
  `bbdcdfdc5b64765a2cd826b87e5255000ed70314d8aad1f38c77849d99e7708f`;
- host JSONL SHA-256:
  `4359c56514f456a6f597fe679a4ddc6893610e9dda54cc0d9030642a3565c371`;
  and
- standalone JSONL SHA-256:
  `e874fdd266f25a8f67fb5c6b879b2ed8af3fb856ce9b4c42db1fb2039b79beed`.

The same-file failures are heterogeneous. The measured top partitions are:

| Partition | Exact files | Both non-pass | Primary mechanism |
| --- | ---: | ---: | --- |
| destructuring forms | 1,350 | 74 | pattern iteration/defaults, generator overlap; owned by #2669/#4275 |
| non-destructuring forms | 202 | 69 | carrier identity, function metadata, TDZ, arguments environment |
| supplied non-`undefined` values | 15 | 15 | dynamic values coerced to one inferred scalar carrier |
| `Function.length` with a default | 16 | 15 | expected-argument-count metadata ignores first initializer |
| self-reference plus later-reference TDZ | 30 | 16 | parameter-environment initialization state is not represented |

This issue owns the shared prepared-IR parameter substrate. It does not claim
that all 143 rows have one assertion string or that fixing Slice A completes
destructuring, generators, function metadata, and `arguments` semantics.

## First exact slice: retain supplied value identity

The procedurally generated `dflt-params-arg-val-not-undefined.js` family passes
`false`, `""`, `NaN`, `0`, `null`, and an Object to six initialized parameters.
No initializer may execute, and every parameter must retain its original value
and type.

| Slice | Shape | Files | GC/host | Standalone | Sorted-list SHA-256 |
| --- | --- | ---: | --- | --- | --- |
| A | every exact ES2015 function form | 15 | 0P / 15F | 0P / 15F | `3dda3aaad28cb2f5026f1c7a077f0c85d34d9987a75d81cc93177ef339c3bdc5` |
| A0 | ordinary non-generator function/arrow/method forms | 8 | 0P / 8F | 0P / 8F | `5f1b3ef8b18f904ef1a610038dbcf8d9b328983bd2100365e08fdc53e13cf1f6` |

Hashes use sorted paths relative to `test/`, joined by newline with one final
newline. Slice A0 paths are:

- `language/expressions/arrow-function/dflt-params-arg-val-not-undefined.js`;
- `language/expressions/class/method-static/dflt-params-arg-val-not-undefined.js`;
- `language/expressions/class/method/dflt-params-arg-val-not-undefined.js`;
- `language/expressions/function/dflt-params-arg-val-not-undefined.js`;
- `language/expressions/object/method-definition/meth-dflt-params-arg-val-not-undefined.js`;
- `language/statements/class/method-static/dflt-params-arg-val-not-undefined.js`;
- `language/statements/class/method/dflt-params-arg-val-not-undefined.js`; and
- `language/statements/function/dflt-params-arg-val-not-undefined.js`.

The other seven Slice A paths are generator functions or generator methods.
They stay under the generator/state-machine programme until that carrier is
prepared; they must not be counted as failures of A0.

The first failing assertion in both lanes is representative and causal:

```text
Expected SameValue(«0», «false») to be true
```

The value supplied as boolean `false` reached the body as numeric `0`. This is
not an initializer side-effect failure: execution stops before the later
initializer-count assertions. One scalar parameter representation was chosen
from incomplete inference and erased the distinct JavaScript values.

## Root cause and IR gap

The legacy function prologue in `src/codegen/function-body.ts` selects a
different default test from the chosen Wasm parameter type:

- `externref` calls `__extern_is_undefined`;
- refs use `ref.is_null`;
- `i32` consults the shared `__argc` global; and
- `f64` combines `__argc` with the signalling-NaN magic value
  `0x7FF00000DEADC0DE`.

This representation-first split cannot preserve a JavaScript parameter that
may receive false/string/number/null/Object values. The current failures expose
the loss directly as `false -> 0`.

Prepared IR does not currently provide an alternative:

1. `src/ir/propagate.ts::seedParamType` correctly classifies any
   initializer-bearing parameter as `DYNAMIC`.
2. `src/ir/select.ts::whyNotIrClaimable` nevertheless rejects every
   `p.initializer` as `param-shape-rejected` for identifier and binding-pattern
   parameters.
3. `src/ir/from-ast.ts::fromFunctionLike` mirrors that rejection so nested
   function paths cannot accidentally drop the initializer.
4. direct and closure call lowering requires exact fixed arity and has no
   prepared rule for padding omitted formals with canonical `undefined`.
5. IR has canonical dynamic carriers and strict-undefined providers from #2949
   and #2106, but no function-entry operation that conditionally evaluates a
   parameter initializer and rebinds the parameter before the body.

The rejection is honest; deleting it alone would silently drop default
semantics. The fix must add the missing function ABI and prologue plan.

Historic #869 remains useful evidence against the sNaN sentinel, but its
caller-side insertion proposal is not the semantic end state. Defaults can
reference prior parameters, throw, mutate state, observe `arguments`, or hit a
TDZ. They must be evaluated in the callee's parameter environment, left to
right, only when the incoming value is JavaScript `undefined`. #3949 fixed a
legacy object-method registration hole and retains its optional-parameter tail;
it does not prepare this IR substrate.

## Required IR programme

### Slice 0 — explicit default-parameter plan

- Build one frozen source-site `IrDefaultParameterPlan` shared by selection,
  signature construction, call planning, and lowering. Each admitted entry
  records its formal index, canonical incoming type, initializer ownership,
  parameter-environment slot, and exact undefined-test provider.
- Keep initializer-bearing unannotated JavaScript parameters on the canonical
  `dynamic` carrier. Do not infer their ABI from the initializer result or from
  one observed caller.
- Make direct/method/closure call plans accept fewer actual arguments only when
  every missing formal has a prepared default/optional entry. Pad omitted
  positions with canonical JavaScript `undefined`; explicit `undefined` uses the
  same carrier and must take the same callee branch.
- Do not evaluate initializers at call sites. Constant folding may be a later
  proven optimization over the semantic callee plan, not a second behavior.

### Slice A0 — callee-side undefined-only initialization

- At function entry, seed a mutable parameter-environment slot from each
  incoming value before lowering initializer expressions or the body.
- Add an explicit structured IR operation/region for `if IsUndefined(slot)
  then evaluate initializer and write slot`. Reuse the prepared dynamic
  undefined/tag provider; do not encode this as `dyn.truthy`, `ref.is_null`,
  argc truthiness, or signalling NaN.
- Evaluate entries left to right. Earlier initialized parameters are readable;
  the current and later entries remain uninitialized for TDZ purposes. Slice A0
  may keep TDZ-heavy shapes rejected, but its IR shape must preserve the state
  transition needed by the later slice.
- Box a concrete initializer result back into the slot's canonical dynamic
  carrier. The non-default arm leaves the supplied value byte-for-byte on that
  carrier, preserving `false`, `""`, `NaN`, `0`, `null`, and Object identity.
- Make every user-body read of the parameter consume the post-prologue slot,
  including reassignment and capture paths.
- Freeze host and standalone provider refs during preparation. Standalone uses
  the tagged undefined singleton, not null-ref equivalence; host uses the
  canonical JS-undefined predicate. If either capability is absent, reject
  before claim.

### Later monotonic slices

- add the seven generator forms only after the real generator/state-machine IR
  carrier can run the same prologue;
- add self/later TDZ rows by representing uninitialized parameter bindings;
- add `arguments`-referencing defaults with an unmapped ES2015 arguments
  environment; and
- fix default-sensitive `Function.length` through prepared function-object
  metadata, stopping the expected count at the first initialized parameter.

Destructuring parameter defaults extend the same plan only after their iterator
and reference-order contracts are prepared under #2669/#4275.

## Required tests and evidence

- selector/from-AST agreement for A0 plus negative matrices for generators,
  rest, binding patterns, TDZ-heavy initializers, unknown callees, exports, and
  unsupported providers;
- prepared reports prove each claimed body is `kind=emitted`,
  `irBodyEmitted=true`, `legacyBodyEmitted=false`, with no post-claim withdrawal;
- supplied `false`, `""`, `NaN`, `0`, `null`, and Object retain SameValue and
  identity, and initializer counters remain zero;
- omitted and explicit `undefined` each evaluate the initializer exactly once;
- a supplied null/false/zero/empty-string/NaN/Object never evaluates it;
- multiple defaults run left to right and later defaults observe prior results;
- initializer throw prevents the body; a prior parameter is visible while
  current/later TDZ shapes remain rejected until explicitly owned;
- direct calls, extracted closures, instance/static methods, and object methods
  either share the prepared argument plan or fail closed before selection;
- standalone emits no host imports and uses the same dynamic carrier semantics;
- targeted IR bodies contain neither the sNaN sentinel nor the legacy global
  `__argc` default decision; and
- authentic Test262 before/after reports reproduce the A/A0 hashes and show
  zero pass-to-non-pass changes across all 1,552 exact files.

## Acceptance criteria

- [ ] The frozen plan admits only semantically complete default-parameter
      shapes and is consumed identically by selection, call lowering, and the
      callee prologue.
- [ ] All eight Slice A0 files pass in GC/host and standalone through prepared
      IR with the recorded carrier identity and no legacy body.
- [ ] The seven generator members remain coherent fallback and are not claimed
      until their prepared state machine can run the same prologue.
- [ ] Omitted and explicit undefined trigger defaults; every other JavaScript
      value, including null and falsy values, does not.
- [ ] No targeted function uses signalling NaN or shared mutable argc state to
      decide the default branch.
- [ ] The exact 1,552-file feature cohort has zero regressions in both lanes,
      and gains are reported by file rather than projected from tags.
