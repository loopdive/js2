---
id: 4491
title: "ES5 standalone: Object.defineProperty/defineProperties/create residual (90 tests) — descriptor MOP semantics on the dynamic object runtime"
status: ready
sprint: current
created: 2026-08-15
updated: 2026-08-20
assignee: claude/es6-standalone-session
priority: high
horizon: m
feasibility: medium
task_type: conformance
area: codegen
es_edition: es5
goal: standalone-mode
related: [4444, 3031, 4490, 4504]
loc-budget-allow:
  - src/codegen/vec-overlay.ts
  - src/codegen/object-ops.ts
  # 2026-08-19 mirror/vec descriptor slice: a compiled array crosses the
  # externref boundary as a DETACHED __make_iterable mirror while
  # Object.defineProperty gets the RAW vec, so every recorded attribute was
  # invisible to reflective reads. The bulk went to two NEW subsystem modules
  # (src/runtime/vec-descriptor-mirror.ts, src/runtime/builtin-proto-expando.ts)
  # — +284 -> +134; the residual is call-site wiring that must live in the
  # runtime barrel at the host-import boundary.
  - src/runtime.ts
  # 2026-08-20 honest-carrier slice: emitRuntimeDescriptorGet keeps externref
  # in standalone (accessor results are runtime state; narrowing to the
  # checker's f64 turned a get:undefined redefine's canonical undefined into
  # NaN — 15.2.3.6-4-498/516/534/552 measured fail→pass).
  - src/codegen/property-access.ts
  # 2026-08-21 void-undefined slice: typeof unsound-fold guard for runtime
  # accessor keys (typeof-delete.ts), void-typed binding slot widening
  # (declarations.ts moduleGlobalWasmType arm).
  - src/codegen/typeof-delete.ts
  - src/codegen/declarations.ts
  # 2026-08-21 defineProperties/create edge slice (buckets Q + R): the
  # `Object.prototype.isPrototypeOf` reflective body is dispatched from
  # `makeGlue`'s Object arm (array-object-proto.ts, +6) and the `for…in`
  # [[Enumerable]] gate joins the existing #4222 presence gate
  # (statements/loops.ts, +26). Both bodies live in NEW modules
  # (object-proto-is-prototype-of.ts, vec-index-enumerable.ts); only the
  # dispatch/wiring is in the big files.
  - src/codegen/array-object-proto.ts
  - src/codegen/statements/loops.ts
oracle-ratchet-allow:
  # 2026-08-21: one getTypeAtLocation in varBindingNeedsExternrefForUndefined's
  # new call arm — the same raw-checker idiom as the surrounding predicate;
  # the query is a TypeFlags test (void/undefined purity) the oracle does not
  # express.
  - src/codegen/index.ts
  # 2026-08-21 (regression fix): the module-global consult was narrowed to an
  # INLINE void-call check in moduleGlobalWasmType (the full predicate's
  # void-0/#4206 arms regressed the filter harness family) — same TypeFlags
  # purity query, same rationale.
  - src/codegen/declarations.ts
func-budget-allow:
  # 2026-08-21 defineProperties/create edge slice: the `Properties`-map entry
  # model gains a PASS-THROUGH arm (a map entry that is not an object literal)
  # plus the reified-map construction. Already 724 LOC at base — the growth is
  # in the existing `stableDescriptorMapEntries` IIFE, which cannot be split out
  # without also moving the stability visitor it closes over.
  - src/codegen/object-ops.ts::compileObjectDefineProperties
  - src/codegen/declarations.ts::collectDeclarations
  - src/codegen/vec-overlay.ts::fillVecOverlayHelpers
  - src/codegen/object-ops.ts::compilePropertyIntrospection
---

# #4491 — ES5 defineProperty/defineProperties/create MOP residual

## Problem (measured 2026-08-15, `.tmp/es5-standalone-clusters.ts`, fresh baseline)

ES5 standalone stands at 8,386/9,029 (92.9%), 643 non-passing. The single
largest family is the property-descriptor MOP: `built-ins/Object/
defineProperty` (52) + `defineProperties` (26) + `create` (12) = **90 tests**.

Symptom mix (top): silent no-op defines (`result !== true`, `Expected "a ===
10", actually 0`), accessor descriptors not taking effect (`foo value should
be undefined`), index-keyed defines landing wrong (`Expected obj[0] to equal
0, actually null`), `Object.create(proto, props)` second-arg families, 3
`__module_init` null derefs.

## FALSIFIED HYPOTHESIS (kept visible per lane convention)

The plan below was built by mining error TEXT, not by verifying tests. Its
symptom list and its sub-bucket table did **not** survive contact — see
"Measured triage" after it. Kept so the next reader can see what was tried.

## Implementation Plan (fable, 2026-08-15) — triage-first

1. **Sub-bucket by MOP operation before coding** (mandatory table in this
   file): (a) data-descriptor writes on dyn objects, (b) ACCESSOR descriptors
   (get/set installation + invocation), (c) attribute enforcement
   (writable:false silently ignored? configurable transitions?), (d)
   index-keyed properties on vec-backed arrays, (e) `Object.create` props-arg,
   (f) the 3 null-deref crashes (fix first — crashes before semantics).
2. The dynamic object runtime (`src/stdlib/object-runtime.ts`,
   `__defineProperty_value` — note #2175's S3b-1 just touched materialization
   ordering vs `__defineProperty_value`, coordinate with the reflection lane's
   in-flight worktree) already has descriptor machinery; expect the residual
   to be missing arms (accessor install on specific carriers, attribute
   checks on define-over-existing) rather than a missing subsystem.
3. Fix largest bounded sub-buckets first; each with unit tests; A/B file-copy
   baselines; zero pass→non-pass on the scoped filter.

## Measured triage (generators lane, 2026-08-15)

**Source**: the shared full standalone baseline
`.test262-cache/test262-standalone-current.jsonl` (mtime 2026-08-15 20:21Z, 1.2 h
old at extraction), filtered to the plan's own scope. A dedicated scoped run was
started and **abandoned** — at the observed ~60 s/test under three-lane load,
2083 files is hours, and the shared baseline covers the identical file set. The
baseline is one other lane's run against integrated main, which is the right
reference for triage (main's state, not my worktree's).

**Scope totals: 2083 files, 1983 pass, 100 non-passing** (99 fail + 1 CE) —
`defineProperty` 59, `defineProperties` 29, `create` 12. Close to the plan's 90;
the delta is snapshot drift, not a different population.

### Step 0 — the plan's symptoms do not reproduce

One minimal standalone program per sub-bucket in the plan's list. **All ten
pass, host-free, zero imports** — including the two named as top symptoms:

