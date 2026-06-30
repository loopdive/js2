---
id: 2864
title: "Standalone: no Wasm-native generator carrier — sync generators leak __create_generator/__gen_* host imports"
status: in-progress
assignee: ttraenkler/sr-frame
created: 2026-06-30
updated: 2026-06-30
priority: high
feasibility: hard
task_type: feature
area: codegen
goal: standalone
sprint: current
horizon: xl
related: [2860, 680, 2865]
umbrella: 2860
architect_spec: candidate
---

# Standalone: Wasm-native generator carrier (sync)

## Problem

Sync generators (`function*`, generator methods, `yield`/`yield*`) work in
js-host via host imports but have **no general standalone carrier**. Only
"sequential numeric yields" are lowered natively (#680); anything else leaks
`__create_generator` / `__gen_create_buffer` / `__gen_next` / `__gen_yield_star`
/ `__gen_result_value` / `__gen_set_return` / `__gen_push_ref` / `__gen_push_f64`,
which under standalone either fail instantiation or hit the #680 refusal
(`src/codegen/function-body.ts:1020`).

### Impact (measured 2026-06-30) — ~697 standalone-only failures

Leaked imports across the gap: `__gen_create_buffer` 1,648, `__gen_next` 1,070,
`__create_generator` 748, `__gen_yield_star` 505 (these counts include the async
cases tracked in #2865). Manifests as `fail` (598) and CE (99); many proximate
errors are `illegal cast [in __obj_find() ← __extern_set]` inside the
destructuring/iterator machinery that the generator drives.

## Root cause

There is no Wasm-native coroutine/state-machine lowering for general generator
bodies in standalone. The host carrier buffers yields in a JS-side structure
(`__gen_*`). A standalone generator needs either:

1. a **resumable state-machine transform** (CPS / explicit state var + switch on
   re-entry, locals spilled to a heap frame struct), or
2. WasmGC **stack-switching** (the `stack-switching` proposal) if the target
   runtime enables it — but CLAUDE.md notes wasmtime rejects all-proposals; this
   is not portable yet.

Approach (1) is the portable path: lower a generator body to a `$GenFrame`
struct (captured locals + an i32 `state`), and a `next(frame, sentValue)`
function that `br_table`s on `state` to the resume point, runs to the next
`yield`, stores the next state, and returns `{value, done}`. `yield*` delegates
to the inner iterator's `next`.

## Implementation Plan

**Architecture-scale — tagged `architect_spec: candidate`.** Design needed
before coding. Key decisions for the architect:

- Frame representation: `struct $GenFrame (field $state (mut i32)) (field $localN (mut T))…`
  one field per live-across-yield local; reuse the ref-cell pattern for captures.
- State-machine transform location: in IR lowering (`src/ir/lower.ts`) vs the
  legacy codegen generator path (`src/codegen/function-body.ts`,
  `class-bodies.ts`, `closures.ts`). Prefer IR if generator nodes are adopted;
  else extend the #680 native path in function-body.ts:1020.
- `IteratorResult` representation: reuse the existing `{value, done}` $Object or
  a nominal struct; must satisfy the for-of / spread / destructuring consumers
  natively (overlaps #2863 `__array_from_iter_n` spread).
- `return()`/`throw()` completion (try/finally inside generators) → finally
  blocks must run on early completion; the state machine must encode finally
  regions.

Start scope: plain `function*` with value yields + `yield*` over an array /
another native generator. Defer `[Symbol.iterator]`-driven `yield*` over an
arbitrary host iterator until the iterator-protocol carrier is native.

## Test plan

Standalone fail/CE → pass:

- `test/language/expressions/yield/**`, `test/language/statements/generators/**`
- `test/built-ins/GeneratorFunction/**`, `test/built-ins/GeneratorPrototype/**`
- `test/built-ins/Iterator/prototype/{map,take,drop,flatMap}/**` (driven by gens)

Full `merge_group` + standalone high-water. This is the single largest lever
(sync 697 + async 986 = 1,683 combined with #2865). Sequence #2864 before #2865
(async generators build on this).

## F1 — heterogeneous (boxed-`any`) carrier (landed)

**Scope shipped:** object / mixed-type yields now lower to the Wasm-native
generator carrier host-free in standalone/WASI, via the dominant consumers:
`.next()` / `.next().value` (open dispatch), `for-of`, and array destructuring.
Verify-first (`function* g(){ yield {a:1}; yield 2 }` → `r1.value.a + r2.value`)
compiles with **zero host imports** and returns `3` (the yielded object survives
the frame). gc-mode unchanged; numeric / string carriers byte-for-byte unchanged.

### Why these decisions (root-cause, not symptom)

The resumable frame already existed — `src/codegen/generators-native.ts` is a
`br_table`-on-state-machine, but its `value`/`sent`/`abrupt`/spill slots were
f64-only (#1665) or a uniform native-string ref (#2171). `generatorElemValType`
returned `null` for object/mixed yields, which routed them to the eager-buffer
**host** path (`__gen_*` imports) — fatal under standalone. F1 generalises the
frame rather than building a new one.

- **Carrier = `externref`, not a bespoke tagged struct.** The `any` TS type
  already maps to `externref` (`type-mapper.ts`), and the boxing seams
  (`__box_number`, `extern.convert_any`) are **native defined funcs** under
  `target: standalone|wasi` (`addUnionImportsAsNativeFuncs`), so every JS value
  boxes to externref with NO host import. Using externref (over anyref) means a
  consumer reading `.value` / a for-of loop var as `any` needs no extra coercion
  — the carrier IS the `any` representation the rest of codegen agrees on.
- **`sent`/`abrupt` typed PER-CARRIER** (`genCarrierFieldType`): externref for
  the boxed-any carrier, f64 for numeric/string. The state struct is minted
  per-generator, so this keeps the numeric/string structs and all their call
  sites byte-identical — zero regression risk to the ~250 existing native-gen
  tests — while the any frame carries arbitrary `.next(v)`/`.return(v)` values.
- **Open dispatch (`buildNativeGeneratorDispatch`) was the load-bearing path.**
  `let it = g()` types `it` as `Generator<…>` → externref (the state struct is
  boxed), so `it.next()` routes through the open anyref dispatch, NOT the
  concrete-typed direct path. The dispatch keyed its enclosing block on the f64
  IteratorResult singleton and set one shared f64 `sent` across branches — it
  could not host a boxed-any branch (distinct result struct, externref sent). Fix
  is **gated on `hasAny`**: a module with no any-carrier generator keeps the
  exact f64-singleton dispatch (byte-identical); a module that has one switches
  the block type to `eqref` (common supertype of all result structs) and emits
  the `.next(v)` arg both as externref (any branches) and f64 (numeric branches,
  derived by one unbox so a side-effecting arg evals once). This confines all
  behavioural change to modules that actually use the new carrier.
- **Open result reader** (`tryCompileNativeGeneratorResultProperty`) now
  ref-tests EVERY distinct result struct (not just the f64 singleton): `.done`
  is uniformly i32; `.value` picks its return ValType from the **static** type of
  the `.value` property (number → f64 fast path preserved; object/any →
  externref). This is why numeric `.next().value` reads are unchanged.

### Deferred (follow-ups; all bail cleanly / are non-regressing today)

- **Typed LOCAL spills for the any carrier** — a live-across-yield local of
  object type lowers to a concrete `ref $Object`, whose exact wasm type the
  up-front state-struct layout cannot know without a body pre-pass (the "deeper
  rewrite" the architect flagged). So an any-carrier generator that needs to
  spill ANY local bails to the host path in `buildNativeGeneratorPlan`
  (consistent across the candidate gate and registration). Numeric/string spills
  (f64) are unaffected. This is the single biggest remaining widener — needs a
  two-pass spill-typing pass.
- **Spread / `Array.from` precision for the boxed-any carrier** — drains to a
  vec whose element type must match the array-literal heuristic; for an object
  generator the literal infers a concrete-struct vec ≠ the externref drain vec,
  so the conservative skip leaves an (empty, host-free, valid) array. Strictly
  better than the pre-F1 host-import instantiation failure, but semantically
  incomplete. Array destructuring (which uses the carrier vec directly) DOES work.
- **F2** (try/catch/finally across yield + `return()`/`throw()`), **F3**
  (`yield*` over arbitrary iterables) — separate PRs per the issue's slicing.

### Files

- `src/codegen/generators-native.ts` — carrier decision, per-carrier frame
  field typing, boxed-any yield/sent/abrupt emission, gated open dispatch +
  generalised open result reader.
- `src/codegen/literals.ts`, `src/codegen/statements/destructuring.ts` — vec
  drain consumers parametrised on the generator's carrier element type.
- `tests/issue-2864-standalone-generator-carrier.test.ts` — 8 standalone cases
  (zero-host-import asserted).

## F1b — typed live-across-yield LOCAL spills (landed)

**Scope shipped:** a generator that carries an OBJECT / STRING / typed-struct
local across a `yield` now compiles host-free in standalone/WASI, instead of
mis-compiling (the f64 spill field could not hold a `ref`) or bailing. The
spill field, the resume-function load local, and the state-struct construction
default are all minted at the local's **actual** ValType.

Verify-first (`function* g(){ let o={n:1}; yield 1; yield o.n }`, read via
`.next().value`): **CE-refused** on main → host-free + returns `2` after F1b
(`result.imports` empty). Also host-free: numeric/string LOCAL spills, an
object-yield carrier WITH an object local spill, and loop-carried object spills
drained via `for-of`. gc-mode unchanged (the native path is gated
`noJsHostTarget`); numeric spills stay byte-identical (f64).

### Why these decisions (root-cause, not symptom)

The F1 notes framed this as gated on the **any** carrier, but the dominant
failure is broader: a generator with **numeric** yields and an **object/string
LOCAL** (e.g. `let o={…}; yield 1; yield o.n`) is an f64-carrier generator whose
spill field was hardcoded f64 (`stateFields … {kind:"f64"}`), the resume-load
local was hardcoded f64, and the struct-init pushed `f64.const NaN` — so the
object local's `ref` value mis-stored against an f64 field → a hard wasm
validation error (`local.set expected (ref null N), found struct.get of type
f64`). The fix types all three sites per-spill.

- **Spill type resolved by `resolveSpillLocalValType` (in `variables.ts`).** The
  resume function compiles the body with a FRESH `FunctionContext` whose analysis
  caches are empty and whose locals never resolve to a module global, so the type
  its var-declaration computes reduces to the **fctx-independent** subset of the
  `compileVariableStatement` cascade — the ctx/AST externref-forcing overrides
  plus `localTypeForDeclaration`. The helper replicates exactly that subset (it
  lives next to those predicates so they stay in lockstep) and returns `null` for
  any form whose representation the up-front layout cannot match (Proxy, accessor
  / spread / growable object literals, `subarray` subview, regexp-match arrays,
  `Array<any>` vecs, …). A `null` for ANY spill keeps the WHOLE generator on the
  host path — a conservative, non-regressing bail consistent across the candidate
  gate and registration.
- **Non-null `ref` widened to `ref_null`.** `resolveWasmType` returns a non-null
  `ref` for object literals, but a wasm local is widened to nullable and a
  non-null ref struct field has no `struct.new` default. So spills carry
  `ref_null`; `struct.get` of a nullable ref is valid and traps-on-null exactly
  as the source semantics require.
- **Post-emission reconcile.** The body's var-declaration reuses the
  pre-allocated spill slot and may re-type it (e.g. narrow `ref_null` → non-null
  `ref`). After the resume body is emitted, each spill's FINAL local type is
  read back, widened to `ref_null`, and pinned onto BOTH the local slot and the
  state-struct field (+ `info.spillTypes`, which the constructor init reads). This
  runs before any `struct.new` of the state struct (the constructor calls the
  resume builder first), so the init defaults observe the reconciled types — no
  prediction-vs-emission divergence can slip through.

### Deferred (F1b — kept on the host path; correctness-preserving)

- **Boxed-any `.next(v)` RESUME bindings** (`let x = yield …` where the yields are
  object/mixed → externref carrier): the sent value is an externref whose later
  **member** reads need the any-receiver dispatch (#2151), which silently computes
  a wrong value here. So an any-carrier generator with a resume binding still
  bails to the host path (exactly as F1 did) — a CE-refusal is correct, a wrong
  answer is not. Numeric/native-string resume bindings (sent = f64 / string) ARE
  supported. Widening the boxed-any sent-value reads is an F1c follow-up that
  builds on #2151.
- **String-ELEM generators read via `.next().value as string`** remain blocked on
  a PRE-EXISTING #2171 string-carrier result-reader mismatch (result `value`
  typeIdx ≠ the produced string vec), independent of spills — reproduces with a
  zero-spill string generator. Not in F1b scope.

### Files (F1b)

- `src/codegen/statements/variables.ts` — new exported `resolveSpillLocalValType`.
- `src/codegen/generators-native.ts` — per-spill `spillTypes` in the plan + info,
  typed spill fields / resume-load locals / `struct.new` defaults
  (`defaultSpillInstr`), the any-carrier resume-binding bail, and the
  post-emission spill-type reconcile. Retired the F1 `elemIsAny && spills>0` and
  string-elem spill guards (subsumed by per-spill resolution).
- `src/codegen/context/types.ts` — `NativeGeneratorInfo.spillTypes`.
- `tests/issue-2864-standalone-generator-carrier.test.ts` — 6 F1b standalone
  cases (zero-host-import asserted).

## F2 — `gen.throw()` abrupt completion (landed)

**Scope shipped:** `gen.throw(e)` now completes a native generator host-free —
running enclosing `finally` blocks and then propagating the error to the
`.throw(e)` caller. Previously `.throw()` was effectively unimplemented: the open
dispatch (`buildNativeGeneratorDispatch`) lumped it into the `.return()` arm
(mode 1), so it silently _completed_ the generator instead of throwing and never
ran the `finally`.

Verify-first (`--target standalone`):
`function* g(){ try { yield 1; yield 2 } finally { log = 42 } }` with
`it.throw(new Error())` mid-yield → **before:** `log` stayed 0 and the error did
NOT propagate (silently wrong); **after:** `finally` runs (`log === 42`) and the
error is caught by the caller, all host-free (`result.imports` empty). Also
host-free: `throw()` on a plain-suspended / not-started / exhausted generator all
propagate the error; `return()` through try/finally is unchanged.

### Why these decisions (root-cause, not symptom)

- **A dedicated externref `error` field** (`ERROR_FIELD`, `PARAM_FIELD_OFFSET`
  4→5). The thrown value is always an Error object (externref), but the
  `sent`/`abrupt` carrier fields are f64 in a numeric generator, so the error
  needs its own slot. Added once to every state struct (inert for non-throw
  paths); `PARAM_FIELD_OFFSET`-derived spill/deleg offsets shift automatically.
- **Resume mode 2 = throw**, alongside 0 = next, 1 = return. The per-state abrupt
  block (present at EVERY yield-successor, finalizers possibly empty) now guards
  on `mode != 0`, runs the finalizers + spill-store + done-transition ONCE, then
  branches: mode 2 → `local.get error; throw $exnTag` (stack-polymorphic, so the
  generator unwinds to the caller after the finally ran); mode 1 → complete with
  the return value (unchanged). Reuses the existing wasm-EH tag
  (`ensureExnTag`) — the same one `throw`/`try` statements use — so no new
  import and host-free.
- **`.throw()` wired in BOTH dispatch paths.** The direct (concrete-`Generator`-
  typed receiver) and open (`let it = g()` → externref) paths each get a throw
  arm: SUSPENDED → write the error field, set mode 2, resume (re-throws after
  finalizers); NOT-STARTED / DONE → mark done and `throw` the error directly
  (§27.5.3.4 GeneratorResumeAbrupt). The open path is the load-bearing one (most
  `it.throw()` receivers are externref-typed).

### Deferred (F2 — kept on the host path)

- **try/CATCH across a yield** (a `catch` clause spanning a suspend point, and
  `gen.throw()` routed INTO a catch) still bails to the host path
  (`generators-native.ts` try-statement lowering: `if (stmt.catchClause) fail()`).
  This is the next slice — it needs the state machine to model catch-handler
  regions (which yield-successor states are covered by which catch) and route a
  mode-2 resume to the catch state with the error bound, rather than re-throwing.
- **yield inside a `finally`** block remains unsupported (the finally must be
  yield-free, unchanged from F1).

### Files (F2)

- `src/codegen/generators-native.ts` — `ERROR_FIELD` + `MODE_*` constants
  (`PARAM_FIELD_OFFSET` 4→5), error field in the state struct + its
  `ref.null.extern` init, mode-2 arm in the per-state abrupt block, `.throw()`
  in both `compileDirectNativeGeneratorMethod` and `buildNativeGeneratorDispatch`
  (+ externref error local threading through `tryCompileNativeGeneratorMethodCall`),
  `ensureExnTag` import.
- `tests/issue-2864-standalone-generator-carrier.test.ts` — 5 F2 standalone cases
  (zero-host-import asserted).
