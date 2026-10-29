---
id: 7136
title: "IR: native dynamic console arguments and output providers"
status: in-progress
sprint: current
created: 2026-10-22
updated: 2026-10-22
priority: high
horizon: m
feasibility: medium
reasoning_effort: medium
task_type: feature
area: ir
goal: ir-full-coverage
parent: 7106
assignee: "ttraenkler/codex-session-b"
import-cycles-allow:
  - largestSccSize: 725 # 2026-10-28 (#7136): restated on main b6250f09f8 (724 there). The extracted native console provider joins the existing engine SCC (+1).
  - ir->codegen: 82 # 2026-10-28 (#7136): restated on main b6250f09f8 (81 there; was 79 at the 10-22 base). Integration still binds only the single extracted provider (+1); no new codegen->IR edge.
loc-budget-allow:
  # 2026-10-22: +1 import, shared five-method demand contract.
  - src/codegen/wasi.ts
  # 2026-10-29 (review, #6961): the pre-claim native-i32 operand refusal. The
  # predicate lives in ir/analysis/operand-admissibility.ts; what stays is the
  # selection option (select.ts: doc + field, the 3-line arm, the import) and
  # its codegen wiring (index.ts: import, re-export, option line). The option
  # and the arm belong to the selector and the planner that owns its options.
  - src/ir/select.ts
  - src/codegen/index.ts
func-budget-allow:
  # 2026-10-29 (review, #6961): +3 for the refusal arm in the expression walk,
  # and +1 per selection-option builder for `isNativeI32FieldRead` (the
  # production planner and its compatibility twin must offer the same table).
  - src/ir/select.ts::isPhase1Expr
  - src/codegen/index.ts::planIrOverlay
  - src/ir/integration.ts::compileIrPathFunctions
---

## Problem

The unchanged Test262 prelude defines `print` as a closure forwarding a dynamic
value to `console.log`. The existing native IR console path only renders
concrete scalars, and its dynamic-use scan refuses a dynamic console argument.
This keeps an output boundary outside IR even after native `in` admission.
Raw `doneprintHandle.js` also exposes a separate unresolved external `print`
binding; it must not be reported as a complete assembled-harness measurement.

Base: upstream `7d26a84789828fbe6cc6614172161532b7f91e64`.
The full open-PR scan and allocator verified issue 7136 and its branch. Existing
script-var storage, argument closures and constructor stacks remain owned by
their current sessions. No existing PR head, hold or queue is changed.

## Implementation Plan

- Reproduce the unchanged prelude console closure and dynamic top-level
  forwarding functions with real output readback. Distinguish standalone's
  in-module rope from WASI's fd_write stdout/stderr contract.
- Reuse `ensureAnyToStringHelper` and the existing output sinks. Put provider
  adapters in a small codegen module; do not duplicate value formatting,
  syscall marshalling or property conversion in an IR arm.
- Keep console shape, ambient-binding proof, dynamic-use admission and the
  lowering on one supported capability. Preserve fast-carrier and unsupported
  call shapes as explicit refusals before ownership is claimed.
- Extract native console argument/line construction from the large AST-to-IR
  file when extending it. Keep source evaluation once and append one newline.
- Quality acceptance: one renderer/provider owner, no new large function,
  no hand-written second coercion engine, no direct-AST feature additions.
  Fresh-context adversarial review is required before release.

## Acceptance

- [x] Record exact-base failures and meaningful output controls.
- [x] Dynamic values reach native output through actual IR bodies.
- [x] Standalone has no host imports; WASI preserves permitted syscall imports
      and stdout/stderr routing. Missing providers fail closed.
- [ ] Shadowed console, fast carriers, scalar brands, evaluation effects,
      nullish/symbol/object values and unsupported call shapes are qualified.
- [x] Recompile unchanged prelude/harness sources and report remaining ownership
      gaps without predicting population gains.
- [ ] Run relevant tests and normal gates; publish a ready PR with review status.