| probe                                             | result |
| ------------------------------------------------- | ------ |
| data define; returns obj; value reads back        | pass   |
| accessor `get` installs **and invokes**           | pass   |
| accessor `set` installs **and invokes**           | pass   |
| `writable:false` blocks a later write             | pass (throws TypeError — correct, see below) |
| `enumerable:false` hidden from `for-in`           | pass   |
| `configurable:false` redefine throws              | pass   |
| index-keyed define on an array (`a[0] === 42`)    | pass   |
| `Object.create(proto, props)`                     | pass   |
| `Object.defineProperties` two data props          | pass   |
| `getOwnPropertyDescriptor` round-trip (all 4 attrs) | pass |

`writable:false` first looked like a real hit — a wasm exception. That was the
PROBE's fault: it had no `try`/`catch`, and a compiled module is always strict,
where that write MUST throw. With the catch it is a proper catchable TypeError,
matching Node. Recorded so the false positive is not re-derived.

**Consequently the source comment in `src/codegen/object-runtime.ts` calling
`__defineProperty_accessor` / `__getOwnPropertyDescriptor` "RUNTIME-LAYER
GROUNDWORK … not yet reached end-to-end under standalone" is STALE** — both are
reached and both work. Fix that comment in the first slice that touches the file.

### Step 1 — measured sub-buckets (classified from test SOURCE, not error text)

| bucket                                              | n  | status |
| ---------------------------------------------------- | -: | ------ |
| D array index at/above the 2^32 boundary             | 26 | **reproduced** |
| Q `defineProperties` descriptor-map edges            | 18 | unprobed |
| R `Object.create` edges                              | 13 | unprobed |
| B accessor descriptor round-trip (non-trivial)       | 12 | unprobed |
| H still unclassified                                 | 11 | — |
| P1 define ACCESSOR on a **builtin prototype**        |  7 | **reproduced** |
| E symbol-keyed define                                |  5 | unprobed |
| F crash — `__module_init` null deref                 |  3 | fix first |
| P2 define DATA prop on a **builtin prototype**       |  3 | **reproduced** |
| OUT Proxy / TypedArray-RAB / DOM global              |  4 | out of lane |

**The plan had no category for P1/P2 at all**, and they are the cleanest
reproductions:

- **P1** — `Object.defineProperty(Array.prototype, "prop", {get, set})`, then
  `a.prop` reads correctly but `a.prop = v` **does not run the setter**.
- **P2** — `Object.defineProperty(Date.prototype, "prop", {value})`, then
  `d.prop = 1002` reads back 1002 but `d.hasOwnProperty("prop")` is **false**:
  the assignment never created an own property on the instance.
  These overlap #2175's builtin-prototype territory — coordinate before coding.

- **D is NOT "length/index coupling"**, which works: index define extends
  `length` (index 5 → length 6; index 1000 → length 1001), a `length` shrink
  deletes higher indices, and an ACCESSOR at index `"0"` installs and invokes.
  What fails is the **boundary**: at index `4294967294` the property is created
  but `length` does not become `4294967295` and the element does not read back;
  at `4294967295` (not an array index) the ordinary string-keyed property is not
  created. Smells like an i32/u32 truncation in the index path — bounded, and
  the largest single target.

**Recommended order**: F (3 crashes) → D boundary → P1/P2 with #2175 (10).

### Step 2 — F verified: REAL crashes, not failure-path artifacts

Decisive test: strip the asserts. If the crash survives, it is on the success
path. It does.

- `create/15.2.3.5-4-{165,191}.js` — **real, success-path crash**, narrowed to
  `Object.create(proto, { prop: <constructor instance> })`. Controls isolate it
  tightly: the same call with an object-LITERAL descriptor works, and
  `Object.defineProperty(o, "p", <constructor instance>)` works. So it is
  `Object.create`'s props-arg reader, not the descriptor reader, and not the
  instance carrier per se. **2 tests.**
- `defineProperty/15.2.3.6-3-123.js` — does NOT reproduce in a module. The test
  is `{ configurable: this }` in a SLOPPY script, where `this` is the global
  object (truthy); in a module `this` is `undefined` (falsy) and the shape
  passes. Different root cause; needs the sloppy-`this` context to study.
  **1 test.**

### Step 3 — D re-scoped: it is not one 26-test bucket

Extracting the index literals each D test actually uses splits it three ways,
and only one part is a bounded, self-contained fix:

| part | n | what it needs |
| ---- | -: | ------------- |
| **D-a** non-index key ≥ 2^32-1 on an ARRAY via `defineProperty` | 8 | self-contained, no representation change |
| **D-b** index in `[2^31, 2^32-2]` | 7 | widen `__obj_index_of_key` i32 → u32 — see below |
| mis-bucketed by my own heuristic | 11 | re-triage |

**D-b is a DOCUMENTED, deliberate approximation, not an unnoticed truncation.**
`vec-index-domain.ts` §1 (#4434) states it outright: "The ceiling stays 2^31-1
rather than the spec's 2^32-2 … the result doubles as a SIGNED sort key for
OrdinaryOwnPropertyKeys ordering. Keys in `[2^31, 2^32-2]` are therefore treated
as ordinary string keys." So the i32/u32 smell is real and the mechanism is
right, but the fix is a representation change with a named downstream consumer —
not a one-line boundary correction. Do not start it as if it were.

**D-a is the bounded slice.** Isolated with four probes:

| probe | result |
| ----- | ------ |
| `defineProperty(arr, "4294967295", …)` | `length` right; `hasOwnProperty` **false**; value unreadable |
| `arr["4294967295"] = 7` (plain assignment) | `length` right; value **readable**; `hasOwnProperty` **false** |
| `defineProperty(arr, "foo", …)` | fully correct |
| `defineProperty(plainObj, "4294967295", …)` | fully correct |

So: ordinary names on arrays work, the same key on a plain object works — only
**array × numeric-non-index via `defineProperty`** fails. A second, adjacent
defect shows up in the assignment control: `hasOwnProperty` does not see the
#4247 expando-bag entry even when the value reads back, which likely accounts
for part of the 8 on its own.

### Step 4 — D-a is THREE defects, not one (key-domain sweep)

Sweeping `Object.defineProperty(a, K, {value:7,…})` over key spellings, then
checking `a.length`, `a.hasOwnProperty(K)` and `a[K]`, separates them. (Earlier
probes used DOT access `a.foo` / a NUMERIC literal `a[5]`, which is why this
only surfaced on the sweep — the read spelling matters.)

| key | length | hasOwnProperty | `a[K]` reads back |
| --- | ------ | -------------- | ----------------- |
| `"foo"`, `"-1"`, `"1.5"`, `"4294967295x"`, `"2147483648"` | ok | ok | **NO** |
| `"4294967295"`, `4294967295`, `"4294967296"` | ok | **NO** | **NO** |
| `"99"` (ordinary index) | ok | ok | **NO** |
| `"2147483647"` (= 2^31-1, a legal index) | — | — | **TRAPS**: "array element access out of bounds" |

1. **Read-path**: a COMPUTED STRING key on an array (`a["foo"]`) does not find
   the property, while DOT access (`a.foo`) does — and the same holds for
   elements (`a["99"]` misses where `a[99]` hits). This gates almost every case
   in the table, including ones whose store already works, so it is the
   load-bearing half of the "visibility" family.
2. **Store-path**: `defineProperty` with a numeric non-index key `>= 2^32-1`
   creates no named property at all (`hasOwnProperty` false).
3. **Trap**: defining a legal but huge index (`2^31-1`) tries to grow the
   backing array to ~2 billion elements and aborts — an uncatchable trap, the
   #4222/#4247 family, still reachable through `defineProperty`.

(3) is a new component, not in the original D-a scope, and it is a hard abort
rather than a wrong answer — split out as **#4498** (allocation policy, blast
radius over every array grow path).

