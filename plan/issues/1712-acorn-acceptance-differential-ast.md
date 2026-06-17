---
id: 1712
title: "acceptance: compiled acorn parses a representative .js with AST structurally equal to node-acorn"
status: in-progress
created: 2026-05-29
updated: 2026-06-11
priority: high
feasibility: hard
reasoning_effort: high
task_type: test
area: test-infrastructure, codegen
language_feature: multi
goal: self-hosting-dogfood
sprint: 63
model: opus
depends_on: [1710, 1711]
es_edition: multi
related: [1690, 1690b, 1584, 1058]
pr: 1293
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
   "every shift path" to walk them, but the *global*-index fixup never did.

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
   closure wrapping/__sget_ on it. Harness updated to call it.
5. Start-window `Object.defineProperties(proto, structDescs)` defers to a
   `pendingExportsDeferred` queue drained by `setExports`.

**Result: compiled acorn now compiles + validates + instantiates + RUNS** —
`parse` callable, ASTs produced for all 5 fixtures. Surface: 0 equal /
5 divergent / 0 errored — the runtime-divergence phase is reachable for the
first time.

Open items for the next session:
- Probe C (`Object.defineProperties` accessors at module scope) still loses
  the accessor: the executing __defineProperties handler did NOT take the
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
   dispatch, grow = compileArrayPush discipline (newCap = max((len+1)*2,4),
   array.new_default + array.copy + struct.set). Elem coverage: externref
   always; f64/i32 when __box_number/__unbox_number imported; others return
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
   support (__js_array_push packing, JS-host).
4. Runtime `_wrapForHost.safeGetField`: a nullish `__sget_<name>` result is
   a MISS, not a hit — the per-shape dispatcher returns undefined for
   shapes that don't carry the field, which short-circuited the vivified-
   prototype fallback (every prototype method was unreachable whenever the
   checker shape had synthesized a same-named __sget export).

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
