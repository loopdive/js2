# IR optimization retirement ledger

This is the fail-closed parity inventory for #3792. It prevents a direct
AST-to-Wasm handler from being treated as deletable merely because an IR
lowering exists. #3518 owns the IR-only transition, #3521 owns prepare-before-
emit function ownership, and #3090 owns the eventual deletion audit. The
ledger gates that deletion; it does not change or forbid the current hybrid
pipeline.

The fenced region is JSON Lines so each decision is both readable and
deterministically machine-checkable. Evidence with status `pending` is an
explicit gap, not a passing result. `retirementReady` can become true only when
the checker sees complete executable IR ownership plus accepted semantic,
output-shape, and performance evidence. A performance check may be
`not-applicable` only when its reference explains why the decision is not a
performance optimization.

`pnpm run check:issues` runs normal consistency validation on every required
issue check during hybrid operation. It does not require rows to be ready.
After #3518 R9, #3090's deletion work must additionally run:

```sh
pnpm run check:ir-optimization-retirement -- --require-ready
```

That stricter mode fails unless every row is `retirementReady: true`.

Schema:

- `id`, `family`: stable identity and grouping.
- `directOwner`: current direct-path implementation owner.
- `irOwnership`: intended IR owner, one of `lowering`, `pass`,
  `runtime-intent`, or `typed-unsupported`, plus whether that ownership is
  complete.
- `evidence`: semantic, output-shape, and performance records. Pending records
  must name the issue/test/measurement that will close them.
- `retirementReady`: per-decision readiness. Global deletion still additionally
  requires #3518 R9 and #3090's fresh reachability audit.

Measured seed inventory: **11 decisions; 2 have complete IR ownership; 0 are
retirement-ready**.

<!-- ir-optimization-retirement-ledger:start -->

