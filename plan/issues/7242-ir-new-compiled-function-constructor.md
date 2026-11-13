---
id: 7242
title: "IR: `new F(args)` of a compiled top-level function constructor (e.g. harness `Test262Error`) demotes the whole body"
status: done
sprint: current
created: 2026-11-05
updated: 2026-11-05
completed: 2026-11-05
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
related: [7106, 7240, 7241, 3123, 2949, 4502]
assignee: "ttraenkler/c-lead"
---

# #7242: IR cannot construct a compiled function constructor

## Problem

When an IR body contains `new F(...)` and `F` is a top-level `function`
declaration (not a class) compiled by legacy, the selector claims the body,
but `ir/from-ast` cannot build the expression. It demotes the body with
`unknown-class-construction` (`src/ir/from-ast.ts` ~L8506:
`unknown class "F" in <fn>`), and the body falls back to legacy.

In test262 the main case is `throw new Test262Error(msg)`. In the authoritative
lanes `Test262Error` is a harness function constructor from `sta.js`, so every
test262 file carries it.

Measurements, from the harness-wrapped ledger (`--wrapped`, #7240, standalone)
and the #6583 claim notice 6655440988:
- 35 `extends Iterator` class members whose body is `throw new Test262Error()`
  are claimed and then demoted for exactly this reason.
- Elsewhere in the wrapped ledger, `unknown class "Test262Error" in assert`
  appears ×22, and harness functions show more rows of the same kind.

## Implementation Plan (C lead, 2026-11-05; implement on Opus)

1. **Measure and attribute first.**
   - Count every `unknown-class-construction` demotion on the wrapped ledger at
     stride 40, standalone, by constructor name and by unit origin
     (harness/test). Use `JS2WASM_IR_SHAPE_DIAG=1` or a throwaway counter at
     the demotion site; do not commit it.
   - Check why the selector claims `new F()` when the builder cannot build it.
     Selector and builder must agree. If the selector has an arm that admits
     `new <top-level function>`, the fix belongs behind exactly that arm.
2. **Find legacy's construct path for a function constructor.**
   - Locate it: `compileNewExpression` in `src/codegen/expressions/new-super.ts`
     and the fnctor machinery (#3123). Record which function legacy calls,
     how `this` is allocated (object runtime / `$Object` / externref), what
     the result type is, and how a non-object return value is handled
     (`return 5` is ignored and `this` is used; returning an object replaces
     `this`).
   - Write the finding into this file before coding.
3. **Lower `new F(args)` in IR by calling legacy's existing construct entry**
   through the existing IR→legacy call ABI, the same symbolic function-ref
   mechanism IR already uses to call legacy-compiled functions. Do not inline
   or re-implement construction. Keep these exactly as legacy does them: the
   arguments' representation (externref / boxing), arity padding, and the
   result's representation (the value the IR expression produces).
   - In scope: `F` is a top-level `function` declaration in the same
     compilation unit, legacy compiles it as a constructor-capable function,
     and it is not reassigned anywhere (no writes to `F`).
   - Out of scope: dynamic callees, `new` of a parameter or value, builtin
     error constructors (`error-constructor-unsupported`), classes (already
     handled), `new.target`-observing constructors unless legacy's entry
     already threads it, and the harness function bodies themselves (#7106).
4. **Do not touch** `dynamicUsesAreMoveOnly`, the async/generator lanes, or the
   Shepherd's getter-callable files: `class-bodies.ts`,
   `closures/method-trampolines.ts`, `program-abi-class-callable-planning.ts`,
   `method-receiver-this.ts`, `property-access-exact-shapes.ts`.
5. **Never worse than legacy.** Every newly IR-claimed unit must give the
   legacy-observable result on gc, standalone and wasi. Probe:
   - `throw new F(msg)` caught and inspected: `instanceof F`, `.message`,
     `.constructor`, `String(e)`;
   - `new F()` used as a value;
   - F returning an object vs. a primitive;
   - F reading `new.target` or `this`;
   - F called both with and without `new` in one program;
   - a subclass of F, if legacy supports it (#3123);
   - exceptions thrown inside F.

## Acceptance criteria

- Wrapped ledger A/B (stride 40, standalone) in the PR body: IR units rise,
  `unknown-class-construction` falls, 0 invariants, `compileOk` not lower.
  Report the raw-mode A/B too.
- Typed corpus is byte-identical on gc, standalone and wasi, or every changed
  binary is explained.
- test262 A/B on the route-changed files plus a sample: no test that passes on
  base fails on head (standalone).
- Test: `tests/equivalence/issue-7242-ir-new-compiled-function-constructor.test.ts`.
  It asserts the IR route (`trackIrOutcomes`) and the node/base result on all 3
  lanes, including the `throw new F()` / `instanceof` case.

## Findings (steps 1–2, 2026-11-05)

**Measured** (wrapped ledger, stride 40, standalone, base `d468fa1a3c`,
`JS2WASM_IR_SHAPE_DIAG=1`; per-file attribution with a scratch route dump):
`build:unknown-class-construction` = 27 rows, **all `Test262Error`**:

| owner | rows | origin | files |
| --- | --- | --- | --- |
| `assert` (harness) | 22 | harness | 22 |
| `fakeObjectGetOwnPropertyDescriptor`, `doNotCall` (top-level test functions) | 2 | test | 2 |
| `A_method`, `A_name`, `D_set_name` (class members) | 3 | test | 1 |

No other constructor name appears. In this sample every case is the harness's
self-guarded `function Test262Error(message) { if (!(this instanceof
Test262Error)) return new Test262Error(message); … }`.

**Why the selector claims it but the builder cannot build it.** The claim is
the #7106 S3c arm: `dynamicConstructCallee` → `selfGuardedConstructorValueUse`
(`src/ir/select.ts`) admits `new F(…)` of a self-guarded top-level constructor
as `dyn.construct` on F's function-object value. The builder reads that value
from `cx.topLevelFunctionValues`, minted by `planIrImportedCalls`
(`src/codegen/ir-imported-call-planning.ts`). The two disagree in two places:

1. **Missing evidence (24 rows: `assert`, the 2 test functions).** The planner
   refused a VALUE use when F's signature had no flow evidence
   (`if (missingEvidence && !isReceiver && !isStoredValue) return;`). That is
   the case whenever `Test262Error` itself stays legacy (e.g.
   `select:logical-value-unsupported` on `message || ""`), because then there is
   no IR claim with a `typeEntry`. The selector never asked about evidence.
2. **Class members (3 rows).** The planner mints plans only for top-level
   function owners and module-init statements; class bodies are never visited.

**Legacy's construct path (step 2).** Where the S3c arm is live
(`irSelfGuardedConstructorValue` requires `selfGuardedConstructorsLeaveFnctor`,
which tests `ctx.standalone`, the native semantic regime (#5385), not the
`--target standalone` environment; that regime is also on for the default gc
target, so gc routes and bytes change with this arm too, while wasi stays
byte-identical; and never with a shared-realm eval; corrected 2026-11-05 after
the #7242 review), legacy does **not** use the `__fnctor_F` struct for a self-guarded
constructor: `compileNewExpression` checks
`calleeIsStandaloneSelfGuardedConstructor` (`fnctor-ctor-decl.ts`) and builds
from F's runtime function value through the native construct driver
(`tryCompileNativeConstructFromValue`, `new-super.ts`). `this` is an ordinary
`$Object` created by that driver from `F.prototype`; the result is the
driver's externref/dynamic value; an object returned by F replaces `this`, a
primitive is ignored (ordinary [[Construct]], done by the driver). IR's
`dyn.construct` lowers to the same driver (`resolveDynamicLowering().emitConstruct`),
with args boxed to the dynamic carrier. So IR already has the existing entry;
no new ABI is needed for case 1.

For a NON-self-guarded function constructor legacy builds the
`$__fnctor_F` struct through `__fnctor_F_new` (`compileNewFunctionDeclaration`);
IR has no general carrier for that struct (`fnctor.new` exists only for the
dormant #3521 L1 route). The selector already refuses that shape at select
(`expr-new-ctor-unknown`), so it is not a claim-then-demote, and it is out of
scope here.

**Design.**
- Case 1: the planner gives a self-guarded VALUE use with missing evidence the
  opaque all-dynamic signature, exactly as #7106 census arm 4 does for receiver
  uses. Every plan here is `objectReceiver: true`: the accessor's externref is
  boxed straight into the dynamic carrier and the signature is never read
  (`dyn.construct` takes the carrier; `dyn.instanceof_fn` reads only the exact
  unit target).
- Case 2: minting plans for class members is not enough. Tried: the class
  member then fails `resolve:late-preparation-unsupported`, because the
  prepared class component has no Program ABI identity for the dynamic
  carrier ops (`__ir_dyn_call_box`, `box`, `dyn.construct`). That is an ABI gap,
  not a #7242 change, and the failure is per class component (it could demote
  sibling members). So the S3c predicate the selector asks
  (`irSelfGuardedConstructorValue`, `src/codegen/ir-dynamic-construct.ts`) now
  answers no inside a class body: selector and builder agree, and the 3 rows move from
  `build:unknown-class-construction` to `select:constructor-resolution-unsupported`.
  The 35 `extends Iterator` class members from the #6583 notice are this case;
  they stay legacy until the prepared class component can carry the dynamic
  ops.

## Results (2026-11-05, base `d468fa1a3c`)

Change: `src/codegen/ir-imported-call-planning.ts` (value use with missing
evidence → opaque signature) and `src/codegen/ir-dynamic-construct.ts`
(`irSelfGuardedConstructorValue` answers no inside a class body).

**Wrapped ledger** (stride 40, standalone, `--jobs 2`):

| | base | head |
| --- | --- | --- |
| files / compileOk / compileFail | 1296 / 1117 / 179 | 1296 / 1117 / 179 |
| IR units (emitted) | 9633 | **9657 (+24)** |
| legacy units | 4800 | 4776 |
| harness IR units | 9547 | 9569 (+22, `assert`) |
| test IR units | 86 | 88 (+2) |
| `build:unknown-class-construction` | 27 | **0** |
| `select:constructor-resolution-unsupported` | 58 | 60 |
| `select:class-member-unsupported` | 239 | 240 |
| invariants | 0 | 0 |

Per-unit route dump of the same 1296 files: exactly 23 files change, 27
units: 24 `build:unknown-class-construction → emitted`, 3 class members →
refused at select. No other unit moves.

**Raw ledger** (stride 40, standalone): identical JSON apart from
timing/commit fields.

**Typed corpus bytes** (playground examples, benchmark suites, every
equivalence snippet; gc/standalone/wasi; 6879 compiles): byte-identical.

**test262 A/B, standalone** (`scripts/run-test262-paths.mts`, 237 files: the
23 route-changed files plus every 6th file of the sample): base and head both
175 pass / 52 fail / 10 compile_error, identical output. 8 of the fails on
both sides are "quickjs provider is not built" (eval engine not present in this
container).

**Probes** (gc, standalone, wasi; head = base on every lane; gc and standalone
= node): throw + `instanceof`/`.message`/`.constructor`/`String(e)`, `new F()`
as a value, F returning an object vs a primitive, F reading `this`, F called
with and without `new`, `x instanceof F`, a subclass of F, `new.target` in F,
an exception thrown inside F, `new F()` in a class member. WASI differs from
node on three of them on base already; unchanged.

Test: `tests/equivalence/issue-7242-ir-new-compiled-function-constructor.test.ts`
(30 cases; 18 fail on base on the route assertion, values equal).

### Left open

- Class members (the 35 `extends Iterator` members of the #6583 notice) stay
  legacy: the prepared class component cannot resolve the dynamic-carrier
  support (`__ir_dyn_call_box`, `box`, `dyn.construct`) without a Program ABI
  identity. They are now refused at select instead of demoted at build.
- `new F()` of a NON-self-guarded function constructor still needs the
  `$__fnctor_F` struct ABI in IR; already refused at select.
