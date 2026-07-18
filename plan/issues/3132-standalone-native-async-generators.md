---
id: 3132
title: "Standalone native ASYNC GENERATORS — retire env::__create_async_generator leaky-passes (~2,800 files)"
status: done
completed: 2026-07-16
sprint: current
priority: high
feasibility: hard
reasoning_effort: high
task_type: feature
area: codegen
language_feature: async-generators, yield-star, iterator-protocol
goal: standalone-mode
horizon: xl
umbrella: 2860
related: [3075, 2906, 2865, 2938, 2936, 2980, 2895, 2922, 1042, 3120, 3312, 3313]
created: 2026-07-10
updated: 2026-07-16
assignee: ttraenkler/fable-3132-s2
loc-budget-allow:
  - src/codegen/class-bodies.ts
  - src/codegen/async-cps.ts
  - src/codegen/expressions.ts
  - src/codegen/async-frame.ts
  - src/codegen/expressions/calls.ts
  - src/codegen/declarations.ts
  - src/codegen/context/types.ts
  - src/codegen/async-scheduler.ts
  - src/codegen/closures.ts
  - src/codegen/literals.ts
  - src/codegen/declarations/import-collector.ts
origin: "FABLE task 30 — env::__create_async_generator touches ~2,800 leaky-passes (largest unowned chunk of the standalone-vs-host gap)."
---

# #3132 — standalone native async generators

## Slice — async-gen binding-PATTERN params (PR #3011, opus-asyncgen2)