## Evidence and constraints, 2026-10-22

The qualified exact-base matrix has 38 positive runtime cases, all failing on
`7d26a84789828fbe6cc6614172161532b7f91e64`, and 12 negative boundaries already
passing. The candidate passes these 50 semantic and refusal controls. Standalone readback explicitly enables
its existing `hostBridge: "always"` exports; the earlier raw fixture without
these exports was an invalid output instrument and is preserved separately.

WASI's base path prints `[object]` for dynamic values. The IR provider uses the
same native value renderer as standalone instead. Both preserve observable
source evaluation once, one newline, and native output channel behavior.
`info`/`debug` previously did not demand fd_write, although both console
frontends serve them. The shared import/resource collector now uses the same
five-method contract as IR, console-object metadata and host import collection;
no direct-AST body emitter is changed.

The standard 60-pair byte-identity tool reports 58 unchanged records: all 15 gc,
all 15 standalone, all 15 linear and 13/15 WASI records. These include 14 existing Linear
compile errors and ten existing WASI compile errors; only one Linear and five
WASI records were successful binaries. Only WASI
`algorithms.ts` and `classes.ts` change, where console bodies can now reach IR.
Their legacy outputs contain existing `[object]` placeholders; the IR outputs
are checked against execution of the same TypeScript source transpiled to
JavaScript, with an executed legacy control retained. Compile success alone
is not execution evidence. The two older #4462 test failures are also reproduced on
exact base: the DOM admission expectation and the default-native gc number
formatter expectation. Historical tests/results are not relabelled as green.

The unchanged full FYI runtime plus `doneprintHandle.js` and `$DONE();` still
reports three legacy units on both targets: `__consolePrintHandle__` has
`param-type-not-resolvable`, `$DONE` has `body-shape-rejected`, and module init
is legacy. It has no standalone imports and only fd_write on WASI. The
console forwarding body is now supported when selected, but this does not
claim that the source print closure/module storage is prepared or the
assembled harness is IR-only. Those ownership dependencies remain visible;
no async/Test262 population gain is claimed.

Quality: argument rendering/newline/channel construction moved out of
from-ast; native provider materialization has one separate owner; console
method families have one shared contract. All existing long functions stay
within their old sizes. The WASI registration file grows only by its one
shared-contract import; its dated allowance grants that wiring, not a new
semantic body or a budget-baseline edit. Review before release remains pending.


The cycle detector initially caught an avoidable codegen-to-IR edge for console
binding constants. Moving the method and binding vocabulary into the shared
console-output contract removes that edge. The provider itself still joins the
existing engine SCC (725 to 726) and adds one integration-to-codegen edge
(79 to 80); the dated grants record this remaining migration debt. The adapter
uses the stable handle returned by the canonical renderer API, so it has no
new hand-written coercion vocabulary or index lookup policy.

Focused qualification after the reference-oracle and scalar checks covers
**108 semantic/refusal controls plus two separately named known-open witnesses
in seven files**. The new file has 68 semantic/refusal/provider controls and two
known-open constructor witnesses. The two changed WASI examples match full
JavaScript output; legacy execution remains a control and its placeholder
output is not treated as the correct answer. The old #4462 suite retains its
two exact-base failures. Strict IR-only harness ownership remains unproved.

A scalar probe found a separate existing constructor defect: `type u32 =
number; class C { value: u32 = 4294967295; }` stores `2147483647`, before console
formatting. Both exact base and candidate reproduce this value from a separate
field-return export; the base's console also prints the wrong value through an
already-IR-emitted main. Its Wasm `C_init` contains `i32.const 2147483647`.
The new tests label and pin this incorrect result as KNOWN OPEN; they are not
passing semantic controls. Returning the field as `number` also retains an
existing post-claim return-type mismatch and legacy fallback in the diagnostic
probe. This shared-initializer/body-ownership migration gap is not repaired by
developing the frozen direct-AST initializer.

