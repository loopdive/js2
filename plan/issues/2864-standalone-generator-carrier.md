---
id: 2864
title: "Standalone: no Wasm-native generator carrier — sync generators leak __create_generator/__gen_* host imports"
status: in-progress
assignee: ttraenkler/sendev-genframe
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
