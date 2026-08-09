---
id: 1712
title: "acceptance: compiled acorn parses a representative .js with AST structurally equal to node-acorn"
status: done
assignee: ttraenkler/codex-acorn
created: 2026-05-29
updated: 2026-07-30
completed: 2026-07-26
loc-budget-allow:
  - src/codegen/regexp-standalone.ts
  - src/codegen/property-access.ts
  - src/codegen/declarations.ts
  - src/codegen/index.ts
  - src/codegen/type-coercion.ts
  - src/codegen/expressions/assignment.ts
  - src/ir/select.ts
  - src/runtime.ts
  - src/codegen/expressions/calls-closures.ts
  - src/codegen/context/types.ts
  - src/ir/integration.ts
  - src/codegen/property-access-dispatch.ts
  - src/codegen/object-runtime.ts
  - src/codegen/expressions/call-receiver-method.ts
func-budget-allow:
  - src/codegen/regexp-standalone.ts::ensureDynamicStandaloneRegExpCompiler
  - src/runtime.ts::<anonymous>#77
  - src/codegen/type-coercion.ts::coerceType
  - src/codegen/property-access.ts::compileElementAccessBody
  - src/codegen/expressions/assignment.ts::compilePropertyAssignment
  - src/codegen/index.ts::generateModule
  - src/ir/select.ts::isPhase1Expr
  - src/codegen/builtin-value-read.ts::ensureStandaloneBuiltinStaticMethodClosure
  - src/codegen/index.ts::generateMultiModule
  - src/codegen/expressions/calls-closures.ts::compileCallablePropertyCall
  - src/codegen/index.ts::resolveWasmType
  - src/codegen/declarations.ts::collectDeclarations
  - src/codegen/context/create-context.ts::createCodegenContext
  - src/codegen/index.ts::planIrOverlay
  - src/ir/integration.ts::compileIrPathFunctions
  - src/codegen/expressions/call-receiver-method.ts::compileReceiverMethodCall
  - src/codegen/object-runtime.ts::ensureObjectRuntime
  - src/runtime.ts::resolveImport
oracle-ratchet-allow:
  - src/codegen/declarations/object-shape-widening.ts
  - src/codegen/fnctor-escape-gate.ts
  - src/codegen/regexp-standalone.ts
coercion-sites-allow:
  - src/codegen/regexp-standalone.ts
priority: high
feasibility: hard
reasoning_effort: high
task_type: test
area: test-infrastructure, codegen
language_feature: multi
goal: self-hosting-dogfood
sprint: 77
model: fable
depends_on: [1710, 1711]
es_edition: multi
related: [1690, 1690b, 1584, 1058, 2928, 3098, 3308, 3651]
pr: 3646
---

# #1712 — Acceptance milestone: compiled acorn parses a representative .js with a structurally-equal AST

## Problem