```jsonl
{"id":"IR-OPT-NUMERIC-SWITCH-PROOF","family":"control-flow","directOwner":{"source":"src/codegen/statements/control-flow.ts","symbol":"isProvenNumericLocalSwitchDiscriminant"},"irOwnership":{"owner":{"source":"src/ir/from-ast.ts","symbol":"lowerSwitchStatement"},"status":"lowering","complete":true},"evidence":{"semantic":{"status":"verified","reference":"tests/issue-3765-numeric-locals.test.ts#keeps-a-grounded-numeric-local-unboxed-through-a-numeric-switch"},"outputShape":{"status":"verified","reference":"tests/issue-3765-numeric-locals.test.ts#numeric-switch-WAT-assertions"},"performance":{"status":"pending","reference":"#3792 requires an IR-vs-direct numeric-switch benchmark with the exact Acorn driver."}},"retirementReady":false}
{"id":"IR-OPT-GROUNDED-NUMERIC-ABI","family":"numeric-representation","directOwner":{"source":"src/codegen/declarations/param-return-inference.ts","symbol":"grounded numeric parameter and return projection"},"irOwnership":{"owner":{"source":"src/ir/integration.ts","symbol":"numericLocalScalarForDecl"},"status":"lowering","complete":true},"evidence":{"semantic":{"status":"verified","reference":"tests/issue-3765-numeric-locals.test.ts"},"outputShape":{"status":"verified","reference":"tests/issue-3765-numeric-locals.test.ts#unboxed-local-WAT-assertions"},"performance":{"status":"pending","reference":"#3792 requires an isolated IR attribution measurement for grounded numeric ABI propagation."}},"retirementReady":false}
{"id":"IR-OPT-RETAINED-DIRECT-CLOSURES","family":"closure-calls","directOwner":{"source":"src/codegen/typed-this.ts","symbol":"recordDirectMethodTarget"},"irOwnership":{"owner":{"source":"plan/issues/3522-ir-r3-classes-closures-compile-once.md","symbol":"R3 retained closure ownership"},"status":"typed-unsupported","complete":false},"evidence":{"semantic":{"status":"pending","reference":"#3522 must prove retained generic closure calls preserve target identity and fallback behavior."},"outputShape":{"status":"pending","reference":"#3522 must assert the final IR callable ABI and absence of a legacy body for prepared closures."},"performance":{"status":"pending","reference":"#3792 requires exact Acorn direct-vs-IR closure dispatch attribution."}},"retirementReady":false}
{"id":"IR-OPT-GUARDED-DIRECT-THIS-CALL","family":"method-devirtualization","directOwner":{"source":"src/codegen/typed-this.ts","symbol":"DirectMethodTrampoline.guardedReceiver"},"irOwnership":{"owner":{"source":"plan/issues/3522-ir-r3-classes-closures-compile-once.md","symbol":"R3 guarded method-call ownership"},"status":"typed-unsupported","complete":false},"evidence":{"semantic":{"status":"pending","reference":"#3522 must preserve the legacy miss arm and ambient this behavior for guarded twins."},"outputShape":{"status":"pending","reference":"#3522 must prove guarded IR dispatch retains ref.test and the miss arm."},"performance":{"status":"pending","reference":"#3792 requires paired exact-driver attribution after IR guarded dispatch lands."}},"retirementReady":false}
{"id":"IR-OPT-TYPED-RECEIVER-THIS","family":"receiver-abi","directOwner":{"source":"src/codegen/typed-this.ts","symbol":"typed twin receiver parameter and current-this framing"},"irOwnership":{"owner":{"source":"plan/issues/3522-ir-r3-classes-closures-compile-once.md","symbol":"R3 class and closure receiver ABI"},"status":"typed-unsupported","complete":false},"evidence":{"semantic":{"status":"pending","reference":"tests/issue-3683-typed-this-twin.test.ts guards the direct path; #3522 needs equivalent IR execution coverage."},"outputShape":{"status":"pending","reference":"#3522 must distinguish twin-exclusive receiver parameters from guarded/generic current-this frames."},"performance":{"status":"pending","reference":"#3792 requires the exact Acorn receiver-frame paired measurement on IR."}},"retirementReady":false}
{"id":"IR-OPT-SAFE-ARGC-FRAME-OMISSION","family":"call-abi","directOwner":{"source":"src/codegen/typed-this.ts","symbol":"DirectMethodTrampoline.needsArgcFrame"},"irOwnership":{"owner":{"source":"src/ir/ast-lowering-plans.ts","symbol":"IrDirectCallPlan.needsArgc"},"status":"lowering","complete":false},"evidence":{"semantic":{"status":"pending","reference":"tests/issue-3683-arity-padding.test.ts covers direct padding; IR needs refusal/overapplication/default-parameter parity coverage."},"outputShape":{"status":"pending","reference":"#3792 requires IR WAT proof that argc state is omitted only when unobservable."},"performance":{"status":"pending","reference":"#3792 requires paired exact-driver attribution for argc-frame omission on IR."}},"retirementReady":false}
{"id":"IR-OPT-NATIVE-REGEXP-BRAND-ORDER","family":"runtime-dispatch","directOwner":{"source":"src/codegen/closed-method-dispatch.ts","symbol":"outer NativeRegExp test brand arm"},"irOwnership":{"owner":{"source":"src/ir/from-ast.ts","symbol":"standalone native RegExp.test runtime intent"},"status":"runtime-intent","complete":false},"evidence":{"semantic":{"status":"pending","reference":"tests/issue-3507.test.ts proves direct carrier semantics; the IR RegExp.test bridge needs matching execution coverage."},"outputShape":{"status":"pending","reference":"IR must prove the NativeRegExp brand arm precedes the user closed-struct/method ladder."},"performance":{"status":"pending","reference":"#3792 requires exact Acorn attribution after the IR RegExp.test bridge lands."}},"retirementReady":false}
{"id":"IR-OPT-FIXED-CLOSED-TOKEN-TABLES","family":"object-representation","directOwner":{"source":"src/codegen/context/types.ts","symbol":"closed struct eligibility under declared nested writes"},"irOwnership":{"owner":{"source":"src/ir/analysis/escape.ts","symbol":"closed object representation analysis"},"status":"pass","complete":false},"evidence":{"semantic":{"status":"pending","reference":"tests/issue-1712-exactfield-lane-guard.test.ts proves direct identity/mutation behavior; IR parity is not yet established."},"outputShape":{"status":"pending","reference":"IR must retain struct.get/struct.set and avoid __extern_get for fixed outer token tables."},"performance":{"status":"pending","reference":"#3792 must preserve the recorded Acorn paired win and size reduction with an IR attribution run."}},"retirementReady":false}
{"id":"IR-OPT-PARSER-OPTIONS-OPEN-READ","family":"object-representation","directOwner":{"source":"src/codegen/property-access.ts","symbol":"tryKnownFnctorDynamicObjectCarrierGet"},"irOwnership":{"owner":{"source":"src/ir/types.ts","symbol":"open object carrier representation"},"status":"runtime-intent","complete":false},"evidence":{"semantic":{"status":"pending","reference":"tests/issue-1712-exactfield-lane-guard.test.ts proves direct replacement and read semantics; IR parity is pending."},"outputShape":{"status":"pending","reference":"IR must route proven Parser.options carriers directly to canonical open-object lookup without a redundant closed-struct ladder."},"performance":{"status":"pending","reference":"#3792 must preserve the recorded Acorn paired win and size reduction with an IR attribution run."}},"retirementReady":false}
{"id":"IR-OPT-DYNAMIC-STRING-DISPATCH","family":"dynamic-runtime","directOwner":{"source":"src/codegen/expressions/calls.ts","symbol":"dynamic string named-method dispatch"},"irOwnership":{"owner":{"source":"src/ir/from-ast.ts","symbol":"dynamic named-method call lowering"},"status":"runtime-intent","complete":false},"evidence":{"semantic":{"status":"pending","reference":"#3790 owns the dynamic string-method execution slice and must land before this row can be complete."},"outputShape":{"status":"pending","reference":"#3790 must prove IR emission and zero legacy body emission for the claimed dynamic string functions."},"performance":{"status":"pending","reference":"#3790 must rerun the unchanged exact runtime-dynamic Acorn driver and record the emitted-function census."}},"retirementReady":false}
{"id":"IR-OPT-MUTABLE-NUMERIC-LOOP-COERCION","family":"numeric-representation","directOwner":{"source":"src/codegen/statements/variables.ts","symbol":"scalarForDecl numeric local slot"},"irOwnership":{"owner":{"source":"src/ir/analysis/i32-slots.ts","symbol":"analyzeI32LocalSlots"},"status":"pass","complete":false},"evidence":{"semantic":{"status":"pending","reference":"#3790 and #3741 cover adjacent loop cases; generic mutable dynamic numeric coercion remains an IR residual."},"outputShape":{"status":"pending","reference":"IR must prove the mutable counter stays scalar through loop updates without redundant dyn box/unbox operations."},"performance":{"status":"pending","reference":"#3792 requires exact Acorn attribution after the generic mutable numeric-loop slice lands."}},"retirementReady":false}
```

<!-- ir-optimization-retirement-ledger:end -->
