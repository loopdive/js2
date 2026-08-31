---
id: 680
title: "Wasm-native generators (state machines) with optional JS host fallback"
status: ready
created: 2026-03-20
updated: 2026-08-31
priority: high
feasibility: hard
reasoning_effort: max
goal: standalone-mode
sprint: current
active_slice: expression-continuations
active_branch: codex/680-expr-continuations-d60-20260831
required_by: [681, 735, 762, 1042]
loc-budget-allow:
  - src/codegen/index.ts
  - src/ir/from-ast.ts
  - src/codegen/context/types.ts
  - src/codegen/expressions.ts
  - src/codegen/generators-native.ts
func-budget-allow:
  - src/codegen/expressions.ts::compileExpressionInner
  - src/codegen/generators-native.ts::buildNativeGeneratorPlan
  - src/codegen/generators-native.ts::compileState
files:
  src/codegen/statements.ts:
    breaking:
      - "compile generators as Wasm state machines instead of host-backed buffers"
  src/codegen/expressions.ts:
    breaking:
      - "yield compiles to state save + return, next() resumes from saved state"
---
# #680 — Wasm-native generators (state machines) with optional JS host fallback

## ECMAScript spec reference

- [§27.5.3.1 GeneratorStart](https://tc39.es/ecma262/#sec-generatorstart) — initializes generator execution context
- [§27.5.3.3 GeneratorResume](https://tc39.es/ecma262/#sec-generatorresume) — resumes suspended generator
- [§27.5.3.4 GeneratorResumeAbrupt](https://tc39.es/ecma262/#sec-generatorresumeabrupt) — handles throw/return into generator
- [§15.5.2 Runtime Semantics: EvaluateGeneratorBody](https://tc39.es/ecma262/#sec-runtime-semantics-evaluategeneratorbody) — creates generator object and starts execution


## Status: open

Generators currently use 10+ JS host imports (__gen_create_buffer, __gen_push_f64, __gen_result_done, etc). In standalone/WASI mode there is no JS host, so a pure Wasm implementation is required. In JS host mode, the existing host imports remain available as an option.

### Current approach (limitations)
The generator eagerly evaluates ALL yields into a JS array buffer, then iterates over it. This means:
- Infinite generators are impossible (buffer fills forever)
- Lazy evaluation is lost (all values computed upfront)
- Only works in JS host mode (crashes under WASI)

### Pure Wasm approach: state machine transformation

Transform each generator function into a state machine stored in a WasmGC struct:

```typescript
function* gen() {     // Original
  yield 1;
  yield 2;
  return 3;
}
```

Compiles to:
```
struct $gen_state {
  field $state i32     ;; current state (0=start, 1=after yield 1, 2=after yield 2, 3=done)
  field $value f64     ;; last yielded value
  field $done i32      ;; 0 or 1
  ;; captured locals saved here
}

func $gen_next(self: ref $gen_state) -> ref $gen_result {
  switch (self.$state) {
    case 0: self.$value = 1; self.$state = 1; self.$done = 0; return;
    case 1: self.$value = 2; self.$state = 2; self.$done = 0; return;
    case 2: self.$value = 3; self.$state = 3; self.$done = 1; return;
    default: self.$done = 1; return;
  }
}
```

### Key challenges
1. **Local variable persistence**: Locals between yields must be saved to the state struct
2. **Control flow across yields**: yield inside loops/if/try needs state labels
3. **yield delegation**: `yield*` delegates to another iterator
4. **Generator.return()**: Forces early completion
5. **Generator.throw()**: Resumes with an exception

### Phased approach
- Phase 1: Simple sequential yields (covers 60% of test262 generator tests)
- Phase 2: Yield in loops/conditionals (covers 85%)
- Phase 3: yield*, return(), throw() (covers 95%)

## Complexity: XL

## Implementation Plan

(Author: architect, 2026-05-21. Concrete plan for Phase 1 — sequential
yields. Phases 2-3 sketched at the end.)

### Entry point

- **AST detection**: `compileFunctionDeclaration` and friends in
  `src/codegen/declarations.ts` — branch when `node.asteriskToken`
  is present.
- **Codegen**: new file `src/codegen/generators-native.ts` with the
  state-machine lowering.
- **Yield expression**: `compileYieldExpression` in
  `src/codegen/expressions.ts` — emit state save + `return` from
  the resume function.

### Data structure

Per-generator state struct (one type per generator function in the
type section):

```wat
(type $GenState_<funcName> (sub (struct
  (field $tag i32)                  ;; GENERATOR_TAG
  (field $state (mut i32))          ;; current state label
  (field $value (mut f64))          ;; last yielded f64
  (field $valueRef (mut (ref null any))) ;; or ref payload
  (field $done (mut i32))
  ;; captured params/locals (filled per function via analysis)
  (field $local_x (mut f64))
  (field $local_y (mut (ref null any)))
)))
```

Generator result struct (shared):

```wat
(type $IterResult (struct
  (field $value (ref null any))
  (field $done i32)
)))
```

### Algorithm — Phase 1 (sequential yields)

1. **CPS transform**: split the generator body at every `yield`.
   Each segment becomes a `case` in a switch on `$state`.

2. **Local analysis**: identify all locals that cross a yield
   boundary; allocate them as struct fields, not wasm locals.

3. **State numbering**: assign state IDs:
   - 0 = initial (before first instruction)
   - 1..N = after each yield N
   - N+1 = done

4. **Generated resume function**:

```wat
(func $gen_resume_<name> (param $self (ref $GenState_<name>))
                         (param $sent (ref null any))
                         (result (ref $IterResult))
  local.get $self
  struct.get $state
  br_table 0 1 2 ... N
  ;; case 0:
  ;; ... segment 0 instructions ...
  ;; yield_1: save state=1, value=...
  ;; return result
  ;; case 1:
  ;; ... segment 1 instructions ...
  ...
)
```

5. **Generator object construction** — `compileFunctionCall` for a
   generator function:
   1. Allocate `$GenState_<name>` with state=0.
   2. Copy params into the corresponding fields.
   3. Return wrapped in `$Generator` (existing tag).

6. **`gen.next(arg)`** — dispatch to `$gen_resume_<name>`.

7. **`gen.return(arg)`** — set state to N+1, return
   `{value: arg, done: true}`.

8. **`gen.throw(err)`** — Phase 3.

### Phase 2 — yields inside control flow

- **Yield in loop**: state ID per loop iteration's yield site; the
  loop's induction variable becomes a struct field. On resume,
  br_table jumps mid-loop; the loop continuation is re-entered.
- **Yield in if/switch**: each branch's post-yield is its own state.
- **Yield in try**: try-block segments get their own state; on
  resume from inside a try, the exception handler state is
  preserved.

### Phase 3 — yield*, throw, return

- **`yield* iter`** — delegate: capture sub-iterator in a struct
  field; each resume steps the sub-iterator and re-yields its
  value; on done, fall through.
- **`gen.throw(err)`** — re-enter the resume function in a new state
  that re-raises; the existing wasm exception tag handles the
  surface.
- **`gen.return(arg)`** — invoke any active `finally` blocks via
  the suspended state's cleanup path; then mark done.

### Edge cases

- **Yield as expression value**: `let x = yield 1` — the next
  `.next(arg)` provides `x`. The resume function takes `$sent` as
  a parameter; the resumption point assigns `$sent` to the
  target local.
- **Yield inside expression**: `f(yield 1, yield 2)` — multiple
  yields per statement; CPS-split per yield, intermediate values
  saved to struct fields.
- **`for-of` over a generator** — driven by the iterator protocol;
  no special case.
- **Async generators (`async function*`)** — different state
  machine (combines async + generator); separate Phase 4 / #1042.
- **Closures inside generators** — captured locals must live in
  the state struct, not the resume function's stack.
- **Strict mode / arguments object** — arguments captured at
  construction time.

### Test262 paths

- `test/language/statements/generators/*` — Phase 1 + 2.
- `test/built-ins/GeneratorPrototype/*` — all phases.
- `test/language/expressions/yield/*` — Phase 1.

Acceptance per phase:
- Phase 1: ≥60% of test262 generator tests pass.
- Phase 2: ≥85%.
- Phase 3: ≥95%.

## Implementation notes — 2026-06-03

- Added a Phase 1 Wasm-native generator path for standalone/WASI targets:
  top-level non-async `function*` declarations with sequential numeric
  `yield` statements and optional numeric `return` lower to a WasmGC state
  struct plus a generated resume function.
- Native `.next()` / `.return(value)` calls dispatch directly to the generated
  resume/state update path, and `IteratorResult.value` / `.done` lower to
  `struct.get` on the native result struct.
- Generator parameters are copied into the state struct at construction so
  simple yielded expressions can read them across suspension.
- The existing eager JS-host generator buffer path remains active for default
  JS-host builds. Standalone/WASI no longer registers `__gen_*` /
  `__create_generator` imports; unsupported generator shapes receive a scoped
  compile diagnostic instead of silently depending on JS host helpers.

Validation:

- `pnpm exec vitest run tests/issue-680.test.ts`
- `pnpm exec tsc --noEmit --pretty false`

### Dependencies

- **#1042** — async/await state machine; shares CPS-transform
  infrastructure. Land async first if its plan is approved; #680
  can reuse the splitting machinery.
- **#735** — async iteration correctness; benefits from this work.
- **#1257** — funcIdx shift; detached-bodies fix; relevant because
  CPS splitting creates many detached Instr[] arrays.

### Risks

- **Compile-time CPS analysis**: every yield creates a state; deeply
  nested loops with yields explode the state count. Cap at 256
  states per generator; beyond, fall back to host import (gated by
  ctx.wasi check).
- **Local lifetime correctness**: forgetting to spill a local into
  the state struct causes silent data corruption on resume. Add an
  assertion: every local read in segment N must come from either
  (a) a wasm local set in the same segment or (b) a struct field.

### Measurement note (2026-06-19, sdev-ctorval re-ground of task #69)

The `function-body.ts:1009` diagnostic ("native generator lowering currently
supports only sequential numeric yields") is now **largely vestigial** and is a
**0-flip** target on real test262:

- Native generators now lower yields inside `while`/`for`/`if`/`try-catch`/
  `switch`, `yield*` delegation (#2170), string yields (#2171 — done), and
  numeric/boolean/undefined yields (booleans/undefined coerce to f64).
- The only remaining plan-bail is **non-numeric / non-string / mixed-type
  yields** (`yield {obj}`, `yield [arr]`, `yield 1; yield "a"`) — these need the
  generator state-machine's yield ValType widened to a boxed `externref`/`anyref`
  element rep (state-struct field types + result struct + resume fn + spill
  machinery). Architect-scale.
- **Measured impact: 0 / 350** sampled generator/iterator test262 files (under
  `--target standalone`) hit the seq-numeric-yield CE. The real generator
  residual is an ~88-file long tail of **distinct per-test `result.value`/
  `result.done` runtime-semantics mismatches**, NOT the codegen bail — each a
  separate small bug, not one clusterable slice.

Conclusion: do NOT invest in widening the yield element rep for conformance —
it flips ~0. The "sequential numeric yields" harvest label was misleading (it
appeared in a sampled error string but is not a meaningfully-occurring gate, same
class as the #68 BigInt64Array_new mislabel). If non-numeric yields are wanted
for completeness, treat as a low-priority #680 follow-up, not a conformance slice.

## Reopened 2026-07-20 (harvest cross-reference)

Marked `status: done` but the test262 harvest shows **398 live failures still citing #680** in the error field. Premature close — reopened as `ready`. See the sprint-73 harvest note.

## Regression-fix slice (2026-07-24, dev-opus-2) — #3341/#3519 STRICT-IR regression fixed; #680 STAYS OPEN

**Scope: this is a REGRESSION FIX under #680, NOT a completion.** #680 the
umbrella feature still has **364 live test262 failures** citing it (the broader
native-generator scope — for-of/spread/delegation/async-gen edges), so the issue
stays `status: ready`. This slice fixes ONLY the specific #3341/#3519 STRICT-IR
regression that broke *basic* standalone generator compilation.

Surfaced by the invisible-guard-test audit (`tests/issue-680.test.ts` silently
red on main, outside required checks — the #3008 gap). **A basic standalone
generator regressed from compile+run to a HARD COMPILE ERROR.**

**Verify-first + bisect (measured, not assumed).** `function* gen(){ yield 1;
yield 2; return 3 }` + a caller doing `g.next()` under `--target standalone`:
GOOD at `d093f05` → BAD at `a3a3a76`. **Culprit: #3341 (PR #3249,
`issue-3341-strict-ir-buildorerrors`), 2026-07-17** — a 7-day-old regression,
NOT recent. Two independent hard-error paths, both from #3341/#3519 promoting IR
fallbacks to hard errors on a premise validated on a scope that missed valid
standalone programs:

1. **`gen`** — the IR generator path emits a ref to the host-only
   `__gen_create_buffer`, which `addGeneratorImports` (registry/imports.ts)
   intentionally **skips** under standalone/wasi (the native `__GenState` path
   serves those targets). #3341 promoted that `unknown-function-ref` invariant to
   hard. The premise ("no valid TS source produces an unresolvable ref on a
   claimed function") was validated on the **gc-target** playground corpus,
   missing the standalone-target dimension.
2. **`run`** — the caller's `.next()` hit `ir/from-ast: method call .next(...) on
   externref not in slice 4`, thrown as a **plain `Error`** → classified as the
   untyped `unexpected-internal-throw` invariant → hard (#3519). Its sibling
   property-write "not in slice 4" throw was already a typed `IrUnsupportedError`;
   the method-call one being a plain Error was an inconsistency.

**Fix (two scoped source changes).**
- `src/codegen/index.ts` (`formatIrPathFallbackDiagnostic`): an
  `unknown-function-ref` invariant demotes to warning ONLY when the target is
  standalone/wasi AND the ref is a host-only generator import (exactly the set
  `addGeneratorImports` omits). Genuine desync still hard-errors.
- `src/ir/from-ast.ts` (~L4941): type the method-call "not in slice 4" throw as
  `IrUnsupportedError("method-call-unsupported")` (new code in `outcomes.ts`),
  matching its property-write sibling — a not-yet-adopted construct is
  UNSUPPORTED (→ warning/legacy), not an unexpected bug. Un-breaks EVERY
  method-call-not-in-slice-4 program, not just generators (merge_group-measured).

Both leave #3519's genuine-desync / genuinely-unexpected-throw hard-erroring
intact (its 3 tests stay green). `tests/issue-680.test.ts` refreshed (the 2 stale
host-import-presence subtests → native host-free assertions) and folded into the
required guard suite (`tests/guard-suite.json`, #3552) to close the #3008
invisibility. Regression guard: standalone `function* gen(){yield 1;yield 2;
return 3}` + caller compiles host-free, `run() === 1235`.

**Broader lesson (flagged for the next STRICT_IR / classify tightening):** both
over-strict promotions (#3341 `unknown-function-ref`, #3519
`unexpected-internal-throw`) were validated on a scope (gc-target /
recognized-throws) that did not exercise the fallback-demotion cases across ALL
targets. A future tightening must check that valid standalone programs still
demote.

## Expression-continuation d60 reconstruction and P2 repair (2026-08-31)

This bounded slice is reconstructed in the isolated worktree
`codex/680-expr-continuations-d60-20260831` from exact upstream main
`d60aa73f9b3405dcdc1f832a511acb2366c7de00`. The prior recovery worktree at
`c39de6dac8c376482b4f2cd628e445c6d8441728` and its b91 live port are
evidence-only source material; the five owned paths were reconciled onto d60
instead of copied or rebased. No GitHub issue was created.

The current post-review replay target is upstream main
`a4d141321daf7f8874e540d7b75f58f8c3e2c2a7`. The complete
`d60aa73f9b3405dcdc1f832a511acb2366c7de00..a4d141321daf7f8874e540d7b75f58f8c3e2c2a7`
span contains benchmark artifacts plus the unrelated #5247 tracker filing, and
has no overlap with these five owned paths; the final clean-head integration
must nevertheless replay the focused gate.

### Bounded implementation plan and admitted grammar

The native planner owns pre-yield capture spills and original-AST replacement
identities for a state. It evaluates a safe prefix operand exactly once before
the suspension, then recompiles the original expression after resume under a
state-local replacement map. The public expression layer retains ordinary
expected-type coercion and boxing; only common inner dispatch reads a spill.
Missing capture/local/type metadata is an invariant failure, never an excuse to
replay source or synthesize a default.

This slice admits only direct-generator-body expression statements with:

- a parenthesized bare `yield`;
- one bare `yield` in an array or a noncomputed object-data-property literal;
- comma chains of safe operands and bare yields; or
- the three-bare-yield conditional, lowered through canonical JavaScript
  ToBoolean and distinct successor states.

Recursive statement lowering explicitly disables that permission. Blocks, if
arms, loops, try/catch/finally, `yield*`, async generators, calls/property
access, spread, computed keys, and destructuring remain fail-closed. A
state-lowered finally rejects the continuation route even if a future caller
accidentally grants it. The raw boolean capture preserves its branded `i32`
representation until ordinary array-element boxing; raw references have only
compile/validate/resume coverage, not a representation claim.

### Recovery evidence: independently reviewed, not d60 evidence

The recovery-base focused file passed **1 / 1 test file and 26 / 26 tests**
with direct Node, one Vitest fork, and no file parallelism (20.72 s total;
10.41 s test time). Root then replayed the same b91 port at **1 / 1 and 26 / 26**
in 18.92 s total (9.86 s test time). Both are historical exact denominators,
not acceptance evidence for this d60 reconstruction.

The 26 controls are:

- 10 positive controls: object-literal generator method with a parenthesized
  yield; standalone prelude-before-capture; consecutive array continuations;
  object-data-property once-only capture; comma-prefix no-replay; raw boolean
  boxing; raw-reference compile/validate/resume; three-yield conditional
  canonical-ToBoolean/state-target evidence; adjacent sequential yields; and
  the matching default gc/host prelude control.
- 16 valid-contract refusal controls: bare block, if then, else, while, do,
  for, try, catch, finally, `yield*`, async generator, call operand, property
  access, spread, computed object key, and destructuring assignment.

The earlier independent review confirmed state-local capture ownership,
prelude/suspension order, conditional ToBoolean/targets, map restoration, and
the fail-closed boundary. It also corrected formerly vacuous observations: the
prelude-sensitive `let i = 10; [i++, yield]; return i` control distinguishes
the required `11` from capture-before-prelude's `10`, and the boolean WAT proof
resolves the two interned boolean globals inside `__gen_resume_g` instead of
assuming an uninlined helper call.

### Historical independent review BLOCK and initial P2 repair (superseded below)

The review identified a P2 invariant violation in the recovered planner:
`isSafeContinuationOperand` admits identifier prefixes, while
`continuationCaptureType` previously took the checker result directly. The
identifier `undefined` could therefore become an unbranded `i32` capture.
Resume-time replacement bypasses normal literal handling, and an externref
array carrier could send that `0` through numeric boxing instead of canonical
`undefined` emission. Statement-position runtime results discard the value, so
they could not expose the defect; the WAT-level ordinary-boxing invariant did.

The initial d60 repair was intentionally narrow:

1. Exact checker `Undefined`/`Void` prefixes are admitted only in the
   standalone/native-string canonical-undefined regime. They get an `externref`
   spill marked `canonicalUndefined`; ordinary host mode rejects only this
   prefix form and remains on the existing host fallback. No raw numeric `i32`
   representation is accepted.
2. Capture emission requires an `externref` local and emits
   `canonicalUndefinedExternInstrs(ctx)` directly. It never invokes the normal
   expression compiler, numerical conversion, or number boxer for that
   marker.
3. The focused suite now adds `[undefined, yield, null]`. Its scoped resume-WAT
   assertion resolves the canonical `__undefined` global, requires exactly one
   `global.get` → `extern.convert_any` → `local.set` capture sequence and
   rejects `f64.convert_i32_s`, the mandatory numeric-box route from an i32
   continuation. The prior 26 controls remain unchanged, so the next focused
   denominator is 27.
4. Grammar admission and every existing refusal stay unchanged. This does not
   broaden a fallback or downgrade an invariant.

### Historical P2 re-review BLOCK and syntax-only repair plan (superseded below)

The preceding checker-only repair is not sufficient. `isSafeContinuationOperand`
intentionally unwraps TypeScript-only wrappers, but
`continuationCaptureType` queried the **outer** wrapper's checker type and then
marked every `Undefined`/`Void`-typed operand canonical. That lets a wrapper
erase an observable, otherwise admitted operation. The exact standalone
reproduction is:

```ts
function* g(): Generator<number | undefined, number, unknown> {
  let i = 0;
  [((i = 1) as unknown as undefined), yield, null];
  return i;
}
```

The inner assignment is accepted by the bounded safe-operand grammar, the outer
assertion has checker type `undefined`, and the old canonical emission skipped
the original AST entirely. The first suspension therefore lost `i = 1`; the
required completion value is `1`, whereas the broken path yields `0`. The same
checker-only rule could collapse other erased undefined/void shapes, so it is
not a sound value-carrier proof.

The first repaired boundary was deliberately narrower, but is superseded by
the oracle-and-type admission order recorded below:

1. Mark a capture canonical only for the syntax-only `undefined` literal form
   (with transparent parentheses/assertion wrappers whose innermost expression
   is that literal). In standalone/native-string mode it uses the existing
   canonical externref singleton; in default host mode it declines native
   planning and uses the existing host fallback.
2. Any other checker `Undefined`/`Void`-containing prefix, including the cast
   reproduction above, declines the expression-continuation plan rather than
   replacing evaluation with a canonical value. Other safe operands continue to
   compile their original AST exactly once.
3. Strengthen the `[undefined, yield, null]` WAT control: resolve the exact
   `__undefined` global in `__gen_resume_g`, recover the canonical capture local,
   prove that local crosses the suspension through a state spill field, and
   prove the same field is reloaded and feeds the rebuilt successor expression.
   Keep the scoped no-`f64.convert_i32_s` assertion. This prevents a match from
   an unrelated helper or a discarded direct-undefined expression.
4. Keep the 11 direct controls plus 16 refusal rows (27 Vitest cases). Add the
   cast-side-effect refusal and default-host canonical-prefix fallback assertions
   inside their existing focused controls, so the denominator remains stable.

This repair has not used a compiler or runtime lane. After static review and a
clean integration onto `932341cc7d01547bf6b0065d766a31cdf3478d9f` or newer,
run the one-fork focused 27-case file exactly once before publication.

### Historical syntax-only P2 static handoff (superseded by admission-order repair)

This superseded snapshot used a syntax proof rather than a checker-only type
proof. It admitted direct `undefined` through transparent TypeScript-only
wrappers; the later review found that wrapper treatment and its spelling-only
binding check insufficient. The side-effecting double-assertion, default
gc/host fallback, and strengthened WAT spill trace remain useful controls, but
the active admission rule is the oracle-and-type boundary recorded below.

Completed after this repair, without a compiler/runtime lane:

- targeted Prettier check passed for the tracker, all three source paths, and
  the focused test;
- targeted Biome **lint** at error level passed for the four TypeScript files
  with no diagnostics or fixes; and
- tracked and untracked owned-path whitespace checks passed.

Current source diff accounting is three allowlisted files at net **+690** lines
(`context/types` +10, `expressions` +38, `generators-native` +642). The focused
manifest remains exactly 11 direct controls plus 16 `it.each` refusal rows
(**27 cases**); its two added assertions are inside existing controls. No
compiler, Vitest, Test262, TypeScript, hook, commit, push, or PR command has run
from this worktree. The next action is one clean-head focused replay on
`932341cc7d01547bf6b0065d766a31cdf3478d9f` or newer.

### Owned-path reconciliation and handoff

Only this tracker, `src/codegen/context/types.ts`,
`src/codegen/expressions.ts`, `src/codegen/generators-native.ts`, and
`tests/issue-680-generator-expression-continuations.test.ts` belong to the
d60 replay. The old b91-to-d2 and d2-to-d60 audits found no exact overlap in
the three codegen or test paths; the d2-to-d60 delta's #5246 tracker update is
unrelated. This reconstruction retains current-d60 contents outside the narrow
insertions rather than replacing whole files.

Static-only checks are required before independent review: owned-path diff
whitespace, targeted Prettier/Biome, LOC/function-budget accounting, and a
source inventory proving that canonical undefined is the sole new special
capture path. No compiler, Vitest, Test262, TypeScript, hooks, commit, push, or
PR action has been run from this d60 reconstruction. After a future clean
live-head integration, rerun all scoped static gates and the one-fork focused
27-case file before any publication decision.

### Pre-re-review d60 static handoff (historical source-only evidence)

The reconstructed snapshot is limited to the five owned paths listed above.
Its recovery comparison is exact for `context/types.ts` and `expressions.ts`;
`generators-native.ts` differs from the reviewed recovery only by the P2
canonical-undefined/fail-closed implementation (51 insertions, 7 deletions),
and the focused test differs only by its 29-line new WAT control.

Completed static checks on this d60 worktree:

- owned tracked-path `git diff --check` passed; the new untracked focused file
  was independently parsed by both formatter and linter below;
- targeted Prettier check passed for the tracker, three source files, and
  focused test;
- targeted Biome error-level lint parsed all four TypeScript files with no
  diagnostics or fixes;
- LOC budget passed: 3 changed source files, net **+674** allowed by this
  tracker (`context/types` +10, `expressions` +38, `generators-native` +626);
- function budget passed with the tracker allowances for
  `compileExpressionInner` +26, `buildNativeGeneratorPlan` +487, and
  `compileState` +20; and
- source inventory found 11 direct positive controls plus 16 refusal cases
  (**27 total**), with the canonical-undefined fixture and resume-only proof
  both present.

No compiler, Vitest, Test262, TypeScript, hook, commit, push, or PR command
ran in this worktree. The remaining blocker is independent review followed by
a clean integrated-head replay; this static checkpoint is not a test pass.

### Independent admission-order BLOCK and bounded repair plan

The prior canonical-literal repair still used spelling after transparent-wrapper
unwrapping. That was not a sufficient binding proof: a parameter or local named
`undefined` can be a real user value, while the direct identifier compiler arm
also treats that spelling specially. It must therefore decline this continuation
route unless the oracle proves the **original** node is the unshadowed ambient
global `undefined`.

The review also found that the earlier gate ran after raw-boolean branding and
looked only at the outer checker type. That admits or misclassifies assertion
forms such as `(true as unknown as void)`, and misses type-wrapper laundering
where an outer `number | undefined`/`void`/`null` union hides a non-nullish
unwrapped operand. A union with any `null`, `undefined`, or `void` constituent
has no proven continuation representation in this bounded slice. Direct `null`
remains a separately safe literal and must not be swept into that refusal.

The repair plan is deliberately fail-closed and does not widen grammar:

1. Before boolean branding, query both the original expression and its
   transparent-wrapper-unwrapped node. Canonicalize only a direct identifier
   whose spelling is `undefined` and whose oracle binding/declaration answers
   prove the ambient global; default gc/host still declines it to the legacy
   fallback.
2. Refuse every shadowed `undefined` spelling, every noncanonical direct
   `Undefined`/`Void` type, and every outer or inner union containing
   `Null`/`Undefined`/`Void`. Preserve direct `null` and ordinary non-nullish
   captures unchanged.
3. Make the resume-WAT fixture use the balanced function extractor after a
   unique exact function-name match, and require the state-advance `struct.set`
   to use the recovered capture spill's exact state type.
4. Keep the 27-case Vitest denominator by embedding controls for shadowed
   `undefined`, boolean asserted to `void`, all three nullish union members,
   wrapper-laundered nullish unions, and a direct-null positive in existing
   focused cases. No compiler or runtime evidence is claimed until a later
   released one-fork replay.

### Admission-order repair static handoff (no runtime lane)

The repair now has one coherent capture-admission order in
`continuationCaptureType`:

1. It queries checker types for both the original node and the
   transparent-wrapper-unwrapped node before any boolean brand. A direct
   noncanonical `Undefined`/`Void` type, or either union containing
   `Null`/`Undefined`/`Void`, declines the native plan; direct `null` remains
   ordinary.
2. Canonical emission is restricted to the **original** direct `undefined`
   identifier when the oracle finds only ambient declaration-file bindings, not
   a user source declaration. A wrapper never becomes canonical. Shadowed
   `undefined` declines before it can reach the direct identifier compiler arm.
   In default gc/host mode that otherwise canonical form still declines to the
   existing `__create_generator` fallback.
3. The canonical resume-WAT probe now first chooses one exact
   `__gen_resume_g` match, slices it with the balanced-expression extractor,
   and ties state advancement to the exact state type recovered from the
   canonical capture's `struct.set`. Its former resume-wide no-numeric-box
   claim is superseded below by the exact successor-arm, same-local dataflow
   proof; valid f64 sent-value boxing remains outside that negative assertion.

The existing canonical-undefined positive now embeds valid-contract controls
for the side-effecting erased assertion, shadowed `undefined`, asserted
boolean-to-`void`, `number | undefined`, `number | void`, `number | null`, and
wrapper-laundered `number | undefined` refusals. It also has a direct-`null`
standalone positive. These are inside the existing `it`, preserving exactly
**11 direct controls + 16 refusal rows = 27 Vitest cases**. The older
wrapper-admission claims are explicitly historical and superseded. Every
standalone refusal, including the new embedded controls, must also produce a
compiler diagnostic, so an unrelated silent failure cannot satisfy the row.

Current source inventory remains the three allowlisted files at net **+716**
lines (`context/types` +10, `expressions` +38, `generators-native` +668), plus
this tracker and the 701-line focused test. Completed static-only gates after
this entry are targeted Prettier (all five paths), error-level Biome lint (the
four TypeScript paths), and tracked/untracked whitespace checks; all passed
with no diagnostics or fixes. No compiler, Vitest, Test262, TypeScript, hook,
commit, push, or PR command has run for this repair. The next runtime action,
only after clean integration, is one single-fork replay of the 27-case file
against live `932341cc7d01547bf6b0065d766a31cdf3478d9f` or newer.

### Independent re-review BLOCK: inner-only nullish-union proof

The prior three nullish-union refusal fixtures passed their union-typed
identifier directly to the continuation capture. They exercise the outer-type
gate, but cannot prove that `continuationCaptureType` also consults the
transparent-wrapper-unwrapped node: both checker queries see the same union.

The bounded test-only repair keeps the existing declared
`number | undefined`, `number | void`, and `number | null` parameters, but
wraps each operand as `(value as number)`. The outer assertion is safely
`number`; the unwrapped identifier is still the declared nullish union. Each
fixture must therefore refuse solely through the inner-type gate. They remain
valid Generator contracts and stay inside the canonical-undefined `it`, so the
manifest remains **11 direct controls + 16 refusal rows = 27 Vitest cases**.
No source semantics or WAT proof changes are authorized. After this test-only
repair, rerun only the scoped static gates; a compiler/runtime replay remains
reserved for a released lane.

Scoped static replay completed after this test-only change: targeted Prettier
passed for all five owned paths; error-level Biome lint passed for the four
TypeScript paths; tracked and untracked whitespace checks produced no
diagnostics; and source inventory confirmed 11 direct `it` controls, 16
`it.each` refusal rows, and exactly three `(value as number)` inner-only union
fixtures. No compiler, Vitest, Test262, TypeScript, hook, commit, push, or PR
command ran.

### Hook-stop evidence and bounded successor-state WAT-proof repair

The normal commit hook formatted and staged the five owned paths, but created
no commit and left no new lint-staged stash. Its focused #680 replay stopped at
**26/27**: the only failing assertion was the canonical-undefined WAT proof in
`expectCanonicalUndefinedContinuationSpill`. The source semantics and all 27
fixture contracts remain unchanged.

The failed proof identifies the canonical capture local and its state-struct
spill field correctly, then advances past the first successor-state
`struct.set` and demands a non-store `local.get` before the next matching spill
store. That interval is not a defensible successor-state boundary: the rebuilt
expression's actual consumer can occur after an early state write in the same
successor. The resulting absence is a test-proof false negative, not evidence
that the capture is lost.

The bounded repair will keep the exact balanced `$__gen_resume_g` body and the
same recovered state type/field. It will locate the transition to the exact
successor state, bound analysis to that state arm, and prove that a reload of
that **same** spill field supplies the reconstructed capture local's real
consumer there. It will not widen to a module-wide or unbounded regex, change
codegen semantics, alter the canonical-admission controls, or change the
**11 direct + 16 refusal = 27** denominator. After targeted static checks, one
single-fork focused replay is the only authorized runtime command; on a
failure its output is retained and no second replay is run.

### Single-fork hook replay: 26/27, stopped without retry

The bounded successor-arm proof passed its formerly failing point after scoped
Prettier, error-level Biome lint, and tracked/untracked whitespace checks all
passed. The one authorized direct-Node, one-fork/no-file-parallelism Vitest
replay then produced **26 passed, 1 failed (27 total)**. No second replay ran.

The sole failure is now the older whole-resume negative at
`issue-680-generator-expression-continuations.test.ts:370`:
`no numeric continuation box path` rejects any `f64.convert_i32_s` in
`$__gen_resume_g`. The retained WAT artifact shows the repaired chain is
present — canonical capture local `1` spills/reloads through state field
`46/5`, and state `1` reads it before its sole `array.new_fixed 1 3` rebuild.
The reported conversion instead belongs to the distinct f64 sent local `2`:
its ordinary numeric-to-externref boxing occurs between `local.get 2` and the
same rebuilt array. It is not a conversion of the canonical externref capture.

This is therefore a remaining **test-proof scope defect**, not a source
semantic regression: a module-resume-wide ban on numeric conversion cannot
distinguish the canonical operand carrier from valid boxing of the yielded sent
value. Any follow-up must narrow that negative to the canonical spill/local
dataflow inside the already recovered successor arm, retain the exact
same-field/reload evidence, and use a newly released runtime lane. This task
stops here with the complete Vitest output preserved; it did not run TypeScript,
Test262, hooks, staging, commit, merge, push, or PR commands.

### Bounded follow-up plan: canonical operand numeric-box proof only

The single replay makes the required distinction concrete. In the exact state-1
arm, the recovered canonical capture local is the first stack operand of the
same `array.new_fixed … 3` rebuilt expression; the next immediate stack source
is the distinct f64 sent local, whose subsequent numeric boxing is valid. The
test will preserve the completed unique global-capture, exact spill-field,
prologue reload, successor-arm, and three-element-consumer checks. It will
remove only the whole-resume conversion ban and instead require that the
canonical local flows directly to the next array operand without a numeric
conversion before the distinct sent local is read. Thus no valid sent-value
boxing elsewhere in that state can satisfy or fail the canonical-carrier proof.

This is a static-only follow-up: no source semantics, fixture contracts, WAT
positive evidence, or **27-case** denominator will change, and no second
compiler/Vitest replay is authorized until a new lane is explicitly released.

Scoped static handoff after this correction: targeted Prettier passed for all
five owned paths; error-level Biome lint passed for the four TypeScript files;
both staged and unstaged owned-path whitespace checks passed; and the focused
manifest remains 11 direct controls, 16 refusal rows, and three inner-only
`(value as number)` controls. At that checkpoint, the corrected focused test
was 769 lines; the
three codegen paths remain net +716 lines within the recorded budget. The
previous direct-Node replay remains the only runtime result (**26/27**, with
its exact WAT retained above); this static correction intentionally did not
compile, rerun Vitest, invoke TypeScript/Test262/hooks, stage, commit, merge,
push, or open a PR.

### Independent proof review FAIL: ordered reads were not operand flow

The prior static-only correction was still insufficient. It proved that the
canonical and sent `local.get`s occur before the unique rebuilt
`array.new_fixed … 3`, but it did not prove that no intervening stack effect
consumes or replaces the canonical operand. Its conversion check examined only
the already-trivial text between two adjacent reads, so it could not establish
the full first-array-operand flow.

The revised, test-only plan is to parse the bounded instruction sequence from
the unique canonical successor-state read through that state's unique
three-element `array.new_fixed`. It will require, by explicit stack provenance,
exact operands in source order: **canonical capture**, a sent-value expression
sourced only from the distinct sent local (its numeric box operations are
allowed), and `ref.null extern`. Every top-level instruction in that bounded
segment must be known and must preserve the canonical value until the array
constructor; unknown, drop, store, branch, or early array operations fail the
proof. The balanced inline sent-box expression must have no external/capture
source and may read only the sent local or locals derived from it. The existing
unique-function, spill, reload, state-arm, and consumer checks remain intact.

No compiler or runtime lane is authorized for this revised proof. After the
minimal test edit, run only scoped Prettier, Biome lint, whitespace/diff, and
manifest inventory checks; retain the recorded **26/27** replay as the sole
runtime artifact until a new lane is released.

### Static handoff: bounded canonical operand-flow proof

The test now parses only the segment in the recovered successor-state arm from
the unique same-field canonical reload consumer through that arm's unique
`array.new_fixed … 3`. Its explicit stack provenance requires the constructor
to consume, in order, the canonical capture, a sent-derived externref
expression, and `ref.null extern`. Unknown top-level instructions fail; a
numeric transform, `local.tee`, branch condition, early constructor, or any
other consuming operation fails if applied to the canonical origin. The nested
sent box is bounded as one balanced expression, admits only the current
numeric-box instruction vocabulary, rejects external/capture sources plus
branches, returns, drops, and aggregate operations, and proves every scratch
write/read derives from the exact successor sent-field reload. The older
adjacent-read check remains a named diagnostic only; it is no longer the
operand-flow evidence.

Scoped static gates passed after this repair: direct Prettier checked the
tracker plus all four owned TypeScript paths; error-level direct Biome lint
checked those four TypeScript paths; both staged and unstaged
`git diff --check` checks passed. The inventory is unchanged at **11** direct
positive/host controls plus **16** named refusal rows (**27** total), including
the three inner-only `(value as number)` nullish-union refusals. The focused
test is now 983 lines. No compiler, Vitest, TypeScript, Test262, hook, staging,
commit, merge, push, or PR command ran for this revision; the prior **26/27**
single-fork replay remains the sole runtime artifact until a lane is released.

### Independent proof review FAIL: folded sent-box result was not proven

The bounded outer operand proof is sound, but its nested sent-box verifier was
not. It inspected only the first apparent opcode on each source line and
treated a folded `if` as sent-derived once either arm mentioned a sent local.
An adversarial one-line folded `select` can therefore discard a sent scratch
value and return a constant `ref.i31` carrier while satisfying the shallow
scan. That makes the second array operand's *result* provenance unproven.

The bounded test-only repair replaces that scan with a balanced recursive WAT
instruction parser and evaluator for the one inline sent-box expression. It
will consume every token at every depth, require both `if` arms to return an
externref box derived from sent data, and model only the exact numeric-box
operations seen in the retained WAT artifact. `select`, calls, globals,
aggregate access/mutation, branches, drops, reference constructors other than
the explicitly modeled sent `ref.i31` and sent-number carrier, and all
unmodeled opcodes will fail closed. A pure adversarial helper assertion will
live inside the existing canonical-undefined control, preserving the **11 + 16
= 27** denominator.

No compiler or runtime lane is authorized. After this tracker/test-only
repair, run direct Prettier, Biome, whitespace/diff, and manifest inventory
checks only; retain **26/27** as the sole runtime evidence pending a released
lane.

### Static handoff: recursive sent-box provenance proof

The shallow line scan is removed. The new helper tokenizes every parenthesis,
immediate, and flat opcode in the balanced inline box, recursively parses
`if`/`then`/`else`/`block` structure, and consumes the full token
stream. Each branch must leave exactly one sent-derived `externref`; nested
conditions, local scratch values, numeric transforms, `ref.i31`, and
`extern.convert_any` are stack-provenanced. The one artifact-required
`struct.new <numeric-type>` fallback is allowed only when it consumes sent
data and immediately feeds `extern.convert_any`; every other aggregate or
reference construction is rejected. The embedded pure regression rejects both
the one-line folded `select` form and the folded constant-`ref.i31` form
that the previous first-op-per-line check could accept.

Direct Prettier passed for the tracker and focused test; error-level direct
Biome lint passed for the focused test; staged and unstaged
`git diff --check` checks passed. The manifest remains **11** direct controls,
**16** named refusal rows, and **3** inner-only `(value as number)` rows
(**27** total); the focused test is now 1262 lines. No compiler, Vitest,
TypeScript, Test262, hook, staging, commit, merge, push, or PR command ran for
this repair. The recorded **26/27** single-fork replay remains the sole runtime
artifact until a lane is released.

### Independent proof review BLOCK: taint is not payload equivalence

Two bounded defects remain in the recursive sent-box proof. First, its generic
binary rule marks an operation sent-derived whenever either input is sent. That
incorrectly admits a value-collapsing path such as
`sent → trunc → const 0 → i32.and → ref.i31`, whose final carrier is
always zero despite a sent dependency. Second, the current
`struct.new <any-safe-index>` exception is not tied to the numeric
wrapper actually declared by this module; an unrelated struct followed by
`extern.convert_any` can satisfy it.

The revised test-only plan is to replace taint propagation with a symbolic
whitelist for the exact retained number-box expression: every final
`ref.i31` or float-wrapper input must structurally evaluate to the
original sent value or to the exact checked integer conversion of it. It will
admit only the identity/range/integrality decision tree required by the
artifact and reject masks, selects, constants, and any operation that can
change the boxed payload. It will resolve the sole numeric wrapper type from
the same full WAT module, bind the allowed `struct.new` to that type
definition and its numeric field shape, and reject every unrelated wrapper.
Embedded helper assertions for the zero-mask and unrelated-struct attacks will
remain inside the canonical positive, preserving **11 + 16 = 27** controls.

No compiler or runtime lane is authorized. Implement only tracker/test changes,
then run direct Prettier, Biome, whitespace/diff, and inventory checks; retain
the recorded **26/27** replay as the only runtime evidence pending independent
re-review.

### Static handoff: exact native number-box payload and carrier proof

The generic sent-taint evaluator is replaced by a balanced recursive symbolic
interpreter for the bounded native `__box_number` decision tree. It keeps the
original f64, saturated i32 conversion, signed-31 round-trip, integrality,
range, nonzero, and negative-zero predicates distinct. `ref.i31` accepts only
the exact saturated conversion; the f64 fallback accepts only the untouched
sent f64. Therefore `sent → trunc → const 0 → i32.and → ref.i31` is rejected
as a payload-changing mask rather than accepted merely because it depends on
sent. The parser still rejects every unmodelled nested opcode, including
folded `select`, calls, aggregates, branches, drops/stores, globals, and
reference constructors outside the two canonical carriers.

The permitted `struct.new` index is resolved from the same full WAT module's
unique `$__box_number` body, whose direct fallback must immediately convert to
externref. The module must also contain exactly the native immutable
`$__box_number_struct { value: f64 }` definition. A helper assertion rejects a
real separately declared `struct.new` index even when it directly converts to
externref. The canonical positive embeds that unrelated-wrapper control plus
the zero-mask, constant-`ref.i31`, and folded-`select` controls, so it does not
alter the manifest: **11** direct Vitest controls plus **16** `it.each`
refusal rows remain **27** total.

Static-only validation passed: direct Prettier `--check` for this tracker and
the focused test; error-level direct Biome lint for the focused test; and both
staged and unstaged `git diff --check` checks. The focused test is now **1,406
lines**. No compiler, Vitest, TypeScript, Test262, hook, staging, commit,
merge, push, or PR command ran for this revision. The retained one-fork
runtime artifact is still **26 passed, 1 failed (27 total)** from before this
test-proof repair; a fresh replay requires a released lane and independent
review first.

### Independent proof review BLOCK: named wrapper was not index-bound

The previous carrier proof independently found a named
`$__box_number_struct { value: f64 }` definition and the numeric
`struct.new N` used by `$__box_number`, but did not establish that the named
definition occupied index `N`. A module with an unrelated f64 struct at index
0 and the named number wrapper at index 1 could therefore pass while
`__box_number` allocated the unrelated type.

The bounded test-only repair will balanced-scan every emitted top-level type
definition in numeric order, resolve the unique named
`$__box_number_struct` definition to its exact index, require the unique
`$__box_number` `struct.new` to name that index, and then validate the same
resolved definition as an immutable one-field f64 struct. An embedded inverted
module fixture will prove that the old name/index split is rejected. The
existing **11 + 16 = 27** manifest, source semantics, and retained **26/27**
runtime artifact remain unchanged. Only direct Prettier, Biome lint, diff, and
inventory checks are authorized after this repair.

### Static handoff: exact named wrapper type-table binding

The WAT proof now reads the emitter's leading type table as balanced module
expressions, including direct definitions nested in a `rec` group. It records
every emitted definition in order, recognizes the emitter's `$typeN` numeric
anchors (and Binaryen-style `$N` anchors), and resolves
`$__box_number_struct` only when the immediately surrounding anchors prove a
contiguous numeric span. This fails closed if an omitted inlineable type could
make source order differ from the Wasm type index.

`$__box_number` must now contain exactly one `struct.new`, and that numeric
operand must equal the resolved named-wrapper index before the same resolved
definition is checked as the immutable `{ value: f64 }` carrier and as the
direct `local.get 0 → struct.new → extern.convert_any` fallback. The embedded
positive fixture puts an unrelated f64 struct at type 0 and the named wrapper
at type 1, with `$type0`/`$type2` anchors; the inverted fixture keeps that
table but makes `$__box_number` allocate type 0 and is required to throw. This
closes the prior independent name/index split false positive without changing
compiler source or the **11 + 16 = 27** manifest.

Static-only validation passed: direct Prettier `--check` for this tracker and
the focused test; error-level direct Biome lint for the focused test; and both
staged and unstaged `git diff --check` checks. The inventory remains **11**
direct controls, **16** `it.each` refusal rows, and **3** inner-only
`(value as number)` nullish-union controls (**27** total). The focused test is
now **1,519 lines**. No compiler, Vitest, TypeScript, Test262, hook, staging,
commit, merge, push, or PR command ran; the retained single-fork runtime
artifact remains **26 passed, 1 failed (27 total)** from before these
test-proof repairs. A fresh replay still requires a released lane and
independent review.

### Independent re-review BLOCK: unrelated-carrier fixture used the wrapper

The new type-index fixtures correctly resolve the named wrapper as type 1, but
the separate adversarial consumer still emitted `struct.new 1`. That is the
valid named wrapper, so the asserted rejection did not exercise an unrelated
carrier. The bounded correction changes only that adversarial consumer to
`struct.new 0`, the separately declared f64 struct; it leaves the parser,
native boxer fixtures, source semantics, and **11 + 16 = 27** manifest intact.

Only targeted Prettier, Biome lint, whitespace/diff, and inventory checks are
authorized after this test-fixture correction. The retained **26/27** runtime
artifact remains stale pending a released replay lane.

### Static handoff: unrelated carrier fixture correction

The adversarial array operand now constructs type 0 while the resolved native
number-wrapper type remains 1, so it is a genuine separately declared carrier
and the existing direct-conversion/type-index rejection is non-vacuous again.
No parser, compiler, positive control, refusal row, or runtime expectation
changed.

Direct Prettier `--check`, error-level direct Biome lint, and staged plus
unstaged `git diff --check` all passed. The inventory remains **11** direct
controls, **16** refusal rows, and **3** inner-only nullish-union controls
(**27** total); the focused test remains **1,519 lines**. No Vitest, compiler,
TypeScript, Test262, hook, staging, commit, merge, push, or PR command ran.

### Final independent PASS and released focused replay plan

Independent re-review accepted the bounded type-table binding and corrected
unrelated-carrier fixture: the named wrapper is index-bound, the adversarial
carrier is genuinely type 0 rather than the valid type-1 wrapper, and the
existing canonical capture/number-box proof remains non-vacuous. The final
released validation is one—and only one—direct bundled-Node Vitest invocation
of `tests/issue-680-generator-expression-continuations.test.ts`, using a
single fork with file parallelism disabled. The expected result is **27/27**.
No retry is authorized on failure; record exact output, exit status, and
duration below, with no source/test change during the replay.

### Final focused replay result — PASS

Executed exactly once (single fork, no file parallelism):

```text
PATH=/private/tmp:/private/tmp/codex-pnpm10/node_modules/.bin:/Users/thomas/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:/Users/thomas/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback:/Users/thomas/Code/js2/node_modules/.bin:/opt/homebrew/opt/llvm@18/bin:$PATH node node_modules/vitest/dist/cli.js run tests/issue-680-generator-expression-continuations.test.ts --pool=forks --poolOptions.forks.singleFork=true --no-file-parallelism --reporter=dot
```

Exit status: **0**. Tool wall duration: **21.764636334s**. Vitest reported:

```text
 RUN  v3.2.4 /Users/thomas/Code/js2/.codex-worktrees/final-680-expr-continuations-d60-20260831

···························

 Test Files  1 passed (1)
      Tests  27 passed (27)
   Start at  23:13:27
   Duration  21.55s (transform 6.25s, setup 0ms, collect 8.52s, tests 12.82s, environment 0ms, prepare 38ms)
```

The expected **27/27** result passed. This was the sole released runtime replay;
no retry was needed or run. No source/test edit, TypeScript, Test262, hook,
staging, commit, merge, push, or PR command ran after the replay plan.

### Normal commit-hook BLOCK: oracle-ratchet

The normal commit hook ran after the final **27/27** replay but stopped at the
oracle-ratchet gate; no commit was created. Its reported delta is exactly
`src/codegen/generators-native.ts`: `getTypeAtLocation +2` and `ctx.checker
+2` (the two new queries are around lines 1330–1331). This is a boundary-policy
failure, not a replay regression.

The bounded repair will replace only those two direct checker queries with the
existing `ctx.oracle` facade or already-recorded oracle facts, preserving the
canonical-unshadowed-`undefined` and outer/inner nullish-union admission
semantics exactly. Do not add an oracle-ratchet allow unless inspection proves
the facade cannot express the required facts. Run only targeted Prettier,
Biome, diff, and `pnpm run check:oracle-ratchet`; no compiler, Vitest, hook,
staging, commit, merge, push, or PR operation is authorized.

### Static handoff: oracle-fact continuation admission

The two new raw calls are replaced by `ctx.oracle.typeFactOf` for the original
expression and its transparent-wrapper-unwrapped node. The oracle expresses
the prior gate exactly: direct `undefined`/`void` facts reject; union facts
carry `nullable`/`undefinable` flags (and recursively checked parts), so any
union containing `null`/`undefined`/`void` rejects; direct `null` remains
ordinary. The pre-existing ambient-binding proof for a direct unshadowed
`undefined` is unchanged, so only that original spelling takes the canonical
standalone/native-string externref route and default gc/host still declines to
its existing fallback.

The bounded fact-to-spill adapter preserves primitive carriers without leaking
a checker type: number → f64, boolean/symbol → branded i32, native string when
available (otherwise externref), and target-correct bigint. Complex, unknown,
and non-nullish-union facts use the existing lossless externref spill boundary;
no native type registry is queried or mutated during admission. The raw
boolean literal branch remains after the nullish gate and is unchanged. No
runtime controls changed.

Targeted direct Prettier and error-level Biome lint passed; staged and unstaged
`git diff --check` passed. `pnpm run check:oracle-ratchet` exited **0** with:

```text
[oracle-ratchet] OK — no net checker-usage growth across 3 changed src/codegen file(s) (getTypeAtLocation +0, ctx.checker +0; base: merge-base(upstream-remote(origin-is-a-fork))).
```

No compiler, Vitest, TypeScript, Test262, hook, staging, commit, merge, push,
or PR command ran after the hook failure. The prior exact single-fork **27/27**
replay remains the runtime evidence; this repair is ready for independent
semantic review before another runtime lane is used.

### Commit retry interrupted before repository gates

The first normal commit retry created no commit and did not reach lint,
budgets, focused tests, or the oracle ratchet. `npx lint-staged` resolved a
generated dependency shim back through the now-removed temporary harness
bisect checkout and Node reported `MODULE_NOT_FOUND` for the otherwise present
lockfile-pinned `lint-staged` package.

The bounded retry uses an untracked, worktree-local `npx` launcher that invokes
that exact installed `lint-staged@16.4.0` entry point and delegates every other
command to the existing `pnpm exec`. No hook is disabled or skipped. The
launcher will be removed after the normal commit gate, and the full hook chain
must still pass before this checkpoint can be integrated.

That launcher allowed `lint-staged` to start, but its child `prettier` command
then hit the same stale generated shim path. Lint-staged restored the index and
removed its temporary backup; again, no commit or semantic gate ran. With all
compiler lanes idle, a root `CI=true pnpm install --frozen-lockfile` rebuilt
only generated `node_modules` content from 819 cached packages. The regenerated
shims resolve `lint-staged 16.4.0` and `prettier 3.8.1` from the repository;
`package.json` and `pnpm-lock.yaml` remain unchanged. The temporary launcher is
removed, so the next retry uses the repository's normal hook environment.

### Integrated checkpoint handoff

The normal implementation commit is
`2e43d9d93916ea958c33db8dc2ad791558a32dec` (`fix(generators): lower
suspended expression continuations ✓`). Its unskipped commit hook passed
Prettier, error-level Biome, the three exact LOC grants, the three exact
function-budget grants, all **27 / 27** focused controls in one Vitest fork,
and the oracle ratchet at `getTypeAtLocation +0`, `ctx.checker +0`.

Fresh `git fetch upstream main` resolved loopdive/js2 main to
`a4d141321daf7f8874e540d7b75f58f8c3e2c2a7`, eleven commits ahead of the d60
reconstruction base. The upstream delta has no direct overlap with the five
owned #680 paths; its changed LOC baseline was retained. The attributed normal
merge commit is `1c9b69faf1` (`merge(upstream): sync #680 with main ✓`). That
merge hook independently repeated the exact gates and passed all **27 / 27**
controls (20.15 s total, 11.15 s test time) plus the zero-growth oracle ratchet.

Publication remains pending final exact-head pre-push validation and explicit
authorization to push this completed branch to the public `ttraenkler/js2`
fork for a non-draft PR against `loopdive/js2:main`. No push or GitHub mutation
has occurred.

The first integrated pre-push pass ran against clean handoff head
`bcd2a159c3769f33e91c51092a21e9a19e2ce98b` with the exact synthetic new-branch
ref update for `fork`. An initial standalone `pnpm run
sync:conformance:check` attempted an unnecessary worktree dependency verify and
stopped before the script; no file changed. The equivalent direct pinned Node
entry then confirmed all five conformance anchors unchanged, and the pre-push
environment disabled only that redundant dependency reinstall—not any gate.

The unskipped hook passed TS7 typecheck plus lint, repository-wide Prettier,
the zero-growth oracle and coercion ratchets, numeric-local IR parity **18 /
18**, conformance synchronization with no generated commit, and both committed
and working-tree issue integrity. This final evidence note must now pass the
normal commit hook and the resulting documentation-only head must repeat the
same pre-push gate before publication.

### Publication-scope repair plan: generated mirror formatting drift

The checked-out final handoff is
`ac787c9645c8a023f1ee36492beccaa028d771ee`. A prior synthetic pre-push ref
record incorrectly used a nonexistent expanded SHA; the hook itself ran against
this cwd HEAD. Future synthetic refs must use the exact value returned by
`git rev-parse HEAD`, without expansion or substitution.

The PR-range comparison against upstream/main
`a4d141321daf7f8874e540d7b75f58f8c3e2c2a7` also carries formatting-only
drift in four generated mirrors that are outside this slice:

- `public/benchmarks/results/test262-report.json`
- `public/benchmarks/results/test262-standalone-report.json`
- `website/public/benchmarks/results/test262-report.json`
- `website/public/benchmarks/results/test262-standalone-report.json`

1. Restore those four files byte-for-byte to the upstream/main blobs using
   patch-only edits; do not regenerate a benchmark or alter the #680 source,
   test, or acceptance evidence.
2. While the normal unskipped commit hook runs, keep a worktree-only
   `.prettierignore` entry for precisely those four mirrors so lint-staged does
   not recreate formatting drift. Stage only the tracker and restored mirrors;
   remove the temporary ignore entries immediately after the commit, without
   staging them.
3. Prove `.prettierignore` again equals upstream/main, the worktree is clean,
   and `upstream/main...HEAD` contains exactly the five #680 paths and no
   benchmark or labs artifacts. Record that proof in a final tracker-only
   commit, using the normal hook again.
4. Run the full pre-push hook once with the final actual HEAD in the synthetic
   new-branch ref and `PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false`. Report that
   final hook externally rather than creating another tracker commit. No GitHub
   issue or GitHub mutation is created by this repair.

### Approved EOF-byte exception: pre-mutation proof

`apply_patch` reconstructs Add/Update files with a terminating LF, while each
upstream generated mirror below ends in byte `0x7d` (`}`). The branch worktree
version of each ends in `0x0a`; consequently the normal patch-only formatting
reversion cannot make the blobs byte-identical. The coordination lead has
authorized one mechanical exception solely for this already-proven final-byte
difference:

- `public/benchmarks/results/test262-report.json`
- `public/benchmarks/results/test262-standalone-report.json`
- `website/public/benchmarks/results/test262-report.json`
- `website/public/benchmarks/results/test262-standalone-report.json`

After patch-only restoration of textual formatting, each path is read-only
validated independently for its exact path, byte size, upstream terminal
`0x7d`, and working terminal `0x0a`. Only then may a literal
`truncate -s -1 <exact-path>` remove that one final LF—no variable, glob,
substitution, checkout, restore, copy, Perl, Python, or broader rewrite. Each
result is then SHA-256 compared byte-for-byte with
`git show upstream/main:<path>` before any staging. This exception is not a
source or benchmark regeneration and creates no GitHub issue.

Read-only preflight after textual restoration recorded the one-byte-only
relationship before any truncation:

- `public/benchmarks/results/test262-report.json`: upstream `27509` bytes /
  worktree `27510` bytes; `0x7d` / `0x0a` terminal bytes.
- `public/benchmarks/results/test262-standalone-report.json`: upstream
  `109257` bytes / worktree `109258` bytes; `0x7d` / `0x0a` terminal bytes.
- `website/public/benchmarks/results/test262-report.json`: upstream `27509`
  bytes / worktree `27510` bytes; `0x7d` / `0x0a` terminal bytes.
- `website/public/benchmarks/results/test262-standalone-report.json`: upstream
  `109257` bytes / worktree `109258` bytes; `0x7d` / `0x0a` terminal bytes.

### Publication-scope repair proof

The normal, unskipped cleanup commit restored all four mirrors and completed its
full hook chain. Lint-staged invoked Prettier for the staged JSON set while the
temporary unstaged ignore guard was present; the post-hook SHA-256 of every
working and committed mirror matched its `upstream/main` blob exactly:

- `test262-report.json` mirrors:
  `15b50b2e0db0d0e70b3d344eac966abdf3edc07c21cfd8b74adb95972e9e1039`.
- `test262-standalone-report.json` mirrors:
  `4a8d03ef3900807921212a184e42fb602987c0560933733b180f1a7fb7e376be`.

That hook also passed the LOC/function budget gates, the zero-growth oracle
ratchet, and the one-fork focused expression-continuation suite at **27 / 27**
(18.94 s total, 9.71 s tests). The worktree-only `.prettierignore` guard was
then removed with a patch; it is byte-identical to both `upstream/main` and
HEAD, and the worktree was clean before this evidence note.

At that clean point, `git diff --name-only upstream/main...HEAD` contained
exactly these five #680 paths:

- `plan/issues/680-wasm-native-generators-state-machines.md`
- `src/codegen/context/types.ts`
- `src/codegen/expressions.ts`
- `src/codegen/generators-native.ts`
- `tests/issue-680-generator-expression-continuations.test.ts`

The range had no `benchmarks/`, `public/benchmarks/`,
`website/public/benchmarks/`, or `labs/` path. This tracker-only proof commit
must pass the normal hook; after it, one final pre-push replay is planned using
the actual `git rev-parse HEAD` in the synthetic new-branch ref with
`PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false`. Its result is reported externally
to avoid an evidence-commit loop. No GitHub issue was created.
