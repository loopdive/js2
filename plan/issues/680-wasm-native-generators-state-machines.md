---
id: 680
title: "Wasm-native generators (state machines) with optional JS host fallback"
status: ready
created: 2026-03-20
updated: 2026-07-24
priority: high
feasibility: hard
reasoning_effort: max
goal: standalone-mode
sprint: current
required_by: [681, 735, 762, 1042]
loc-budget-allow:
  - src/codegen/index.ts
  - src/ir/from-ast.ts
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
