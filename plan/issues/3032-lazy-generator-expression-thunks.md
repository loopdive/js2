---
id: 3032
title: "Lazy-first-resume generator thunks: stop running eager-buffer generator bodies at creation (unblocks #2141 S3 / #2626 classifier)"
status: in-progress
assignee: ttraenkler/fable-tag5
sprint: current
created: 2026-07-04
priority: high
feasibility: hard
reasoning_effort: max
task_type: bugfix
area: codegen, runtime, generators, value-rep
language_feature: generators, destructuring defaults, equality
goal: test262-conformance
related: [2141, 2626, 2040, 2585, 928, 2203, 991]
origin: "2026-07-04 #2141 S2 root-cause (fable-tag5): the −162 dstr eject was never a dstr/eq dependency — it was eager generator bodies + comparator vacuity"
---

# #3032 — eager-buffer generators run their body AT CREATION; the tag-5 comparator vacuity is the only thing hiding it

## Root cause (S2 of #2141, fully verified 2026-07-04)

The eager-buffer generator lowering (#991/#928 era) compiles a generator to:
run the whole body NOW, buffering yields (`__gen_create_buffer` +
`__gen_push_*`), then `__create_generator(buffer, pendingThrow)` whose host
object replays the buffer on `next()`. That means **the body's side effects
happen at generator-object creation**, violating §27.5 (a generator suspends
at start-of-body; nothing runs until the first `next()`).

Which generators take this path:

- **Anonymous generator function expressions** (`function*(){}` — incl. the
  ubiquitous test262 dstr fixture IIFE `var iter = function*() { iterations += 1; }();`)
  — `isNativeGeneratorCandidate` requires `decl.name`, so they can never be
  native (closures.ts eager branch).
- **Nested capturing generators** (#2203) — the native state struct has no
  capture slots. The test262 wrapper puts every test inside
  `export function test() { ... }`, so in wrapped tests even NAMED generators
  touching test-scope vars are nested+capturing → eager.
- Method generators using `arguments`/`super`/captures; object-literal
  method generators with defaults (class-bodies/literals bail conditions).

Why nobody saw it: the harness comparator masks it. `assert.sameValue` /
`isSameValue(a: any, b: any)` params ride the externref ABI; inside, each
operand is boxed per-use via `__any_box_string` (the #1888 tag-5 lie).
Legacy tag-5 non-string eq answers `0` — so a lie-boxed value is
**self-unequal** (fake NaN), and `isSameValue`'s
`a === b || (a !== a && b !== b)` returns **TRUE for every pair of lie-boxed
operands**. `assert.sameValue(iterations, 0)` with `iterations === 1` passes
vacuously. The #2626 classifier arms (numeric `f64.eq`, object `ref.eq`)
each make self-compare honest, closing the escape → the −162 "regression"
(class/dstr cluster) is **unmasking, not breakage**. Bisect artifacts: WAT
trace shows the ONLY `__any_strict_eq` callers in the canary module are the 3
`isSameValue` sites; probe `v8` (`return iterations*100+7` right after the
fixture) returns **107** on the pre-fix compiler — the body ran at creation.

## Slice 1 (landed with the #2141-S2 PR): lazy-first-resume thunks for zero-param expressions

Mechanism (no new imports, no funcidx shifts, no body-splitting):

- **Wasm** (`src/codegen/closures.ts`, generator branch of
  `compileArrowAsClosure`): for `!isAsync && parameters.length === 0`, the
  historical eager sequence is wrapped in
  `if (global $__gen_eager_mode) { <eager, byte-for-byte> } else { return __create_generator(extern.convert_any(self), null) }`.
  The eager arm CLEARS the flag at its top (nested creations during a
  deferred run stay lazy). `ensureGenEagerFlag` reserves the `mut i32`
  global + exports a `__gen_set_eager(i32)` setter. Branch-target safe: all
  body `br`s target the inner block/try; `return` is depth-independent.
- **Host** (`src/runtime.ts`): `__create_generator` detects a non-Array
  first arg as a THUNK (the closure itself, opaque externref).
  `next()` materializes: `__gen_set_eager(1)`; `__call_fn_0(thunk)` (the
  closure re-runs, taking the eager path); adopt the inner generator's
  `{buf, pendingThrow, retVal}`; `__gen_set_eager(0)` in a finally.
  `return()`/`throw()` before the first `next()` DROP the thunk without
  running the body (§27.5.3.2 GeneratorResumeAbrupt on suspendedStart —
  strictly more spec-correct than eager).
- **Contract**: consumers of `buildImports` MUST wire
  `setExports(instance.exports)` (already required for wasm-closure interop
  — `wrapForHost`; the runner does). Missing wiring → clear TypeError at
  first resume only.
- **Eligibility gates (learned from PR #2625's first merge_group cycle —
  41 regressions in three buckets, all fixed by gating):** lazy only when
  `!isAsync && parameters.length === 0 && !closureBodyUsesArguments(body)
&& !genBodyReferencesThis(body)`. `arguments` (zero-declared-param
  generators still see call-site args — `gen-func-expr-args-trailing-comma-*`)
  and `this`/`super` (`Array.prototype[Symbol.iterator] = function*(){
...this[0]... }` — the `iter-val-array-prototype` cluster) are call-time
  state the deferred `__call_fn_0` re-invocation cannot rebind; W2 spills
  them. ALSO: the cached `ctx.genEagerFlagGlobalIdx` MUST be kept in step by
  `fixupModuleGlobalIndices` (registry/imports.ts) — a string-constant
  import between two generator emissions left the second `global.get`
  pointing one slot low (externref) → wasm validation error (the
  `fn-name-gen` + `Set receiver-not-set` compile_error cluster; the exact
  #2023 `newTargetGlobalIdx` / #2001 `holeGlobalIdx` staleness hazard).
- **Merge_group A/B for the gated slice** (js-host lane, vs 30-min-old
  content-current baseline): +42 net (83 improvements — the whole
  `ary-ptrn-empty` family — vs 41 bucket regressions pre-gates; the gates
  eliminate all 41 while keeping the improvements, re-verified per bucket).

Verified: probes v10/v12 (creation runs nothing, was `log=2`), v15
(resume/drain/done exact), v16/v17 (return/throw-before-start never run the
body), dstr canary `meth-dflt-ary-ptrn-empty` + siblings green **with the
classifier force-enabled** (the #2141-S2 deliverable), 24-file
class/dstr `dflt` sample byte-of-behavior identical under the default
(legacy) comparator: 18 pass / 6 fail before and after.

## Banked waves (Opus-executable, in dependency order)

- **W2 — paramful generator expressions.** The thunk re-invocation goes
  through `__call_fn_0` (self only), so params can't replay. Approach: at
  creation, spill args into the existing ref-cell machinery (a synthesized
  capture env: `{argCell0..argCellN}` appended to the closure struct via a
  SECOND struct instance sharing the funcref) and gate `genLazyEligible` on
  "params spilled". Alternative (simpler): keep eager for paramful
  expressions — measure first; the test262 fixture corpus is ~all
  zero-param.
- **W3 — nested capturing NAMED generators** (`function* g() {...}` inside
  the test wrapper — probe v14 shape, fails honestly on main today). Two
  routes: (a) compile nested named generators AS closure values through the
  same lazy branch (they already fall to an eager path — find it in
  `nested-declarations.ts` / function-body.ts:1038 and apply the same
  if-flag wrap; the creation call site must pass the closure self);
  (b) native-generator capture slots (#2203 proper): store the capture
  cells in the state struct. (a) is the cheap unblock, (b) the endgame.
- **W4 — method generators** (class-bodies.ts:2271 eager arm — the
  `gen-meth-*` dstr shapes that still flip under the classifier; they
  capture test-scope vars so they bail native). Same if-flag wrap; the
  creation site is the method call itself (spec: param
  dstr/defaults run eagerly at call — KEEP that — only the BODY suspends;
  the eager arm must split param-instantiation from body, so W4 is NOT a
  pure wrap — param handling stays outside the flag branch).
- **W5 — `retVal`/`return(v)` marshalling**: `g.return(42).value` and
  `return 9`-observation round-trip an opaque `$BoxedNumber` through
  `__gen_result_value_f64` → `Number(opaque)` throws (pre-existing,
  standalone). Route through `exports.__sget_value` / `__unbox_number`
  fallback in `__gen_result_value*`.
- **W6 — retire the buffer**: real suspension (native state machine for all
  shapes) makes the buffer+thunk model obsolete; `yield` two-way
  communication (`next(v)` value into the body) is impossible under
  buffering and stays broken until W6.

## Interaction with #2141/#2626 (the ordering law)

The classifier (`tag5ValueEqClassifier`, in-tree, default OFF) may flip its
default (#2141 S3/S4, #2626 acceptance) only after enough waves land that
the **merge_group standalone floor** clears: every vacuous pass the
classifier unmasks must first be made a GENUINE pass by laziness. Measure
with `JS2WASM_TAG5_CLASSIFIER=1 pnpm run test:262` A/B per wave.

## Implementation Plan (W3 then W2 — the next executable waves)

(arch, 2026-07-12. Anchors re-verified on main: the landed Slice-1 lazy wrap
lives in `src/codegen/closures.ts` — `genLazyEligible` gate at :2886, eager
sequence capture at :2893, flag-branch emission at :2953,
`ensureGenEagerFlag` at :1721. The gc-host eager-buffer arm for NAMED
generator declarations is `src/codegen/function-body.ts` :1052-1080 (the
`__gen_create_buffer` block; the standalone #680 gate is right above at
:1045). The method-generator eager arm is `src/codegen/class-bodies.ts`
:2309. There is no `nested-declarations.ts` — the W3 note's pointer is
stale; the eager path for nested named generators is the function-body.ts
arm.)

**Recommended order: W3 (route a — cheap wrap) first, then W2 (measure
before building), then W4.** W3 covers the dominant test262 shape (named
generators inside the `export function test()` wrapper); W2's zero-param
observation in the banked note ("the fixture corpus is ~all zero-param")
means W2 may be a measurement no-op.

### W3 route (a) — nested capturing NAMED generators via the same if-flag wrap

**Where**: `src/codegen/function-body.ts` :1052-1080 — the eager-buffer arm
for a gc-host generator FUNCTION DECLARATION (`function* g() {...}` nested
inside the test wrapper falls here after failing native candidacy).

**Change**:

1. Extract the Slice-1 wrap into a shared helper
   `wrapGeneratorEagerSeqLazy(ctx, fctx, bodyEmitter, selfClosureEmitter)`
   in closures.ts (parameterize what :2886-2960 does inline today): capture
   the eager sequence into a fresh `Instr[]`, then emit
   `if (global.get $__gen_eager_mode) { <eager seq, clears flag at top> }
else { <return __create_generator(<self as externref>, null)> }`.
2. Apply it in the function-body.ts arm. The one W3-specific problem is the
   THUNK SELF value: a declaration-form generator is a plain defined func,
   not a closure struct, so there is no `__self` param to pass to
   `__create_generator`. Two options — (a-i) mint the nested named generator
   AS a closure value at its declaration site (route it through
   `compileArrowAsClosure`'s generator branch — it then inherits the landed
   lazy wrap verbatim, captures included); (a-ii) synthesize a zero-capture
   closure struct wrapping the defined funcIdx purely as the thunk handle.
   Prefer (a-i): it reuses the PROVEN Slice-1 branch end-to-end and gives
   capture cells for free; the call sites (`g()`) already compile
   identifier-call-of-closure.
3. Eligibility gates: same as Slice 1 (`!isAsync`, no `arguments`, no
   `this`/`super` — reuse `closureBodyUsesArguments` (closures.ts:4968) +
   `genBodyReferencesThis` (:1758); NOTE both are module-LOCAL functions in
   closures.ts, not exported — route (a-i) sidesteps that by re-entering
   `compileArrowAsClosure`, which applies the :2886 gate itself; only
   route (a-ii) would need them exported), PLUS `parameters.length === 0`
   until W2 lands.
4. Hoisting edge case (route a-i specific): a nested `function* g() {...}`
   DECLARATION is hoisted — `g()` may legally appear before the declaration
   in source order. Minting `g` as a closure VALUE at the declaration site
   changes that unless the mint is hoisted to the top of the enclosing
   function body (follow however the compiler already hoists nested
   function declarations compiled as closures; verify with a
   call-before-declaration probe, and keep the eager arm for the shape if
   hoisting isn't already handled).

**Hazards** (from the Slice-1 PR #2625 lessons, all still live):

- `ctx.genEagerFlagGlobalIdx` staleness across string-constant imports —
  `fixupModuleGlobalIndices` (src/codegen/registry/imports.ts) already
  covers the cached idx; any NEW cached global here must be added there.
- The eager arm must clear the flag at its top (nested creations stay lazy).
- Host contract: `__create_generator` thunk detection + `__call_fn_0`
  re-invocation (src/runtime.ts) is shape-agnostic — no host change needed
  if (a-i) is taken (the thunk IS a closure).

**Probe/tests**: probe v14 (the banked shape — named capturing generator in
the wrapper, `iterations` must stay 0 before first `next()`); the
class/dstr `dflt` canaries with `JS2WASM_TAG5_CLASSIFIER=1`;
return/throw-before-start (v16/v17 twins for the named shape).

### W2 — paramful generator expressions (measure first)

**Step 0 (measurement gate)**: grep the test262 corpus for paramful
`function*(...)` EXPRESSIONS that are also lazy-eligible; the banked note
predicts ~none. If the measured population is <10 files, mark W2 wont-build
and move to W4.

**If built**: at creation time, spill call args into ref cells appended to
the closure struct — but do NOT add a second struct instance. Simpler
concrete shape than the banked sketch: extend `computeClosureWrapperSig`'s
generator arm so a lazy-eligible paramful generator expression's lifted func
reads its params from CAPTURE FIELDS instead of wasm params (compile-time
rewrite: params become synthetic captures initialized at creation), making
the thunk re-invocation `__call_fn_0`-compatible (zero wasm params) with no
host/ABI change. Gate `genLazyEligible` on "all params spillable"
(spill-safe types only, the #2906 rule).

**Reuse**: the ref-cell capture machinery in closures.ts (the mutable
closure-capture struct fields — `struct (field $value (mut T))`), the
Slice-1 wrap, `__call_fn_0`.

### W4 pointer (banked, unchanged)

class-bodies.ts:2309 is the method-generator eager arm; param
instantiation must stay OUTSIDE the flag branch (spec: param defaults run at
call). Not a pure wrap — do after W3.

### Acceptance per wave

- Probe battery v10-v17 green; creation runs NOTHING (side-effect counter
  0 before first `next()`).
- `JS2WASM_TAG5_CLASSIFIER=1` A/B on the dstr/class cluster: unmasked
  vacuous passes become genuine (net ≥ 0 per wave vs the classifier-off
  baseline).
- gc/host lane: no regression on the generator suites
  (`gen-func-expr-args-trailing-comma-*`, `iter-val-array-prototype` — the
  two PR-#2625 regression buckets must stay green).
