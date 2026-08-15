---
id: 2864
title: "Standalone: no Wasm-native generator carrier — sync generators leak __create_generator/__gen_* host imports"
status: in-progress
assignee: claude/es6-team-generators
created: 2026-06-30
updated: 2026-08-15
priority: high
feasibility: hard
model: fable
task_type: feature
area: codegen
goal: standalone
sprint: current
horizon: xl
related: [2860, 680, 2865]
umbrella: 2860
architect_spec: candidate
loc-budget-allow:
  - src/codegen/generators-native.ts
  # (#2864 wave-2 S1) Three god-files grow, and the growth is overwhelmingly
  # the root-cause notes rather than logic — the executable change is ~30 lines
  # total across all three. Each note is load-bearing because each site had
  # ALREADY been reasoned about in writing and reached the wrong conclusion:
  #   * type-coercion.ts — the new brand-aware arm sits directly beside #3315's
  #     note explaining why the GENERIC f64 box must NOT resurrect the
  #     sentinel. Both are true; without the adjacency the next reader deletes
  #     one of them. The arm itself is 5 lines + a 16-line helper.
  #   * any-helpers.ts — `canonicalUndefinedExternInstrs` exists precisely
  #     because `undefinedExternInstrs` two functions above LOOKS like the
  #     right helper and silently is not (it is flag-gated on a default-OFF
  #     regime). Splitting it into another module would hide that.
  #   * property-access-dispatch.ts — the Phase-3 narrowing needed the #2979
  #     generator-sentinel exception that four sibling consumers already carry;
  #     the note records that closing it alone fixed zero real tests, so the
  #     next person does not re-derive that dead end.
  - src/codegen/type-coercion.ts
  - src/codegen/any-helpers.ts
  - src/codegen/property-access-dispatch.ts
func-budget-allow:
  # D4 (+10 LOC): buildNativeGeneratorPlan must now compute the REAL fallthrough
  # state instead of assuming states.length-1. That assumption only holds for a
  # straight-line body — every structural lowering (lowerFor/lowerWhile/
  # lowerDoWhile/lowerIf and #3050's lowerTryRegion) reserves its exit/join state
  # BEFORE the nested body, so a loop/if/try-TAIL body leaves the fallthrough at a
  # lower id. Deriving it correctly is inherently a few lines inside the planner;
  # extracting it would split the state-reservation invariant across two units.
  # Same rationale as the D2 loc-budget-allow grant (#2662 precedent).
  - src/codegen/generators-native.ts::buildNativeGeneratorPlan
  # (#2864 wave-2 S1) All three grow by their root-cause notes, and all three
  # notes have to live INSIDE the function because each corrects a decision
  # made a few lines away:
  #   * coerceType — the brand arm must be read together with the #3315 note
  #     immediately below it (generic f64 boxing must NOT canonicalize).
  #   * finalizeStructAndDynamicMemberGet — the Phase-3 vote's new
  #     generator-sentinel exception belongs beside the vote it modifies.
  #   * fillMemberGetDispatch — +4 lines, the canonical-undefined producer
  #     swap plus why "standalone keeps the null externref" was wrong.
  # Extracting any of them would separate the exception from the rule it
  # excepts, which is exactly how this defect survived four sibling fixes.
  - src/codegen/type-coercion.ts::coerceType
  - src/codegen/property-access-dispatch.ts::finalizeStructAndDynamicMemberGet
  - src/codegen/member-get-dispatch.ts::fillMemberGetDispatch
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

## Reconciliation note (shepherd, 2026-07-01)

