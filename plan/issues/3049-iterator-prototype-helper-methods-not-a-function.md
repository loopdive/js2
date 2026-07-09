---
id: 3049
title: "Iterator.prototype helper methods (map/filter/take/drop/flatMap/…): 'X is not a function' + this-plain-iterator / return-forwarding residual (~27 fails)"
status: done
completed: 2026-07-09
assignee: ttraenkler/fable-proto
sprint: current
priority: medium
horizon: l
feasibility: hard
reasoning_effort: max
model: fable
architect_spec: needs-revision
created: 2026-07-05
task_type: bugfix
area: codegen, runtime
language_feature: iterator-helpers
goal: spec-completeness
test262_category: built-ins/Iterator/prototype
related: [3023]
---

# #3049 — Iterator.prototype helper methods residual

## Source

Fresh default-lane test262 harvest of current main
(`.test262-cache/test262-current.jsonl`, 2026-07-02). Of the ~158 fails under
`built-ins/Iterator/prototype/*`, **27** fail with a codegen/dispatch signature
(`object is not a function` / `undefined is not a function` /
`Cannot read properties of null`) rather than a pure assertion — i.e. the helper
method itself isn't wired, not just a semantic edge.

This is the **Iterator Helpers** surface (Stage-4: `map`/`filter`/`take`/`drop`/
`flatMap`/`reduce`/`some`/`find`/`every`/`forEach`/`toArray`). Distinct from
**#3023** (synthesized-iterator `.next` callability + for-of/for-await abrupt
completion) — this is the built-in `%Iterator.prototype%` helper methods.

## Root-cause hypothesis

The failing subset clusters on:

- **`this-plain-iterator`** twins across every helper — calling a helper with a
  plain (non-generator) iterator receiver resolves the helper (or its inner
  `next`) to a non-function.
- **`return-is-forwarded` / `exhaustion-does-not-call-return`** — the helper's
  wrapper iterator must forward/close the underlying iterator's `return`.
- **`flattens-iterable` / `iterable-to-iterator-fallback`** (flatMap) — GetIterator
  fallback on the flattened value.

Likely a single root: the helper wrapper's `GetIteratorDirect(O)` / `next`
resolution off a plain-object iterator receiver (vs a generator) yields
undefined/non-callable. Verify whether the helpers are registered at all on
`%Iterator.prototype%` for a non-generator receiver.

## Sample failing files (27 in the codegen subset; ~158 total incl. assertions)

- `built-ins/Iterator/prototype/map/this-plain-iterator.js` (+ filter/drop/find/every twins)
- `built-ins/Iterator/prototype/drop/return-is-forwarded.js`
- `built-ins/Iterator/prototype/filter/exhaustion-does-not-call-return.js`
- `built-ins/Iterator/prototype/flatMap/flattens-iterable.js`, `iterable-to-iterator-fallback.js`
- `built-ins/Iterator/prototype/Symbol.iterator/return-val.js`

## Suggested approach

Start with one helper (`map`) + its `this-plain-iterator` case; trace how
`GetIteratorDirect` / the underlying `next` is resolved for a plain-object
iterator receiver and fix the resolution, then confirm the sibling helpers
inherit the fix. Coordinate with #3023 so the shared `.next`-callability path
isn't double-fixed.

## Acceptance criteria

- The 27 codegen-signature files (`this-plain-iterator`, `return-is-forwarded`,
  `flattens-*`) pass; helper `next`/`return` resolution works on a plain-object
  iterator.
- No regression in the generator-receiver helper paths or in #3023.

## Investigation (2026-07-05, dev-3042) — root cause pinned; handing off with findings

**Confirmed root cause: the array-iterator prototype chain does not reach the
helper-bearing `%IteratorPrototype%`.** The 27 `*/this-plain-iterator.js` files
all call `Iterator.prototype.<helper>.call(plainIter, …)`, where the runner
injects `Iterator.prototype = getPrototypeOf(getPrototypeOf([][Symbol.iterator]()))`
(test262-runner.ts:1938). So the fix is purely: **that expression must resolve
to the object carrying the helper methods.** It currently does not —
`Iterator.prototype.<helper>` is `undefined` → "object is not a function".

What I verified:

- The 11 helpers (map/filter/take/drop/flatMap/reduce/some/find/every/forEach/
  toArray) **are implemented** in `runtime.ts` and installed by
  `_installIteratorHelperPolyfills()` (called from `buildImports`) onto `Iproto`
  = the host's native `globalThis.Iterator.prototype` (Node ≥22 has it), with
  `_getIteratorPrototype()` (our `compilerIteratorProto`) `setPrototypeOf`-chained
  to it. So the helpers ARE reachable **from** `_getIteratorPrototype()`.
- **Generators** work: a generator instance chains
  `instance → GeneratorPrototype → _getIteratorPrototype()` (runtime.ts:403), so
  generator receivers resolve the helpers.
- **Array iterators do NOT.** `[][Symbol.iterator]()` lowers to the
  `env::__iterator` host import → `__call_@@iterator` (the **compiled** array
  iterator), NOT the runtime synthesized fallback. Probe:
  `getPrototypeOf(getPrototypeOf([][Symbol.iterator]())).map === undefined`, and
  its `.__proto__.map` is also undefined — i.e. the chain lands on
  `Object.prototype`, one level shy of (and never reaching) the helper proto.

Two candidate emission sites, **neither chains to `%IteratorPrototype%`**:

1. Compiled `%ArrayIteratorPrototype%` — `emitArrayIteratorPrototypeSingleton`
   (`src/codegen/array-object-proto.ts:2001`) builds it via `__new_plain_object()`
   and never sets its `[[Prototype]]` to the runtime `_getIteratorPrototype()`.
   Spec §23.1.5.2: array iterators are `ObjectCreate(%ArrayIteratorPrototype%)`
   and `%ArrayIteratorPrototype%.[[Prototype]] === %IteratorPrototype%`.
