---
id: 3214
title: "IR: first-class function values (pass a top-level function / arrow as a () => T argument)"
status: backlog
sprint: Backlog
created: 2026-07-13
updated: 2026-07-21
priority: medium
horizon: l
feasibility: hard
model: fable
reasoning_effort: high
task_type: feature
area: ir, codegen
language_feature: closures
goal: ir-full-coverage
parent: 2855
related: [2856, 1276, 1382]
loc-budget-allow:
  - src/codegen/index.ts
  - src/codegen/closures.ts
  - src/ir/lower.ts
  - src/ir/from-ast.ts
  - src/ir/nodes.ts
  - src/ir/select.ts
  - src/ir/builder.ts
  - src/codegen/expressions/calls-closures.ts
  - src/ir/integration.ts
  - src/ir/host-extern.ts
  - src/ir/analysis/linear-memory-plan.ts
  - src/ir/passes/monomorphize.ts
  - src/codegen/expressions/call-tail-dispatch.ts
  - src/codegen/async-scheduler.ts
  - src/codegen/expressions/calls.ts
  - src/runtime.ts
  - scripts/check-ir-fallbacks.ts
  - scripts/ir-fallback-baseline.json
  - tests/issue-3214-void-host-callback.test.ts
---

# #3214 — IR: first-class function values

Child of the IR front-end migration epic **#2855**. A **bounded, broadly-useful**
capability surfaced while scoping the #2856 corpus (2026-07-13, opus-2856): the
IR front end cannot yet claim a function that **passes a top-level function or an
arrow as a `() => T` value** (a first-class function reference). This is
generally useful far beyond the corpus — but note it is **NOT bucket-serving on
its own** (see Scope).

## Motivating shapes (from the benchmark-harness corpus)

```ts
// benchmarks/*.ts main — passing a named top-level fn as () => number:
addBenchCard(wrap, "fib(30)", "…", bench_fib);

// benchmarks/helpers.ts addBenchCard — an arrow-closure value + its use:
card.addEventListener("click", () => {
  const v = fn(); // fn: () => number invoked
  out.textContent = v.toString();
});
```

`main` rejects at `nontail-callstmt:CallExpression` (the `addBenchCard(…,
bench_fib)` call is not IR-claimable because a function-valued argument has no IR
lowering); `addBenchCard` rejects at `expr-unhandled:ArrowFunction`.

## Prior art (reuse, don't reinvent)

`#1276` (HOF returning closure — function-valued module exports) and `#1382`
(wasm-closure ↔ host bridge) landed the closure/function-reference ABI in the
LEGACY backend (`closures.ts`, `builtin-fn-meta.ts`, `$__fn_wrap`). This issue
is the **IR front-end** adoption of that ABI: `select.ts` accepting a function
identifier / arrow as a `() => T` value, `from-ast.ts` lowering it to the same
closure-wrap the legacy backend emits (ABI/byte parity so a mixed IR/legacy
module links), and the call site (`fn()`) lowering to the closure-call path.

## Scope — bounded capability, NOT a `body-shape-rejected` drain

