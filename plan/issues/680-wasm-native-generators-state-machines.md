---
id: 680
title: "Wasm-native generators (state machines) with optional JS host fallback"
status: done
completed: 2026-06-12
created: 2026-03-20
updated: 2026-06-03
priority: high
feasibility: hard
reasoning_effort: max
goal: standalone-mode
sprint: Backlog
required_by: [681, 735, 762, 1042]
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
