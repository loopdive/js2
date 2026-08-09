---
id: 3032
title: "Lazy-first-resume generator thunks: stop running eager-buffer generator bodies at creation (unblocks #2141 S3 / #2626 classifier)"
status: ready
sprint: current
created: 2026-07-04
priority: high
feasibility: hard
model: fable
reasoning_effort: max
horizon: xl
task_type: bugfix
area: codegen, runtime, generators, value-rep
language_feature: generators, destructuring defaults, equality
goal: test262-conformance
related: [2141, 2626, 2040, 2585, 928, 2203, 991, 3050]
# (#3032 W3+W4) Intended growth at the canonical sites: W3 — TDZ-flag capture
# boxes threaded through the native generator state machine
# (generators-native.ts, nested-declarations.ts, context/types.ts). W4 —
# the method-generator capture-bail lane split in isNativeGeneratorCandidate
# (generators-native.ts +12: the standalone-lane arm + rationale comment).
# No barrel/driver growth.
loc-budget-allow:
  - src/codegen/generators-native.ts
  - src/codegen/statements/nested-declarations.ts
  - src/codegen/context/types.ts
  # (#3032 W6) sentinel-aware dynamic value reads for the GenState brand
  # property dispatch (+42, host-lane laziness). Intended, canonical site.
  - src/codegen/property-access-dispatch.ts
origin: "2026-07-04 #2141 S2 root-cause (fable-tag5): the −162 dstr eject was never a dstr/eq dependency — it was eager generator bodies + comparator vacuity"
note: "W3 (TDZ-native-threading) + W4 (method generators, standalone lane) LANDED (sendev-3032-w3/-w4, 2026-07-16) — see '## W3 landed' / '## W4 landed'; #3302 covered capturing fn-EXPRESSIONS in between. The A1/tag-5-vacuity unblock is fully delivered on the standalone side. Remaining banked waves: W2 (paramful gen expressions — MEASURE FIRST, predicted wont-build), W5 (retVal marshalling), W6 (retire the buffer / host-lane laziness; next(v) two-way under the buffer stays broken until W6). Issue stays open for those."
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
   `this`/`super` — reuse `closureBodyUsesArguments` +
   `genBodyReferencesThis`, both already exported for the :2886 gate), PLUS
   `parameters.length === 0` until W2 lands.

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

## W3 — CORRECTED ROUTE + THE REAL BLOCKER (sendev-3032, 2026-07-14, empirically verified against `origin/main @ f1c9069`)

The 2026-07-12 Implementation Plan above is **materially wrong about the
code** — do not follow its file anchors. Corrected, all verified by probe +
source trace:

### 1. The plan's anchors are stale

- The plan asserts "**There is no `nested-declarations.ts`** — the W3 note's
  pointer is stale; the eager path for nested named generators is the
  function-body.ts arm." **FALSE.** `src/codegen/statements/nested-declarations.ts`
  exists (2726 lines) and IS the target. `function-body.ts` :1041-1128 is the
  path for **top-level** generator declarations, and in standalone/wasi its
  non-native arm `reportError`s — it is NOT where nested capturing generators
  land.
- A **capturing** nested named generator (`function* g(){...}` inside
  `export function test()`) routes through `compileNestedFunctionDeclaration`
  → the **has-captures branch** (`nested-declarations.ts` ~:771), whose
  generator arm is an **eager-buffer** (`__gen_create_buffer` +
  `__create_generator`, ~:990) that runs the WHOLE body at creation. Probe
  (`function* g(){ iterations+=1; yield 1; iterations+=1 }`, read `iterations`
  before the first `next()`): returns **202, must be 1** — on BOTH host AND
  standalone. That is the §27.5 violation / eager-generator vacuity.
- The has-captures path is **direct-call-with-leading-capture-params**
  (`ctx.nestedFuncCaptures`), NOT a closure struct. So the plan's route (a-i)
  "route through `compileArrowAsClosure`'s generator branch" and the
  `__create_generator(<self>, null)` thunk model **do not apply** here — there
  is no `__self` closure to hand as a thunk.

### 2. The genuinely-lazy fix + the exact blocker