Verified against the corpus gate (opus-2856, #2856 Step-2 lineage): landing this
capability **alone does not reduce `body-shape-rejected`**. The benchmark `main`s
that need it ALSO need cross-module imported calls (ES-module IR, #1046) + DOM
host-member SET + DOM event/host APIs — contagion means a `main` claims only when
ALL land together. So this issue is tracked/prioritised as a **general IR
capability** on its own merits, not as a corpus-bucket lever. Do not schedule it
expecting a gate delta.

## B0 implementation result — canonical callable ABI (2026-07-21)

B0 is implemented as an ABI foundation **before** either selector/storage
expansion (A/B below). The overall issue remains `backlog`: B0 deliberately does
not claim the motivating inline-arrow or top-level-function argument shapes.

### Root cause and design

The legacy backend already represents a callback boundary as `externref`
carrying a descendant of the canonical `__fn_wrap_*` family. The IR path instead
typed a function parameter as its private `(ref $__ir_closure_base_*)` hierarchy.
Direct all-IR tests hid that structural mismatch; a legacy closure reaching an
IR callback consumer could fail its RTT cast even though the source signatures
matched.

B0 separates the two roles:

- `IrType.closure<S>` remains compiler-owned and lowers to the canonical
  `__fn_wrap_*` root carrier. A `closure.new` still allocates S's signature
  wrapper (or a captured subtype beneath it); allocation identity is not the
  SSA/cross-module carrier.
- `IrType.callable<S>` is the source boundary carrier and lowers to `externref`,
  matching legacy exactly. B0 permits it in parameter positions only; callable
  results and storage/escape remain deferred.
- An exact `closure<S> -> callable<S>` pack reuses `coerce.to_externref` /
  `extern.convert_any`. Mismatched signatures, covariance, and the reverse
  conversion remain illegal.
- A callable invocation performs `any.convert_extern`, casts to the module-wide
  wrapper root, extracts field 0 from that root, casts the funcref to S's exact
  lifted func type, and only then emits `call_ref`. The root unpack is emitted
  twice because the lifted ABI needs root `self` as well as the field-0
  funcref; there is no root-to-signature-wrapper cast, and the wrapper object
  itself is never passed as the `call_ref` operand.
- `ClosureStructRegistry` now delegates to
  `getOrCreateFuncRefWrapperTypes()`. A no-capture IR closure constructs the
  exact wrapper. A captured IR closure is a declared subtype of that exact
  wrapper and registers exact params/result plus `hasCaptures: true` in
  `closureInfoByTypeIdx`. The parallel `__ir_closure_base_*` hierarchy is gone.
- Every shared lifted wrapper func takes canonical-root `self`. Captured bodies
  downcast root self only to recover their capture subtype. Private/named
  function-expression funcs retain concrete self, and generic dispatch derives
  param 0 from the actual func type so those arms remain type-valid.
- The canonical wrapper root is exempt from leaf finalization even in a module
  with no child wrapper. Finality participates in WasmGC canonical identity, so
  this is required for minimal separately compiled modules to agree.
- Callable keys/traversal are distinct across equality, diagnostics,
  monomorphization, linear-memory planning, and backend legality. Linear rejects
  callable call/coercion at its legality boundary, before emitter hooks run.

This avoids the three relevant prior failure classes: wrapper creation order no
longer chooses an arbitrary per-signature cast target (#2873), a module with no
wrapper child cannot finalize its ABI root into a different canonical type, and
`call_ref` always sees the extracted typed funcref rather than a wrapper struct
(#2193).

### Deliberate B0 boundary

`src/ir/select.ts` logic is unchanged, including `hasCallableParam`'s
caller-direction demotion (comments now record that it is a B0 claim-set freeze,
not an ABI mismatch). The M0 cross-file callable gate is also unchanged. B0
does not add inline arrow arguments, bare top-level function identifiers,
imported calls, host-JS functions, callback covariance, optional/rest/default or
void callbacks, `call`/`apply`/`bind`, callable storage/escape, or any
function-valued result position. The selector continues to report a
FunctionTypeNode return as `return-type-not-resolvable`.

The sequencing is intentional:

1. **B0 (this result):** canonical structural ABI, exact pack/root unpack, and
   mixed legacy/IR proof with zero selection delta.
2. **A (follow-up):** widen selection/lowering for the motivating inline-arrow
   and named top-level function arguments only after the boundary is safe.
3. **B (follow-up):** separately design storage/escape and function-valued
   result positions; do not smuggle those semantics into A.

### Measured result

- `tests/issue-3214-callable-abi.test.ts`: **11/11**. Covers the existing #2859
  result `68`, externref params in legacy and IR WAT, no-capture/captured/
  forwarded callbacks, real string callback carriers in host and native-string
  modes, optimize parity, exact-signature rejection, linear pre-emitter
  legality, dynamic `undefined` guards, permanent-root finality, private/named
  candidate validity, and no selector/result widening.
- Mixed proof: separately compiled legacy producers and genuine IR consumers run
  captured closures in both adversarial wrapper orders (producer root/consumer
  child and producer child/consumer root), returning `42`. A legacy child
  consumer also accepts the producer-root closure while an unrelated same-arity
  private/named function-expression candidate is present. Minimal no-capture
  modules pass with `optimize: false` and `optimize: true`. The reverse
  IR-caller direction remains pinned compositionally by the `closure.new` ->
  `callable pack` -> `externref direct-call arg` chain plus the legacy
  consumer's root unpack body; B0 intentionally does not widen selection enough
  to execute that cross-module caller end-to-end.
- Existing `tests/issue-2859.test.ts`: **8/8**, including the callback program
  returning `68` with zero post-claim demotions.
- Closure/funcref regression coverage (`issue-1169c`, `issue-2873`,
  `issue-2876`, and `funcref-emit-guard`): **58/58**.
- `tests/equivalence/optimize-differential.test.ts`: **4/4**; the focused B0
  suite also executes optimized/unoptimized callback output and validates both.
- `pnpm run check:ir-fallbacks`: `body-shape-rejected` **12 -> 12**,
  module-level **2 -> 2**, and **zero** post-claim demotions.
- `pnpm run typecheck`: clean.
- `pnpm run check:loc-budget`: clean with issue-scoped allowances for only the
  nine touched god-files reported by the gate; the shared baseline is unchanged.
- Fresh post-rebase byte-neutrality A/B (merged M0 `558f597866425b` versus the
  rebased B0 code tree `923dc4d7923cd7`, before this documentation-only
  measurement update) is exact for two closure-free numeric probes under both
  `{ fileName: "t.ts" }` and `{ fileName: "t.ts", nativeStrings: true }`:
  `cf169943...`, `b4bd707c...`, `8021f746...`, and `f3bc4ce3...` are unchanged.
  This is the precise invariant: mandatory canonicalization intentionally
  changes the type shape of sources that already lower internal IR closures,
  even if they do not yet expose an `IrType.callable` boundary.

## A+B1 implementation result — imported direct HOF calls (2026-07-21)

The first claim-set widening is complete for the production non-fast multi-file
host lane. It deliberately combines the two pieces needed by the benchmark entry
functions: a checker-certified imported direct call (A), and an exact bare
same-file top-level `FunctionDeclaration` value in a function-typed parameter
position (B1). The broader arrow/storage/result surface remains deferred.

### Root cause and design

M0 treated every imported call as an external selector boundary, and the IR
lowerer had no representation for a bare declaration value such as
`bench_fib`. Text-based import/name checks were insufficient: renamed/default
imports, barrel aliases, shadowing, reassignment, overloads, and the compiler's
flat function registry could otherwise select one symbol and lower another.

The implementation therefore uses one realm-wide checker resolver shared by
selection and overlay planning. It accepts only value named/default imports
whose alias chain resolves to one non-ambient function body in the exact
compiled source set. Namespace/import-equals/type-only/external/cyclic or
ambiguous aliases, overload sets, flat-name collisions, and reassigned/live
bindings are rejected before claim. Reassignment detection is symbol-exact and
covers updates, destructuring, and `for-in`/`for-of` assignment targets.

Selection admits a bare function identifier only when it is a same-file
top-level declaration at an exact, required `FunctionTypeNode` argument
position and its primitive signature exactly matches. Arrows, aliases/stored
values, callable results, optional supplied callbacks, generics, rest/spread,
and extra arguments remain on legacy. Imported calls are symbolic external
edges, not local call-graph edges; standalone/WASI retain the conservative M0
boundary.

The overlay records AST-node-keyed symbolic plans (`targetName`, signature,
defaults, argc requirement), never pre-shift numeric indices. Before lowering,
it proves each target against the final flat `funcMap`, settles any late
`__get_undefined` import shift, registers `__argc` when required, and extracts
the legacy cached function-singleton creation path. IR then emits the same
lazy `__fn_closure_<target>` / `__fn_tramp_<target>_cached` protocol and packs
the canonical wrapper as `callable<S>`. A second trampoline finalization pass
handles declarations created after legacy compilation. Host function
declarations remain ordinary/non-constructible; the standalone #3371
constructible-wrapper path is unchanged.

Missing imported arguments mirror legacy: constants are inlined, numeric
expression defaults use the exact `0x7ff00000deadc0de` signaling-NaN sentinel,
i32 uses zero plus `__argc`, and host extern/callable carriers use
`__get_undefined`. Unsupported preparation removes the owner's entire local
call component before integration, keeping the post-claim channel at zero.
Cached singleton reuse is provenance-paired: a source function occupying
`__fn_tramp_<target>_cached` cannot be mistaken for the generated trampoline,
so A+B1 preparation demotes rather than creating a mismatched cache. Legacy
value-producing sites instead use the existing per-site `emitFuncRefAsClosure`
path when the canonical pair is unavailable; this includes reassigned-function
live-binding seeds, Annex-B bindings, fnctor registration, and identifier
reads. Void-return expressions share recursive discard lowering through
parentheses, `void`, conditionals, and comma expressions in final and loop
early returns. A zero-result imported call outside those proven discarded
contexts is rejected during planning, before the legacy body can be skipped.
Fast multi-file overlays remain pre-claim disabled because legacy uses i32 for
numeric function boundaries while the current IR plans f64; full fast support
requires a mode-aware boundary plan rather than an unsafe cast.

### Measured result

- `tests/issue-3214-imported-hof.test.ts`: **20/20**. Runtime execution,
  runtime identity plus one cached singleton, renamed/default/barrel imports,
  void, constant and expression defaults, host `undefined`, argc semantics,
  optimize off/on, namespace/storage/arrow/reassigned-callback/live-target/
  spread/extra/overload negatives, synthetic-trampoline collision demotion,
  collision-safe reassigned live-binding seeding, recursively wrapped
  final/loop-early/conditional void-return effects, value-context void-call
  pre-claim rejection, standalone and fast-mode pins, and zero post-claim
  demotions.
- `tests/issue-3214-callable-abi.test.ts`: **11/11**. The B0 canonical callable
  ABI and mixed wrapper-order proofs remain green.
- `tests/issue-2138-multi-module-ir-overlay.test.ts`: **6/6**, updated to prove
  the bounded host import widening while retaining collision, global-script,
  standalone, class-member, module-init, compileFiles, and compileProject
  guards.
- The production fallback gate now compiles disk dependency graphs through
  `compileFiles`, asserts all seven benchmark entry `main` functions appear in
  `irCompiledFuncs`, and measures `body-shape-rejected` **12 -> 5**,
  module-level **2 -> 2**, with **zero** post-claim demotions.
- The five residual body rejections are exactly: benchmark helper
  `addBenchCard` (inline arrow; B2), calendar `renderCal`, `onDay`, and `main`,
  plus async `delay`. This supersedes the older statement above that #3214
  alone could not move the bucket: the prerequisite imported-call and host DOM
  capabilities now exist, so the combined A+B1 slice genuinely unlocks the
  seven benchmark entry functions.

## B2 implementation result — ambient zero-argument void callbacks (2026-07-21)

B2 closes the benchmark helper without widening general arrow arguments. The
accepted shape is a direct, discarded ambient
`receiver.addEventListener(type, () => { ... })` call in a top-level function;
the Calendar follow-up permits multiple independently certified sibling sites
when they are the owner's only runtime declarations.
The checker proves the declaration-file method/extern receiver, exactly two
arguments, a synchronous zero-parameter non-empty block arrow with void result,
no lexical `this`/`arguments`/`super`/`new.target`, no nested or non-certified
sibling runtime declarations, and symbol-exact readonly captures. User-defined same-name
methods, options arguments, parameters, concise/async/non-void arrows, mutable
or later-written captures, unsupported sibling runtime declarations, and any
non-certified callback site remain legacy-owned.

The planned arrow lowers to B0's canonical closure family with the new exact
`{ params: [], returnType: null }` signature; `null` means a zero-result Wasm
function and is threaded through type equality/keys, the closure registry,
linear planning, monomorphization, and diagnostics. The extern argument path
alone packs that closure as the canonical callable carrier and invokes the
existing `env.__make_callback` import with reserved id `-1`. The runtime sentinel
returns a cached outer JS arrow, ignores host event arguments, dispatches via
`__call_fn_0`, explicitly returns `undefined`, and is nonconstructible. Existing
non-negative legacy `__cb_N` callbacks are unchanged.

Final-context preparation is shared by single- and multi-source compilation.
It validates the actual function-import ordinal as exactly
`env.__make_callback: (i32, externref) -> externref`, rejects an occupied
`<owner>__closure_N` before integration for every planned source-order site,
and closes the affected local call component. Captured IR subtype names allocate against the module-wide struct
registry, so separate source overlays and user structs cannot reuse or
overwrite `__ir_closure_N`. Because those final proofs require the completed
legacy import/function registries, every selected local call component that
contains a planned B2 owner remains compile-twice under IR-first; a later safe
demotion can therefore never expose an unreachable skipped-body placeholder.

### Measured result

- `tests/issue-3214-void-host-callback.test.ts`: **29/29**. Runtime dispatch
  twice, sentinel identity/cache, distinct-closure identity, `undefined`,
  arity zero, `Reflect.construct` rejection, and unchanged positive-id legacy
  dispatch; optimized/unoptimized genuine IR execution; exact
  `-1`/maker/zero-result shape; two sibling sites with distinct capture/value
  types and deterministic source-order `_0`/`_1` lifting; strict pre-claim
  negatives including symbol-vs-spelling capture ambiguity (including
  destructured bindings), nested sibling declarations, and mixed
  certified/non-certified sites; wrong maker/lifted-name collision demotion;
  cross-source subtype uniqueness; IR-first skipped-slot containment; and
  standalone containment.
- The production gate genuinely IR-emits `addBenchCard` and ratchets
  `body-shape-rejected` **5 -> 4**. Module-level remains **2**, async-function
  remains **4**, and every post-claim bucket remains zero.
- Before the Calendar follow-up, the four residual body rejections were exactly
  calendar `renderCal`, `onDay`, and `main`, plus async `delay`. B2 does not
  widen Promise executors, async callbacks, general arrow storage/escape, or
  callback parameters.

The Calendar follow-up retains the same callback ABI and admits only multiple
independently certified sibling event sites. It assigns deterministic
source-order lift ordinals, validates every final lifted name, and still rejects
the whole owner for any nested or non-certified sibling declaration. Together
with the Calendar residual lowering recorded in #2856, the live source now
genuinely IR-emits all callback owners and ratchets `body-shape-rejected`
**4 → 1**; the only remaining rejection is async `delay`, with zero post-claim
demotions.

## Sequenced acceptance criteria

### B0 — complete

1. Function-typed source parameter positions resolve to `callable<S>` /
   externref while internal closure values remain `closure<S>` root refs and
   construction retains exact allocation wrappers/subtypes.
2. Exact pack plus root -> field-0 -> exact-funcref invocation works in legacy,
   IR, mixed-module, host, and native-string coverage; shared lifted funcs take
   root self while private/named funcs retain their actual concrete self.
3. The canonical root stays open through finalization, including minimal
   no-child optimized modules.
4. No private IR base hierarchy, no wrapper-to-`call_ref`, no stack/type-index
   instability, no selector/result widening, and no fallback-gate regression.

### A/B — deferred full-issue acceptance

1. `select.ts` accepts a named-function / arrow argument at a `() => T`
   parameter position (JS-host lane; standalone per the closure ABI's existing
   support), and the matching `fn()` call.
2. `from-ast.ts` lowers both to the legacy closure-wrap ABI with byte/ABI parity
   (a mixed IR-caller / legacy-callee — and vice versa — links and runs).
3. IR-vs-legacy equivalence tests (a HOF that takes a `() => number` and invokes
   it), anti-vacuity (`irFirstSkipped` / byte-diff).
4. No `check:ir-fallbacks` regression; no test262 regression.

## Follow-up files

- `src/ir/select.ts` — function-value argument + arrow-value acceptance.
- `src/ir/from-ast.ts` — closure-wrap lowering + closure-call.
- `src/ir/nodes.ts` / `src/ir/lower.ts` — IR node/lowering as needed (reuse the
  legacy closure ABI, don't fork it).
- `src/codegen/closures.ts`, `src/codegen/builtin-fn-meta.ts` — the ABI to mirror.