Substrate PR (decoupled). `isAsyncGenDriveCandidate` hard-rejected any
binding-pattern param (`async function* f([x]){…}`) → the whole module hit the
#680 native-gen refusal in standalone. Fix threads the #2967
`collectDerivedPatternParams` → `derivedSpillInit` machinery (already used by
the async-FUNCTION path) into `emitAsyncGenerator`, capturing pattern-param
locals as live frame spill fields; the resume fn restores them by name.
Consumer half: `tryEmitAsyncGenNextDispatch` drops the host `__gen_next`
miss-arm on standalone (not just wasi) when no legacy buffer async gen was
emitted — the dispatch is type-gated to async-gen receivers so the arm is
provably dead in an all-driven module (mirrors #2903's `.then` de-leak).

Measured (compile, all 558 `async-generator/dstr` files, standalone): main 174
hard #680 CE + 348 `__gen_`-leaky, 0 gen-host-free → 0 CE, 522 error-free, 498
gen-host-free. **Floor delta ≈ 0** (converted modules still leak
`env::Promise_resolve/Promise_reject/__get_caught_exception`) — value is
retiring the 174 hard CEs + providing the driven substrate. NET≥0 on the floor.

## Stacked follow-on — the actual floor lever (PR-2, measure-gated)

The host-free floor flip is blocked on `widenAsyncGenFallback`
(async-scheduler.ts): `isStandalonePromiseActive = wasi || (standalone &&
!moduleHasAsyncGen)` disables the native `$Promise` carrier for ANY module with
an async gen (#2980's conservative fallback — native `$Promise` mixing into a
host `__gen_*` buffer caused the 07-09 −4). A driven module has NO legacy
buffer, so the carrier is safe there. PR-2 refines the fallback via a
CONSERVATIVE pre-pass drive-candidate gate: keep the carrier ON only when ALL a
module's async gens are provably drive-lowered. Carrier-on ceiling measured
~294 fully host-free; a further ~204-file `env::__make_callback`
(`.then`-callback) front sits beyond the carrier (a later slice). PR-2 gate is
go/no-go on a FULL merge_group standalone-floor A/B, routed through the tech
lead — never a scoped measurement.

## Problem

Async generators under `--target standalone` mostly bail to the **legacy
eager-buffer HOST runtime** (`env::__create_async_generator` + the `__gen_*`
bundle, via `sourceNeedsGeneratorHostImports`). The affected tests PASS with
host imports supplied (leaky-passes — after #3075's HOSTGEN consumer arm), but
are **not host-free**, so they do not count toward the standalone floor.
~2,800 files carry the leak.

The driven native producer (#2906 3d-i / #2865: `emitAsyncGenerator`, the
`$AsyncFrame` carrier + per-gen `__async_gen_next_<stem>` driver) exists but
its admission gate (`analyzeAsyncGen` in async-cps.ts) accepts only flat
top-level plain yields, and only for function DECLARATIONS + EXPRESSIONS.

## Measured decomposition (2026-07-10, static AST scan of all 3,955 corpus files with async-gen syntax; 4,460 decls)

| construct (by FILE)                                                          | files                 | native today?                                     | slice            |
| ---------------------------------------------------------------------------- | --------------------- | ------------------------------------------------- | ---------------- |
| `method:zero-yield` (class/obj-literal `async *m() {}` — assert-only bodies) | 1,725                 | NO — class-bodies/literals not wired to the drive | **S2**           |
| `zero-yield` / `plain-yields` fn decl/expr                                   | 991 + 37 + 82(method) | fn decl/expr YES (driven); methods NO             | (fn ok) / S2     |
| `method:yield*-non-literal`                                                  | 554                   | NO                                                | S3               |
| **`yield*-array-literal` (statically unrollable)**                           | **392**               | NO — `analyzeAsyncGen` rejects every `yield*`     | **S1 (this PR)** |
| `method:has-return` / `has-return`                                           | 172 + 5               | NO (needs settleReturn)                           | S4               |
| `nested-suspend` (control flow)                                              | 90 + 17               | NO (CFG loop states)                              | S3               |
| `yield*-non-literal` fn                                                      | 37                    | NO                                                | S3               |
| `yield-await`                                                                | 3                     | carrier lane only (#2980/#3120)                   | —                |

Verified leak probes (compile → import set): `(async function*(){ yield* [[1]] })()`
leaks `__gen_create_buffer,__gen_yield_star,__create_async_generator`;
`class C { async *m() {} }` leaks; zero-/plain-yield fn decls & exprs are
already host-free (driven).

## Slice 1 (this PR) — `yield*` array-literal unroll + native frame-carrier consumer

Two halves, mirroring #3075's producer/consumer split:

1. **Producer** (`analyzeAsyncGen`, async-cps.ts): accept a top-level
   `yield* [e1, e2, …]` whose elements are suspend-free and non-spread by
   statically unrolling it into per-element plain-yield segments (an elision
   hole ⇒ `yield;` ⇒ undefined — matching §27.5.3 yield* over an array, which
   only forwards `done:false` values). Everything else (`yield*`of a
non-literal, spread elements, nested suspends) keeps the legacy path —
correct-or-legacy. The single-source-of-truth gate propagates automatically
to`isBoundedAsyncGenBody`/`isAwaitFreeAsyncGenBody`/`isAsyncGenDriveCandidate`/`sourceNeedsGeneratorHostImports`, so the
   host-import leak disappears exactly for the newly-admitted bodies.
2. **Consumer** (`iterator-native.ts` fill): an `ITER_KIND_ASYNCGEN` IterRec
   arm — the follow-up banked in #3075. A DRIVEN async-gen frame carrier
   consumed through an identifier (`var it = g(); for await (const [x] of it)`)
   or any dstr binding falls to the legacy sync `__iterator` lowering (the
   3d-ii CFG consumer rejects patterns), which today hard-cast traps on the
   frame struct. Fill a per-producer type-switch over
   `ctx.asyncGenProducers` (stateTypeIdx → `__async_gen_next_<stem>`):
   `__iterator` wraps the frame in an ASYNCGEN record; `__iterator_next`
   calls the matching next-driver, requires the minted `$Promise` FULFILLED
   (await-free producers settle synchronously; pending ⇒ loud trap, unchanged
   failure mode), and reads done/value from the `$IteratorResult` struct.

## Banked slices

- **S2 — async-gen METHODS** (biggest bucket, 1,725+ files): wire class-bodies
  / object-literal method emit into `emitAsyncGenerator` the way #2865 wired
  fn expressions; needs receiver/`this` threading into the frame
  (`readsCurrentThis`). CAUTION: #2938's relax found the class-STATIC sync-gen
  emit path broken — audit the static path before admitting methods.
  - **S2 audit (2026-07-10, fable-3075)**: class methods branch at
    class-bodies.ts ~2258 (`isGeneratorMethod && nativeGenInfo` → native sync
    factory; else legacy buffer). An async route would sit BEFORE the legacy
    buffer arm: `isAsyncMethod && isAsyncGenDriveCandidate(ctx, member)` →
    `emitAsyncGenerator(ctx, fctx, member)`. Open questions: (a) instance
    methods carry the receiver as fctx param 0 — `buildAsyncFrameInfo`
    captures fctx.params into frame param fields, but the RESUME body's
    `this` resolution against a frame field is unproven; start with the
    bounded no-`this`/no-`super`/no-`arguments`/no-capture subset (covers the
    assert-only zero-yield corpus bodies); (b) stem naming/collision — the
    producer registry keys `sanitizeTypeName(asyncFnName(decl))`, which must
    be the `${className}_${methodName}` funcMap key for methods; (c) the
    duplicate-name / computed-name method hazards from #2938 apply verbatim.
    Object-literal methods (literals.ts ~2854) additionally run through the
    closure trampoline — audit `__argc_default` interplay (#2581) first.
  - **S2a SHIPPED (2026-07-10, follow-up PR)**: the receiver-free CLASS-method
    subset (`!genBodyReferencesThis && !bodyUsesArguments &&
isAsyncGenDriveCandidate`) routes through `emitAsyncGenerator` — covers
    the zero-/plain-yield and (with S1) `yield*`-literal method bodies,
    instance AND static, host-free. Probes: zero-yield/plain/static/yield\*
    methods correct with zero gen imports; `this`-reading bodies stay legacy.
    Scans (class/elements async-gen n=10, expressions/async-generator n=31)
    identical to control. REMAINING for full S2: receiver-threading
    (`this`-reading bodies) + object-literal methods (trampoline audit).
- **S3 — general `yield*` / control-flow yields**: CFG loop states over the
  native `__iterator` protocol (runtime loop, not static unroll).
- **S4 — `return` in async-gen body**: needs a settleReturn terminator.

## S2/S3/S4 PRODUCER-runtime slice spec (2026-07-13, opus-asyncgen2, post-carrier)

Context: after PR-1 #3011 (pattern-param producer + `.next()` de-leak) and PR-2
#3013 (native `$Promise` carrier for all-drivable modules), the `.then`-callback
`__make_callback` front is CLOSED (stale-baseline artifact — the native `.then`
scheduler `emitStandalonePromiseThen` already routes callbacks host-free; verified
live by opus-asyncthen). The remaining `__gen_*`/`__create_async_generator`
PRODUCER-runtime leak in the async-gen/dstr corpus is **~76 files**, in three
disjoint drive-shape gaps. Each is a self-contained slice a fresh agent can own.
Owner of the drive machinery: opus-asyncgen2 (PR-1/PR-2) — ping to pair.

**Important carrier interaction (read first):** a non-drivable async gen in a
module now forces `moduleHasNonDrivableAsyncGen=true` → the whole module's native
`$Promise` carrier goes OFF (host Promise pipeline). So each slice below is
DOUBLE-valued: it removes the gen's own `__gen_*` leak AND (by making the gen
drivable) lets its module keep the carrier → also drops that module's
`env::Promise_*` leak. Extend `asyncGenDrivableUnderCarrier` (async-frame.ts) in
lockstep with the emit gate so the pre-pass verdict stays == the emit decision
(the invariant that guarantees no native-`$Promise`-into-host-buffer mix).

### S2 — async-gen METHODS (remaining after S2a)
- **Leak sites**: class methods that touch `this`/`super`/`arguments` fall to
  the legacy buffer — the exclusion is at `class-bodies.ts:2328`
  (`!genBodyReferencesThis(member.body) && !bodyUsesArguments(member.body)` gate
  in front of `emitAsyncGenerator`). OBJECT-LITERAL async-gen methods are
  entirely unwired: `literals.ts:~2959` (`isGeneratorMethod && prop.body`) has NO
  drive interception at all — it always emits `__create_async_generator`
  (`literals.ts:3008`). Same for the closure-trampoline path (`closures.ts:3076`).
- **Root cause**: the resume fn is a fresh lifted function; a `this`-reading body
  needs the receiver captured into the frame and re-materialized in the resume
  prologue. S2a shipped the receiver-FREE subset only.
- **Native approach**: (i) receiver threading — capture the receiver (instance
  method's fctx param 0) into a frame param field and resolve `this` in the
  resume body against it, reusing the `readsCurrentThis`/`selfCaptureLayout`
  machinery `emitAsyncGenerator` ALREADY threads for nested-closure producers
  (async-frame.ts, `info.readsCurrentThis`/`info.selfCaptureLayout`). Lift the
  `!genBodyReferencesThis` half of the gate once `this` resolves. (ii)
  object-literal methods — wire `literals.ts:~2959` to the same
  `isAsyncGenDriveCandidate` → `emitAsyncGenerator` interception as
  `class-bodies.ts:2314-2332`, AFTER auditing the `__argc_default`/closure
  trampoline interplay (#2581) and the #2938 class-STATIC / computed-name hazards.
- **Stem key**: methods must key `asyncGenStem` as `${className}_${methodName}` /
  the object-literal method's funcMap name — verify it matches the `.next()`
  dispatch registry key so the consumer resolves the driver.
- **Rough yield**: the single biggest bucket (issue's decomposition: 1,725+
  method files corpus-wide; ~part of the 76 in the dstr slice). Heaviest lift.

### S3 — non-literal `yield*` / control-flow yields
- **Leak site**: `analyzeAsyncGen` (async-cps.ts:2214) accepts `yield*` ONLY over
  an ARRAY LITERAL (static unroll, S1). A `yield*` over an iterable identifier /
  call / string, or a `yield` nested in control flow (loop/if), returns `null` →
  the gen is non-drivable → legacy buffer + `__gen_yield_star`.
- **Native approach**: a RUNTIME CFG loop over the inner (async-)iterator, not a
  static unroll — `GetAsyncIterator(operand)` at a head state, then loop {`p =
  inner.next()`; `await p`; read `{done,value}`; if `done` break; `settleYield`
  value; back-edge}. This is the DUAL of the 3d-ii consumer already built in
  async-cps.ts (`planForAwaitAsyncCfg` / the `for await` consumer CFG) — reuse
  that machine as a producer-side delegation loop. Control-flow yields need the
  general expression-level suspend numbering the bounded analyzer currently
  rejects (the `containsAwaitOrYield` lead guards) — a larger CFG generalization.
- **Rough yield**: moderate; the delegation-loop variant is bounded and reuses
  existing machinery; the general control-flow-yield variant is the big one.

### S4 — `return` completion in async-gen body
- **Leak site**: `analyzeAsyncGen` rejects any own-scope `return` —
  `containsOwnScopeReturn(st)` at async-cps.ts:2259 → non-drivable → legacy.
- **Root cause**: the async-gen CFG has only `settleUndefined` (body-end ⇒
  `{value:undefined, done:true}`) and `settleYield` terminators; there is no
  terminator that settles the result promise with a RETURN VALUE and `done:true`.
- **Native approach**: (a) admit a top-level `return E` in `analyzeAsyncGen`
  (a trailing tail segment, or a mid-body return that becomes a terminator);
  (b) add a `settleReturn` CFG terminator + emitter that settles
  `frame.result_promise` `{value: E, done: true}` (§27.6.3.8 AsyncGenerator
  return-completion — NOT the same as body fall-through, which yields
  `value:undefined`). Mind that a `return` inside a try/finally must still run
  the finally (out of scope for the first bounded slice — top-level `return E`
  only, correct-or-legacy).
- **Rough yield**: smallest, most self-contained of the three; ~172+5 has-return
  files in the corpus decomposition.

### Suggested order
Bucket-2 (dstr binding-correctness, #1042/#1048/#1543) is already dispatched to
opus-asyncthen. For this producer bucket: **S4** first (smallest, one terminator),
then **S3** delegation-loop, then **S2** receiver-threading (biggest but heaviest,
+ the #2938 static/computed audit). Each is measure-first: sample by CONSTRUCT,
verify host-free + runtime-correct on a corpus sample BEFORE PR, and confirm the
carrier stays consistent (0 invalid wasm across the async-gen corpus).

## S-consumer — async-gen CONSUMER drive (2026-07-13, opus-asyncgen)

Measure-first found the producer already drives host-free (S1/S2a); the residual
leak on the `for await (const … of <async-gen>)` files is the CONSUMER, in two
parts landed as two PRs:

- **PR-1 (foundation, #3001, merged)** — (a) `resolveAsyncGenNextHelperName`
  resolves a var-held / IIFE async-gen FRAME source (identifier → var-initializer
  → producer; `(async function*(){})()` → producer-by-decl), not only a direct
  named call; (b) `calleeIsDriveLowered` recognises the standalone async-gen
  consumer drive lane (carrier-independent, returns a native `$Promise`) so the
  CALL site skips the host `Promise_reject`/`__get_caught_exception` try/catch
  wrap. Identifier-binding var/inline/`yield*`-literal sources → host-free.
- **PR-2 (dstr composition, #3007)** — a DESTRUCTURING head over an async-gen
  source now drives natively, composing #2996/#3228's `compileForOfDestructuring`
  delivery into the async-gen consumer CFG (`forAwaitAsyncNeedsDrive` +
  `planForAwaitAsyncCfg`: drop the identifier-only guards; run `destructureElem`
  via `postDeliverEmit` on the `bodyId` state against the `FORAWAIT_ELEM`
  carrier). Flips the ~195 `async-func-dstr-*-async-*` corpus files. The
  consumer whose source is itself an async GENERATOR (`async-gen-dstr-*`, +195)
  is a harder nested shape, banked for a later slice.

## S2 SHIPPED (2026-07-16, fable-3132-s2) — receiver threading + object-literal methods + carrier lockstep

Closes the remaining S2 scope on top of S2a. Three changes:

1. **Receiver threading (class methods)** — `class-bodies.ts` gate relaxed:
   an INSTANCE method body reading/writing `this` now drives. No new frame
   machinery was needed: the receiver is the synthetic param 0 (`this`, typed
   `ref $Class`), which `emitAsyncGenerator` already captures as a frame param
   field and `ensureAsyncResumeFunction` restores BY NAME into the resume fn's
   localMap — the ThisKeyword branch (expressions.ts:1009) resolves it exactly
   as in the entry body. Still legacy (correct-or-legacy): `super` (new
   `genBodyReferencesSuper` walk in closures.ts — home-object binding not
   threaded), `arguments`, and STATIC bodies reading `this` (the
   `isStaticContext`/class-object-global fallback isn't threaded into the
   resume FunctionContext).
2. **Object-literal methods** — `literals.ts` (~2960) gained the same
   interception in front of the legacy eager-buffer arm (receiver = param 0
   `this`, same threading; captures work via the existing promote-to-globals
   path). Class expressions, nested classes/literals in functions, and the
   `emitObjectMethodAsClosure` trampoline (wraps the same funcIdx) all route
   through it.
3. **Carrier pre-pass lockstep** (`import-collector.ts`) — methods are no
   longer blanket non-drivable: a method is drivable under the same
   preconditions the emit sites apply (no super/arguments/static-this) plus
   `asyncGenDrivableUnderCarrier` + stem dedup. Drivable-method-only modules
   keep the native `$Promise` carrier → the `Promise_resolve/Promise_reject/
   __get_caught_exception` residue disappears too (probes: zero imports).
   Pre-pass ⊆ emit is preserved (emit-side skips — computed names, dedup —
   emit NO legacy buffer, so an optimistic verdict there is still mix-safe).
   PLUS a shadowed-outer-local exclusion (`methodBodyRefsShadowedOuterLocal`,
   closures.ts): the pre-existing #3312 capture-promotion bug makes a method
   body and sibling `.then` callbacks bind DIVERGENT storages when an
   enclosing fn-local shadows a module-scope name (test262's dstr
   `ary-elision-iter` template via wrapper hoisting, 16 files); such modules
   keep the host pipeline so the divergence is not newly exposed. Remove the
   guard when #3312 lands.

### S2 Test Results (2026-07-16)

- Probes (standalone): this-reading/this-writing class methods, obj-literal
  methods (plain/this/capturing), class expressions, nested classes,
  yield-await under carrier, S1×S2 compose — all host-free with correct
  values; static-this/super/arguments stay legacy; mixed drivable+legacy
  module valid (carrier off). Default JS-host lane byte-identical (SHA-equal)
  on method/obj-literal shapes.
- Targeted dstr scan (182 files: all 72 `function* g` template files + 110
  stratified): base 157 pass → S2 166 pass, **+9, zero pass→fail**.
- Broad stratified scan (190 files across expr/object, class async-gen,
  stmt/expr async-generator, for-await-of): base → S2 **+4, zero pass→fail**
  (incl. class-async-gen-this 21→23).
- Suites: issue-3132 (7, 1 pre-existing baseline failure: elision-hole),
  issue-3132-s2 (17), issue-3132-s2-consumer (7), issue-3075 (6) pass;
  issue-2865 WASI failures identical on control.
- Known pre-existing hazards found and filed: #3312 (shadowed-binding capture
  promotion, host lane affected), #3313 (same-layout $AsyncFrame
  canonicalization misdispatch, affects fn decls on main today).

**Banked follow-ups (S3/S4 remain, see sections above):** S3 general `yield*`
/ control-flow yields; S4 `return` completion. Spin out as fresh issues when
scheduled.

## Graveyard discipline

Measure-first honest yield (sample by CONSTRUCT, not directory — the #2938
542-sample lesson), carrier-gated, byte-inert for modules without the
construct, corpus-verified before PR, escalate rather than churn. The full
standalone lane runs ONLY on merge_group — treat scoped-sample green as
provisional.

## Acceptance (S1)

- `yield*`-array-literal async gens compile host-free (no `__gen_*` imports)
  and pass standalone (producer + consumer, incl. dstr bindings).
- The 392-file construct sample flips leaky-pass → host-free pass; no
  regression in either lane; modules without the construct byte-identical.

## S1 Test Results (2026-07-10, PR)

- Import-leak probes: `(async function*(){ yield* [[1]] })()` compiles with
  **zero** `__gen_*` imports (was 3-import leak); non-literal `yield*` keeps
  the legacy imports (control). Identifier-held driven-gen consumption
  (plain + dstr + obj-pattern + elision hole) returns correct values with
  zero gen imports.
- A third gate closed en route: the eager `__gen_*` bundle registration plus
  the #3075 HOSTGEN arm would have PINNED the whole bundle as referenced in
  an all-driven module — the arm now keys on the new
  `ctx.legacyGenBufferEmitted` flag (set at the four legacy buffer emit
  sites), not on funcMap import presence.
- 56-file `dstr-*-async-*` cluster sample: 33 pass / 8 vacuous / 15
  fail-other — pass count identical to the #3075 state, but the passes are
  now HOST-FREE (floor-visible) instead of leaky.
- Adjacent standalone scans exactly identical to upstream/main control:
  for-of/dstr (n=72), for-of (n=30), generators (n=9),
  Iterator.prototype.toArray (n=18), for-await-of non-dstr (n=5),
  expressions/async-generator (n=13). Host lane on the cluster (n=14)
  identical.
- Suites: issue-3132 (7), issue-3075 (6), issue-2038/3100(s4,s5)/3119 (65),
  issue-2865/2906\*/2980/3120 (52) all pass; the 5 failures in
  2865-unwrap/2906-gap3 are WASI-environment pre-existing (identical on
  control).

---

## Regression note (2026-07-18, fable-dev-2)

**Symptom.** `tests/issue-3132.test.ts` › "elision hole in the yield\* literal
delivers undefined" FAILS on current `origin/main`: `yield* [1, , 3]` consumed
by a `for await` — the middle ELISION HOLE no longer delivers `undefined` to the
consumer. Test returns `40` (n=4 from 1+3, `holeOk=0`) instead of `41` (expected
`holeOk=1` — the hole seen once as `undefined`). The hole element is either
skipped or delivered as a non-`undefined` value. n=4 is correct, so only the
hole→undefined delivery broke.

**A/B methodology (conclusive — NOT caused by #3388/#3332).** Discovered while
testing #3388 (PR #3332). Reverted ALL of #3388's changes (`async-cps.ts`,
`async-frame.ts`, `iterator-native.ts` → clean `origin/main` state via
`git checkout HEAD~2 -- …` + throw-fix removed) and re-ran: the elision-hole
test **still fails identically (40 vs 41)**. So it is a PRE-EXISTING regression
on `main`, independent of #3388. (The sibling "non-literal yield\* keeps legacy"
change in that same file IS #3388's intended behavior — that one flips with
#3388 and was updated in #3332.)

**Suspected window.** Prime suspect: **#2570 / PR #3312** (commit `37bef32f8`
"feat(#2570): lazy yield\* delegation on the driven async-generator machine",
landed 2026-07-17 ~22:47Z). #3312 reworked the exact driven-async-gen `yield*`
+ for-await consumer machinery this test exercises (the `$IteratorResult`
done/value unpack, the settleYield delivery, the ASYNCGEN carrier arm). A full
`git bisect` was NOT run (budget) — recording the window; a resumer should
confirm by checking the test at `37bef32f8^` vs `37bef32f8`. Other candidates in
the 2026-07-17 async/generator merge cluster (#3309–#3316) are secondary.

**Scope.** Narrow — only the ELISION-HOLE element of an array-literal `yield*`
consumed by `for await`. Non-hole elements (n=4) and the plain/destructuring
for-await paths are unaffected (the other #3132 consumer cases pass). Likely a
`$undefined`-singleton-vs-null mismatch in how the hole's `plain: null`
settleYield value flows through the (reworked) delivery path.

Status left `done` (the #3132 feature landed); this note flags a follow-up
regression fix. Owner: async-generator subsystem (whoever owns the #3132/#2570
bucket).