### Step 7 — the D-a gate, and the PRICED SKIP of the full regression run

**Gate composition (corrected by reading each test's FIRST failing assertion,
not its bucket label).** The "8-test D-a gate" is really three groups:

| tests | first failing assertion | owner |
| ----- | ----------------------- | ----- |
| `defineProperties/15.2.3.7-6-a-{180,181,182}` | `arr[K]` value read (their `hasOwnProperty` already PASSES) | **this slice (element-read fall-through)** |
| `defineProperty/15.2.3.6-4-{184,185,186}` | `hasOwnProperty(K)` | blocked on the `__hasOwnProperty` fall-through, HELD behind #2175 P2 |
| `defineProperty/15.2.3.6-4-155`, `defineProperties/15.2.3.7-6-a-151` | `arr.length === 4294967295` | **re-bucketed to #4497** (needs index 4294967294 to be legal) |

So the element-read slice's honest bar is **3 flips**, not 8. Recorded before
implementing so the slice is not later read as underdelivering.

**Priced skip — why the full (a)/(c) regression run was NOT done.** Measured
throughput of the per-file driver on this box: **3.67 s/file** (timed, 30 files;
the pooled runner measured no faster at 2.9 s/file). Populations:

| gate | population | cost |
| ---- | ---------: | ---: |
| (a) `built-ins/**/{name,length}.js` — the propertyHelper set that burned 684 passes | 1,240 | 75 min |
| (c) `built-ins/Array` + `built-ins/Object/defineProperty` | 4,213 | 257 min |
| | **before-state** | **~5.5 h** |
| | before + after | **~11 h** |

Eleven hours for a read-side arm addition is the wrong trade, so the gate was
**substituted** (approved): emitted-BYTE identity over a bracketing corpus
(`.tmp/byte-corpus.mts`, 23 programs × gc + standalone) + the functional D-a
gate + a **random 200-file** spot-check of gate (a), **seed 20260815**
(`.tmp/sample-gate-a.mjs`; the sample is random precisely because path order
correlates with feature families, so an alphabetical head-200 is not a sample).

Byte identity is the STRONGER proof for the population that must not move: a
program whose emitted binary is unchanged cannot have changed behaviour, which
is exactly the claim needed about the 684-pass propertyHelper set. The corpus
program whose bytes are EXPECTED to change (non-index numeric read) gets its own
functional before/after so the only observable delta is the intended
absent → found.

### Step 9 — D-a element-read fall-through: LANDED, gates measured

**Change.** `vec-overlay.ts` — the existing finalize-time overlay read prologue
is now spliced into **both** `__extern_get` and `__vec_prop_get`, by iterating
the two lane names rather than duplicating the body, so they cannot drift.
Standalone routes a non-index named read on an array to `__vec_prop_get`
(`resolveNamedPropHelper`, deliberately — the `__extern_*` prologue would
swallow the key as an element), and that lane never received the prologue while
the gc/host lane has had it since #3251. That asymmetry was the whole bug.

**Functional delta (the intended one, and only it):**

| probe | before | after |
| ----- | ------ | ----- |
| `a[4294967295]` after `defineProperty` | miss | **7** ✅ |
| `a["4294967295"]` | miss | **7** ✅ |
| `a.hasOwnProperty(K)` | false | false (HELD step-3 edit) |
| `Object.hasOwn(a,K)` / plain-object / `a.hasOwnProperty("foo")` | ok | unchanged ✅ |