This is the **definition of done for the first dogfood lap** of the
`self-hosting-dogfood` goal. All the other acorn issues (#1710 harness, #1711
triage, #1690, #1690b, and #1711's children) exist to make this one pass.

The milestone: take the #1710 harness, compile acorn to Wasm, instantiate it,
parse a representative real `.js` source file, and assert the produced AST is
**structurally equal** to node-acorn's AST on the identical input. This is the
end-to-end proof that "the compiler can compile its own parser and run it
correctly" — not just compile it to valid Wasm.

## Why it's `feasibility: hard` and depends on others

The three known full-module blockers are **already fixed**: #1679
(`new this`), #1690 (invalid-Wasm index-shift), #1690b (var-shadow) are all
`done`. So acorn may already compile to a _valid, instantiable_ binary on
current main — but "valid Wasm" is not "correct AST". The remaining risk is
_runtime divergence_: compiled acorn instantiates and runs but produces a
subtly wrong AST (off-by-one positions, a dropped node, a mis-coerced numeric
field). Those bugs are exactly what the #1710 harness + #1711 triage exist to
surface, and any of them blocks this acceptance.

So #1712 is the _integration gate_: it flips from `backlog` to `ready` once
#1710 (harness) lands and #1711 (triage) confirms either zero divergences (in
which case #1712 may pass immediately) or a tractable set of fixes. It is the
track's north star; whether it lands _within_ s57 depends on what #1711
surfaces. The optimistic case — given the known blockers are cleared — is that
#1712 passes early and the sprint pivots to widening the fixture corpus.

## Acceptance criteria

1. A committed test (extending the #1710 harness) compiles acorn to Wasm,
   instantiates it (JS-host mode acceptable for this lap), and calls
   `parse(fixtureSource, { ecmaVersion, sourceType })`.
2. The compiled-acorn AST is **structurally deep-equal** to node-acorn's AST on
   the same `fixtureSource` for at least one non-trivial representative `.js`
   file (e.g. a real ~100–300 line module mixing functions, classes, control
   flow, template literals, and regex — a reduced slice of a real library).
3. The comparison is documented: which fields are compared, which (if any)
   position fields are normalized, and why.
4. The test is wired so it can run in CI without network access (acorn pinned
   per #1710) and is fast enough not to bloat the suite (single representative
   file, not the whole acorn test262 corpus).
5. No test262 regression.

## Notes / scope

- A passing #1712 is the trigger to (a) widen the fixture corpus for a second
  dogfood lap (more libraries), and (b) unblock #1584's "compile acorn as the
  runtime parser" dependency — the interpreter needs exactly this artifact.
- Standalone (`--target wasi`) acorn execution is a _second-lap_ extension, not
  part of this acceptance (JS-host first to isolate codegen correctness from
  host-import gaps).
- Status starts `backlog`; the tech lead flips it to `ready` once the blocking
  issues merge. Do NOT dispatch a dev to "make #1712 pass" directly — it is an
  integration gate, satisfied by fixing its dependencies.

## PR #1293 final scope (2026-06-11) — test lands SKIPPED, fixes landed

PR #1293 (symphony/1712) ships `tests/issue-1712.test.ts` as a ready-to-arm
acceptance gate, marked `it.skip` pending the in-flight fnctor laps (#1327
dynamic-dispatch chain, #1345 two-shape unification, #1335 vec mutators).
The PR's own closure-dispatch machinery passed the test on its branch, but
main's independently-landed fnctor implementation (#1307 lineage) superseded
it; reconciling both inside one merge would duplicate the open laps. The
PR's durable codegen contribution is the `shiftLateImportIndices`
startFuncIdx fix below. **Un-skip the test when #1345 lands.**

### Historical note (2026-06-10, branch state before the supersede)

PR #1293's branch passed the acceptance test green. The 24 equivalence
regressions that previously blocked it were root-caused to a SINGLE latent
bug exposed (not introduced) by the PR: `shiftLateImportIndices`
(`src/codegen/expressions/late-imports.ts`) never shifted
`ctx.mod.startFuncIdx`, so any late import added via
`ensureLateImport`/`flushLateImportShifts` left `(start N)` pointing at an
exported user function with a result type → `WebAssembly.validate` failure.
Fixing that one shift cleared all 24 buckets (verified by a full local
equivalence-gate run: 0 new regressions, 37 baseline failures now passing).
Three additional hardening fixes shipped alongside: the
`fctx.readsCurrentThis` gate on the `__current_this` read was restored
(matches main; #1702 null-guard keeps host dispatch working), `__host_eq`
import resolution now happens BEFORE operand coercion (ill-typed-Wasm
fall-through), and externref switch discriminants keep numeric unbox-to-f64
comparison when all case expressions are numeric (reference identity only
for genuine reference cases). The PR's dynamic-`this` property lookup,
`Foo.prototype` host bridge, and higher-arity closure dispatch are
load-bearing for acorn and retained. #1301 (if/else then-buffer
global-index shift) merged independently and complements the PR's
`liveBodies` registration — both mechanisms coexist (dedup via the
`shifted` set).

## Attempt 22 Findings

- Added `tests/issue-1712.test.ts`, a focused CI-safe acceptance test that
  compiles the pinned Acorn tarball, instantiates the compiled parser in
  JS-host mode, parses one representative JavaScript fixture, and diffs the AST
  against node-acorn via the #1710 `diffAst` helper.
- The comparison ignores Acorn position fields through `diffAst` and strips
  compiled-only `sourceFile: null` metadata before comparison. All other fields
  in the normalized AST are structurally compared.
- The fixture covers multiple statement forms currently inside the compiled
  parser's passing surface: expression statements, block statements, labeled
  statements, a regex literal, and a conditional expression. Follow-up dogfood
  widening should add declarations/classes/functions once the remaining keyword,
  array/object, and operator-local parser-runtime gaps are closed.
- Codegen/runtime fixes made for this acceptance include function-constructor
  object-literal shape pre-registration, function-constructor call-index repair
  after late import shifts, current-this dynamic update/writeback repairs, and
  WasmGC struct getter/setter fallback improvements needed while Acorn
  initializes token tables and parser state.
- Scoped validation passes:
  `node node_modules/vitest/dist/cli.js run tests/issue-1712.test.ts`.

## Dogfood lap 2026-06-10 (fable-1712, main 6efc0d279)

Prior attempt: **Codex PR #1293** (symphony/1712) implemented the full
acceptance in one 1,700-line PR, but is CONFLICTING with main, stale since
2026-06-08, and its own equivalence-gate found **24 new regressions** from its
broad codegen edits (typeof-member, computed properties, shape-inference,
refcast fallback, destructuring initializers) — violating acceptance #5.
Treated as superseded; this lap re-fixes the blockers minimally off current
main, one root cause per slice.

### Blocker 1 — invalid Wasm: stale module-global index in `__closure_86` (FIXED, this PR)

`pnpm run dogfood:acorn` on 6efc0d279: compile succeeds, binary INVALID —
`f64.trunc[0] expected type f64, found global.get of type (ref null 1)`.

**Root cause** (not the #1690/#1839 surface — a NEW orphan-buffer window):
`compileIfStatement` (`src/codegen/statements/control-flow.ts`) finishes the
then branch, then raw-swaps `fctx.body = []` for the else branch. The
completed then-buffer survives only in the `thenInstrs` local — unreachable
by `fixupModuleGlobalIndices` (and the func-idx shifters). When the else
branch registers a brand-new string constant (acorn: a property null-throw
TypeError message — codegen-generated, so not pre-collected by the module
scan), the late `string_constants` import global shifts every module-global
index +1, but the detached then-buffer's `global.get`s stay stale. In acorn,
`return this.parseFunction(fNode, FUNC_STATEMENT | FUNC_NULLABLE_ID, …)`
(dist line 1855) sits in exactly such a then branch; its stale reads landed
on the neighbouring globals (one a `(ref null $array)`) → invalid Wasm.

**Fix** (2 sites):

1. `compileIfStatement` parks `thenInstrs` in `fctx.savedBodies` for the
   else-compilation window (savedBodies is walked by every late-import
   shifter), unparked LIFO before assembling the `if` instr.
2. `fixupModuleGlobalIndices` (`src/codegen/registry/imports.ts`) now also
   walks `ctx.liveBodies` — parity with `addStringImports`/`addUnionImports`
   (#1384); the #779d destructuring branch buffers register there expecting
   "every shift path" to walk them, but the _global_-index fixup never did.

Regression pin: `tests/issue-1712-ifelse-global-shift.test.ts` (verified red
on unfixed tree by reverse-applying the fix, green with it).

Result: acorn binary now **validates** (835,680 bytes).

### Blocker 2 — instantiation: `function.prototype` host bridge (NEXT)

With the binary valid, instantiation fails in module-init:
`Object.defineProperties called on non-object` (acorn dist 685:
`Object.defineProperties(Parser.prototype, prototypeAccessors)`).
`<fn>.prototype` on a function-style constructor compiles to
`__extern_get(closureStruct→externref, "prototype")` which has no sidecar
entry and no `__sget_prototype` export → undefined. This is the known
function.prototype host-bridge gap (#1340 recon — escalated NEEDS-SPEC).
25-line repro: `var P = function P(x){this.x=x}; P.prototype.m =
function(){…}; Object.defineProperties(P.prototype, …); new P(1).m()` —
all three flows fail (`m is not a function` / defineProperties non-object).

Bridge sketch (JS-host lap-1 scope per the acceptance note): vivify a
sidecar `prototype` object on closure structs in `__extern_get`; link
functor instances → ctor closure at `new`-site codegen; `_wrapForHost` get
trap falls back to the ctor's vivified proto and threads `this` via
`__call_fn_method_N` (#1636-S1). Acorn's `var pp$N = Parser.prototype;
pp$N.method = fn` aliasing is satisfied by the vivified object's identity.

### Blocker 2 progress — fnctor prototype bridge (WIP, branch issue-1712-proto-bridge)

Implemented (this branch, stacked on issue-1712-acorn-acceptance / PR #1301):

1. `__extern_get(closure, "prototype")` auto-vivifies an identity-stable JS
   object in the closure's sidecar (`_getOrVivifyFnPrototype`, runtime.ts) —
   wired in BOTH resolution regimes (intent `case "extern_get"` AND the
   by-name builtin chain; they are different handlers).
2. Synthesized fnctor ctors emit `__register_fnctor_instance(inst, ctor)`
   (new-super.ts; ensureLateImport + flushLateImportShifts discipline; JS-host
   only, gated off for standalone/wasi). Instance property misses resolve via
   `_fnctorProtoLookup` hooks in `_safeGet` + `_wrapForHost.safeGetField`.
3. `_wrapWasmClosure` is this-aware (dispatches `__call_fn_method_N` when the
   receiver unwraps to a Wasm struct) and resolves dispatcher exports at CALL
   time, fixing the start-window wrap no-op. Arity-5 method export added.
4. **`withImportObject` (#1667) now exposes `__setExports`** — previously the
   convenience importObject path NEVER wired exports, permanently disabling
   closure wrapping/\__sget_ on it. Harness updated to call it.
5. Start-window `Object.defineProperties(proto, structDescs)` defers to a
   `pendingExportsDeferred` queue drained by `setExports`.

**Result: compiled acorn now compiles + validates + instantiates + RUNS** —
`parse` callable, ASTs produced for all 5 fixtures. Surface: 0 equal /
5 divergent / 0 errored — the runtime-divergence phase is reachable for the
first time.

Open items for the next session:

- Probe C (`Object.defineProperties` accessors at module scope) still loses
  the accessor: the executing \_\_defineProperties handler did NOT take the
  deferral branch (dbg3 showed it running eagerly with zero keys). Verify
  which handler instance executes for intent vs name, and that callbackState
  there carries `deferToExports`.
- ~~Root AST divergence: `exports.parse(...)` diffs as null at `$`~~ —
  ROOT-CAUSED + FIXED (2026-06-10, fable-1712b). Two stacked defects:
  1. **Capture-struct dispatch exclusion** (`src/codegen/index.ts`): the
     `__call_fn_<N>` / `__call_fn_method_<N>` dispatchers tested ONE
     representative base-wrapper struct type for funcref extraction, but
     capture-carrying closure structs are standalone Wasm types with NO
     subtype relation to the 1-field base wrapper — `ref.test <base>` fails
     for them and the dispatcher silently yields `ref.null.extern`. Acorn's
     prototype methods all capture their fnctor (`Node`, `Parser`, …) so
     every host-bridge method call returned null. Fixed by per-shape
     extraction (`buildFuncrefExtraction`, mirrors `__is_closure`'s
     root-walking). Minimal repro: a proto method whose body merely does
     `typeof <other-fnctor>` returned null (F3, `.tmp/dbg10.mts`).
  2. **`__call_fn_1` covered exactly-arity-1 only**, violating the
     `_maybeWrapCallableUnknownArity` contract (it wraps with the HIGHEST
     available dispatcher, so fn_1 must invoke arity-0 closures). Fixed by
     delegating the legacy `emitClosureCallExport`/`...Export1` to the
     generic `emitClosureCallExportN` (arity ≤ N coverage + #820l argc
     plumbing + #1896 arg coercion for free).
     Regression pin: `tests/issue-1712-capture-closure-dispatch.test.ts`.
     The harness now also routes through `wrapExports` (#1504) so returned
     node graphs marshal to plain JS for diffing (raw exports are opaque).
- NEW first triage target after the dispatch fix: all 5 fixtures moved
  null→**trap "dereferencing a null pointer"** inside compiled `parse`
  execution. ROOT-CAUSED (not yet fixed): **fnctor instances have TWO
  irreconcilable struct shapes.**
  - `compileFnctorNew` (`src/codegen/expressions/new-super.ts:~850`)
    synthesizes the instance struct from the ctor body's `this.*` writes
    only (E3: `$8 = {input}`) and registers it as `__fnctor_<name>` /
    `funcConstructorMap`.
  - Consumer sites resolve the receiver via the TS checker; in JS mode the
    checker models `Parser.prototype.parse = fn` as an instance member, so
    the anonymous-struct fallback in `resolveWasmType`
    (`src/codegen/index.ts:~8741`, structMap miss because the fnctor
    registered under `__fnctor_Parser`, not `Parser`) synthesizes a WIDER
    shape (E3: `$3 = {input, parse}`).
  - `ref.test (ref $3)` on a `$8` instance always fails → guarded-cast
    else-arm `ref.null none` → `struct.get $3 1` / `ref.as_non_null` →
    trap. See `.tmp/e3.wat` `$parse` + `$__closure_1`.
  - **Attempted fix that did NOT work** (do not repeat naively): resolving
    fnctor names to the ctor struct inside `resolveWasmType` (consult
    `funcConstructorMap` before the anonymous fallback). It regressed G4/G5
    (probe `.tmp/dbg15.mts`) from working→null — `resolveWasmType` feeds
    params/locals/fields everywhere and the member-call path's
    static-vs-dynamic split needs to be steered TOGETHER with the type
    change (when the receiver is the ctor struct, `.method()` must compile
    to the dynamic host-bridge call, and the checker-shape struct must stop
    being synthesized at all). Suggest handling in the member-access /
    call-expression resolution layer (where receiver typeIdx is chosen),
    not in resolveWasmType alone — or unify by making compileFnctorNew
    emit the checker shape with prototype-method fields POPULATED from the
    module-init closures (compile-away-the-prototype strategy; needs the
    proto-method closure values to be reachable as globals at ctor time).
- Probes live in `.tmp/repro2.mts` / `.tmp/dbg1.mts`–`.tmp/dbg15.mts`
  (dbg4–15 are the #1712b dispatch-bisection series).

### Dynamic-dispatch slice 2026-06-11 (fable-1712c, branch issue-1712-dyn-dispatch)

After the merge with main (#1320 closure-bridge reconcile), the live blocker
chain shifted: all 5 fixtures failed `parse is not a function` BEFORE reaching
the two-shape trap. Bisection (`.tmp/dbg17.mts`–`.tmp/dbg22.mts`) pinned and
fixed FOUR stacked root causes (regression pin:
`tests/issue-1712-dynamic-dispatch.test.ts`):

1. **Static methods on fnctors unreachable** (`src/runtime.ts`,
   `__extern_method_call`): a CALLABLE closure-struct receiver is wrapped by
   `_wrapWasmClosureUnknownArity` into a bare JS function bridge with no view
   of sidecar statics, so `Parser.parse(input)` threw. Fix: not-a-function arm
   resolves through `_safeGet` on the RAW struct (sidecar → accessors →
   vivified prototype) and applies with the raw closure struct as receiver —
   which also makes `new this(…)` inside the static body see the ctor.
2. **Non-closure-shaped callee trapped** (`src/codegen/expressions/calls.ts`,
   `__callable_param_` dispatch ~8447): externref callee guard-cast against
   ONE wrapper-struct shape; non-null mismatch (acorn's `var hasOwn =
Object.hasOwn || fn` → host builtin in a JS var) fell into `struct.get`
   of null → "dereferencing a null pointer" inside `getOptions`. Fix: a
   host-callable fallback arm — `if (cast-null && raw-non-null)` route
   through `__call_function(callee, undefined, argsArray)` (JS-host only,
   i64/v128 params bail). Buffers parked in `fctx.savedBodies` while
   detached (blocker-1 shifter discipline).
3. **`__call_function` arg marshaling** (`src/runtime.ts`): passed raw WasmGC
   structs to host callees (`Object.hasOwn(struct, "a")` → false) and wrapped
   closure callees at arity 0 (dropped args). Fix: `__extern_method_call`-style
   wrapHostValue marshaling + `_maybeWrapCallableUnknownArity` + return
   `_unwrapForHost`.
4. **In-ctor prototype calls on `this`** (`src/codegen/expressions/new-super.ts`):
   `__register_fnctor_instance` was emitted at the END of the synthesized
   ctor, so acorn's `this.context = this.initialContext()` (inside the ctor)
   missed the vivified prototype. Fix: moved to the ctor PROLOGUE (buffer-reach
   note in the code comment).

Verified: acorn's compiled `parse` now executes `getOptions` →
`new this(…)` → `initialContext` correctly. Targeted suites
(fn-constructor, prototype-chain, bind-call, illegal-cast-closures, …):
identical pass/fail with and without the changes (19 pre-existing fails on
the branch tip, 0 new).

**NEXT blocker (root-caused, not fixed): host-side vec mutation.** The chain
now stops at acorn's `enterScope`: `this.scopeStack.push(new Scope(flags))` →
`push is not a function`. `this.scopeStack = []` compiles to a WasmGC vec
struct stored in the ctor-shape field; dynamic dispatch hands the vec struct
to `__extern_method_call`, but `_wrapForHost` has NO array facade and the
host cannot grow a WasmGC array. Recommended fix direction (mirrors the
existing `__vec_len`/`__vec_get`/`__vec_set_byte` precedent,
`src/codegen/index.ts:3530+`): emit generic Wasm-side mutator exports
(`__vec_push`, `__vec_pop`, `__vec_set`) with per-vec-type ref.test dispatch
chains (grow = alloc new $arr + struct.set, fields are mutable), then route
array methods on vec receivers there from `__extern_method_call`. The
two-shape struct issue (previous section) remains relevant after that.

### Vec-mutator slice 2026-06-11 (fable-1712c, branch issue-1712-vec-mutators, stacked on issue-1712-dyn-dispatch)

Fixes the `push is not a function` blocker (acorn `enterScope`:
`this.scopeStack.push(new Scope(flags))`) — THREE stacked defects:

1. **No host-side vec mutation**: new Wasm-side exports in
   `_emitVecAccessExportsInner` (`src/codegen/index.ts`): `__is_vec`,
   `__vec_mut_supported`, `__vec_push`, `__vec_pop` — per-vec-type ref.test
   dispatch, grow = compileArrayPush discipline (newCap = max((len+1)\*2,4),
   array.new_default + array.copy + struct.set). Elem coverage: externref
   always; f64/i32 when **box_number/**unbox_number imported; others return
   the -1/0 sentinel (runtime falls through to its fail-loud TypeError).
2. **closureBridge wrapped DATA fields**: `_wrapForHost`'s get trap bridged
   ANY struct field into a callable (`closureBridge`, #1090) — acorn's
   `this.scopeStack` read returned a JS function. Vetoed via `__is_vec`
   (positive discriminator; `__is_closure` can FALSE-POSITIVE on vecs whose
   canonicalized layout collides with a closure capture struct).
3. **Routing**: `__extern_method_call`'s not-a-function arm routes push/pop
   on vec receivers through the new exports (raw args, not host proxies, so
   Wasm-side element reads see structs; receiver unwrapped through both the
   proxy map and `_wasmClosureWrapperTargets`).

acorn now executes enterScope/exitScope; the chain stops at the NEXT
blocker — a null-deref in `__closure_340` (the static `Parser.parse` body)
right after `__fnctor_Parser_new` returns: this is the documented TWO-SHAPE
instance trap (`new this(…).parse()` member call guard-casts the ctor-shape
instance against the checker shape → null → struct.get). See the
"fnctor instances have TWO irreconcilable struct shapes" analysis above —
that is now the live front of the onion.

Also KNOWN, pre-existing, NOT fixed here (`.tmp/dbg23.mts` L1/L2): when the
TS checker CAN type the instance array field (TS-typed input, not acorn),
the member call takes the STATIC vec path which UNGUARDED-casts the
externref field value to the checker-inferred vec type → "illegal cast".
Needs the same guarded-cast + dynamic-fallback treatment in the
property-access lowering that feeds compileArrayPush.

### Two-shape slice 2026-06-11 (fable-1712c, branch issue-1712-two-shape, stacked on issue-1712-vec-mutators)

The original Blocker-2 two-shape trap is FIXED — three coordinated changes
(the "steer member-call split together with the type change" the failed
attempt called for, but resolved to EXTERNREF instead of the ctor struct):

1. `resolveWasmType` (src/codegen/index.ts, before the named-struct arm):
   fnctor instance types resolve to EXTERNREF — the checker shape is never
   synthesized. Gated to instance shapes only (`getCallSignatures().length
=== 0` keeps the function VALUE on its closure-wrapper resolution),
   JS-host only. This makes fnctor instances flow dynamically end-to-end.
2. `compileCallablePropertyCall` (calls-closures.ts): when the receiver is
   an fnctor instance, route the member call through
   `emitWrapperDynamicMethodCall` (host bridge) instead of the
   checker-shape field-read path (which trapped struct.get-on-null).
3. `emitWrapperDynamicMethodCall` (calls.ts, exported now): grew args
   support (\_\_js_array_push packing, JS-host).
4. Runtime `_wrapForHost.safeGetField`: a nullish `__sget_<name>` result is
   a MISS, not a hit — the per-shape dispatcher returns undefined for
   shapes that don't carry the field, which short-circuited the vivified-
   prototype fallback (every prototype method was unreachable whenever the
   checker shape had synthesized a same-named \_\_sget export).

Verified: `.tmp/dbg16/25/26` (E4/M-series) green, G/H probes unchanged,
tests/issue-1712-dynamic-dispatch.test.ts extended (8 green), targeted
suites 0 new fails (19 pre-existing env fails).

**acorn status: parse() now EXECUTES into the tokenizer and LOOPS FOREVER
(dogfood times out after compile+validate).** Next root-cause: likely
instance field WRITES through dynamic dispatch (`this.pos = ...` /
`+= `) not writing back to the struct (so the scan position never
advances), or a loop-condition coercion. Probe direction: minimal
`Parser.prototype.step = function(){ this.pos = this.pos + 1 }` write-back
check, then bisect acorn's nextToken loop.

**Correction (same session): the field-write-back hypothesis is DISPROVEN.**
`.tmp/dbg27.mts` N-probes all pass: `this.pos = this.pos + 1` through a
prototype method writes back (N1=2), a bounded `while (this.pos <
this.input.length)` terminates correctly (N2), and compound `this.pos += n`
works (N3). The acorn tokenizer infinite loop must be bisected INSIDE the
loop instead — likely candidates: `charCodeAt`/`fullCharCodeAtPos` results
through the dynamic path (NaN making no scanner branch match so `pos` never
moves), `skipSpace` semantics, or a context/type-token comparison that
never becomes true. Suggested approach: instrument the host bridge with an
invocation counter per method name (env-gated) and run one fixture to see
which method spins; or precompile acorn once to .tmp and drive
`parse` with a 1-char input under a watchdog.

**Tokenizer-loop root cause pinned (`.tmp/dbg28.mts`, host-bridge call
counter under a 200k watchdog):** for input `var x = 1;`, `parseStatement`
executes 9,090 times — each iteration COMPLETES (its statement is pushed:
`push` 9,090, `parseExpressionStatement` 9,089), but `parseTopLevel`'s
guard `this.type !== types$1.eof` never becomes false. This is a token-
object IDENTITY failure across dynamic reads: TokenType objects are
compared with `!==` by reference, and the two operands (`this.type` via
the instance read path; `types$1.eof` via module-global + property read)
evidently don't resolve to the SAME reference — one side likely a
`_wrapForHost` proxy / boxed copy and the other the raw struct (the
`_hostProxyCache` makes proxies identity-stable per struct, so the bug is
a path that returns the RAW value while the other returns the proxy, or
vice versa). Also suspicious: every statement parses as an
ExpressionStatement (`isLet` truthiness / keyword-token recognition may
have the same identity/equality defect). Next slice: make all dynamic
read paths return ONE canonical representation per struct (always raw, or
always cached proxy) before values re-enter Wasm, and check the strict-
equality lowering for externref operands unwraps proxies on both sides.

### Identity-loop slice 2026-06-21 (issue-1712-acorn-identity, sd-acorn) — TWO root causes fixed, branch PR pending

The pinned "token-object identity" framing was confirmed empirically AND
shown to be only HALF the story. Reproduced via a fast cached-binary probe
(`.tmp/run-acorn.mjs` + a `host_eq` call-counter/watchdog in `host_eq`) and
bisected to TWO **independent** compiler defects, each narrowed to a minimal
isolated repro that reproduces the acorn loop. Both fixed on the branch:

**BUG 1 — dynamic-method struct-field write never reaches the WasmGC field
(`src/runtime.ts` `_safeSet`).** A `this.field = v` inside a method body
compiled through the host bridge (`__extern_set` / `__extern_set_strict`)
called `_safeSet(obj, key, val, /*exports*/ undefined, callbackState, …)` —
i.e. it passed `callbackState`, NOT the `exports` param. But `_safeSet`'s
`__sset_<key>` struct-field writeback was gated on the `exports` PARAM only,
so the writeback was SKIPPED and the value landed in the SIDECAR ONLY. A
later _static_ `struct.get` read — the compiled member-access path takes the
guarded-cast struct branch whenever the receiver ref-tests as the struct type
(every fnctor-instance method body reading `this.field`) — bypasses the
sidecar and reads the raw WasmGC field, which still held its **initializer**
value. So a method write was invisible to a struct-typed read of the same
field. THIS is the real "two reads disagree" identity defect (not merely
proxy-vs-raw). Minimal repro: a function-constructor `Box` with proto methods
`store(v){this.t=v}` / `load(){return this.t}`, then `b.store(T); b.load() ===
T` returned `false` (`load()` read the stale ctor-init `this.t`). Acorn shape:
`this.type = types$1.eof` (write) vs `this.type !== types$1.eof` (guard read)
→ guard never tripped → infinite loop.
Fix: resolve exports from `callbackState` as a fallback for the `__sset_`
writeback, AND `_unwrapForHost(val)` before the struct-field store so a
proxy-wrapped method ARG (host-bridge arg marshaling wraps struct args) is
stored as the RAW struct, keeping typed `ref.eq` reads identity-correct.
Also hardened `_hostEqComparableValue` to unwrap `_wrapForHost` proxies (the
originally-pinned proxy-vs-raw case — real, just not sufficient alone).
Verified: minimal `methodRoundTrip` 0→1; acorn-shape identity probe
(module-global TokenType object + fnctor Parser + `this.type` guard loop)
infinite-loop → terminates correct.

**BUG 2 — `any`-receiver `String.prototype.replace` mis-dispatches to a DOM
extern class and drops the replacement arg (`src/codegen/expressions/
calls-closures.ts` `tryExternClassMethodOnAny`).** On an `any`/untyped
receiver, `value.replace(/re/g, "rep")` was first-matched against the FIRST
registered extern class with a `replace` method — `CSSStyleSheet.replace(text)`
(one user arg → the replacement string was emitted then immediately `drop`ped,
so host `replace` ran with `undefined`: `"a b".replace(/ /, "|")` →
`"aundefinedb"`), and after the arg-count guard, `DOMTokenList.replace(a,b)`
(returns boolean → `"^(?:false)$"`). This silently broke acorn's
`wordsRegexp(words){ return new RegExp("^(?:"+words.replace(/ /g,"|")+")$") }`:
keyword recognition failed (`this.keywords.test("var")` false), so `readWord`
finished `var` as token `name` instead of `_var`, every statement
mis-tokenized, and the tokenizer looped forever (the "every statement parses
as ExpressionStatement / isLet truthiness" symptom noted above). Confirmed via
`finishToken` call-counter: `readWord("var")` → `finishToken(name)`.
Fix: refuse extern-class dispatch for `replace`/`replaceAll` on an `any`
receiver (mirrors the existing `.slice` ambiguity refusal) + a general guard
that refuses any candidate whose user-arity is LESS than the call's arg count
(dropping a real arg is never correct). The call then falls through to the
generic `__extern_method_call` host path, which forwards ALL args to the real
`String.prototype.replace`. Verified: `anyReplace`/`wordsRegexp`-shape probes
and the keyword-classification probes all green.

**Regression check:** no new failures from either fix. Scoped suites run on
the branch: regex/replace (`issue-1539-*`, 209 pass), `issue-1712-dynamic-
dispatch`, `issue-1712-ifelse-global-shift`, `issue-2192b-*` all pass. The
failures observed in `prototype-chain.test.ts` (6), `externref.test.ts` (5,
`Host_*` missing-import), `string-methods.test.ts` (`./helpers.js` load error),
and `issue-1712-capture-closure-dispatch.test.ts` (1, `__call_fn_1` arity-0)
were each verified to fail IDENTICALLY on `origin/main` (revert-test-restore) —
pre-existing container/test-infra issues, NOT regressions from this branch.

**acorn status after this slice: the tokenizer identity loop is GONE.** acorn
now executes far past the loop — into module-init `buildUnicodeData` →
`wordsRegexp(...)`. A THIRD, independent blocker surfaces there (not yet
fixed): `wordsRegexp(unicodeBinaryPropertiesOfStrings[ecmaVersion])` throws
`Cannot read properties of null (reading 'replace')` — the receiver is `null`
where real JS reads `""`. The value comes from a module-level object literal
with numeric keys (`{ 9: "", 10: "", … }`) read by a dynamic numeric key
inside a `data[ecmaVersion] = { …: wordsRegexp(obj[k]), … }` assignment-as-
expression. Minimal probes of `obj[numKey]`, empty-string args, and the
nested-object-literal shape ALL pass in isolation, so the trigger is more
specific (likely the module-global-object + assignment-expression + nested
`wordsRegexp` interaction, or a cross-module-global reference
`unicodeBinaryPropertiesOfStrings[14] = ecma14BinaryPropertiesOfStrings`).
This is a fresh investigation — a separate slice from the identity loop this
branch closes. The #1712 acceptance test (`tests/issue-1712.test.ts`) stays
`it.skip` until the module-init chain clears.

## Status reconcile (2026-07-02)

Stays **in-progress** — the acceptance gate is NOT met: `tests/issue-1712.test.ts`
is still `it.skip` on main, and the committed differential corpus shows open gaps.
Landed since the last note above:

- **PR #1874** (2026-06-21) — the two tokenizer identity-loop root causes
  documented in the section above (the `_safeSet` struct-writeback + the
  `any`-receiver `replace` mis-dispatch).
- **PR #2330** (2026-06-29) — wider acorn differential corpus + committed gap map
  (`tests/dogfood/CORPUS-GAP-MAP.md`, `pnpm run dogfood:acorn-corpus`); measured
  `inputs=22 equal±quirks=6 REAL=6 compiled-threw=10` and filed the distinct gap
  issues #2844–#2848/#2850 (return wall = #2838, arrow params = #2841).

This remains an integration gate satisfied by fixing its dependency gap issues,
not by direct dispatch.

## Regression 2026-07-23 (sendev-acorn) — parse regression bisected + fixed

**Measured regression** (unattributed for ~6 days; the probe/corpus are not in
the default CI sweep, `DOGFOOD_ACORN=1`-gated): `dogfood:acorn-corpus`
**23/23 → 13/23** equal±quirks (10 inputs `compiled-parse-threw`);
`dogfood:acorn-probe` **13/13 → 8/13** (objects.js, spread-rest.js,
arrow-params.js, destructuring.js, classes.js `wasm-threw`) plus the
single-construct `"function g(a, b) { return a + b; }"` → in-Wasm=null. The
throws are GENUINE acorn SyntaxErrors: `'return' outside of function`,
`'new.target' can only be used in functions…`, `Unexpected token` after
`yield`.

**Culprit (git bisect, first-parent b9b89b8→9bc9454, then intra-PR):** merge
`852c40a9f516` = **PR #3267** (`codex/test262-original-harness-parity`, merged
2026-07-18 04:50Z); exact commit **`479f747c4292ff`** "fix(test262): preserve
widened descriptor data reads" — added an exact-struct-field read lane to
`finalizeStructAndDynamicMemberGet` (property-access-dispatch.ts): when
`typeName` is unrecoverable but the receiver's checker type resolves to a
struct typeIdx with a same-named field, read `struct.get` directly instead of
the dynamic host-MOP path.

**Mechanism (measured via compile-time lane logging + minimal repros):** the
unrestricted guard also hijacked receivers whose RUNTIME value is a growable
host `$Object` — the anon struct exists statically but is never instantiated.
acorn's `types$1` token table and `prototypeAccessors` descriptor tables are
both growable-marked (depth-2 writes `types$1.parenR.updateContext = …`,
`prototypeAccessors.inFunction.get = …`). The load-bearing break: for a
ref_null-typed field (`prototypeAccessors.inFunction`, an inline
`{configurable:true}` descriptor struct), `emitExternrefToStructGet`'s
`__extern_get` fallback ref.tests the HOST result against the struct type,
fails, and substitutes **ref.null** (defaultValueInstrs arm,
property-access.ts:1609). So `prototypeAccessors.<k>.get = fn` wrote onto
null, `Object.defineProperties(Parser.prototype, prototypeAccessors)`
installed getterless accessors, and every scope predicate (`inFunction`,
`inGenerator`, `inAsync`, `allowNewDotTarget`) answered undefined→false —
exactly the three SyntaxErrors. Same family as #2694's warning: a read-only
struct-slot shortcut without matching the write lane diverges.

**Hypothesis audit (bisect-first discipline):** H1 (#3506 `__extern_get`
vec-props fallthrough, merged 07-23) — **REFUTED**: regression predates it by
5 days. H2 (re-regression of #2848) — **REFUTED as mechanism**: #2848's fix
family (#2838/#2325 dynamic prototype-accessor dispatch) is intact; the same
SYMPTOMS re-appeared through a new, unrelated read-lane defect. Neither
hypothesis named the culprit; the bisect did.

**Fix (this branch):** restrict the lane to defineProperty-WIDENED structs
(`widenedVarStructMap` + `widenedDefinePropertyKeys` — the widening pre-pass
only widens EMPTY literals, so a widened receiver's runtime value IS the
struct and the exact-field read is sound; acorn's non-empty tables can never
qualify). A pure revert would re-break #3267's widened-descriptor reads
(measured: `var obj = {}; Object.defineProperty(obj,"prop",{value:2010})` read
→ `undefined` with the lane off). Regression guard:
`tests/issue-1712-exactfield-lane-guard.test.ts` (4 cheap tests in the DEFAULT
sweep — the probe/corpus guards are `DOGFOOD_ACORN=1`-gated, which is why this
landed unnoticed). Post-fix measurements: probe **13/13** (+15/15
single-construct, up from 14/15 pre-regression), corpus **23/23**
equal±quirks, 0 throws, 0 real gaps.

`loc-budget-allow` note: +35 lines on property-access-dispatch.ts are the
narrowed guard + the mechanism documentation comment.

## Acceptance refresh 2026-07-26 — host ASTs correct; standalone artifact and bare-arrow follow-up

The Acorn-owned branch now establishes two distinct parser contracts:

1. **JS-host differential AST:** `tests/dogfood/acorn-corpus.mjs` reports
   **23/23 exact structurally equal results**, including Acorn self-parse, with
   **0 normalization quirks, 0 compiled throws, and 0 real divergences**.
   `tests/issue-1712.test.ts` is active and asserts exact equality on
   its 22-input CI corpus.
2. **Host-free in-module parser:** `tests/dogfood/acorn-standalone-compile.mjs`
   compiles Acorn plus a scalar AST consumer as one `target: "standalone"`
   module, validates a **zero-import** artifact, calls
   `parse(nativeString, { ecmaVersion: 2025, sourceType: "script" })`, and reads
   `Program → ExpressionStatement → BinaryExpression` inside Wasm. This keeps
   the parser/AST carrier native for #2928; it does not claim host marshalling
   of the standalone AST.

The refreshed host-free artifact is **1,704,853 bytes**, has **zero function
imports**, and also executes scalar canaries for the other public parser
entries:

- `parseExpressionAt("xx 1 + 2 yy", 3, options)` returns the expected
  `BinaryExpression` at `[3, 8]`;
- `tokenizer("42", options)` returns the expected numeric token followed by
  EOF.

The preserved parser seam is:

```text
parse(nativeString, optionsObject) -> ESTree AST object
```

No new callable, rec-group, or export ABI was introduced. The implementation
reuses the existing fnctor constructor and closure-call machinery, including
the #3098 `new this(options, input)` argument-preserving path. This is compatible
with the interpreter seam `emitProgram(ast) -> FuncMeta` followed by
`interpEnter(...)`; E6 packaging and ordered-initializer ABI remain explicitly
unfrozen.

### Bare-arrow regression found during refresh

Expanding the in-Wasm single-construct probe exposed a branch-only regression:
all six bare-arrow forms threw at `=>`, reducing parity to **14/20**, while the
13 larger scale fixtures remained green. Exact A/B showed the failure already
present at Acorn publication commit `f80654c4455664ce1bd7b95bbe871f8e5fd5026c`,
not introduced by the latest upstream merge.

Follow-up **#3651** identifies the root cause: fnctor-shape analysis treated
Acorn Parser fields assigned in both arms of a complete `if/else` as optional.
The implemented definite-assignment reconciliation restores **20/20**
single-construct parity and keeps the scale gate **13/13**. The #1712 branch
is complete after the refreshed full corpus, standalone artifact, typecheck,
and regression gates passed on the final upstream merge.

## PR #3646 test results (2026-07-26)

- Exact Acorn differential AST and zero-import standalone acceptance: **pass**.
- Focused dynamic-dispatch/boolean-brand, RegExp/String, and object-runtime
  reconciliation suites: **46 tests pass**.
- Native Messaging real-Wasmtime scale matrix: **4 variants × 4 sizes pass**
  at 1/64/128/256 MiB.
- Typecheck, lint, format, IR fallback/IR-only, oracle, coercion, LOC/function,
  adoption, dead-export, pushRaw, and guard-suite gates: **pass**.
- Deterministic harness compile work: **121,637 → 111,490** calls after
  consolidating the three new boolean-brand source scans; ceiling **112,803**
  (current-main control **105,924**). No budget baseline was changed.

## Standalone Function-body regression fixed 2026-07-26

The interpreter integration widened the host-free acceptance input from
`1 + 2` to the production `new Function` shape:

```js
parse("function f(a,b) { return a + b; }", {
  ecmaVersion: 2025,
  sourceType: "script",
});
```

The published branch compiled and instantiated this parser with zero imports,
but the call trapped through Acorn's `allowReturn → inFunction →
currentVarScope` path. Two independent standalone defects caused the trap:

1. Acorn installs the `inFunction` getter before assigning
   `Parser.prototype.currentVarScope`. The getter therefore had no direct
   method target when it was compiled. Pinned fnctor receivers now use the
   existing closed-method dispatcher for this late prototype-method case; its
   target is finalized after all prototype writes.
2. `Object.defineProperties(Parser.prototype, prototypeAccessors)` installs 11
   getters. Growing the open-object property table reinserted only each
   entry's key, value, flags, and sequence number, silently dropping its
   getter/setter callback slots. Rehashing now preserves both accessor halves.

The focused standalone regressions separate the late-method case from the
11-accessor table-growth case. The real pinned Acorn 8.16.0 artifact now:

- compiles on the synced upstream base in **25,970 ms** to **1,711,629
  bytes**;
- validates and instantiates with **zero imports**;
- passes `parse`, `parseExpressionAt`, and `tokenizer` scalar canaries; and
- returns the expected `Program → FunctionDeclaration → ReturnStatement →
BinaryExpression` shape for the exact production input above.

The exported parser seam remains
`parse(nativeString, optionsObject) → ESTree AST object`. No callable carrier,
rec-group, runtime-eval envelope, or interpreter export changed.

### Change-set budget accounting

PR #3646 carries the complete Acorn acceptance stack rather than only this
last regression fix. Its merge-base therefore includes the earlier native
RegExp, fnctor reconstruction, field-presence, AST marshalling, and dynamic
dispatch slices listed in this issue's history. The `loc-budget-allow` and
`func-budget-allow` entries above enumerate that already-reviewed integration
surface so the change-scoped quality gates assess the PR intentionally. This
does not raise the repository baselines; post-merge ratchets still bank the
new sizes.

## Full Test262 parser differential 2026-07-26

The acceptance surface now includes every Git-tracked Test262 JavaScript parser
input, using pinned acorn 8.16.0 on both sides and comparing exact ESTree,
including positions and Test262 script/module/strict variants. The completed
pre-fix four-shard census covered **53,259 files / 102,312 variants** and reduced
the remaining mismatches to two files / four variants after first closing the
lexical early-error and arbitrary-width BigInt families.

The lexical family covered **36 files / 72 variants** across invalid
template/string escapes, truncated radix numerics, and dangling named RegExp
backreferences. Two substrate defects explained it: nullable primitive function
results erased Acorn's `readInt`/`readHexChar` null sentinel, while nested vec
`push` mutated a materialized host Array mirror rather than Acorn's live
`backReferenceNames` vector. The complete recorded 223-file replay eliminated
every `compiled-accepted-oracle-rejected` residual from that family.

The final two residuals were:

- A generator-context vec mutation left `yield/regexp/` in the division lexical
  goal because the host proxy write did not update the live Wasm vector.
- One depth-32 nested-function program overflowed the alternating
  Wasm→host→Wasm prototype-method bridge.

Both residual files now replay exact (**2/2 files, 4/4 variants**). The required
23-input corpus is **23/23 exact**, and the standalone parser remains a
zero-import artifact with all four scalar canaries green. The clean integrated
compiler revision `9768f821f79999845750bc80a929de607d728441` completes the
full four-shard differential at **53,259/53,259 exact files** and
**102,312/102,312 exact variants**: 92,649 variants produced structurally
identical ESTree ASTs, 9,663 were rejected by both parsers, and zero files or
variants mismatched. The run used pinned Acorn 8.16.0 and Test262 revision
`63829c6d925e24a3f5f307b08754aaa1c412c6a6`. After the final upstream
slot-widening merge, code revision
`2cccb33288957f` emits the byte-identical 681,946-byte host artifact
(`sha256:765c5cc3570ab3b5fb62942701e0969dbaeafdd49fe5a6e863c2410a9c523ee6`);
the exhaustive result therefore transfers exactly, and the zero-import
standalone canaries remain green.

The vec mutation is now routed through the module's canonical mutation export.
The recursive method path first resolves the live prototype property, returns
from the host lookup, and only then invokes the compiled closure through a
private Wasm driver. Under-applied calls receive the host's real `undefined`
carrier while retaining the original `arguments.length`; genuine host
overrides and calls wider than the supported fixed arities retain the generic
host fallback. These are internal lowering/runtime repairs and do not change
the public Acorn or interpreter ABI.