2. Runtime synthesized fallback (`runtime.ts` `__iterator`, ~line 12403) uses a
   **one-level** `Object.create(nativeIteratorPrototype)`; a two-level
   `Object.create(Object.create(_getIteratorPrototype()))` fixes the off-by-one
   there (drafted + reverted — it compiled clean but is NOT the path
   `[][Symbol.iterator]()` takes, so it didn't move the 27; keep as a follow-up).

**Suggested fix (bounded, but cross codegen/runtime boundary — take care):** wire
the compiled `%ArrayIteratorPrototype%` singleton's `[[Prototype]]` to the
runtime helper-bearing `%IteratorPrototype%` (`_getIteratorPrototype()`), so
`getPrototypeOf(getPrototypeOf(arrayIter))` === that proto. Confirm the same for
string/map/set iterators. Then the `.call(plainIter, …)` helper body runs on the
plain-object receiver via `GetIteratorDirect` (already implemented). The
`return-is-forwarded` / `exhaustion-does-not-call-return` / `flattens-iterable`
files share the same resolution root — retest after the chain fix.

**Status:** claim released; feasibility stays `medium` (bounded dev fix, just
spans codegen↔runtime prototype identity). Not started as a code change — no PR
beyond this findings note.

## Implementation Plan (arch, 2026-07-05) — SUPERSEDED

> **SUPERSEDED by "## Implementation Plan — CORRECTED (arch-3049, 2026-07-06)"
> at the end of this file.** This 2026-07-05 plan targeted a runtime
> `%ArrayIteratorPrototype%` proto-chain off-by-one (dev-3049's Layer 3). That
> off-by-one is real, but dev-3049's end-to-end trace (see "## Root cause —
> CORRECTED & VERIFIED") proved it is NOT what fails the 27 host-lane files —
> the dominant blockers are a codegen elision (Layer 1) + a module-init-timing
> constraint (Layer 2) that gate the runtime path entirely. Kept below for
> history; do NOT implement from it.

**Bumped `feasibility: hard` / `reasoning_effort: max` / `model: fable`.** dev-3042's
first read ("bounded medium") is right about the _mechanism_ but understates the
scope: the fix must make `getPrototypeOf(getPrototypeOf(arrayIter)) === the
helper-bearing %IteratorPrototype%` hold **by object identity in BOTH lanes**
(JS-host and standalone), for **four iterator kinds** (array / string / map /
set), **without** regressing the already-shipped #3013 array-iterator-proto
identity assertion or the generator-receiver path. That is a cross-lane
prototype-identity change → silently-wrong-code risk if the two lanes disagree.

### Root cause (confirmed, dev-3042)

The 27 `*/this-plain-iterator.js` files call
`Iterator.prototype.<helper>.call(plainIter, …)`, where the runner injects
`Iterator.prototype = getPrototypeOf(getPrototypeOf([][Symbol.iterator]()))`
(`tests/test262-runner.ts:1938`). The helper bodies are implemented and
installed on `_getIteratorPrototype()` (runtime.ts:346) by
`_installIteratorHelperPolyfills()` (runtime.ts:729). Generators reach that proto
(`instance → GeneratorPrototype → _getIteratorPrototype()`, runtime.ts:403).
**Array iterators do not** — `[][Symbol.iterator]()`'s 2-levels-up prototype is
`Object.prototype`, one level shy of the helper proto, so `Iterator.prototype`
resolves to a helper-less object and `<helper>` is `undefined`.

### The two lanes need DIFFERENT fixes — do BOTH and keep them identity-consistent

**Lane A — JS-host (default, the 27 harvested fails run here).**
`[][Symbol.iterator]()` lowers to the `env::__iterator` host import
(`src/runtime.ts` `__iterator`, runtime.ts:12438) which, for a compiled array
(a WasmGC vec struct), dispatches `__call_@@iterator(obj)` → a compiled
`$__IterRec` struct (`src/codegen/iterator-native.ts`, struct built via
`getOrRegisterIterRecType`, iterator-native.ts:89). That struct is opaque to V8;
`Object.getPrototypeOf` on it (via the `__getPrototypeOf` host import,
`src/codegen/expressions/calls.ts:7073`) does not chain to the helper proto.

- **Fix site:** in the `__iterator` host import (runtime.ts:12438), when the
  result comes back from `__call_@@iterator` for a vec/array (the
  `_isWasmStruct(obj)` arm, runtime.ts:12454-12461), the returned iterator must
  be presented to the host with a `[[Prototype]]` chain reaching
  `_getIteratorPrototype()`. Two viable shapes (pick one, document why):
  1. **Wrap** the returned `$__IterRec` in a host proxy / plain object whose
     `[[Prototype]]` is `Object.create(_getIteratorPrototype())` (a fresh
     `%ArrayIteratorPrototype%`-analog, cached module-wide so identity is stable
     across all array iterators) and that forwards `next`/`return`/`@@iterator`
     to the struct's dispatchers (mirror the existing vec-fallback synthesis at
     runtime.ts:12469-12486, which ALREADY does `Object.create(iterProto)` — but
     with `iterProto = _getIteratorPrototype()`, NOT
     `globalThis.Iterator.prototype`, and at ONE level below a stable
     `%ArrayIteratorPrototype%` so the runner's DOUBLE `getPrototypeOf` lands on
     the helper proto, not on `Object.prototype`). The current fallback is
     one-level (`Object.create(iterProto)`), so `getPrototypeOf(getPrototypeOf(
it))` overshoots — build `Object.create(Object.create(_getIteratorPrototype()))`
     so the 2-hop walk lands exactly on the helper proto. dev-3042 drafted+reverted
     exactly this two-level fix in the fallback; it compiled clean but did not move
     the 27 because `[][Symbol.iterator]()` takes the `__call_@@iterator` arm, NOT
     the fallback — so apply the same two-level shape to the `__call_@@iterator`
     RESULT (12454-12461), where the 27 actually flow.
  2. Alternatively special-case the `__getPrototypeOf` host import to return the
     stable `%ArrayIteratorPrototype%` singleton for an `$__IterRec` struct — but
     this splits proto identity between "what getPrototypeOf reports" and "what the
     object actually inherits", which breaks `.map` resolution on the iterator
     itself. Prefer shape (1) (real inheritance) so `arrayIter.map(...)` ALSO works,
     not just the `.call(plainIter)` form.

**Lane B — standalone/WASI.** `Object.getPrototypeOf(<array iterator>)` routes to
`emitArrayIteratorPrototypeSingleton` (`src/codegen/array-object-proto.ts:2001`,
called from `src/codegen/expressions/calls.ts:7043` under
`(ctx.standalone || ctx.wasi) && argTsType.getSymbol()?.name === "ArrayIterator"`).
That singleton is built via `__new_plain_object()` and **never sets its
`[[Prototype]]`**.

- **Fix site:** in `emitArrayIteratorPrototypeSingleton` (array-object-proto.ts:2019),
  after `call __new_plain_object` and before the `global.set`, set the new object's
  `[[Prototype]]` to the standalone helper-bearing `%IteratorPrototype%`. This
  requires a standalone `%IteratorPrototype%` that carries Wasm-native helper
  methods — check whether one exists (grep `iterator_prototype` /
  `%IteratorPrototype%` in `src/codegen/` and `src/runtime-standalone*`); if the
  helpers are host-only today, standalone helper resolution is a **separate,
  larger** slice — in that case scope Lane B to _chaining_ to whatever standalone
  `%IteratorPrototype%` object exists (even if helper-less) so the identity graph
  is correct, and file a follow-up for standalone helper bodies. Use the same
  `__set_prototype` / `Object.setPrototypeOf` runtime the class-proto singletons
  use (`emitLazyProtoGet` path); confirm `__new_plain_object` results accept a
  proto set.

### Extend to string/map/set iterators

The same 2-levels-up gap exists for `""[Symbol.iterator]()`,
`new Map()[Symbol.iterator]()`, `new Set()[Symbol.iterator]()` (test262 has
`this-plain-iterator` twins under those too, though the harvested 27 are
array-keyed). Whatever wrap/chain Lane A applies in `__iterator` is kind-agnostic
(it wraps the `__call_@@iterator` result), so it should cover all four for free —
**verify** with the string/map/set `this-plain-iterator` files, don't assume.

### Edge cases / regression guards

- **#3013 identity assertion must still hold**: `getPrototypeOf([].values()) ===
getPrototypeOf([][Symbol.iterator]())` (same singleton) AND `!==
getPrototypeOf([1,2])` (distinct from Array.prototype). The Lane-A wrap must
  cache the `%ArrayIteratorPrototype%`-analog module-wide (one object) so all
  array iterators share it by identity — do NOT `Object.create` a fresh proto per
  `[][Symbol.iterator]()` call.
- **Generator receivers unaffected**: generators already chain correctly; the
  Lane-A change only touches the array/vec `__call_@@iterator` arm, so confirm a
  `function*(){}` iterator's `.map` still resolves (regression file: any
  `Iterator/prototype/*/proto-from-ctor-realm.js` that uses a generator).
- **`return()` forwarding** (`drop/return-is-forwarded.js`,
  `filter/exhaustion-does-not-call-return.js`): once the helper resolves, its
  body's `GetIteratorDirect` + IteratorClose runs on the plain-object receiver
  (already implemented in `_installIteratorHelperPolyfills`, runtime.ts:765+). If
  a wrap is used in Lane A, the wrapper's `return` MUST forward to the underlying
  `$__IterRec`'s `return` dispatcher — else the `-does-not-call-return` files
  regress the other way.
- **flatMap `flattens-iterable` / `iterable-to-iterator-fallback`**: these drive
  `GetIteratorFlattenable` (runtime.ts:795+) on the yielded value — should fall
  out of the resolution fix; retest, do not special-case.

### Verification plan

1. Repro in `.tmp/`: compile a program doing
   `Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]())).map` and
   assert it is a function (host lane). Confirm it is `undefined` on main first.
2. Local default-lane sweep of `built-ins/Iterator/prototype/*` before/after;
   target: the 27 codegen-signature files (`this-plain-iterator`,
   `return-is-forwarded`, `flattens-*`, `exhaustion-does-not-call-return`) flip to
   pass, and the generator-receiver corpus is unchanged.
3. Sweep `built-ins/Array/prototype/Symbol.iterator`, `String.prototype/@@iterator`,
   `Map/Set` iterator suites for identity regressions (#3013 guard).
4. Full `merge_group` (cross-lane prototype identity is broad-impact — no scoped
   sweep suffices; standalone floor must stay green).

## Root cause — CORRECTED & VERIFIED (2026-07-06, dev-3049, Opus/max)

**The architect's root-cause (a runtime `%ArrayIteratorPrototype%` proto-chain
off-by-one) is REAL but is NOT what fails the 27 host-lane files.** I traced the
actual failure end-to-end with empirical probes (`.tmp/probe-3049*.mts`) and the
real test262 files via `runTest262File`. The dominant blocker is a **codegen
statement-collection elision + a module-init timing constraint** — a different
subsystem than the spec targets. Three distinct, independently-verified layers:

### Layer 1 (DOMINANT) — top-level `F.prototype = <expr>` is silently ELIDED in host/GC mode

The test262 runner injects, **at module top level**
(`tests/test262-runner.ts:1939`):

```ts
function Iterator(this: any): void {}
(Iterator as any).prototype = Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()));
```

In **host/GC mode**, the module-init statement filter in
`src/codegen/declarations.ts` (the `ts.isExpressionStatement` → `isBinaryExpression`
arm, ~L4489–4524) **drops** a top-level `F.prototype = …` whose receiver `F` is a
top-level function declaration:

- L4496 keeps `F.prototype = …` **only for `ctx.standalone`**
  (`isFnctorPrototypeAssignTarget`).
- L4518–4524 keeps `F.<staticprop> = …` for host/GC — but **explicitly excludes
  `prototype`** (`expr.left.name.text !== "prototype"`), with a comment claiming
  `F.prototype = …` is "consumed by the compile-time fnctor-prototype lift."
- **But that lift (`src/codegen/expressions/fnctor-prototype.ts`
  `tryCompileFnctorPrototypeAssign`, L189) is `if (!ctx.standalone) return
undefined` — STANDALONE-ONLY.** So in host mode nothing consumes it and the
  statement is dropped: **no `$__module_init` is emitted at all** for the fnctor-
  prototype form.

Verified: `(F).prototype = {marker:42}` at top level → **no `$__module_init`,
`test()` reads `undefined`** (`.tmp/probe-elide.mts`). The identical assignment
_inside a function body_ works. Consequence: the runner's `Iterator.prototype`
is never assigned; reads fall back to the auto-vivified helper-less `{}` (or
`null`), so `Iterator.prototype.<helper>` is `undefined`/`null` →
"object is not a function" / "Cannot read properties of null". This matches the
real failures exactly (`.tmp/probe-realtest.mts`: map/filter/drop/flatMap/…).

### Layer 2 — module-init runs DURING `WebAssembly.instantiate`, before `setExports`; `__iterator` throws

Even if Layer 1 were fixed (statement kept in `__module_init`), the RHS
`Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()))` emits an
`env::__iterator` host-import call (host lane, `calls.ts:15005` @@iterator
dispatch). `__module_init` runs via the Wasm `(start)` section **inside**
`WebAssembly.instantiate` (`src/codegen/index.ts` ~L2705), i.e. **before the
harness calls `setExports`**. At that point `callbackState.getExports()` is
`undefined`, so `__iterator`'s vec fallback (`runtime.ts` ~L12518) can't reach
`__vec_len`/`__vec_get` and **throws "… is not iterable"**. Verified: a top-level
`let x = getPrototypeOf(getPrototypeOf([][Symbol.iterator]()))` throws at
`__module_init` during instantiate (`.tmp/probe-src2.mts`). So a naive Layer-1
fix converts the 27 from "not a function" into an init-time **throw** — no better.

### Layer 3 — the runtime vec-fallback proto chain IS off-by-one (the architect's Lane A)

Independently true: the host vec fallback does a **one-level**
`Object.create(globalThis.Iterator.prototype)`, so
`getPrototypeOf(getPrototypeOf(<arrayIter>))` overshoots to `Object.prototype`
instead of the helper-bearing `%IteratorPrototype%`. A shared, identity-stable
`%ArrayIteratorPrototype%` singleton (`Object.create(_getIteratorPrototype())`)
inserted as the iterator's immediate proto fixes the _in-function_ chain
(verified: `directChain()` flips 0→1). **But this alone does NOT move the 27** —
they never reach this runtime path because of Layers 1–2. (This is why
dev-3042's drafted vec-fallback two-level fix "compiled clean but didn't move the
27" — the reason was Layers 1–2, NOT "the `__call_@@iterator` arm"; that arm's
export does not even exist for these modules — confirmed via `has
__call_@@iterator export: undefined`.)

### Why this is a STOP-AND-DOCUMENT (exceeds the spec)

A complete host-lane fix must solve all three layers, spanning:

1. `src/codegen/declarations.ts` — keep top-level `F.prototype = <expr>` in host
   `__module_init` (safe: the host lift is standalone-only, so no double-apply);
2. the **module-init-before-`setExports`** timing (Layer 2) — the hard one. Options
   (need an architect decision):
   - **(A) compile-time host resolution of `Object.getPrototypeOf(<ArrayIterator>)`**
     mirroring #3013's standalone singleton (`calls.ts:7040`), routed to a host
     import returning `_getIteratorPrototype()` — but the arg `[][Symbol.iterator]()`
     still materializes an iterator via `__iterator` when evaluated, which throws at
     init unless its evaluation is elided (a side-effect compromise);
   - **(B) a deferred/lazy vec iterator** — `__iterator` returns an iterator whose
     `.next()` fetches `getExports()` lazily so module-init survives with exports
     unbound (broad `__iterator` semantics change: moves a genuine GetIterator
     "not iterable" throw to first IteratorStep — §7.4.2 observable, negative-test
     risk);
   - **(C) run `__module_init` lazily on first export entry** (the #1789 WASI
     mechanism) for host mode so `setExports` precedes it — the cleanest but
     broadest change.
3. `src/runtime.ts` — the Layer-3 two-level `%ArrayIteratorPrototype%` singleton.

All three are broad-impact (host-mode iterator prototypes + module-init) and the
Layer-2 choice is an architecture decision, not a bounded dev fix. Per the
"stop-and-document if it exceeds the spec" mandate this is handed back for an
**architect re-spec** with Layers 1–3 above as the concrete agenda. Probes that
prove each layer are in `.tmp/probe-3049*.mts` (gitignored). No code shipped —
the drafted Layer-3 runtime change was reverted to keep the branch a clean
documentation handoff (mirrors dev-3042's #2718).

**Note the standalone lane (#3013) is separate and already correct** — `#3013`'s
`emitArrayIteratorPrototypeSingleton` + compile-time `getPrototypeOf` resolution
sidesteps Layers 1–2 entirely (no host import, no module-init throw). Extending
standalone helper _bodies_ onto that singleton (architect Lane B) remains a valid,
independent follow-up, but the harvested 27 are **host-lane** and gated on
Layers 1–2.

## Implementation Plan — CORRECTED (arch-3049, 2026-07-06)

> **RECOMMENDATION: PROCEED — but SURFACE TO USER FIRST.** dev-3049's three-layer
> trace is correct and independently re-verified below against current `main`.
> Layers 1 and 3 are bounded, low-risk fixes. Layer 2 is the crux and it is a
> **module-init-timing** decision that reshapes when top-level code runs in the
> host lane. The good news: the mechanism to fix Layer 2 **already exists,
> already shipped, and is already tested** — the `deferTopLevelInit` option
> (#2796). So this is not "invent new init machinery"; it is "decide how widely
> to turn on a switch that already works." Because that switch changes init
> ordering for host-mode modules, the lead should confirm the **scope choice**
> (§ "Two staging choices") with the user before dispatch. `architect_spec: done`
> — the plan below is complete and dev-ready once the scope is chosen.

### Verification of dev-3049's three layers against current main (arch re-check)

All four cited sites confirmed on `origin/main` @ 52937f5:

- **Layer 1 CONFIRMED.** `src/codegen/declarations.ts` top-level assignment
  filter: the `F.prototype = …` keep is `if (ctx.standalone &&
isFnctorPrototypeAssignTarget(ctx, expr.left))` (standalone-only), and the
  #2671 host/GC static-write keep **explicitly excludes** `prototype`
  (`expr.left.name.text !== "prototype"`) with the comment "consumed by the
  compile-time fnctor-prototype lift." That lift —
  `tryCompileFnctorPrototypeAssign` in
  `src/codegen/expressions/fnctor-prototype.ts` — opens with
  `if (!ctx.standalone) return undefined;`. So in host/GC mode **nothing**
  keeps or consumes a top-level `F.prototype = <expr>`: the statement is
  dropped, and if it is the only top-level code, **no `$__module_init` is
  emitted at all**. Exactly as dev-3049 reported.
- **Layer 2 CONFIRMED + a key nuance.** `__module_init` reaches the Wasm
  `(start)` section via `declarations.ts` `ctx.mod.startFuncIdx = initFuncIdx`
  — but **only** when `!ctx.wasi && !exportModuleInit`, where
  `exportModuleInit = ctx.deferTopLevelInit && !ctx.wasi`. The `__iterator`
  host import (`src/runtime.ts` ~L12491) reads
  `callbackState?.getExports()` at L12498/12508/12516; pre-`setExports` those
  are `undefined`, so the vec-fallback `__vec_len`/`__vec_get` are missing and
  L12543 throws "… is not iterable". The test262 host runner
  (`tests/test262-runner.ts` ~L3792–3797) instantiates → `setExports` → calls
  `test()`, and does **not** set `deferTopLevelInit`, so the `(start)` section
  runs `__module_init` inside `WebAssembly.instantiate`, before `setExports`.
  Confirmed. **The nuance that makes this tractable:** the identical
  before-`setExports` problem was already solved for the diff-test host lane by
  **#2796's `deferTopLevelInit`** — when set (and `!wasi`) the compiler
  **exports** `__module_init` and does **not** wire the `(start)` section, and
  the host calls the exported `__module_init()` _after_ `setExports`
  (`scripts/diff-test.ts` ~L222–230). That is dev-3049's Option C, already
  built and covered by `tests/issue-2796.test.ts`.
- **Layer 3 CONFIRMED.** `src/runtime.ts` vec fallback (~L12524–12529) does a
  **one-level** `Object.create(globalThis.Iterator.prototype)`. Because the
  runner reads a **double** `getPrototypeOf`, the second hop overshoots to
  `Object.prototype` — one level past the helper-bearing proto. Also note it
  borrows `globalThis.Iterator.prototype` rather than the compiler's
  `_getIteratorPrototype()` (runtime.ts:361). Real, but gated behind Layers 1–2
  so it never runs for the 27 today.

### Option evaluation (A / B / C), against current main

**Option A — compile-time host resolution of `getPrototypeOf(<ArrayIterator>)`
(mirror #3013's standalone singleton at `calls.ts` ~L7040). REJECTED as the
primary fix.** Even if `getPrototypeOf(getPrototypeOf(x))` is folded to a host
import returning `_getIteratorPrototype()`, the **argument** `x =
[][Symbol.iterator]()` is still evaluated first and materialises an iterator
via the `__iterator` host import → throws at init (Layer 2) unless the arg's
evaluation is _elided_. Eliding a spec-observable sub-expression to dodge an
init-time throw is a fragile, special-case compromise that only covers the
exact `getPrototypeOf(getPrototypeOf([][Symbol.iterator]()))` shape and leaves
every _other_ top-level host-import expression still broken. It does not solve
the root (top-level code runs before the runtime is wired); it patches one
syntactic shape. Keep A only as a possible micro-optimisation _after_ C, never
instead of it.

**Option B — lazy/deferred vec iterator (`__iterator` returns an iterator whose
`.next()` lazily re-fetches `getExports()`). REJECTED.** (1) It moves a genuine
GetIterator "not iterable" throw (§7.4.2, thrown at `GetIterator` time) to
first `IteratorStep` — an **observable timing change** that risks flipping
negative tests that assert the throw at loop entry. (2) It is a broad semantic
change to the single most-used iteration primitive. (3) It only fixes
iterators; any _other_ top-level host-import expression (e.g. a top-level
`Object.getPrototypeOf`, `String.prototype` touch, struct introspection) still
throws at init. Narrow coverage, broad risk.

**Option C — run `__module_init` after `setExports` (the #1789/#2796
mechanism). SELECTED.** It fixes the **root**: top-level code runs against a
fully-wired runtime, which is _more_ spec-correct (ES module top-level runs at
load with all facilities present) and is exactly the model the standalone/WASI
`_start` lane and the diff-test host lane already use. It fixes the whole class
(every top-level host-import expression), not just iterators. And the machinery
(`deferTopLevelInit`) is already implemented, shipped, and tested. The only
open decision is **how widely to enable it** — see the two staging choices.

### The full fix = Layer 1 + Layer 2 (Option C) + Layer 3

Order matters: all three are required for the 27 to pass. Layers 1 and 3 are
bounded and safe; Layer 2 is the scope decision.

**Layer 1 fix — keep top-level `F.prototype = <expr>` in host `__module_init`.**

- File: `src/codegen/declarations.ts`, the top-level assignment-statement filter
  (the `ts.isBinaryExpression` arm around L4489–4524).
- Change: extend the #2671 host/GC static-write keep to **also** keep
  `F.prototype = <expr>` when `F` is a top-level function name — i.e. drop the
  `expr.left.name.text !== "prototype"` exclusion **for the host/GC lane only**,
  OR add a sibling `!ctx.standalone && isFnctorPrototypeAssignTarget(...)` keep
  mirroring the existing standalone keep. Either way the statement lands in
  `ctx.moduleInitStatements` so the ordinary property-write arm
  (`compileAssignment`) runs it at init.
- **Safety (verified):** the host fnctor-prototype _lift_
  (`tryCompileFnctorPrototypeAssign`) is `if (!ctx.standalone) return undefined`
  — it never fires in host mode, so there is **no double-apply**. The comment
  that claims the lift consumes it is stale for host mode; fix the comment too.
- Scope guard: restrict to `ts.isPropertyAccessExpression` with
  `ts.isIdentifier(expr.left.expression)` and
  `ctx.topLevelFunctionNames.has(name)` (same predicate the #2671 arm already
  uses) so only `F.prototype = …` for a _top-level function_ `F` is kept —
  `obj.prototype = …` on an arbitrary receiver is unaffected.

**Layer 2 fix — Option C via `deferTopLevelInit`.** Two staging choices (below).
No new compiler machinery; you are choosing where to flip the existing switch.

**Layer 3 fix — two-level, identity-stable `%ArrayIteratorPrototype%` in the
vec fallback.**

- File: `src/runtime.ts` `__iterator` vec fallback (~L12524–12539).
- Change: replace the one-level `Object.create(globalThis.Iterator.prototype)`
  with an iterator that inherits from a **module-wide cached**
  `%ArrayIteratorPrototype%` singleton whose own `[[Prototype]]` is the
  compiler's `_getIteratorPrototype()` (runtime.ts:361), i.e.
  `iterObj → %ArrayIteratorPrototype% → _getIteratorPrototype() → …`. Then the
  runner's **double** `getPrototypeOf(getPrototypeOf(iterObj))` lands exactly on
  `_getIteratorPrototype()` (which carries the helpers via
  `_installIteratorHelperPolyfills`). Cache the singleton in a module-level
  `let _ArrayIteratorPrototypeCache` (mirror `_GeneratorPrototypeCache` at
  runtime.ts:269) so **all** array iterators share it by identity (the #3013
  guard: `getPrototypeOf([].values()) === getPrototypeOf([][Symbol.iterator]())`
  and `!== getPrototypeOf([1,2])`).
- Prefer `_getIteratorPrototype()` over `globalThis.Iterator.prototype` as the
  helper anchor: `_getIteratorPrototype()` is the compiler-owned proto the
  generator path already chains to (runtime.ts:418 `_getGeneratorPrototype` does
  `Object.create(_getIteratorPrototype())`), so array + generator receivers
  resolve helpers via the **same** object — consistent identity.

### Two staging choices for Layer 2 (SURFACE TO USER)

Both use the already-built `deferTopLevelInit`. They differ only in blast radius.

- **C1 — SCOPED to the host test262 lane (recommended first step; low compiler
  risk).** Set `deferTopLevelInit: true` at the host-lane compile sites, and
  call the exported `__module_init()` after `setExports` at the execute sites.
  Four harness edits, **zero change to the compiler default** (production
  npm/playground consumers keep eager `(start)` init):
  1. `tests/test262-runner.ts` L3640 — add `deferTopLevelInit: true` to the
     `compile()` options (host lane only; leave the `target ? {target}` standalone
     path alone).
  2. `tests/test262-runner.ts` ~L3797 — after `setExports`, before `test()`,
     inside the **existing** try: `const mi = (instance.exports as any).__module_init;
if (typeof mi === "function") mi();`. (The single try/catch at L3787 already
     wraps instantiate + setExports + `test()`, so a top-level throw simply moves
     from the instantiate line to this call — same catch, same negative-test
     bucketing. This is why C1's negative-test blast radius is small.)
  3. `scripts/compiler-fork-worker.mjs` L62 — mirror the `deferTopLevelInit: true`
     compile option so the **sharded baseline** (the committed JSONL) is compiled
     the same way as the in-process runner (the #1251 "keep both paths aligned"
     rule; a mismatch would make the validator disagree with the sharded run).
  4. `tests/test262-shared.ts` ~L668–669 — after the `setExports` call, invoke
     the exported `__module_init()` the same way as (2).
  - **Trade-off to name for the user:** C1 makes the _conformance corpus_ run
    with deferred init while a _production_ host consumer still gets eager
    `(start)` init. For the 27 specifically this is defensible — the failing
    `Iterator.prototype = getPrototypeOf(getPrototypeOf([][Symbol.iterator]()))`
    is a **runner-injected harness prelude**, not user code, and #2796 already
    established deferred-init as the "fully-wired" host model. But it does mean a
    real user who writes top-level code touching a host import still hits the
    init-time throw until C2 lands. C1 is honest as "align the harness with the
    standalone/diff-test init model," not as "fix production."
  - **Risk that must be validated:** C1 flips init timing for the **entire** host
    test262 corpus, not just the 27. Expected net-positive/neutral (deferred is
    strictly more-wired), but it MUST go through full `merge_group` (broad-impact,
    no scoped sweep) to catch any test that depended on the pre-`setExports`
    timing — especially runtime-negative tests whose throw currently lands during
    `instantiate`.

- **C2 — DEFAULT for the host/GC lane (the principled fix; foundational, needs
  explicit user sign-off).** Make host-mode init defer by default so production
  consumers get the same fully-wired top-level init. Two implementation shapes:
  - **C2a (self-contained, preferred):** extend `applyModuleInitGuard`
    (`src/codegen/index.ts` L2765, currently gated `if (ctx.wasi)` inside
    `addWasiStartExport`) to the host/GC lane: add the `__init_done` idempotency
    guard to `__module_init` and prepend `call __module_init` to every exported
    function, and **stop** wiring the `(start)` section for host mode. Then the
    first export the host calls self-initialises **after** `setExports` — **no
    host cooperation required** (unlike `deferTopLevelInit`, which needs the host
    to call `__module_init`). This is the WASI model, generalised.
  - **C2b:** make `deferTopLevelInit` default-true for host mode and update every
    in-repo host consumer (`src/runtime-instantiate.ts` L96–98, playground, both
    test262 paths) to call `__module_init()` after `setExports`. More edit sites;
    an out-of-repo npm consumer that forgets the call gets top-level code that
    never runs (a silent regression) — so C2a is safer.
  - **C2 blast radius — what depends on eager `(start)` init today (enumerate
    before choosing):**
    1. **Top-level side-effects with no export ever called** (e.g. a snippet that
       is only top-level `console.log`). Under `(start)` they fire at instantiate;
       under C2a they fire on first-export-entry and **never** if no export is
       called. Check the playground "Run" path — if it always invokes an entry
       export, fine; if it relies on instantiate-time side effects, it needs a
       `__module_init()` call.
    2. **Runtime-negative tests expecting an instantiate-time throw** — the throw
       moves to first-export-entry. In-repo runners keep it in one try/catch, but
       any consumer that distinguishes "instantiate threw" from "call threw" sees
       the reclassification.
    3. **`#2800 __in_module_init` flag** (`finalizeInModuleInitFlag`,
       index.ts:2724). It wraps `__module_init`'s body with flag=1/flag=0 and the
       comment explicitly notes "gc/host has no idempotency guard (the `(start)`
       section runs the body exactly once)." C2a **adds** an idempotency guard
       prologue to `__module_init`. Verify the compose order: the guard's early
       `return` (when already-init) must sit **outside** the flag set/reset so a
       second entry doesn't leave the flag stuck at 1. Simplest: apply the
       `applyModuleInitGuard` prologue **before** `finalizeInModuleInitFlag`
       wraps, or make the flag reset run on the guard's early-return path too.
       This is the one genuinely new interaction C2 introduces — call it out in
       the C2 PR.
    4. Module-global reads: all go through exports, which now self-init first, so
       reads still see initialised globals. No change.
  - C2 is its own tracked issue (file via `claim-issue.mjs --allocate`), gated on
    a green C1 + user sign-off. Do **not** fold C2 into the #3049 PR.

### Recommended sequencing

1. **PR 1 (this issue, #3049):** Layer 1 (declarations.ts) + Layer 3
   (runtime.ts) + **C1** (four host-lane harness edits). Lands the 27 (+ the
   string/map/set `this-plain-iterator` twins, which share the vec-fallback
   chain — verify, don't assume). Validate via full `merge_group`.
2. **PR 2 (follow-up issue, needs user sign-off):** **C2a** — make deferred
   host init the default so production consumers get the same fix. Carries the
   #2800-flag-compose check and the playground/no-export edge case.

### Edge cases / regression guards

- **#3013 identity** must still hold after Layer 3: cache the
  `%ArrayIteratorPrototype%` singleton module-wide (one object); do **not**
  `Object.create` a fresh proto per `[][Symbol.iterator]()` call.
- **Generator receivers unaffected:** Layer 3 only touches the array/vec
  fallback; generators already chain `instance → %GeneratorPrototype% →
_getIteratorPrototype()` (runtime.ts:418/517). Confirm a `function*(){}`
  iterator's `.map` still resolves.
- **`return()` forwarding** (`drop/return-is-forwarded.js`,
  `filter/exhaustion-does-not-call-return.js`): once the helper resolves, its
  body's `GetIteratorDirect` + IteratorClose runs on the plain-object receiver
  (already implemented in `_installIteratorHelperPolyfills`). No wrapper is
  introduced by C1/Layer-3 (the fallback returns a real inheriting object, not a
  proxy), so `return` forwarding is unchanged — retest, don't special-case.
- **flatMap `flattens-iterable` / `iterable-to-iterator-fallback`**: driven by
  `GetIteratorFlattenable`; should fall out of the resolution fix — retest.
- **Negative / instantiate-throw tests:** the primary C1 risk. Sweep
  runtime-negative results in the full `merge_group` diff; a top-level throw
  that previously landed at `instantiate` now lands at the `__module_init()`
  call — verify the runner still buckets it as the expected negative.

### Validation plan

1. `.tmp/` host-lane repro: compile
   `Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]())).map`
   with `deferTopLevelInit: true`, instantiate, `setExports`, call
   `__module_init()`, then assert `.map` is a function. Confirm it is
   `undefined`/throws on main first.
2. Local default-lane sweep of `built-ins/Iterator/prototype/*`: the 27
   codegen-signature files flip to pass; generator-receiver corpus unchanged.
3. Sweep `built-ins/Array/prototype/Symbol.iterator`,
   `String.prototype/@@iterator`, `Map`/`Set` iterator suites for #3013 identity
   regressions and the string/map/set `this-plain-iterator` twins.
4. **Full `merge_group`** — C1 reshapes host init timing corpus-wide; broad-impact,
   no scoped sweep suffices. Standalone floor must stay green (Lane B untouched).

## Yield measurement + execution-layer wall (2026-07-09, fable-3022)

**Measured EARLY per the mirage-history caution — the prototype-chain fix yields
only 1/24, blocked by a distinct execution-layer wall. Do NOT re-attempt as a
prototype-chain fix alone.**

### The dev-3042 prototype-chain root cause is real but insufficient

The host `[][Symbol.iterator]()` (verified: routes through the `env::__iterator`
host import → the vec-synthesis branch, runtime.ts ~13239) builds the array
iterator as a **one-level** `Object.create(globalThis.Iterator.prototype)`. The
spec chain is two-level (`arrayIter → %ArrayIteratorPrototype% →
%IteratorPrototype%`, §23.1.5.2), and the runner reads the helper proto via
`getPrototypeOf(getPrototypeOf([][Symbol.iterator]()))` (test262-runner.ts:2001).
One level too shallow ⇒ that walk lands on `getPrototypeOf(Iproto)` =
`Object.prototype` (no helpers).

I drafted the two-level fix (a shared `_getArrayIteratorPrototype()` middle layer
chained to the helper-bearing proto). **Verified in isolation it works**:
`getPrototypeOf(getPrototypeOf([1,2,3][Symbol.iterator]())).map` becomes a
function. But the full-runner yield on the 24 codegen-signature target files was
**1/24** (`Symbol.iterator/return-val.js` only; likely already passing).

### The dominant blocker — module-global function-`prototype` assignment does not

### round-trip inherited members across a function boundary

Isolated the wall (probes in `.tmp`, reproduced with a plain user function too,
so it is NOT `Iterator`-name-specific):

```
function G(){}                                              // module top level
(G as any).prototype = getPrototypeOf(getPrototypeOf([][Symbol.iterator]()));
export function test(): number {
  var back = (G as any).prototype;   // back is a non-null object …
  return typeof back.map;            // … but back.map is UNDEFINED (returns 2)
}
```

- Assign + read **inside the same function** ⇒ round-trips (back.map is a
  function; `back === src`).
- Assign at **module top level**, read **in a different function** ⇒ `back` is
  non-null but every INHERITED member (`.map`, from `back`'s own prototype
  chain) reads `undefined`.

So the runner's harness shim itself (`function Iterator(){}; Iterator.prototype =
<helperProto>` at preamble top level, read inside the compiled `test()`) loses
the helper proto's chain. This is a compiled \*\*function-`prototype`-field storage

- externref-object member-read** issue (the stored JS object's prototype chain is
  not consulted on a cross-function `.member` read — smells like an
  externref→anyref→externref boxing / struct-field round-trip that drops the JS
  identity, #679 territory), **not\*\* the Iterator-helper surface.

### Recommendation

- The prototype-chain fix is correct and spec-aligned but yields ~+0 alone and
  carries regression risk on the hot array-iterator path (for-of / spread /
  destructuring all go through `__iterator`), so it is **not** worth shipping in
  isolation. Reverted.
- The real gate is the **module-global function-`prototype` assignment /
  cross-function inherited-member read** wall. File/route THAT as the blocker
  (execution-layer, externref-prototype-storage), then the chain fix + it
  together unlock the cluster. Until then #3049 stays blocked on the execution
  layer — matches the prior +1-not-27 handback.

`status: ready` kept (not claiming further); the chain-fix draft is documented
above for whoever resumes after the assignment-wall lands.

## Implementation (2026-07-09, fable-proto) — SHIPPED

**The "externref-prototype-storage wall" dissolved under verify-first probes:
storage round-trips fine** (`F.prototype = src` in a function body preserves
identity — `p === src` — and own-member reads cross-function; probes E/G).
fable-3022's wall was Layer-1 ELISION wearing a storage costume: the top-level
assignment never ran, so `F.prototype` reads fell back to the auto-vivified
#1712 sidecar object (non-null but empty) — exactly "back non-null but
back.map undefined". What ACTUALLY gated the cluster was a five-part stack,
each pinned empirically before fixing:

1. **Layer 1 — top-level `F.prototype = <expr>` elision (host/GC)**
   (`src/codegen/declarations.ts`): the #2671 static-write keep explicitly
   excluded `prototype`, claiming the fnctor-prototype lift consumes it — but
   `tryCompileFnctorPrototypeAssign` is standalone-only, so host mode dropped
   the statement entirely. Fixed: the keep now also covers `F.prototype = …`,
   with the receiver unwrapped through parens/`as`-casts (the runner shim is
   `(Iterator as any).prototype = …`). No double-apply is possible (verified
   the lift's `!ctx.standalone` gate); standalone byte-identical.
2. **Layer 2 — module-init-before-`setExports` (arch Option C1, as spec'd)**:
   the shim RHS calls the `__iterator` host import, which needs
   `getExports()` — under the wasm `(start)` section it threw "is not
   iterable" DURING instantiate. Fixed via the existing #2796
   `deferTopLevelInit` in the host test262 lanes only (compiler default
   unchanged): `scripts/compiler-fork-worker.mjs` (+ incremental-compiler
   defaults), `scripts/wasm-exec-worker.mjs` (calls exported
   `__module_init()` after `setExports`, preserving runtime-negative
   classification and reclassifying top-level throws honestly as runtime
   fails instead of malformed-wasm compile_errors),
   `tests/test262-runner.ts`, `scripts/test262-worker.mjs` (gated `!target`),
   `tests/test262-shared.ts` fixture path. Standalone/wasi/linear lanes
   untouched (`_start` model).
3. **Layer 3 — one-level vec-fallback proto chain** (`src/runtime.ts`
   `__iterator`): iterators minted for compiled vecs were
   `Object.create(Iterator.prototype)` — ONE level — so the shim's two-hop
   `getPrototypeOf(getPrototypeOf(arrayIter))` overshot to
   `Object.prototype`. Fixed with a module-wide cached
   `%ArrayIteratorPrototype%` middle proto (`_getArrayIteratorPrototype()`,
   §23.1.5.2) anchored at `_getIteratorPrototype()` (same anchor as the
   generator path). Note: the host-lane `getPrototypeOf([].values()) ===
getPrototypeOf([][Symbol.iterator]())` identity was ALREADY false on main
   (#3013 is standalone-only), so this can't regress it.
4. **Bridge-exit marshaling** (`src/runtime.ts` `_marshalBridgeResult`): once
   the helper resolved, native Iterator helpers consumed COMPILED iterators —
   and every closure-bridge (`_wrapWasmClosure`, `_wrapWasmClosureUnknownArity`,
   `_wrapForHost` field closureBridge, `callback_maker` /
   `getter_callback_maker`) returned raw WasmGC structs the host cannot read:
   a compiled `next()`'s `{done, value}` read as `r.done` → undefined → the
   helper chain NEVER terminated; a getter-returned closure (`get next()`)
   arrived non-callable ("object is not a function" — the dominant cluster
   signature). Struct results now marshal at the bridge exit: data/vec →
   identity-stable `_wrapForHost` proxy; closure → host-callable dynamic
   bridge (recursive by construction). Re-entry identity holds via the
   existing `_hostProxyReverse` / `_hostEqComparableValue` unwrap discipline.
5. **Captured-mutable writeback timing** (`src/codegen/closures.ts` +
   `src/codegen/statements.ts`): `.call/.apply/.bind` function args are
   invoke-through registrars with unknown (typically LAZY) invocation — the
   one-shot writeback snapshotted the pre-invocation ref cell, so
   `++mapperCalls` counts stayed stale. They now register persistent
   writebacks (#1695 mechanism), and for-of statements re-sync
   `persistentCallbackWritebacks` at loop exit (lazy helpers invoke the
   callback during for-of stepping, which is emitted by statement codegen,
   not compileCallExpression).

**Measured cluster delta (in-process runner, host lane): 1/21 → 13/21** —
ALL 11 `*/this-plain-iterator.js` twins now pass, plus
`flatMap/flattens-iterable.js` and `Symbol.iterator/return-val.js`. Tests in
`tests/issue-3049.test.ts` (6 green).

**Residuals split out (verify-first, distinct roots — do NOT reopen here):**

- **#3123** — the remaining ~8 (`exhaustion-does-not-call-return`,
  `return-is-forwarded`, `iterable-to-iterator-fallback`) all use
  `class TestIterator extends Iterator` over the runtime-assigned shim
  prototype; the class-extends machinery doesn't observe the live
  `F.prototype`. Different subsystem (class hierarchy wiring).
- **#3124** — the true substrate residue of fable-3022's probes: inherited
  member reads through host chains built OVER compiled structs
  (`Object.create(<struct>)`) resolve undefined (struct opacity mid-chain in
  `__extern_get`'s native walk). Not the #3049 gate (the shim's proto object
  is host-native), but real.

Local regression validation: 27 targeted test files (closures/callbacks/
iterators/prototypes/module-init: #1320/#1367/#1382/#1695/#1712/#2015/#2128/
#2664/#2671/#2794/#2796/#3013/#3046/#2939/#2743/#2836/#2841/#907 + iterators/
generators/prototype-chain/spread-rest suites) — zero deltas vs clean main
(the 21 failures observed are identical on main; Node-25 container
environment, pre-existing). Full validation: PR-level test262 diff +
merge_group (broad-impact: host init timing corpus-wide + bridge marshaling).