**Gate (b) — exactly the predicted 3 flips, 0 regressions:**
`defineProperties/15.2.3.7-6-a-{180,181,182}` fail → **pass**;
`defineProperty/15.2.3.6-4-{184,185,186}` still fail (blocked on the held
`__hasOwnProperty` fall-through); `4-155` / `-151` still fail (#4497).

**Gate (a), seeded 200 (seed 20260815) — 129 pass / 40 fail / 31 skip →
129 / 40 / 31. Zero pass→non-pass.** This is the population that burned 684
passes last time; it does not move.

**Gate: byte matrix — DEVIATED from its stated expectation, and the deviation is
the GATE's flaw, not the change's.** Expected exactly one program to change;
**11 standalone programs changed**, including `syn:obj-prop` and `syn:hasown`,
which contain no array at all. Cause, verified rather than assumed: a standalone
module links the WHOLE runtime, so editing any native shifts every standalone
module's bytes. Probed directly — a program with no array still contains
`__vec_prop_get`, `__extern_get` and `__vec_overlay_lookup`.

So byte-identity is only a blast-radius proof when linkage is per-program. For
standalone whole-runtime linking it proves **lane-level** isolation and nothing
finer. What it does prove here is worth keeping: **the gc lane is 100 %
unchanged (23/23 programs)** — the host lane is provably untouched. Within
standalone, the functional gates above are the binding evidence, not the bytes.

**Gate: FUNCTIONAL corpus, standalone, base vs branch — IDENTICAL on all 23.**
Same 23 programs, same lane, comparing observed OUTPUT instead of bytes
(`.tmp/func-corpus.mts`, A/B with both sides derived from git at use time). This
converts "the 11 byte deltas are benign code-shift" from inference into
measurement: every one of those programs computes exactly what it did before.

Note the corpus program I predicted WOULD change functionally
(`syn:array-nonindex-numeric`) did not — correctly. It reads
`a[4294967295]` on an array that never had `defineProperty` called on it, so
there is no companion entry and `undefined` is the right answer on both sides.
The behavioural delta is confined to programs that actually install a
descriptor, which is what gate (b) and the R4/R5 probes measure directly. That
is the third time in this slice that a stated expectation was wrong in the
SAFE direction; each was caught by measuring rather than asserting.

### Step 11 — step-3 root cause: a COMPILE-TIME FOLD, not a runtime arm

Diagnostic done by disassembling the emitted module — **no src instrumentation
needed**, so nothing had to be reverted. Both candidates in Step 10 are WRONG,
and so is the plan's assumed site.

**The two natives are byte-identical.** `wasm-dis` of a module containing both
calls shows `$__hasOwnProperty` and `$__object_hasOwn` with the SAME locals and
the SAME `fillVecHasOwnHelpers` prologue (`ref.test $vecBase` → `call
$__vec_gopd` → …). The splice worked on both. So it was never a splice-time
resolution failure (candidate a) nor a competing earlier prologue (candidate b).

**`a.hasOwnProperty(K)` never calls either native.** In `$test` the only
predicate call emitted is `call $__object_hasOwn`; the `hasOwnProperty` site
compiled to a literal **`(if (i32.const 0) …)`**. The answer was CONSTANT-FOLDED
at compile time.

**Where.** `compilePropertyIntrospection` (`object-ops.ts`) — its own docstring
says "Static resolution (string literal arg): constant fold to i32.const 0/1".
Its vec-receiver branch has exactly two arms: a dense-literal own index (fold to
1) and, for reference-element vecs, a canonical-index bounds test OR-ed with
`__hasOwnProperty`. A static key that is **not a canonical array index** —
`"4294967295"` — matches neither, falls through to the generic FIELD-NAME logic,
and a vec struct has no field of that name ⇒ folded `0`. `Object.hasOwn` has no
such fold, which is the entire reason the two spellings disagree.

**Fix (small, and NOT in a contended file).** In that vec branch, a static key
that is not a canonical array index must NOT reach the field-name fold: delegate
to `emitRuntimePropertyIntrospection` (same file, already present, already calls
`__hasOwnProperty`). The runtime prologue is proven correct by `__object_hasOwn`
answering `true` on the identical body — so this is a routing fix, not new
semantics. `object-ops.ts` is untouched by the reflection lane (verified:
they hold `object-runtime.ts` + `proto-index-store.ts`).

### Step 12 — step-3 REVERTED after the #4604 park. Do not retry here.

The step-3 arm is **removed from this worktree** (`object-ops.ts` back to base).
Two reasons, the second of which matters more than the first.

**1. The narrowing fix does not behave as designed, and I cannot explain it.**
`vecInfo !== null` was added to confine the arm to genuine vec receivers. Three
states, one script, one probe (`.tmp/three-state.sh`, reproducible):

| probe | base | over-broad arm | narrowed arm |
| ----- | ---- | -------------- | ------------ |
| K1 `C.hasOwnProperty('prototype')` | 0 | 0 | **1** |
| K3 `C.prototype.hasOwnProperty('constructor')` | 1 | 1 | **0** |
| K7 static own on constructor | 0 | 0 | **1** |

Base and the over-broad arm agree; the NARROWED one differs from both. Adding a
restriction cannot make an arm fire more often, so something other than the arm
is moving — an emission-order or late-import side effect of
`emitRuntimePropertyIntrospection` reaching the generic fold differently, most
likely. Unexplained is disqualifying for a change that already parked the queue.

**2. This worktree structurally CANNOT validate the fix.** The regression is a
composition with reflection's **P2**, which I was correctly told not to sync. On
integrated main P2 makes `C.hasOwnProperty('prototype')` answer `true`; here,
without P2, K1/K7 are **already wrong at base** (0). So every local class-receiver
measurement is of a different composition than the one that parked #4604 — a
local "green" would prove nothing and a local "red" mis-attributes. That is why
the over-broad arm looked harmless in this worktree (base == broad above) while
regressing 12 tests in the integrated branch.

**Consequence for whoever retries:** the fold-vs-runtime decision for
`hasOwnProperty` on a non-vec receiver must be validated **where P2 exists**.
The receiver-narrowing idea is still the right shape — the #3251 overlay and
#3537 bag are vec-only, so a non-vec receiver was never in scope — but it needs
to be measured against the P2 composition, with the 12 regressed
class-elements paths in the control set, not against this worktree's base.

**D-a (Step 9) is unaffected** — it is a separate commit (3829480e6) in
`vec-overlay.ts`, and its 3 flips do not depend on step 3.

### Step 11 result — LANDED (superseded by Step 12: reverted)

**Gate (b): 6 upward flips, 0 regressions** — the full D-a gate now stands at
6/8, and the 2 that remain are the ones correctly re-bucketed to #4497:

| test | before | after |
| ---- | ------ | ----- |
| `defineProperties/15.2.3.7-6-a-{180,181,182}` | fail | **pass** (D-a, unchanged by this step — no interaction) |
| `defineProperty/15.2.3.6-4-{184,185,186}` | fail | **pass** (this step) |
| `defineProperty/15.2.3.6-4-155`, `defineProperties/15.2.3.7-6-a-151` | fail | fail (#4497, expected) |

**Probe quartet + fold positive controls: 12/12.** The quartet is green
(`hasOwnProperty`, the `.call` spelling, `Object.hasOwn` still true, non-numeric
key still true) and — the part that matters for a fold change — **the world is
not un-folded**: plain-object own/absent, array canonical index in/out of
bounds, array absent non-index key, array named expando, `length` own, and
inherited `push` NOT own all keep their previous answers.

**Blast radius, base = HEAD (already contains D-a):**

| corpus check | result |
| ------------ | ------ |
| gc lane bytes | **identical** |
| standalone bytes | **identical** |
| functional outputs | **identical on all 23** |

Standalone bytes being identical here — where D-a moved 11 programs — is the
signature of the difference between the two fixes: D-a edited a runtime native
(which every standalone module links), this one changes a CALL-SITE routing
decision, so a program that never calls `hasOwnProperty` with such a key emits
byte-for-byte what it did before.

**Gate (a), seeded 200 (seed 20260815): 129/40/31 → 129/40/31, zero
pass→non-pass.** The population that burned 684 passes does not move.

`pnpm run typecheck`: clean. Files: `src/codegen/object-ops.ts` only.

### Step 10 — step-3 (`hasOwnProperty`) recon: the two predicates DIVERGE

Not implemented. Recon only, recorded so the next attempt starts from measured
facts rather than the plan's assumption.

The step-3 target was expected to be `fillVecHasOwnHelpers` — which lives in
**`vec-bag-seed.ts`** (moved out of `vec-overlay.ts`; NOT `object-runtime.ts`,
so no collision with reflection's `emitHasOwn`/`__extern_set` work). That
function unshifts ONE shared prologue into BOTH `__hasOwnProperty` and
`__object_hasOwn`, via a `for` loop over the two names.

**But the two answers diverge on the same receiver and key**, which the shared
prologue cannot explain:

| spelling | answer |
| -------- | ------ |
| `Object.hasOwn(a, "4294967295")` | **true** ✅ |
| `a.hasOwnProperty("4294967295")` | **false** ❌ |
| `Object.prototype.hasOwnProperty.call(a, "4294967295")` | **false** ❌ |
| `a.hasOwnProperty("foo")` (non-numeric, same overlay store) | **true** ✅ |

The generic `.call` spelling failing too rules out an Array.prototype
borrowed-method quirk. And `__vec_gopd` is NOT the problem: the prologue's
affirmative arm calls it, and `Object.getOwnPropertyDescriptor(a, K)` — which
reaches the same companion — returns `{value: 7}`.

So the open question for step 3 is narrow and specific: **why does the prologue
produce a different answer in `__hasOwnProperty` than in `__object_hasOwn` when
`fillVecHasOwnHelpers` unshifts the same instructions into both?** Candidates
worth instrumenting first: (a) `ctx.mod.functions.find(name)` not resolving
`__hasOwnProperty` at splice time (so it silently never gets the prologue —
the same class of failure as Step 8's dead code), or (b) an earlier prologue
already unshifted into `__hasOwnProperty` by another lane returning before
this one runs. Both are cheap to distinguish with a single emitted-body dump.

### Step 8 — implementation attempt: right native, WRONG WIRING POINT

Tried, measured, **reverted** (byte-identity confirmed zero residue).

The element read for a non-index key on a vec goes to `__vec_prop_get`
(`resolveNamedPropHelper` returns `VEC_PROP_GET` in standalone, deliberately NOT
`__extern_get` — see the `array-nonindex-key.ts` header on why the `__extern_*`
prologue would eat the key as an element). So `__vec_prop_get` IS the right
native to teach about the overlay.

**But its body is built too early.** Instrumented:
`[vpget] overlayLookup=undefined externHas=2097294` — `__vec_overlay_lookup`
does not exist yet when `fillVecPropHelpers` sets the body, exactly as
`vec-overlay.ts`'s own header warns ("the descriptor natives are built EARLY …
the per-carrier vec types and index helpers are only complete at FINALIZE").
The arm I added was therefore **dead code**: guarded on a `funcMap` miss, it
emitted nothing. Reverted rather than kept — an unvalidated change that fixes
nothing is the same call #4492 attempts 2 and 3 made, for the same reason.

**Correct wiring point:** a FINALIZE-time splice in `vec-overlay.ts`, beside the
existing overlay read prologues — `__extern_get_idx` (~L2093) and `__extern_get`
(~L2266). `__vec_prop_get` simply never got the third one. The `__extern_get`
prologue is a working template for the exact shape needed (probe companion →
answer if present → otherwise fall through untouched).

**Why the standalone lane misses while gc does not:** the gc/host lane reads
through `__extern_get`, which HAS the overlay prologue. Standalone routes to
`__vec_prop_get`, which does not. That asymmetry is the whole bug.

### Step 6 — CORRECTION: the store is NOT lost. Step 5 below was wrong.

Step 5 (kept underneath, struck through in effect) concluded the numeric
non-index define never lands. **Measured, that is false** — the store works and
only READS are blind. On `var a = []; Object.defineProperty(a, "4294967295",
{value:7,w/e/c:true})`:

| query | answer | |
| ----- | ------ | - |
| `Object.getOwnPropertyDescriptor(a, K)` | `{value: 7, …}` | ✅ stored |
| `Object.getOwnPropertyNames(a)` | includes `"4294967295"` | ✅ |
| `"4294967295" in a` | `true` | ✅ |
| `Object.hasOwn(a, K)` | `true` | ✅ |
| `a.hasOwnProperty(K)` | **`false`** | ❌ |
| `Object.prototype.hasOwnProperty.call(a, K)` | **`false`** | ❌ |
| `a[4294967295]` / `a["4294967295"]` | **miss** | ❌ |
| same key on a PLAIN OBJECT | both correct | ✅ control |
| `a.hasOwnProperty("foo")` (ordinary name, array) | `true` | ✅ control |

So the defect is **entirely read-side, and specific to a NUMERIC-LIKE key on a
vec receiver**: ordinary names on the same receiver are fine, the same key on a
plain object is fine, and `Object.hasOwn` — a different native — already answers
correctly on the very receiver `__hasOwnProperty` gets wrong.

**Single target.** A numeric-like key on a vec routes into the INDEXED lane
(that is what `markNumericLikeNamedKey`, #4434, arms it for). For a key that is
canonical-numeric but NOT an array index the parsed index is `-1`, the indexed
lane has nothing, and `__hasOwnProperty` + the element read answer "absent"
instead of falling through to the companion/bag. `Object.hasOwn`, `gOPD` and
`getOwnPropertyNames` already have that fall-through; `__hasOwnProperty` and the
element read do not. Fix = give those two the same fall-through, which is a
strictly narrower change than the store-side one Step 5 proposed.

Corollary for the slice's original framing: component **(2) "the ≥2^32-1 store
path" does not exist as a defect**. The whole D-a slice is component (1).

### Step 5 — where the D-a store is lost (SUPERSEDED by Step 6 above)

The substrate is NOT missing: #3251 built a full standalone array-descriptor
OVERLAY (`vec-overlay.ts`) — each vec receiver targeted by a descriptor op gets
a companion `$Object` that the hard parts delegate to. `defineProperty(arr,
"foo", …)` works through it today.

The define arm (`vec-overlay.ts` ~L1440) does `parseIndex(1, 7)` →
`i = __obj_index_of_key(key)`, then branches on `i >= 0`. A non-index key gets
`-1` and should fall through to the companion's named define — which is exactly
what `"foo"` does. `"4294967295"` also parses to `-1`, yet does **not** land.
The divergence to inspect first is the #4434 note at ~L1682, "canonical-numeric
named key → arm the indexed-lane flag": a numeric-SPELLED key that is not an
array index is steered into the indexed lane, where a key `>= 2^32-1` has no
slot and is dropped. That is the site to fix, not `__obj_index_of_key` (whose
`-1` answer is already correct here — contrast #4497, which is about the
range it answers `-1` for *wrongly*).

**Deliberately OUT of scope for this slice** (recorded, not fixed): a computed
STRING-NAME read on an array, `a["foo"]`, misses the bag while `a.foo` finds it,
because `nonArrayIndexNumericKey` admits only numeric/boolean SPELLINGS. Widening
it to arbitrary names means owning a reserved-name exclusion list — `arr["length"]`,
`arr["push"]`, `arr["constructor"]` must NOT route to the bag, and an incomplete
list silently breaks every borrowed prototype method. The 8 D-a tests do not need
it: they read back with a NUMERIC key (`arrObj[4294967295]`), which the existing
numeric arm already routes. Fixing it blind, unprompted by a test, is how that
hazard would land.

### F residual — module-goal-unreachable

`defineProperty/15.2.3.6-3-123.js` (`{ configurable: this }`) cannot be
reproduced or fixed under the module goal: it depends on SLOPPY-script `this`
being the global object (truthy). Compiled modules are always strict, where
`this` is `undefined` (falsy) and the shape already passes. Not a defect in the
MOP; parked here so it is not re-triaged as one.

## Validation

`TEST262_TARGET=standalone TEST262_PATH_FILTER="built-ins/Object/defineProperty|built-ins/Object/defineProperties|built-ins/Object/create" pnpm run test:262`
— baseline 90 non-pass. gc-lane control on the same filter. Equivalence guard.

## 2026-08-19 re-census + dispatch

Fresh standalone baseline (`test262-standalone-current.jsonl`, 48,735 entries,
fetched 2026-08-19 04:52): standalone ES5 is **8,506 / 9,029 (94.2 %)** with
**523 non-passes** (495 fail, 24 compile_error, 4 compile_timeout). Earlier
figures in this file predate that and should be read as history.

This issue's lane in the 2026-08-19 6-way fan-out: **100 rows — defineProperty 47 + defineProperties 15 + rest-of-Object 38**.
Umbrella + full partition: #4163.

The residue is a **long tail** — the largest single error signature across all
523 rows is 13. Expect many small root causes, not one lever.

Local gate for this lane: 551 locally-verified-passing standalone ES5 tests must
stay at 551/551. Reproduce with the `--standalone` flag (without it you measure
the JS-host lane, a different and much worse corpus at 84.8 %).

**eval-rooted rows cannot be validated on the dev Mac** — CI's QuickJS eval tier
needs clang-18 (see #4163 for the full toolchain finding); record them as
blocked rather than chasing them.

## 2026-08-20 routing correction — Date writable-data own visibility

Fresh ES5 standalone triage for #4504 isolated
`built-ins/Object/defineProperty/15.2.3.6-4-408.js` from the inherited-`[[Set]]`
cohort. The write decision itself is already correct: a writable data descriptor
on `Date.prototype` permits `dateObj.prop = 1002`, and the value reads back as
`1002`. The failure is that direct/borrowed `hasOwnProperty` and `in` do not see
the Date instance's created expando (the statically typed Date introspection path
folds false), while the dynamic receiver path can observe it. This is a Date
carrier own-storage/visibility and `compilePropertyIntrospection` convergence
row, not a prototype-descriptor refusal row. #4504 explicitly excludes it from
its nine-test denominator; retain it here for the next MOP/introspection slice.

## 2026-08-21 void-in-argument-position slice (closes the void-undefined family)

**Root cause.** `inferParamTypeFromCallSites` narrowed an implicit-`any`
parameter from the TS type of the argument at each call site. For a purely-void
argument — `verifyEqualTo(arrObj, "0", getFunc())` where `getFunc` returns
nothing — `mapTsTypeToWasm` answers `i32` ("void → no result, handled in
codegen"). That answer is a lowering convention for a *result slot*, not a claim
that the argument is the number `0`, but the inference took it literally: the
harness parameter got an `i32` slot, the void call padded it with `i32.const 0`,
and the deprecated `verifyEqualTo` reported `Expected obj[0] to equal 0,
actually undefined` — with the **expected** side wrong, not the actual one.

**Fix** (`src/codegen/declarations/param-return-inference.ts`, +21 LOC, exactly
the shape of the #4555 under-application rule right above it): record a call
site whose argument type is exclusively `Void | Undefined`, and withdraw the
narrowing when the agreed type is a native scalar (`f64`/`i32`/`i64`) — those
have no encoding of `undefined`. The parameter stays on its resolved
`externref`, whose default value already IS the canonical undefined
(`pushDefaultValue` → `emitUndefinedValue` → the #2106 `$undefined` singleton in
standalone). The withdrawal is per parameter POSITION, so a numeric kernel with
a void argument in some other slot is untouched, and annotated parameters never
reach this inference at all.

**Measured** (serial single-test standalone probes, before/after on the same
worktree):

| test                                          | before | after |
| --------------------------------------------- | ------ | ----- |
| `Object/defineProperty/15.2.3.6-4-207.js`     | fail   | pass  |
| `Object/defineProperty/15.2.3.6-4-208.js`     | fail   | pass  |
| `Object/defineProperty/15.2.3.6-4-312.js`     | fail   | pass  |
| `Object/defineProperty/15.2.3.6-4-570.js`     | pass   | pass  |
| `Object/defineProperty/15.2.3.6-4-498.js`     | pass   | pass  |

Two 12- and 17-test control batches (arguments-object, function statements,
call/void expressions, Math/Array/Object/String/parseInt built-ins, and 12
`verifyEqualTo(..., getFunc())` defineProperty rows that already passed) are
**byte-identical before and after** — no regressions in the sample.

**Residuals deliberately NOT taken in this slice:**

- `15.2.3.6-4-195.js` still fails, but no longer on the void value — its
  `verifyEqualTo` now passes and it stops at `Expected obj[0] to be writable,
  but was not`. That is inherited-accessor `[[Set]]` dispatch, a different row.
- `[1, getFunc()]` — a void element mixed with numbers types the array
  `number[]` after the type mapper's union rule ("`T | undefined` for primitives
  → just use `T`"), so the element lands as `f64 0`. Pure `undefined[]`/`void[]`
  is already correct (#2806). Changing the union rule would move every
  `number | undefined` slot in the compiler and is out of scope here.

## 2026-08-21 bucket D re-triage + the uint32 `length` VALUE slice

**Bucket D was 26 rows in the 2026-08-15 triage; on this head it is 10.** Every
row in the file set that mentions a 2^32-boundary literal
(`built-ins/Object/define{Property,Properties}`, `built-ins/Array{,/length}`,
35 files) was re-run serially against my own HEAD before touching anything —
several had already been carried by the session's earlier slices (`15.2.3.6-4-
{184,185,186}`, `15.2.3.7-6-a-{180,181,182}`, `-{149,152,153}`,
`15.2.3.6-4-{153,156,157}` all pass now).

The 10 reproducing rows split into **three unrelated defects**, not one:

| part | rows | defect |
| ---- | ---- | ------ |
| **D-L** `length` **VALUE** in `[2^31, 2^32-1]` | `defineProperty/15.2.3.6-4-{154,155}`, `defineProperties/15.2.3.7-6-a-{150,151}`, `Array/length/15.4.5.1-3.d-3`, `Array/S15.4.5.2_A3_T3` | this slice (4 of 6 landed; 2 blocked, below) |
| **D-I** array **INDEX** at 2^32-2 must bump `length` to 2^32-1 | `defineProperty/15.2.3.6-4-183`, `defineProperties/15.2.3.7-6-a-179` | #4497 — needs the `vec-index-domain.ts` ceiling raised from 2^31-1 |
| **D-A** allocation | `Array/S15.4.5.2_A1_T1`, `Array/length/S15.4.5.2_A3_T4`, `Array/length/S15.4.2.2_A2.1_T1` | #4498 — `new Array(2^32-1)` / `x[2^31]=1` trap ("requested new array is too large" / "array element access out of bounds") |

(`Array/length/define-own-prop-length-overflow-realm.js` is eval-rooted and
cannot be validated here — no QuickJS provider on this box, per #4163.)

### Root cause of D-L: an explicit bail, not a truncation

`vec-overlay.ts`'s native `__vec_dp_value` `"length"` arm (the standalone
ArraySetLength) carried

```
// u ≥ 2^31 → legacy no-op (i32 vec length cannot represent it)
```

and **returned the receiver untouched**. So
`Object.defineProperty(arr, "length", {value: 2**32-2})` answered `0` — a wrong
answer with no error, invisible to every gate.

The premise is false in the direction that matters. STORING elements at such an
index does need sparse arrays; carrying the uint32 length VALUE does not — the
`$__vec_base` length field round-trips the whole u32 domain as a bit pattern,
and the readers that can observe a length ≥ 2^31 already widen it with
`f64.convert_i32_u` (the `__extern_get` `"length"` arm in `object-runtime.ts`,
added by the `vec-length-set.ts` slice, which had already made the *dynamic*
`arr.length = n` store unsigned). The define arm was the odd one out.

**Fix** (`src/codegen/vec-overlay.ts`, +38 −2): replace the bail with a
sparse-length arm — the same §10.1.6.3 `__vec_dp_value` legality delegate as the
in-range path (so a non-writable / non-configurable `length` still refuses),
then `vec.length = i32.trunc_sat_f64_u(u)`. The element machinery is skipped
deliberately: a length ≥ 2^31 is unbackable, so it is always a grow into sparse
territory with no real elements to create — exactly what the static
`maybeEmitVecLengthDefine` does above its own 16M ceiling. It also *cannot* use
the shrink loop below it, whose `i32.lt_s` against a newLen with a negative bit
pattern never terminates.

### Measured (serial single-test standalone probes, file-copy A/B on one head)

| set | files | base | branch | up | down |
| --- | ----: | ---: | -----: | -: | ---: |
| boundary candidates (every 2^32-literal file in the 4 dirs) | 35 | 23 pass | 27 pass | **4** | **0** |
| control: `Array/length/**` + `defineProperty/15.2.3.6-4-1*` + `defineProperties/15.2.3.7-6-a-1[4-9]*` | 204 | 186 pass | 191 pass | **5** | **0** |
| blast radius: seeded-120 sample of `built-ins/**/{name,length}.js` (the propertyHelper population) + 60 `push`/`pop`/`splice` | 180 | 103 pass | 103 pass | 0 | **0** |

Flips: `defineProperty/15.2.3.6-4-{154,155}`,
`defineProperties/15.2.3.7-6-a-{150,151}`, and — not predicted —
`defineProperty/15.2.3.6-4-116` ("length descriptor should be writable"), which
reads the descriptor back through the same companion the arm now populates.

Gates: `check:loc-budget`, `check:func-budget`, `check:coercion-sites`,
`check:oracle-ratchet` all OK (the `vec-overlay.ts` / `fillVecOverlayHelpers`
grants in this file's frontmatter cover it). `tsc` shows no error in any touched
file (510 pre-existing errors, 482 of them TS2591).

### BLOCKED sub-item — the two assignment-form rows

`Array/length/15.4.5.1-3.d-3` and `Array/S15.4.5.2_A3_T3` are the same defect on
the plain `arr.length = n` ASSIGNMENT form, and they need **two** one-word
changes, only one of which is in reach:

1. `emitArraySetLengthValidation` (`array-length-define.ts`) ends
   `i32.trunc_sat_f64_s` — signed, so a validated `2**32-1` SATURATES to
   2147483647. Its comment reads this as needing sparse arrays; per the argument
   above that is the wrong diagnosis, and `_u` is the fix. (Same for the
   assignment-expression result widening in `expressions/assignment.ts`.)
2. The STATIC `.length` READ of a vec receiver widens with
   `f64.convert_i32_s` — **`src/codegen/property-access-dispatch.ts` ~L2985**
   (verified by disassembling the emitted module: `$run` is
   `f64.convert_i32_s (struct.get $15 0 …)`). That file is held by another lane
   right now, so this slice does not touch it.

Both edits were **implemented and measured, then REVERTED**, because half of the
pair is worse than neither: with the unsigned store and the signed read,
`[].length = 2**32-1` answers **-1** where it used to answer 2147483647 — still
failing, no test won, and a behaviour change on every `arr.length = <≥2^31>`
with no way to validate it to green from here. Measured state of the pair, so
the next attempt does not re-derive it:

| probe | base | store `_u` only | store + read `_u` |
| ----- | ---- | --------------- | ----------------- |
| `var a=[]; a.length=2**32-1; a.length` | 2147483647 | −1 | (expected 4294967295 — unverified, read not touched) |

**Whoever holds `property-access-dispatch.ts` next: make the vec `length` read
`f64.convert_i32_u`, then flip the two truncations above.** Lengths below 2^31 —
every ordinary array — encode identically under either signedness, so the change
is inert outside the boundary band.

## 2026-08-21 defineProperties descriptor-map + Object.create edges (buckets Q, R)

**Method.** Every file in `built-ins/Object/defineProperties` (632) and
`built-ins/Object/create` (320) — 952 rows — run serially through
`runTest262File(..., "standalone")`, A/B against the identical 952 rows with the
change reverted by file copy (`.tmp/probe/ab.sh`, base copies captured at the
first edit). Plus 279 paired CONTROL rows: all of `language/statements/for-in`,
`built-ins/Object/{keys,getOwnPropertyNames}`, and 89 of
`built-ins/Object/getOwnPropertyDescriptor`.

**Result: 1,231 paired rows, 5 fail→pass, 0 pass→fail.**

| test | before | after |
| ---- | ------ | ----- |
| `create/15.2.3.5-3-1.js` | fail | **pass** |
| `create/15.2.3.5-4-1.js` | fail | **pass** |
| `defineProperties/15.2.3.7-6-a-198.js` | fail | **pass** |
| `defineProperties/15.2.3.7-6-a-203.js` | fail | **pass** |
| `defineProperties/15.2.3.7-6-a-209.js` | fail | **pass** |

### The buckets were much smaller than the triage estimated

Bucket Q was estimated at ~18 rows and R at ~13. Measured on this head, the two
directories together hold **19 non-passing rows**, of which **3 are
`JS2WASM_EVAL_ENGINE=quickjs` infrastructure blocks** — the provider does not
build in this container (`scripts/quickjs-artifact/build.sh` needs clang-18 +
network; the compiler-rt fetch returns non-gzip), the #4163 finding — so **16
are real**. Several rows in the 2026-08-20 gap list already pass on this head
(e.g. `create/15.2.3.5-4-263`, the get-only accessor descriptor). Bucket sizes
derived from error TEXT overstate; re-verify before scoping.

### Root causes fixed

1. **`Object.prototype.isPrototypeOf` had no reflective body**
   (`object-proto-is-prototype-of.ts`, new). `makeGlue`'s `Object` arm sent
   every member but `toString` to `emitObjectProtoOrRefusal`, so a *called*
   `isPrototypeOf` threw "not yet implemented in --target standalone". The
   compile-time folds in `native-is-prototype-of.ts` only fire for a receiver
   written literally as `<Ctor>.prototype`; the ordinary `b.isPrototypeOf(d)` on
   a constructed instance resolves the member off `Object.prototype` and lands
   on the reflective CLOSURE. The body routes to the existing `__isPrototypeOf`
   chain walk and boxes with `__box_boolean` (so `r === true` holds, not
   `1 !== true`). Both late imports are ensured BEFORE any instruction is
   emitted — a mid-body late import would shift this body's already-emitted
   `call`, and the shift fixer only repairs `ctx.currentFunc`.
   Probe controls, all correct: `Object.prototype.isPrototypeOf({})` true,
   `Array.prototype.isPrototypeOf([1,2])` true / `({})` false, own chain true,
   reverse false, self false, primitive/`undefined`/`null` arg false, 2-deep
   chain true, `typeof` `boolean`.

2. **A `Properties` map in a VARIABLE with non-literal entries refused**
   (`object-ops.ts`). `stableDescriptorMapEntries` (#3782) required every entry
   initializer to BE an object literal; `var properties = { "0": descObj }`
   declined, the closed WasmGC struct reached the native plural applier, and it
   threw `[SITE-PROPS-BAG-NOT-AUTHORITATIVE]`. Such an entry is now modelled as
   a PASS-THROUGH, and a map containing one is reified into a real `$Object`
   through the existing `compileDescriptorMapAsDynamicObject` builder rather
   than expanded per key — the native applier is the only path with
   ToPropertyDescriptor's conflict/callable checks and it preserves
   §20.1.2.3.1's gather-all-then-define-all order. An all-literal map with no
   merged field write keeps the pre-existing per-key expansion untouched, so
   the paths that already worked emit exactly what they did.
   Note the pre-existing limitation this did NOT change: the stability visitor
   treats a SECOND read of the map variable as instability, so
   `Object.defineProperties(a, props); Object.defineProperties(b, props)`
   declines both.

3. **`for…in` enumerated array indices whose descriptor says
   `enumerable: false`** (`vec-index-enumerable.ts`, new). The descriptor was
   already recorded correctly — `getOwnPropertyDescriptor(a,"0")` reads
   `1001/true/false/true` — only the enumeration disagreed, because
   `emitArrayForIn`'s native lane walks `"0" … "length-1"` unconditionally. The
   new native answers from the #3251 overlay companion and joins the existing
   #4222 presence gate inside the loop's `$continue` block (same `br_if 0`
   shape, so the user body's break/continue depths are untouched). Reserve-then-
   fill like `__vec_overlay_push_keys`, because `__vec_overlay_lookup` is only
   minted at finalize; a skipped fill degrades to the placeholder `1`, i.e. the
   previous answer. Demand gated on `vecOwnKeysDirty`, so a module that never
   mentions a descriptor/own-key builtin gets no native, no call, no local.

### Diagnosed but NOT taken — with the measurement, so it is not re-derived

- **`defineProperty/15.2.3.6-3-138` is NOT an inherited-accessor
  ToPropertyDescriptor bug.** The dispatch brief named it as a §8.10.5 step-5.a
  prototype-walk failure. Measured, `__desc_has_own` already does the full
  §7.3.12 chain walk (#4163) and `"value" in child` answers `true`. The real
  condition is on the RECEIVER: `Object.defineProperty(o, K, desc)` where `o`
  is a compiler-CLOSED struct that already has a declared field `K` and `desc`
  is anything other than an INLINE object literal writes the descriptor into
  the dynamic store while the static `o.K` read still returns the struct field.
  Sweep (`.tmp/probe/pa.js`, `pb.js`), one program, standalone:
  | receiver | descriptor | `o.p` after |
  | -------- | ---------- | ----------- |
  | `{}` | constructed instance w/ own `value` | 42 ✅ |
  | `{q:1}` | constructed instance w/ own `value` | 42 ✅ |
  | `{p:120}` | INLINE `{value:42}` | 42 ✅ |
  | `{p:120}` | `var dsc = {value:42,w/e/c:true}` | **120** ❌ |
  | `{p:120}` | constructed instance | **120** ❌ |
  The descriptor CARRIER (constructed instance, inherited field, set-only
  accessor) is irrelevant — only receiver-shape × descriptor-spelling matters.
  One row in the current red set; the fix belongs with the sidecar/struct-field
  convergence work, not here.
- **`defineProperties/15.2.3.7-6-a-{204,231}` are the typed-lane/aliasing gap,
  not descriptor gaps.** `p5`/`r2` show the accessor at index `"0"` installs,
  invokes, and reports the right descriptor when read directly. What fails is
  reading it back through anything but the original identifier
  (`.tmp/probe/s3.js`, one program):
  `arr[0]` → 101 ✅ · `var idx=0; arr[idx]` → 101 ✅ ·
  `var alias = arr; alias[0]` → **0** ❌ · `f(arr,0)` (param monomorphized to
  the vec) → **0** ❌ · `f(arr,0)` (polymorphic param) → **undefined** ❌ ·
  `f.call(null,arr,0)` → **undefined** ❌ · `f(arr,"verifySetter")` →
  **undefined** ❌ while `arr["verifySetter"]` → 100 ✅.
  That is #4159's own subject (a `propertyHelper.js` parameter on the typed
  lane) plus an ALIAS leak the #4159 note does not mention: the route is keyed
  on the identifier, so `var alias = arr` escapes it. Needs its own slice.
- **`defineProperties/15.2.3.7-6-a-183` is a value-representation row.**
  `arr=[1,2,3]` is a `__vec_f64`; `defineProperties(arr,{"1":{value:"abc"}})`
  cannot store a string in it. Control: the same define with `length` still
  writable also leaves `arr[1] === 2`, and `arr[1] = "zzz"` gives `NaN` — so
  the non-writable `length` in the test is a red herring.
- **`defineProperties/15.2.3.7-2-16` and `create/15.2.3.5-4-15` need the
  ARGUMENTS object, not the descriptor map.** Both assert
  `'[object Arguments]' === Object.prototype.toString.call(this)` inside a
  getter on the `Properties` object. Measured (`.tmp/probe/q3.js`): an
  arguments object here tags `[object Object]`, reports `length: 0` for
  `new Fun(1,2)`, and `Object.defineProperty(args,"bar",{...})` lands nowhere
  (`hasOwnProperty` false, `gOPD` null) while a plain `args.foo = 7` expando
  works. Three separate gaps upstream of anything `defineProperties` can fix.
- **`Object.keys` / `getOwnPropertyNames` still enumerate a non-enumerable
  array index** (`Object.keys(a)` → `["0"]` for the fix-3 array). They reach the
  key list through `__vec_overlay_push_keys` and the `__object_keys` vec arm —
  different wiring, no row in this bucket asserting it, and widening both at
  once would make one regression indistinguishable from the other.
- `15.2.3.7-6-a-{150,151,179}` remain #4497 (the 2^32 `length` boundary);
  `15.2.3.7-6-a-113` is an `Array.prototype.length` value read inside a closure
  (`illegal cast`), a builtin-prototype-value row.