New provider files live in existing codegen subdirectories, so the
flat-directory gate requires no allowance. The integration keeps its provider
import explicit and consolidates duplicate registry/types imports. Its actual
new provider dependency remains visible in the dated cycle grant above; no
barrel re-export hides that debt and no budget baseline is edited.

The output provider boundary also has eight direct controls: absent standalone
sink, absent WASI syscall, non-native strings and a JavaScript environment fail
closed; valid index-zero providers remain available; fast dynamic formatting
and unknown bindings are refused. The 62-test runtime/scalar matrix also passes
with `JS2WASM_IR_I32_DOMAIN=1` (60 controls plus two known-open witnesses).

Final integration qualification: upstream `efa58fece8f01e72122d7f7f5a0e31a764ca92f0`
is merged into this branch (integration `9bbbe452b74de7c1a4cc3d51f31320817f1a98a9`).
The already-landed delete refusal remains present. The eight-file runtime matrix
passes **112/112 registrations: 110 semantic/refusal/provider controls and two
known-open constructor witnesses**. The 70-registration console file also
passes with i32 inference enabled (68 controls, two known-open witnesses).
Current-main LOC/function, flat-directory, IR-layering and import-cycle gates
pass with only the exact dated grants above; inventory remains valid and
architecture incomplete. Fresh-context adversarial review remains pending.

## Takeover integration, 2026-10-28

Main `b6250f09f8` merged in (584 commits since `efa58fece8`). The only textual
conflict was the `from-ast.ts` import block: this branch's
`console-lowering.js` import and main's new `native-in.js` import are
independent, so both are kept. The cycle grants are restated against the new
base, where main itself had already moved (largest SCC 724, `ir->codegen` 81);
this change still adds exactly the one provider file to the SCC and the one
`integration.ts` → `helpers/ir-native-console.ts` edge. The PR's own two test
files pass 84/84; the six console-touching equivalence files pass 92/92. The two
#4462 rows and three #5386 gc rows that fail here fail identically on
`b6250f09f8`.

## Review round, 2026-10-29

- **Claim never turns legacy-compilable into a CE — refused before the claim.**
  With the WASI console claim, `type i32 = number; class C { v: i32 = … } …
  c.v = c.v + 1` reached `lowerBinary` with an `i32` field read against an
  `f64` literal and threw the "Phase 1 requires matching operand types"
  invariant. The selector now judges a native-i32 class-field read
  (`isNativeI32FieldRead`, checker-backed via `nativeTypeOfDeclaration`) as an
  `int32` operand through the shared `binaryOperandsAdmissible`
  (`nativeI32OperandsAdmissible`), so `+ - * / %` against a number, and any
  mixed equality/relational, stay on legacy before any claim (no post-claim
  demotion; the general binary gate keeps its invariant). Widening to f64 is
  not a fix: legacy computes `c.v + 1` in wrapping i32 arithmetic
  (`-2147483648`) and f64-add-then-store saturates (`2147483647`). Witness:
  `issue-7136` "refuses a native i32 field read inside f64 arithmetic before
  the claim" (wasi + standalone; empty `irPostClaimErrors`). Native i32
  arithmetic in the IR is the follow-up.
- **gc change disclosed:** `class C { v: i32 = 5; inc(): i32 { return this.v
  + 1; } }` was a gc compile error (IR claimed `C_inc`, then threw); the
  pre-claim refusal now leaves it on legacy, so it compiles. Every other probe
  and playground example is gc byte-identical.
- **Byte changes, restated:** gc is identical; standalone and WASI change
  wherever a dynamic `console.log(v: any)` is newly claimed (not only WASI
  `classes.ts`/`algorithms.ts`). Every changed binary the review ran prints the
  same output as legacy, or better.
- **Disclosed: BigInt renders by target.** `out(10n)` through
  `__ir_console_format_value` prints `10` on standalone and `[object Object]`
  on WASI; node prints `10n`, legacy WASI printed `[object]`.