The right mechanism already exists: **#3050's `capturingNativeGen`** — the
native generator state machine with captures riding as leading synthetic
params. Native generators suspend at start (lazy by construction), so they fix
202→1 for free, host-free, in both modes. Two gates block the dominant shape:

- `nested-declarations.ts` ~:817-823 requires `bodyHasNewTryRegionAcrossYield(stmt)`.
  Relaxing that for the standalone lane (`ctx.standalone || ctx.wasi`) is
  **safe** and lets non-try-region native-candidate capturing generators go
  native. Host lane stays byte-identical: `isNativeGeneratorCandidate`
  (`generators-native.ts` :1637-1665) internally still requires a try-region
  under a JS host, so a non-try-region capturing generator keeps the host
  eager path there. **Verified:** with the relaxation, standalone
  `candidate=true`, host `candidate=false` (clean split).
- **THE REAL BLOCKER:** the same gate also requires
  `tdzFlaggedCaptures.length === 0`. The dominant shape captures `let`/`const`
  bindings, which are **TDZ-flagged** (`hasTdzFlag`), so the relaxation is
  **corpus-vacuous** for the real population. #3050 gated `=== 0` because the
  native state-struct param model + resume function **do not thread TDZ flag
  boxes** ("flag-box plumbing not modeled in the resume fn — a separate,
  larger change, reasoning_effort:max", `nested-declarations.ts` :810).

### 3. Concrete implementation plan for the TDZ-native-threading extension (next session, a FULL fresh window)

The value-capture machinery (#3050) is the template; TDZ flag boxes are
structurally identical `ref $cell`-of-i32 params. Thread them the same way:

1. `nested-declarations.ts` has-captures gate: replace `tdzFlaggedCaptures.length === 0`
   with a standalone-lane arm that INCLUDES the tdz flags, and pass them to
   `registerNativeGenerator` (a new `leadingTdzFlags?: {name, refCellTypeIdx}[]`
   arg, or extend `leadingCaptures`). Note `allParamTypes` already =
   `[valueCaps, tdzFlags, userParams]` (:798-799) — the fix must make
   `paramNames`/`leadingCaptureCount` agree with that ordering.
2. `registerNativeGenerator` (`generators-native.ts` :1962): insert the tdz
   flag names into `paramNames` between `captureNames` and `userParamNames`
   (so `param_*` state fields exist + align with `allParamTypes`), and carry a
   `leadingTdzFlagCells` list on `NativeGeneratorInfo`.
3. Resume function (`generators-native.ts` ~:3300-3345): after the value-capture
   `boxedCaptures` registration (:3314), register each tdz flag box in
   `resumeFctx.boxedTdzFlags` + `tdzFlagLocals` (map name → {refCellTypeIdx,
   localIdx of its `param_*` local}). Update `thisOffset`/`leadingCaptureCount`
   (:3343) to include the tdz flag count so pattern-param offsets stay correct.
4. Confirm the TDZ-checked identifier reads inside the body
   (`emitLocalTdzCheck`, expressions/identifiers.ts) resolve through
   `resumeFctx.boxedTdzFlags` (they only do `local.get flagBox; struct.get`, so
   a param-slot flag box works — same as the lifted-closure path at
   `nested-declarations.ts` :937-950).

**Validation:** probes must show V1 (lazy: `iterations` before `next()` == 0,
return 1) and V2 (drain a capturing generator: correct values) green on host
AND standalone; the #3050 try-region tests + a no-capture control stay
byte-identical; **merge_group standalone-floor is the decider** (broad-impact,
native-generator internals — do NOT trust scoped CI). Host lane must be
byte-identical (`prove-emit-identity`) — the standalone-only gate arm
guarantees it.

**Risk:** HIGH-floor, native-generator machinery, ~4-6 tightly-coupled offset
sites; a subtle `param_*`/offset misalignment only surfaces in merge_group.
Budget it as a full fresh window, not a tail slice.

## W3 landed (sendev-3032-w3, 2026-07-16, branch `issue-3032-tdz-native-threading`)

Implemented exactly the corrected route above, plus one root-cause fix the
work exposed. Spec basis: ECMA-262 §27.5.3.1-3 — EvaluateGeneratorBody
performs GeneratorStart, which SUSPENDS the generator at the start of its
body; no body statement may run until the first `next()`, and
GeneratorResumeAbrupt on `suspendedStart` never runs the body at all. Native
state-machine generators satisfy this by construction; the eager buffer
cannot.

### What changed (4 files + tests)

1. **`src/codegen/statements/nested-declarations.ts`** — the has-captures
   capturingNativeGen gate is now lane-split:
   `(standalone || (tdz===0 && tryRegion)) && isNativeGeneratorCandidate`.
   Standalone/WASI is candidate-gated ONLY (matching the no-captures branch,
   which never had a try-region gate at its call site); the JS-host lane is
   byte-identical to #3050. TDZ-flag boxes ride as additional leading
   `NativeGeneratorCaptureParam` entries (`{name: "__tdz_box_<n>",
tdzFlagFor: n}`) appended AFTER the value captures — aligned with
   `allParamTypes`'s `[valueCaps, tdzFlagBoxes, userParams]` (#1205 Stage 3)
   layout, which the call-site `nestedFuncCaptures` prepend already produces.
   NO call-site changes were needed: the factory IS the lifted function.
2. **`src/codegen/generators-native.ts`** — `NativeGeneratorCaptureParam`
   gained `tdzFlagFor`; `registerNativeGenerator` records
   `leadingTdzFlags: {name, paramIdx}[]` on the info (paramIdx = position in
   leadingCaptures ⇒ `paramNames`/`paramTypes` index; `leadingCaptureCount`
   naturally includes the flag boxes so `thisOffset`/pattern-param offsets
   stay aligned — the exact misalignment #3050 gated `=== 0` against). The
   resume fn registers each rehydrated flag-box param local in
   `resumeFctx.boxedTdzFlags` + `tdzFlagLocals` under the ORIGINAL captured
   name (refCellTypeIdx read from the param's own ValType, so it always
   matches the state-struct field). `emitLocalTdzCheck`/`emitLocalTdzInit`
   consumers need no changes — they already deref `boxedTdzFlags` boxes.
3. **`src/codegen/context/types.ts`** — `NativeGeneratorInfo.leadingTdzFlags`.
4. **`src/codegen/context/locals.ts` — THE ROOT-CAUSE FIX the work exposed
   (#1847/#1919 lineage, pre-existing in BOTH lanes):** `restoreLocals`
   restored `localMap` + `boxedCaptures` but NOT
   `boxedTdzFlags`/`tdzFlagLocals`. The call-site TDZ-flag prepend
   (call-identifier.ts fresh-box arm) allocates a `__tdz_box_<n>` local and
   RE-AIMS both maps at it — the same mutation class as closure-capture
   boxing (#2029), on maps the snapshot didn't cover. A rolled-back
   speculative probe (e.g. the for-of subject probe) left both maps aimed at
   truncated slots; the committed re-compile's `existing` branch then baked
   `local.get <stale slot>` — re-allocated later at a different type →
   invalid wasm. Verified pre-existing on main in BOTH lanes for
   `for (const v of g())` over a TDZ-capturing nested generator (host:
   `any.convert_extern[0] expected externref, found anyref`; branch pre-fix:
   `call[3] expected (ref null $cell<i32>)`). `LocalsSnapshot` now carries
   exact `tdzBoxEntries`/`tdzFlagEntries` and `restoreLocals` restores both
   maps to their exact snapshot state.

### Validation (local; merge_group standalone-floor is still the decider)

- Probe battery (`.tmp` probes, both lanes, branch vs main): V1 lazy-creation
  201→**1** (standalone), V3 first-resume 111→**11** (standalone), V2
  for-of drain+captures INVALID-WASM→**233** (BOTH lanes — the locals.ts
  fix), V4 no-capture control 3→3, host lane V1/V3 byte-identical (still
  eager — deliberate).
- `tests/issue-3032-w3-tdz-native-threading.test.ts` — 10/10 (lazy creation,
  first-resume ordering, drain+capture-write propagation, TDZ
  init-then-drain, try-region+TDZ capture laziness, `next(v)` two-way with a
  TDZ capture).
- Scoped test262 sweep (GeneratorPrototype + statements/expressions/
  generators + GeneratorFunction, 640 files): **standalone +15 net (15
  fail→pass, 0 pass→fail)** — GeneratorPrototype/return/try-\* +
  from-state-suspended-start + the gen dstr elision clusters; **gc lane 0
  diffs** vs main.
- Canary battery 32/32 pass (dstr `ary-ptrn-empty` family both lanes, PR-#2625
  regression buckets `gen-func-expr-args-trailing-comma-*`, #3050
  GeneratorPrototype/throw/try-\*).
- Suites: issue-3050/2203/1177/1847/1919/2029-tagged-template/tdz-\* +
  generator suites — green (the one `generator-yield-contexts` fn-expr
  failure reproduces identically on clean main: a slice-1 setExports harness
  wiring gap, NOT this change).

### Adjacent pre-existing bugs found (verified identical on clean main — NOT regressions, follow-up candidates)

1. **try/catch around a TDZ-read/TDZ-call → null-pointer trap** (both lanes):
   `try { const it = probe(); it.next(); } catch {}` with `probe` capturing a
   TDZ `let` traps instead of throwing catchable ReferenceError.
2. **Creation-before-init pre-call static TDZ throw**: `const it = probe();
let x = 42; it.next()` throws at CREATION (the #1177 pre-call check — an
   eager-era approximation). Under lazy §27.5 creation must not throw; the
   flag-box read at first resume already handles the TDZ case correctly.
   Fix = suppress the pre-call TDZ check when the callee is a registered
   native generator factory. Small, scoped follow-up.
3. **`(yield e) as T` initializer** doesn't match the plan builder's
   resume-binding pattern — `next(v)` sent value reads 0. The untyped-cast
   shape only; `const got = yield e` in a typed generator works.

## W4 landed (sendev-3032-w4, 2026-07-16, branch `issue-3032-w4-method-generators`)

**One gate-term change.** The banked W4 plan ("class-bodies.ts:2309 eager arm
wrap; not a pure wrap — param instantiation stays outside the flag branch")
described the HOST-lane thunk route. The standalone lane turned out to need
NO wrap and NO capture threading at all:

- **The insight (verified by probe before relaxing anything):** a class /
  object-literal method body never receives captures as params — it resolves
  them through the #2029/#3039/#3121 promotion machinery
  (`ctx.capturedBoxGlobals` / `ctx.capturedGlobals` MODULE GLOBALS), which is
  fctx-INDEPENDENT. So the resume function compiles the same body statements
  with the same global reads/writes — the #2571 native method machinery
  (synthesizedThis + state struct) works unchanged for capturing methods.
- **Change:** `isNativeGeneratorCandidate`'s method-bail
  (`generatorCapturesOuterScope` term) is now HOST-lane-only. `arguments` /
  `super` bails stay. JS-host lane byte-identical — method generators are
  never candidates under a JS host anyway (the host-lane candidate block
  admits only FunctionDeclarations), so its eager path is untouched.
- Promotion ordering holds: capturing classes/literals compile DEFERRED in
  standalone until captures initialize (#3123), so the globals exist before
  the resume fn emits.

**Validation:** probes — class/objlit method with `let` capture: standalone
101→**1** (lazy, §27.5), 4→**0** `__gen_*` imports, `instantiate({})`
FAIL→**OK**; objlit drain NaN→**233** (write-through); capture+this 316;
capture+param 107; static 74; `next(7)`→107 two-way; try/finally+capture
1111; two-methods 12. `tests/issue-3032-w4-method-generators.test.ts` 11/11.
Method suites (2571/2581/2938/2641/generator-methods/-destructuring/3050)
57/57 — the two #2571/#2581 tests that ASSERTED the old capture-bail now
assert the native lowering. **gen-meth dstr family A/B (930 files, standalone,
branch vs main): exactly ZERO flips either direction** — the family's pass
rate is shim-neutral (the runner supplies `__gen_*` shims), so W4's win is
the leak metric (host-free instantiate) + §27.5 laziness, with **no
regressions**.

**Known same-wrong, different-mode:** a TDZ/promotion-timing shape
(`class C { *m() { yield z; } } const z = 42;` — class compiled before `z`
initializes) read a stale NaN via the value-global on main (both lanes,
silent); the native path now throws a loud TDZ ReferenceError at first
resume in standalone. Neither matches spec (42) — the promotion-timing
limitation predates W4 (#3123 lineage), surfaced loudly instead of silently.

**Remaining after W4:** W2 (paramful gen EXPRESSIONS — measure-first,
predicted wont-build), W5 (retVal marshalling), W6 (retire the buffer —
host-lane laziness for the shapes the thunk model doesn't cover; `next(v)`
two-way under the buffer stays broken until then). The tag-5/A1 unblock is
fully delivered by W3+#3302+W4 on the standalone side.

## W6 slice A — HOST-lane declarations go native (sendev-3032-w6, 2026-07-18, branch `issue-3032-w6-host-lane-laziness`)

### W2 + W5 dispositions (measured this wave)

- **W2 = wont-build, confirmed.** Corpus measurement per the plan's Step-0
  gate: 250 raw grep hits for paramful `function*(…)` EXPRESSIONS collapse to
  13 files once skipped categories (eval-code / Proxy / staging / annexB) and
  `arguments`-dependent tests are excluded — and those 13 are syntax/scope
  tests (no-yield, yield-as-parameter, length-dflt, use-strict…), not
  laziness-sensitive. Population < 10 ⇒ wont-build.
- **W5 = already delivered en route (W3/W4 native routing).** Probes on both
  lanes: `return 9` observation → 1009, `it.return(42).value` → 1042 (after
  `next()` AND before start). Pinned by tests in this branch. The
  `__gen_result_value_f64` shim already carries the `__sget_value` fallback.

### The change (this branch)

1. **`src/codegen/generators-native.ts` — host arm of
   `isNativeGeneratorCandidate`**: dropped the #3050 `bodyHasNewTryRegionAcrossYield`
   restriction — every free `function*` DECLARATION passing the safety walks
   routes native under the JS host (lazy §27.5 + `next(v)` two-way). New
   host-arm bails (each root-caused, see below): export-modifier bail;
   `bodyHasHostUnsupportedYieldShape` (nested-yield-operand + `yield*`).
2. **`src/codegen/statements/nested-declarations.ts`** — capturing-gen gate is
   now candidate-only in BOTH lanes (host `tdz===0 && tryRegion` restriction
   dropped; the W3 TDZ-flag threading is lane-agnostic and now rides on host).
3. **Class-A host fix — sentinel canonicalization produces REAL host
   `undefined`**: `sentinelAwareF64BoxInstrs` gained an `undefinedInstrs`
   param (default null-extern = standalone canonical, byte-identical there);
   host callers pass `call __get_undefined`. Wired in
   `buildOpenResultValueReadExtern` (generators-native-consumer.ts,
   ensure+flush at build) and the member-get `value` dispatcher
   (member-get-dispatch.ts — `__get_undefined` registered at RESERVE for
   `value` dispatchers only; fill stays funcMap-read-only).
4. **Use-site walk extensions** (`hostLaneGeneratorUsesAreSafe`):
   result-binding tracking (`resultConsumptionIsSafe`/`resultBindingUsesAreSafe`
   — a `.next()` result escaping to a call argument / reflection bails) and
   the re-entrant bail (instance binding referenced INSIDE the generator's own
   body bails — from-state-executing).
5. **tests/helpers/compile.ts** — `compileAndRunInstance` now wires
   `setExports` (the documented slice-1 thunk contract); fixes the
   pre-existing `generator-yield-contexts` fn-expr failure.

### The 6-regression root-cause map (640-file host sweep, branch-pre-fixes vs main: +8/−6)

All 6 verified against the REFRESHED standalone baseline
(`test262-standalone-current.jsonl`, 24,961 pass — NOT `runs/<sha>.jsonl`,
which is the HOST lane, a trap): every one except yield-star-before-newline is
a pre-existing native-machine gap already failing on standalone.

- `yield-as-statement` — done-result `.value` read null-extern (JS `null` ≠
  `undefined`) → FIXED on host (class A, item 3). Standalone unchanged
  (same-wrong as its baseline).
- `result-prototype` — result struct escaped to
  `hasOwnProperty.call`/`getPrototypeOf` → walk bails it (class C, item 4).
- `yield-as-yield-operand` — native plan collapses `yield yield 1` (first
  `next()` → 0, must be 1); BOTH-lane pre-existing miscompile → host bails
  (class D); standalone keeps its baseline behavior. Machine fix = follow-up.
- `return|throw/from-state-executing` — re-entrant `iter.return(42)` inside
  the body dispatches a raw state struct to the host shim → walk bails (class
  E, item 4).
- `yield-star-before-newline` — host resume fn delegates `yield*` through
  `__iterator` and traps on a host-side delegate (standalone passes natively;
  host-resume-specific) → host bails `yield*` bodies (class F). Machine fix =
  follow-up.

### Two more root-cause fixes the sweep exposed (both-lane, pre-existing)

1. **Nominal `__GenBrand_n` state-struct brands.** Two generators with
   same-shape bodies mint structurally IDENTICAL `$__GenState_*` structs;
   WasmGC iso-recursive canonicalization merges them, so every
   `ref.test`-keyed dispatch arm (open method dispatch, iterator-carrier
   GENSTATE step) resumed the FIRST-registered generator's resume fn on the
   OTHER's state (`iter = g2(); iter.next().value` read g1's `undefined` —
   generators/yield-as-statement.js, BOTH lanes). Fix: each state struct
   declares a DISTINCT empty supertype from a per-module brand CHAIN
   (`__GenBrand_0` open no-parent; `__GenBrand_n` sub of `__GenBrand_{n-1}` —
   depth-distinct), defeating canonicalization type-level only (no
   layout/operand changes; every ref.test site becomes nominally precise).
2. **Sentinel-aware dynamic `.value` reads (3 more sites).** The UNDEF_F64
   absent/done marker leaked as boxed NaN (or JS `null` via null-extern)
   through the INLINE struct fast chain (property-access-dispatch), the
   `__sget_value` export (the `_safeGet`/`__gen_result_value`-shim fallback),
   and `buildOpenResultValueReadExtern`. All three now canonicalize sentinel →
   REAL host `undefined` (`__get_undefined`; registered at reserve for the
   member-get `value` dispatcher — fills stay funcMap-read-only). Standalone
   keeps null-extern (its canonical undefined) byte-identically.

### Validation (final, at merge-base 4878d711c after upstream catch-up)

- 640-file generator-scope sweep, HOST lane: **512 vs 504 — +8, 0 regressions**
  (the whole GeneratorPrototype/return/try-\* family + from-state-suspended-start).
- Same scope, STANDALONE lane: **148 vs 145 — +3, 0 regressions**
  (yield-as-statement ×2 + expressions/return.js flip genuine via the brand fix).
- Unit batteries: 35 files / 283 tests green (generators, 3050, w3, w4, 2203,
  928, 2169/2170/2171/2172/2173, 2571/2581/2938, method-destructuring, iife).
- New suite `tests/issue-3032-w6-host-lane-laziness.test.ts` (17 tests): §27.5
  lazy creation, next(v) two-way, return/throw-before-start, W5 pins, export
  boundary, brand cross-dispatch, sentinel-undefined reads.
- The real test262 yield-as-statement file through `wrapTest` returns PASS.
- merge_group (host shard diff + standalone floor) is the final decider —
  broad-impact (every safe-use host generator declaration flips lowering).

### Follow-up candidates (host-arm-bailed here, machine fixes later)

- `yield (… yield …)` nested-operand plan collapse (first `next()` yields the
  wrong value; both lanes; standalone-baseline-accounted).
- Host-lane resume `yield*` delegation to host-side delegates traps
  (`illegal cast` in `__iterator`; standalone native→native works).
- Re-entrant instance use inside the generator's own body rides an
  any-capture cell → host shim gets a raw state struct
  (from-state-executing; now walk-bailed).
- Host-lane fn-EXPRESSIONS still ride the slice-1 thunk (next(v) two-way
  broken there until they route native — next W6 slice); METHOD generators
  still host-eager under a JS host.