Landed slices: **F1** heterogeneous boxed-any carrier (PR #2366), **F1b** typed live-across-yield local spills (PR #2372), **F2** `gen.throw()` abrupt completion (PR #2375). Issue stays `in-progress` for the remaining carrier phases.

## Carrier-completion design (fable-gencarrier, 2026-07-04) — measured status + remaining protocol

### Measured `return <value>` status (corrects the task framing)

Probed on main (standalone, host-free asserted): `return <value>` routing in
the NATIVE carrier is **already complete** — terminal `{value, done:true}`
exactly once then `{undefined, done:true}` (11111 canary), for-of/spread
exclude it (203 canary), mid-loop `return`, boxed-any `return {…}`,
string-carrier `return "z"`, and `gen.return(v)` value round-trip (numeric +
open dispatch) all pass. What was actually missing on the sync-carrier side:

1. **`const x = yield* inner()`** — the delegation COMPLETION value
   (§27.5.3.7: the yield\* expression's value is `innerRes.value` once
   `innerRes.done`) had no binding path (plan bailed → #680 CE). → **R1, this
   PR.**
2. **`yield*` over a general iterable** — #2173 (design refreshed there;
   slice-2a is NOT #2106-blocked).
3. **IR front-end (js-host lane)**: IR generators still throw-defer any
   `return <expr>` to legacy (#2035 note in `from-ast.ts lowerTail`) — blocks
   the #2951 skip-set retirement. Exact Opus-executable contract banked in
   #2951 ("gen.setReturn" section).

### R1 (this PR) — yield\* completion-value binding + carrier-mismatch gate

- **`const x = yield* inner()`**: the `yield-star` terminator gains
  `bindResultTo`. The done-arm delivers `innerRes.value` (f64 — inners are
  f64-gated) into the binding's pre-allocated local AND its spill field
  BEFORE transitioning to the successor, inside the same resume call that
  observed completion. Deliberately NOT a resume binding: resume bindings
  re-read the `sent` field on every entry, which would clobber the completion
  value with the next `.next(v)` argument. Spill typed f64 via a dedicated
  `delegationBindingNames` set (the decl-shape cascade in
  `resolveSpillLocalValType` doesn't model yield\* initializers; the
  `sent`-carrier rule types `.next(v)` bindings — both wrong here).
- **Latent invalid-wasm fix**: the #2170 delegation gate checked only the
  INNER's elem type. A **string-carrier outer** delegating to an f64 inner
  emitted a module that FAILED WASM VALIDATION at instantiation (f64 →
  concrete-ref result field; `repairStructTypeMismatches` has no repair for
  that pair — the boxed-any outer only works because fixups.ts repairs
  f64→externref to `__box_number`). R1 bails `elemIsString` outers to the
  host path → clean #680 refusal. Do NOT "fix" this by leaning further on the
  repair pass; if string-outer delegation is wanted later, emit an explicit
  elem conversion in the yield-arm.
- **Byte-inertness**: 8-program × 3-lane sha256 matrix (numeric/any/string
  gens, slice-1 delegation, any-outer delegation, spill gen, plain, host gen ×
  gc/standalone/wasi) — all identical before/after; only programs using the
  NEW shapes change.
- **Known residual (pre-existing, NOT R1)**: an inner that completes without
  an explicit `return` delivers the f64 carrier's undefined-as-NaN sentinel,
  so `x === x` diverges from Node (`false` vs `true`). This is the #2106
  value-rep undefined-observability class, same as `.next()`-with-no-arg
  resume bindings today. Do not pin it in tests.

### Remaining protocol gaps (banked slices, exact contracts)

- **D2 — delegation abrupt forwarding (iterator close through yield\*)**:
  **LANDED 2026-07-23** (see the D2 section below). `.return(v)` / `.throw(e)`
  on the OUTER while suspended in a `yield-star` state forwards to the INNER
  (§27.5.3.7 steps 7.b/7.c) so the inner's `finally` blocks run, then
  continues the outer's abrupt path. Also fixed en route: the self-suspending
  yield-star state is now DEDICATED (never state 0, empty prelude, no resume
  bindings), closing three protocol bugs — first-statement `yield*`
  suspensions misclassified as NOT-STARTED by the dispatch, prelude
  re-execution on every mid-delegation `.next()`, and resume-binding clobber
  by mid-delegation `.next(v)` values.
- **D3 — general-iterable `yield*`**: lives in #2173 (vec-cursor for numeric
  arrays — slice-2a there, NOT blocked by #2106; generic `{next()}` +
  `.return()` close as slice-2b, which SHOULD reuse D2's forwarding shape).
- **D4 — try/CATCH across yield** (F2 deferral): ~~do NOT extend the ad-hoc
  region modeling in `generators-native.ts` for this~~ — **SUPERSEDED, see the
  D4 section below.** #3050 landed `lowerTryRegion` in `generators-native.ts`
  (catch across yield + yielding finally) BEFORE this note was written, so the
  "still bails / converge at the planner" framing was already stale when D4 was
  dispatched. The remaining D4 work was a `doneState` misroute, not a missing
  capability.

### Alignment decision: sync generators vs the #2906 AsyncCfgPlan machine

**Question** (from the dispatch): should sync generators ride the #2906
multi-state CFG machine rather than a parallel mechanism?

**Answer: converge at the PLANNER, not the emitter, and only at the D4/W6
trigger — do not port the sync carrier now.** Rationale:

1. **The ABI layer is ALREADY converged.** `frame-core.ts` owns the shared
   frame ABI (`STATE`/`SENT`/`MODE`/`ABRUPT`/`ERROR`, `storeSpills`,
   `setStateInstrs`) consumed by BOTH `generators-native.ts` and
   `async-frame.ts`. The #2618 interpreter's PC-in-`$Frame` bytecode
   suspension is the same model (saved integer position + spilled locals in a
   heap frame) — all three stories are coherent today.
2. **The two machines differ ONLY in suspend/settle backends.** Generator
   `yield` returns `{value, done}` synchronously to the caller; async
   `suspend` registers a promise reaction and returns. `jump`≈`goto`,
   `branch`≈`condGoto`, `return/done`≈`settle*` are already isomorphic.
   What is DUPLICATED is the **statement-tree → state-graph planner**
   (loops/ifs/try-region lowering exists in both files, independently).
3. **Why not port now**: the sync planner+emitter is load-bearing for ~250
   native-gen tests with byte-stability discipline; a port is pure churn with
   zero functional win until a shape needs what only the CFG machine has.
   #2906's planner is also still growing its region model (3c: catch-states,
   completion replay, nested regions) — porting onto a moving substrate
   re-derives the #2367 graveyard.
4. **The convergence trigger is D4 (try/catch-across-yield) / #3032 W6
   (buffer retirement).** Both need catch-region routing + replay — exactly
   #2906 3c. When 3c has landed and proven in the async lane, add a **sync
   settle backend** to the CFG emitter (`yield` terminator → build result
   struct + return, instead of fulfil+microtask) and route NEW generator
   shapes through `planAsyncCfg`; retire `generators-native`'s ad-hoc
   structural lowering only when the CFG path's corpus is net-zero on the
   native-gen suites. **#2865 (async generators) must NOT wait for that
   retirement**: it stacks directly on #2906 3d (`settleYield` terminator +
   result-promise queue), which is the designed convergence point of the two
   frames — building async gens on `generators-native.ts` instead would be a
   third machine. Rule of thumb going forward: **new control-flow capability →
   CFG planner; carrier/value-rep capability → generators-native.**

## D2 — delegation abrupt forwarding + dedicated yield-star states (landed 2026-07-23)

**Scope shipped:** `.return(v)` / `.throw(e)` on the OUTER generator while
suspended mid-`yield*` now closes the INNER native generator first — driving
its resume once with the same abrupt mode/payloads so its `finally` blocks run
(§27.5.3.7 steps 7.b/7.c) — then continues the outer's own abrupt path
(finalizers → complete/throw). Verify-first (M3 probe, standalone, host-free
asserted): inner `try { yield 1; yield 2 } finally { log = 100 }`, outer
`yield* inner()`, `.return(7)` mid-delegation → **before:** `log` stayed 0 and
(first-statement shape) the outer completed via the NOT-STARTED dispatch arm;
**after:** `log === 100`, result `{7, done: true}` — matches Node exactly, as
do `.throw()` forwarding, inner+outer finally ordering (inner first), a
finally-thrown replacement error (return→throw completion upgrade), and the
loop-carried two-pass close.

### Why these decisions (root-cause, not symptom)

- **Dedicated self-suspend state (plan builder).** A yield-star terminator
  re-enters its OWN state on every resume (`state = THIS`), which surfaced
  three latent protocol bugs beyond the missing close: (a) a first-statement
  `yield*` suspends in **state 0**, which the `.return()`/`.throw()` dispatch
  reads as NOT-STARTED (§27.5.3.4/.3.6) — it completed/threw WITHOUT resuming,
  skipping inner AND outer finalizers; (b) the state's prelude statements
  re-ran on every mid-delegation `.next()` (side effects repeated, measured
  `calls=3` vs Node 1); (c) a preceding `const x = yield …` resume binding
  re-copied `sent` per re-entry, clobbering `x` with later `.next(v)` values
  (measured 7 vs Node 5). The `emitYield` asterisk branch now splits: if the
  current state has prelude statements, resume bindings, or IS state 0, it is
  finished with a `jump` and the yield-star terminator gets a fresh dedicated
  state. It also always carries an `abruptResume` (finalizers recomputed from
  the yield\* position's replay chain, empty outside try) so a mid-delegation
  abrupt is handled even when the yield\* was the generator's first suspend
  point. Applies to all three delegation kinds (native-gen / vec / iterable).
- **Forwarding lives in the generic per-state abrupt block** (`compileState`,
  `abruptResume` branch), gated on the state's terminator being a native-gen
  `yield-star` AND the delegation slot being non-null at runtime — so an
  abrupt at the plain-yield suspension BEFORE delegation starts (slot null)
  skips it, and non-delegating generators are **byte-identical** (verified:
  8-program × 3-lane sha256 matrix unchanged; only delegating programs differ,
  and only in standalone/wasi — the gc lane is byte-identical even for
  delegation, the native yield\* path being standalone-gated).
- **Inner drive is wrapped in wasm `try`/`catch $exn`.** A mode-2 inner
  re-throws after its finalizers (F2 wiring), and an inner `finally` that
  itself throws surfaces a NEW error; both are caught, stored into the outer's
  `ERROR` field, and upgrade the outer's mode to THROW — so the outer's own
  finalizers still run before the error reaches the caller, and a `.return()`
  whose close throws becomes a throw completion (spec). Host-mode foreign JS
  exceptions recover via the #3050 `__get_caught_exception` catch_all when the
  resume emitter acquired it.
- **Inner abrupt payload:** inners are f64-gated, so the inner's `abrupt`
  field takes the outer's `.return(v)` value when the outer carrier is f64,
  else the undefined sentinel — unobservable either way (the inner's close
  result is discarded; the outer completes with its OWN abrupt field, which is
  observably equivalent for every supported shape since a yield-free `finally`
  cannot override the return value).

### Residuals (pre-existing, NOT D2)

- Mid-delegation `.next(v)` does not forward `v` to the inner's `sent` field
  (two-way communication through a running delegation) — same class as the
  buffer-model gaps tracked under #3032; the host lane has the same behavior.
- Generic-iterable (`$__IterRec`) close (`inner.return()` protocol for
  non-generator iterators) is #2173 slice-2b's D2-shape reuse, unchanged here
  (the outer now completes correctly; the foreign iterator is simply not
  notified).
- ~~try/CATCH across yield (D4) stays on the host path — #2906 3c convergence.~~
  **Stale** — see the D4 section below; #3050 had already landed the region
  machinery natively.

### Files (D2)

- `src/codegen/generators-native.ts` — dedicated-state split + always-abrupt
  in the `emitYield` asterisk branch; delegate-close forwarding at the top of
  the `abruptResume` block in `compileState`.
- `tests/issue-2864-standalone-generator-carrier.test.ts` — 10 D2 standalone
  cases (zero-host-import asserted), covering the M3 probe, throw forwarding,
  finally ordering, pre-delegation abrupt, finally-throw upgrade, loop-carried
  close, done protocol, vec first-statement close, prelude-once, and
  resume-binding survival.

## D4 — try/catch across yield: `doneState` misroute (landed 2026-07-24)

### Verify-first: the F2/D2 deferral note was STALE

The dispatch framed D4 as "try/CATCH across a yield still bails to the host
path (`generators-native.ts` try-statement lowering: `if (stmt.catchClause)
fail()`) — converge onto the #2906 CFG planner." **That is not current main.**
#3050 (`fdc11cbd`, "try-region state machine for native generators — catch
across yield + yielding finally") landed `lowerTryRegion` in
`generators-native.ts` well before the note was written; there is no
`if (stmt.catchClause) fail()` anywhere in the file. No planner convergence was
needed, and none was done.

Measured on main (12-shape probe, `--target standalone`, host-free asserted,
each compared against Node on the same source) **9/12 already passed**:
runtime-throw-after-resume caught, `gen.throw()` routed into a catch, catch
that re-yields, try/catch/finally across a yield, `yield` inside a catch,
`yield` inside a finally, catch param read after a yield in the catch, nested
try/catch across a yield, and the boxed-any carrier through a catch.

The 3 that did not:

| shape                                      | before                                           | now                     |
| ------------------------------------------ | ------------------------------------------------ | ----------------------- |
| try/catch across yield **inside a loop**   | raw wasm exception escaped (catch skipped)       | **fixed here**          |
| `return v` inside try + yield-free finally | finally SKIPPED, silent wrong answer (15 vs 315) | spun off as **#3582**   |
| `yield*` inside a try-region               | clean #680 CE refusal (documented bail)          | unchanged, out of scope |

### Root cause (not the symptom)

`registerNativeGenerator` derived `doneState: plan.states.length - 1`. That
coincides with the final `done` state **only for a straight-line body**. Every
structural lowering — `lowerFor` / `lowerWhile` / `lowerDoWhile` / `lowerIf`
and the #3050 `lowerTryRegion` — reserves its exit/join state **before**
lowering the nested body, so a body that ENDS in one of those leaves the
fallthrough cursor at a LOWER id, and `states.length - 1` is then a **live
yield-successor state**.

Measured plans (`curId` = the state given the final `done` terminator):

| body shape                         | states | fallthrough | `states.length-1` |
| ---------------------------------- | ------ | ----------- | ----------------- |
| straight-line (control)            | 7      | 6           | 6 ✅              |
| `try { yield } catch {}` as body   | 5      | **3**       | 4 ❌ (yield succ) |
| `for … { try { yield } catch {} }` | 9      | **4**       | 8 ❌ (yield succ) |
| `if (…) { yield } else { yield }`  | 6      | **3**       | 5 ❌ (yield succ) |
| nested `for`/`for`                 | 10     | **4**       | 9 ❌ (yield succ) |

The consumer's suspension test is
`suspended = state != START && state != doneState`
(`generators-native-consumer.ts`). With the alias in place, a generator
genuinely suspended at that last-reserved yield state reported **DONE**, so
`.throw(e)` / `.return(v)` took the §27.5.3.4 _already-completed_ arm and
**never resumed** — the enclosing `catch` across the yield never ran and the
error escaped raw. The same alias also made the `done` terminator store a LIVE
state id as "completed", so a post-exhaustion `.next()` re-entered live states
(benignly idempotent for a simple loop, but it re-ran the loop's update
expression).

Why the failure looked try/catch-specific but is not: without a handler the
already-completed arm's observable behaviour _coincides_ with the correct one
(`.return(v)` → `{v, done:true}`, `.throw(e)` → throws `e`). Only when there is
a finalizer/handler to run does the misroute become visible. So the bug is
**loop/if/try-TAIL-shaped**, not try/catch-shaped, and it was latent in every
such generator since the structural lowerings were added.

### The fix

`buildNativeGeneratorPlan` now returns the real `doneState` — the fallthrough
cursor, or the dedicated empty placeholder it already minted when that state
carries trailing statements (#3050's re-run guard) — and
`registerNativeGenerator` consumes `plan.doneState`. Three lines of behaviour;
the rest is the explanation above, banked at both definition sites.

Safety argument, verified rather than asserted: a `yield` terminator always
mints a FRESH successor as the new cursor, so the state that receives the final
`done` terminator can only coincide with a suspension point when the body's
last statement is itself a `yield` — in which case the two ids were already
equal before this change and the pre-existing (spec-equivalent, handler-free)
behaviour is preserved bit-for-bit.

### Measured delta (8-shape × 3-lane matrix, host-free asserted)

| shape                                                      | before (standalone/wasi) | after        |
| ---------------------------------------------------------- | ------------------------ | ------------ |
| M1 `try { yield } catch {}` as whole body, `.throw()`      | raw wasm exception       | ✅ 511       |
| M2 `for … { try { yield } catch {} }`, `.throw()`          | raw wasm exception       | ✅ 101       |
| M3 `while … { try { yield } catch {} }`, `.throw()`        | raw wasm exception       | ✅ 101       |
| M8 nested `for`/`for` under one try, `.throw()`            | raw wasm exception       | ✅ 301       |
| M4/M5/M7 `.return()` through a finally (loop/if/loop-tail) | already correct          | ✅ unchanged |
| M6 straight-line try/catch + trailing yield (control)      | already correct          | ✅ unchanged |

**4 measured shapes flip from a raw escaping exception to spec behaviour; 4
controls unchanged.** The gc lane is untouched for every try/catch shape above
— all still route to the eager-buffer host path (`__gen_*` present), so this is
a standalone + wasi delta. A PLAIN loop-tail generator (no try) DOES route
native on gc, so gc bytes change there; observable behaviour does not (see the
handler-free coincidence above), and the byte matrix covers it.

### Files (D4)

- `src/codegen/generators-native.ts` — `NativeGeneratorPlan.doneState` (new,
  with the root-cause note), computed at the final fallthrough in
  `buildNativeGeneratorPlan`, consumed by `registerNativeGenerator`.
- `tests/issue-2864-d4-catch-across-yield.test.ts` — standalone regression
  suite (zero-host-import asserted).

### Deferred out of D4 (each has a clean, non-silent fallback today)

- **#3582** — `return v` inside a try with a yield-free finally skips the
  finally (silent wrong answer). Root cause + the recommended fix shape are
  recorded there.
- **`yield*` inside a try-region** — clean #680 CE refusal
  (`generators-native.ts`, the `unwind.some(e => e.kind !== "replay")` bail in
  `emitYield`'s asterisk branch). Needs the delegation states to observe the
  resume mode so an abrupt can route into the region.
- **`return` inside a try whose finally is STATE-LOWERED** (yielding finally) —
  clean #680 CE refusal (the `unwind.some(e => e.kind === "finally")` bail in
  the `isReturnStatement` branch). This is the return-through-a-suspending-
  finally path; #2906 3c-ii-b solved the analogous async case.

## Slice routing after D2 (what remains where)

All remaining carrier work is tracked in OTHER issues: D3 general-iterable
`yield*` close → #2173 slice-2b; D4 try/catch-across-yield → #2906 3c planner
convergence; IR-lane `gen.setReturn` → #2951; boxed-any resume bindings (F1c)
→ blocked on #2151; spread/`Array.from` precision for the boxed-any carrier —
small, unowned, listed in F1's deferred notes. This issue stays open only as
the umbrella record for those pointers.

### Composition with #3032 lazy-first-resume thunks

Disjoint lanes, one destination. The thunk model is the JS-HOST answer for
expression/nested/method generators (eager buffer made lazy at creation); the
native carrier is standalone-only (`noJsHostTarget`) and already truly lazy —
nothing runs until the first resume, `return()`/`throw()` before start never
run the body (F2), matching the thunk model's §27.5.3.2 behavior. No gating
interaction exists today (verified: R1 touches only the native path; js-host
bytes identical). The composition rules:

- **#3032 W3 route (b) (#2203 capture slots in the state struct) is the
  preferred endgame** over widening route (a) thunk-wraps: every generator
  family that becomes a native candidate exits the buffer model entirely
  (and with it the thunk hack) in standalone; W6 then widens the native
  carrier to js-host, retiring both.
- **Do not add new eager-buffer capabilities** beyond the #2951 IR
  `gen.setReturn` unblock (needed for the IR-first flip in the js-host lane
  regardless of W6 timing).
- Any future js-host widening of the native carrier must preserve #3032's
  observable contract: creation runs nothing; `next(v)` two-way communication
  (impossible under the buffer) comes free with the carrier.

## Wave-2 adoption + re-triage plan (fable, 2026-08-15, #4444 session)

Stale-lane adoption per project-lead direction (prior claim `dev-opus5-gen`
inactive since 2026-07-24; re-claimed by `claude/es6-team-generators` with
--force on origin/issue-assignments; same for #2906/`dev-laneB`).

The ES2015 standalone bucket still carries **~500 generator-attributed
non-passes** (2026-08-15 baseline, `.tmp/es6-standalone-clusters.ts`): ~313
runtime/leak failures mentioning `__gen_*`/`__create_generator` host imports
across `language/{expressions,statements}/generators`, class gen-methods,
object gen-shorthand and for-of; plus ~96 CEs "native generator lowering
currently supports only sequential numeric yields" concentrated in
`language/expressions/yield` (46) and assignment (12).

Given F1/F1b/F2/D2/D4 are landed and the residual work was routed out (see
"Slice routing after D2"), the burn-down is a **candidate-gate widening +
routed-slice execution** problem, not a new-machine problem:

1. **Triage first (mandatory)**: sample 10 representative failures per family
   on CURRENT main and classify: (a) body-shape not yet a native-carrier
   candidate (gate refusal → which check), (b) carrier candidate but wrong
   semantics, (c) routed-slice gap (#2173-2b yield*-close, #2906-3c
   try/catch-across-yield planner, #2951 IR gen.setReturn, F1c boxed-any
   resume bindings), (d) reflection/#2175. Record the counts table here.
2. **Widen the candidate gate** for the largest (a) family — the
   "sequential numeric yields" refusal message marks the legacy pre-carrier
   lowering; find why those bodies don't route to the F1 boxed-any carrier
   (expression-position generators? method generators? see #3032's
   composition note above — W3 route (b) capture slots is the preferred
   endgame).
3. **Execute the routed slices** blocking (c), smallest first; spread/
   `Array.from` precision for the boxed-any carrier is named small + unowned.
4. Class gen-methods + object gen-shorthand (~90 combined) likely share one
   creation-site gate — check `isGenerator` routing for method bodies.

Validation: `TEST262_TARGET=standalone TEST262_PATH_FILTER="language/expressions/generators|language/statements/generators|language/expressions/yield" pnpm run test:262`
+ gc control; equivalence guard; per-slice unit tests. Do NOT regress the
js-host eager-buffer lane (#3032 contract: js-host bytes identical unless
deliberately widening W6).

### Step 1 — mandatory re-triage (measured 2026-08-15, generators lane)

**Artifact**: a full scoped standalone run of the plan's own filter, executed by
this lane on worktree `agent-abc7a54c612648f57` (base = `9e17d34f3`, whose
compiler tree is identical to `a89bc2ff`'s — the latter is docs-only). Not
inherited from `.tmp/es6-standalone-clusters.ts`; the numbers below differ from
the plan's framing above and **supersede it**.

`benchmarks/results/test262-standalone-results-20260815-174617.jsonl`,
610 rows: **404 pass · 103 fail · 102 CE · 1 compile-timeout (66.2 %)**.

| directory                        | pass | non-pass |
| -------------------------------- | ---: | -------: |
| `language/expressions/generators` |  205 |       84 |
| `language/statements/generators`  |  195 |       61 |
| `language/expressions/yield`      |    4 |       59 |
| `annexB/language/expressions`     |    0 |        2 |

Family classification of the 206 non-passes (a/b/c/d per the plan's step 1):

| # | family                                                       | class | count |
| - | ------------------------------------------------------------ | ----- | ----: |
| 1 | `#680` CE refusal — plan bail ("only sequential numeric yields") | (a)   |    57 |
| 2 | other semantic fail (heterogeneous tail)                        | (b)   |    35 |
| 3 | **terminal `{value: undefined}` value-rep**                     | (b)   |    34 |
| 4 | host-import leak (candidate-gate refusal, `__gen_*`)            | (a)   |    31 |
| 5 | reflection / prototype / brand                                  | (d)   |    21 |
| 6 | iterator + destructuring drive (`Cannot destructure 'null'`)    | (c)   |    13 |
| 7 | parser: `yield` as identifier in sloppy mode                    | (a)   |    11 |
| 8 | other CE                                                        | (a)   |     3 |
| 9 | compile timeout (`yield-weak-binding.js`)                       | (a)   |     1 |

Two corrections to the plan's framing, both load-bearing for routing:

- The ~313 "runtime/leak failures mentioning `__gen_*`" is **31** here, not 313:
  most of that leak family already routes natively. The plan's counts were taken
  over the whole ES2015 bucket, this table over the plan's own validation filter.
- The largest **semantics** family is not a gate-widening problem at all —
  family 3, the terminal `{value: undefined, done: true}` read, is a
  value-REPRESENTATION defect in code the carrier already handles. It is
  invisible to the gate-widening plan because those generators compile
  host-free and *look* supported. Slice S1 below fixes it.

`language/expressions/yield` is the concentration (4/63 passing) and is
dominated by families 1 and 3.

## S1 — terminal `{value: undefined, done: true}` reads as NaN / null (landed here)

**Scope:** an exhausted or `done`-completing native generator now delivers an
observable `undefined` in `.value`, in both carriers, at every consuming
context. Before: `assert.sameValue(result.value, undefined)` — the single most
common assertion in the generator suites — reported `SameValue(«NaN»,
«undefined»)` (f64 carrier) or `SameValue(«null», «undefined»)` (boxed-any
carrier). Host-free and silent; the generator machinery itself was correct.

Verify-first, `--target standalone`, zero host imports, six-file probe over
`language/expressions/yield`: **0/6 → 4/6** (`captured-free-vars`, `from-catch`,
`formal-parameters`, `formal-parameters-after-reassignment-strict`). The two
that remain are different bugs (family 2: an `arguments`-object read, and
parameter reassignment not observed across a suspend).

**Final S1+S2 scoped run** (re-run cleanly after a tree-drift incident, see
below): on the 610 files present in both runs, **404 → 422 pass, net +18, ZERO
regressions**. One of the 18 — `expressions/generators/yield-weak-binding.js` —
was a `compile_timeout` in the base run and is the known load-flaky slow
negative-parse file (it flipped the OTHER way in an intermediate run), so the
**attributable figure is 17, with one flake in our favour**.

> **Tree-drift incident, recorded because the lesson generalises.** An earlier
> "S1+S2" run measured a tree in which S2 had been silently REVERTED: the
> file-copy A/B helper's `new` snapshot was taken during S1, before S2 existed,
> so restoring "new" after a base comparison wrote the S1-era file back over S2
> and deleted the bail with no error. CLAUDE.md's A/B guidance warns about
> capturing the BASE copy early; the mirror hazard is that the NEW copy goes
> stale as work continues. Two things caught it and one did not: `git status`
> caught it; the headline pass count did NOT, because S2 is conformance-neutral
> in standalone and so cannot move that number. Once work is committed,
> `git show HEAD:<path>` is the correct restore source and no snapshot should
> exist at all.

The S1-only measurement, for the record: on the 578 files common to that pair,
**374 → 389 pass, net +15**, 17 fixed:
`expressions/yield/{from-catch, from-try, captured-free-vars, formal-parameters,
formal-parameters-after-reassignment-strict, rhs-iter, star-array}`,
`expressions/generators/{return, no-yield, yield-as-statement, yield-newline,
yield-as-property-name, yield-star-before-newline}`,
`statements/generators/{return, yield-as-statement, yield-newline,
yield-as-property-name}`.

Two files show `compile_timeout` in the after-run
(`statements/generators/{yield-star-after-newline, yield-weak-binding}.js`) and
are **not** regressions: run in-process against the BASE tree they fail
identically, and `yield-weak-binding` was itself a timeout in the BASE run.
They are slow negative-parse tests (BASE `compile_ms` 17,584) that flip on
machine load.

**js-host / #3032 contract, proven not asserted.** 9-program × 3-lane sha256
matrix, BASE vs NEW by file-copy A/B: the **gc lane is 9/9 byte-identical**.
Only standalone + wasi move, and only for the 2 programs that actually produce
or read a generator absent value (boxed-any carrier; dynamic `.value` read).
Numeric / string / delegating / spilling / try-catch generators, a plain
function, and a NON-generator `o.value` read are byte-identical in all three
lanes — so the Phase-3 narrowing change does not touch ordinary property reads.

**Equivalence guard.** Scoped subset (31 files: generators / iterators / yield /
destructuring / spread / for-of / optional / nullish) — 3 failed / 200 passed,
all three **pre-existing**, each confirmed by re-running on the BASE tree. (The
full `tests/equivalence` suite OOMed twice on this shared 4-core box, so the
scoped subset is what was actually run.)

**Cleanup candidate, deliberately NOT taken in this batch** —
`tests/equivalence/yield-as-expression.test.ts` > "yield with value used as
expression" fails to COMPILE its test program:
`L3: Type 'undefined' is not assignable to type 'number'`. That is a correct TS
diagnostic about the test's own annotation: `Generator<T, TReturn, TNext>` with
`Generator<number, number, undefined>` types `yield 10` as `undefined`, so
`const x: number = yield 10` cannot typecheck. Node never type-checks, which is
why it "works" at runtime. Verified pre-existing by an exact pre-change-main
repro (base src + base test file → identical failure, identical message), and it
is a committed known failure in `scripts/equivalence-baseline.json`, so the
equivalence gate is green on it. Fix is a one-line annotation
(`Generator<number, number, number>`, or drop the `: number`) — out of scope
here because it is pre-existing and baselined, not because it is hard.

Two OTHER assertions in the same file were changed, and the reason belongs here
rather than in a commit message: "yield without
value used as IIFE argument" and "bare yield as function argument" asserted
`typeof result.value === "number"` on a DONE result, which pinned the
SENTINEL'S RENDERING rather than behaviour. Node returns `43` / `5` there; we
have never delivered the `.next(v)` sent value into an ARGUMENT-position yield,
so that value was always the undefined sentinel — it merely used to read back
as the number NaN and satisfy the check by accident. The assertions now pin
`result.done`, true in every model, and the real gap is named in the test. This
is the residual R1 above already says not to pin.

### Why these decisions (root cause, not symptom)

Two independent producers of "absent value", each undone by a different
consumer:

- **f64 carrier — the brand, not the box.** `UNDEF_F64_BITS` already meant
  `undefined` in the `value` slot (#2979), and the dynamic member-get dispatcher
  already resurrected it. But `tryCompileNativeGeneratorResultProperty`'s
  `valueStaticNumeric` fast path returns a bare `f64`, on the reasoning "an
  exhausted read yields NaN, which is the spec ToNumber(undefined)" — true in a
  NUMERIC context, and the harness's context is `any`. The generic
  f64→externref box then applied `__box_number`, and #3315's note says it MUST:
  an arbitrary sentinel-patterned f64 is a computed NaN (`Math.abs` preserves
  the payload) and boxing it to `undefined` regressed the JS-host `log2`
  assertions. That note also names the correct seam — "dedicated
  identity-carrying-slot boxing sites". So the fix is a structural **BRAND** on
  the carrier, `{kind:"f64", undefSentinel:true}`, exactly like #1788's
  `boolean` / #2785's `symbol` on `i32`: every `.kind === "f64"` check still
  matches (numeric codegen byte-identical), and only `coerceType(f64 →
  externref)` consults it. Generic f64 boxing is untouched.
- **boxed-any carrier — `ref.null.extern` is `null`, not `undefined`.** F1's
  note called the null externref "already the canonical undefined"; that was
  inherited from the pre-#2106 model and is no longer true. The tag-1
  `$undefined` singleton is reserved in EVERY standalone/native-strings module
  (`ensureAnyValueType`'s S1.0 reservation), independently of the default-OFF
  `undefinedSingleton` flag, and the value model already separates the two —
  measured host-free: `undefined === null` is **false**, `typeof null` is
  `"object"`, and an unpassed argument is `SameValue`-equal to `undefined`. So
  `defaultElemValueInstrs` was minting JS **null**. Confirmed directly on
  `formal-parameters.js`'s shape: `result.value === null` true, `typeof`
  `"object"`.
- **One canonical producer.** `canonicalUndefinedExternInstrs(ctx)`
  (any-helpers.ts) is the lane-correct `undefined` and is deliberately NOT gated
  on the `undefinedSingleton` flag — `undefinedExternInstrs` is, which is why
  every caller silently fell back to `ref.null.extern`. Host lane keeps
  `__get_undefined` (a null externref surfaces as JS `null` there); the lookup
  is `funcMap.get` only, so no late import is registered mid-body.

### Not the fix (checked and rejected, recorded so it is not re-tried)

The Phase-3 (#1269) consumer-side narrowing in `property-access-dispatch.ts`
lacked the #2979 generator-sentinel exception that `fillMemberGetDispatch`,
`planGeneric`, `planTypedF64` and `member-set-f64` all carry, so it unboxed the
dispatcher's canonicalized `undefined` back through `__unbox_number`. That IS a
real hole and is closed here too — but closing it alone changed nothing on the
real tests, because the harness shape never reaches that path (`objType` is the
narrowed `IteratorResult`, so the read goes through
`tryCompileNativeGeneratorResultProperty`). Fixing the visible-in-a-probe path
and declaring victory would have been the failure mode; the probe had to be
built from the ACTUAL assembled harness before the real producer showed up.

### Files (S1)

- `src/ir/types.ts` — `undefSentinel?: true` brand on the `f64` ValType.
- `src/codegen/any-helpers.ts` — `canonicalUndefinedExternInstrs`.
- `src/codegen/type-coercion.ts` — brand-aware f64→externref box.
- `src/codegen/generators-native.ts` — `defaultElemValueInstrs` /
  `emptyResult` / `emptyResultForType` take `ctx`; externref carrier default is
  the canonical `undefined`.
- `src/codegen/generators-native-consumer.ts` — brand the
  `valueStaticNumeric` read result.
- `src/codegen/property-access-dispatch.ts` — Phase-3 narrowing skips
  generator-sentinel candidates.
- `src/codegen/member-get-dispatch.ts` — the dynamic dispatcher's sentinel arm
  uses the canonical producer (this is the site that served the read in a
  module without full `$AnyValue` wiring).
- `tests/issue-2864-s1-terminal-undefined.test.ts` — 5 standalone cases
  (zero-host-import asserted), including the NEGATIVE case: a generator that
  yields a genuine `0/0` must still read as a NUMBER, so the brand cannot
  swallow #3315's computed-NaN.

### Tracked residual — `.next(v)` sent value not bound in ARGUMENT position

Surfaced by S1 and kept here deliberately so de-pinning the two
`yield-as-expression` assertions does not lose it. `function* gen(){ return
identity(yield) }` + `it.next(); it.next(5)` returns **`undefined`** where Node
returns `5`: an argument-position `yield` gets no resume binding, so the slot
keeps the undefined sentinel. Before S1 this read back as the number NaN, which
is why a `typeof … === "number"` assertion passed over it for so long — that
check could not distinguish Node's `5` from our sentinel, since both are
numbers. S1 did not change the behaviour, only stopped it from being disguised.

Same root as slice 3 below (a yield in a nested expression position is not a
suspend point the planner binds), and the same class as the R1 `.next()`-with-
no-arg residual. Fixing it is part of the nested-yield slice, not of the carrier.

## S2 — generator × `arguments`: a green compile that the ENGINE REJECTS (landed here)

**The headline is not a conformance delta — it is a JS-HOST correctness fix that
the standalone numbers cannot show.** On the gc lane,
`function* g(a,b){ const n = arguments.length; yield n }` compiled *successfully*
and produced a module WebAssembly refuses to load:
`global.set[0] expected type externref, found i32.const of type i32`. Isolated:
a NON-generator reading `arguments` is valid, and a generator NOT reading it is
valid — it is specifically generator × `arguments`. In standalone the same shape
was a raw wasm trap at the FIRST `arguments` read, i.e. before any suspend, so
it was never a suspend-crossing problem.

### Root cause

The native state struct has slots for `this`, own params and spilled locals. The
RESUME function compiles the body with a FRESH `FunctionContext`, and the
§10.2.11 arguments-vec setup in `function-body.ts` runs against the FACTORY's
context only — so `arguments` resolves to nothing in the resume body.

**The bail already existed for the two other generator forms** — generator
EXPRESSIONS (`isNativeGeneratorExpressionShape`) and generator METHODS (whose
arm names this exact reason) — and was simply never applied to free function
DECLARATIONS. #3032 W6 then routed those natively on the JS-host lane too,
which is how a standalone-only trap became an invalid module on the default lane.
One check, moved to the shared part of `isNativeGeneratorCandidate`, so all three
forms agree.

### Re-triage correction — this family is 2 tests, not ~7

The routed list below originally estimated ~7 tests from the family label. Built
NON-generator twins for each and measured; five are not generator defects:

| test(s)                                   | verdict                                                             |
| ----------------------------------------- | ------------------------------------------------------------------- |
| `arguments-object-attributes`, `formal-parameters-after-reassignment-non-strict` | **generator-specific** — this slice |
| `params-dflt-ref-arguments`               | `arguments[i]` in a param DEFAULT is broken for plain functions too — general, out of lane |
| `arguments-with-arguments-{fn,lex}` ×2 dirs | fails on `typeof <captured arguments>`; the non-generator twin also fails (differently). Reflection/`typeof` class → #2175 |

`arguments` in a param default DOES work for generators (verified against Node),
so that half of the family was never broken here.

### Measured

- JS-host: invalid module → **valid module, correct value (2)**, both before and
  after a yield. A generator NOT reading `arguments` still routes natively (no
  `__gen_*` imports) — the bail's blast radius is pinned by a test.
- standalone: the 2 in-lane tests go `fail` (trap) → `compile_error` (clean #680
  refusal). **Conformance-neutral by design**; a refusal is the correct answer
  until the frame carries `arguments`, and it replaces a trap.
- `tests/issue-2864-s2-generator-arguments.test.ts`: 5/5.

**#3032 contract exception, stated rather than glossed:** host bytes DO change
for these programs. The contract cannot apply — the bytes being replaced are an
invalid module, so there is no valid baseline to preserve.

### The real fix, banked

Making `arguments` work in the frame: the factory builds the vec at CALL time
(§10.2.11, where the spec puts it), spills it as a synthetic `arguments` spill
(the F1b typed-spill machinery already carries vec refs); the resume function
reloads it into an `arguments` local; and MAPPED aliasing
(`arguments[0] = 32` writing back to param `a`, which
`formal-parameters-after-reassignment-non-strict` needs) requires
`fctx.mappedArgsInfo` rebuilt against the frame rather than the factory locals.
Three sites in the most byte-stability-sensitive file for a 2-test payoff — worth
doing after the higher-count slices, not before.

### Next slices (routed on the measured triage, not started)

1. ~~**`arguments` inside a native generator** (~7)~~ — **S2 above**. The
   admission bail is fixed (green-compile-invalid-module on the JS-host lane);
   the frame-carrying implementation is banked, and the family re-scoped to 2.
2. **Self-name reference in a named generator EXPRESSION** (~9:
   `named-*-reassign-fn-name-in-body*`, `scope-name-var-*`). One gate check —
   `isNativeGeneratorExpressionShape`'s self-name bail — blocks all of them.
3. **Nested-yield expression positions** — measured design note below.

## S3 design note — yield POSITION admission (measured, not implemented)

The coordinator's instruction for this slice was to scope the convergence
honestly rather than force a point fix, so this is a measured trigger list plus
a design, with no code change.

### What the planner actually admits

`lowerStatements` recognises a suspend at exactly **two** syntactic positions —
`yield e;` as an ExpressionStatement, and `let x = yield e;` as a
single-declarator VariableStatement. Every other statement containing a yield
falls through to `fail()`. Probed on current main (untyped JS, standalone,
which is the test262 shape):

| shape                                | result | why |
| ------------------------------------ | ------ | ---- |
| `yield;` bare statement              | works  | the ExpressionStatement arm |
| `(yield);` parenthesised             | **CE** | the arm tests `isYieldExpression(stmt.expression)`; a `ParenthesizedExpression` is not one. A one-line unwrap. |
| `const t = yield; return t;`         | **CE** | the declaration arm is reached, but an operand-LESS yield has no resolvable carrier (`isNumericExpression(undefined)`) |
| `t = yield;` (assignment)            | **CE** | no assignment arm at all |
| `return identity(yield);`            | **CE** | yield in argument position AND `yieldValueOk` rejects a call as the return expression |

So admission is restricted on **two independent axes** — the yield's syntactic
POSITION and the accepted RETURN-expression shape — and the CE message
("only sequential numeric yields") names neither.

### Measured trigger list

Of the 57 `#680` CE refusals in the triage, **38 are `star-rhs-iter-*` /
`yield*`** and belong to #2173 slice-2b. Of the remaining 19:

- **~7 are true nested-yield**: `rhs-primitive`, `rhs-omitted`,
  `rhs-template-middle`, `rhs-regexp`, `in-rltn-expr`,
  `iter-value-{specified,unspecified}`, `yield-as-literal-property-name`.
- **8 are `dstr/*-fn-name-{gen,class}`** — a destructuring default whose
  initializer is a nested class/generator expression; a different bail.
- `from-with` (`with`), `scope-param-rest-elem-var-*` (rest params — an
  explicit gate bail).

So this slice is ~7 tests, not ~10 — and the `dstr` group should be re-triaged
separately rather than counted here.

### Two candidate designs

**(a) ANF normalisation before planning** — rewrite a statement containing a
nested yield into the shapes the planner already admits
(`return identity(yield)` → `const t = yield; return identity(t)`), then plan as
today. Attractive because it needs no new machinery, and it would also close the
tracked `.next(v)`-in-argument-position residual above.

**The constraint that makes it non-trivial, and that a naive hoist gets wrong:
evaluation ORDER.** Operands to the LEFT of the yield must be evaluated BEFORE
the suspend and operands to the right after it, so hoisting the yield requires
hoisting every earlier sub-expression into temps in source order. Verified
against Node: for `two((log += "L", 1), yield)`, `log` is already `"L"` when the
generator suspends. A rewrite that evaluates the left operand after the resume
is silently wrong in exactly the way this issue's history keeps warning about, so
this design is only safe with a real effect-ordering pass — not a pattern match
on the common cases.

**(b) Route these shapes to the #2906 CFG planner**, which models suspension as
a terminator on a control-flow graph and therefore does not care about syntactic
position. This is the convergence trigger the "Alignment decision" section above
already anticipates ("new control-flow capability → CFG planner; carrier /
value-rep capability → generators-native").

**Recommendation: (b), and this is the trigger.** Yield-position admission is a
control-flow capability, not a carrier one — it is precisely the case the
alignment rule reserves for the CFG planner. (a) would work for the simplest
files and would then need the same effect-ordering machinery the CFG path
already has to build, so it buys a handful of tests and a second place to get
ordering wrong.

**One exception worth taking independently of (a)/(b):** the
`ParenthesizedExpression` unwrap in the ExpressionStatement arm. It is a
one-line, order-neutral admission fix (`(yield)` is exactly `yield`), and it is
measured above as a real CE today. It does not commit the lane to either design.

Out of this lane on the measured evidence: `star-rhs-iter-*` (~35) → #2173
slice-2b; `prototype-*` / brand (~21) → #2175; `unscopables-with*` (4) → `with`;
sloppy-mode `yield`-as-identifier (11) → parser.
