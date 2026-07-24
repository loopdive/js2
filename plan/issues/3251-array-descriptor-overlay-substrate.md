---
id: 3251
title: "standalone: array-descriptor OVERLAY substrate — $Vec receivers have no per-index/expando property-descriptor storage (blocks array-exotic defineProperty + Array generic-method-over-accessor-index)"
status: ready
sprint: current
s1_completed: 2026-07-18
created: 2026-07-13
priority: high
feasibility: hard
model: fable
reasoning_effort: max
task_type: epic
area: codegen, runtime, standalone
language_feature: arrays, property-descriptors
goal: standalone-mode
umbrella: 1781
related: [3246, 2042, 2992, 3116, 2668]
horizon: xl
epic: true
# (#3102 LOC ratchet) S1 grows only the unavoidable arm/wiring lines in these
# god-files (+36/+18/+12/+8/+5/+4); the substrate itself is the new subsystem
# module src/codegen/vec-overlay.ts (~1.4k lines), per the consolidation plan.
loc-budget-allow:
  - src/codegen/object-runtime-descriptors.ts
  - src/codegen/context/types.ts
  - src/codegen/index.ts
  - src/codegen/object-ops.ts
  - src/codegen/registry/imports.ts
  - src/codegen/object-runtime.ts
# (#2108 coercion-sites ratchet) vec-overlay's number_toString uses are NOT a
# hand-rolled coercion matrix — they canonicalise an array index to its
# property key (§7.1.19, the same number_toString pattern __extern_get_idx's
# own $Object arm and fillDynamicForinVecArms already use) for __obj_find
# companion lookups and the ArraySetLength shrink walk.
coercion-sites-allow:
  - src/codegen/vec-overlay.ts
---

# #3251 — array-descriptor OVERLAY substrate (standalone)

**This is an ARCHITECT EPIC, not a dev slice.** Cross-cutting, real
standalone-floor regression risk. Needs an implementation spec before any
code. Filed after a scope-first investigation of the #3246 array-exotic
defineProperty follow-up proved the slice is substrate-blocked (see root cause).

## Problem

Under `--target standalone`, WasmGC-vec-backed arrays (`$Vec`) have **no
per-index or expando property-descriptor storage**. Every array-property
operation that needs descriptor semantics (attributes, accessor get/set,
ValidateAndApplyPropertyDescriptor redefine-legality, non-configurable/
non-writable enforcement) is silently dropped or bypassed. Both the **write**
side (`Object.defineProperty(arr, idx/name, desc)`) and the **read** side
(`arr[idx]`, `Object.getOwnPropertyDescriptor(arr, k)`, iteration through a
defined accessor index) are incoherent with each other.

## Root cause (verified 2026-07-13, opus-defineprop2)

Verified with a local standalone test262 runner (compile → `_start` →
render exn) + WAT dumps:

1. **`__defineProperty_value` native lenient no-op on `$Vec`**
   (`src/codegen/object-runtime.ts:5135`): the body opens with
   `any.convert_extern; ref.test $Object; i32.eqz; if → return obj`. Array
   receivers are `$Vec`, **not** `$Object`, so they hit the early return —
   **zero** ValidateAndApply validation and **zero** coherent descriptor
   storage for array-INDEX defines. (The #2042-S4 preflight lives *inside*
   this native, after the `$Object` gate, so it never runs for arrays.)

2. **Named-key define on arrays works only via COMPILE-TIME machinery, not a
   runtime overlay** (`src/codegen/declarations.ts:2570` `widenedTypeProperties`
   + `definedPropertyFlags` + `emitStaticDescriptorTransitionThrow`): when the
   compiler statically sees `arr.foo` referenced, it widens the var to a struct
   with a `foo` field and validates redefine transitions at compile time. That
   is why `Object.defineProperty(arr,"foo",{...configurable:false})` +
   config-flip redefine throws (15.2.3.6-4-34 passes). Array **indices**
   (`"0"`,`"1"`) are vec *elements*, never widened struct fields, so they miss
   this path entirely — no field, no flag tracking, no throw.

3. **Plain-object index-key redefine already validates** (S4 works on
   `$Object`) — confirming the gap is array-specific: `$Vec` receivers bypass S4.

4. **`verifyProperty` demands full read/write coherence**
   (`test262/harness/propertyHelper.js:86`): it asserts
   `desc.value === obj[name]` via a DIRECT index read, plus writability probes
   that WRITE `obj[name]` and check it stuck, plus enumerability/configurability
   (for-in + delete) probes. So making a redefine *throw* is necessary but NOT
   sufficient — element reads AND writes must honor per-index descriptor
   attributes. That is the substrate this epic must build.

## Impact (why this is a big lever, not a 69-test slice)

Two host-free-FAIL clusters are downstream of the SAME missing substrate:

- **Array-exotic defineProperty TypeError cluster** — 69 `built-ins/Object/
  defineProperty` "'O' is an Array" tests; 41 use `verifyProperty` (need full
  coherence), 28 throw-only (many need per-index configurability for
  length-shrink). The self-contained cases (length attr/accessor TypeErrors
  9/10, named-key redefine -34/-187/-188) already pass.
- **Array generic-method over a defined-accessor index** — **~204 host-free
  assertion_fail** (`built-ins/Array/prototype/{map,filter,reduce,reduceRight,
  forEach,some,every}` `15.4.4.*`, signature `assert(testResult, 'testResult
  !== true')` + `assert(accessed,...)`, plus ~43 `newArr.length`). These do
  `Object.defineProperty(arr, "1", { get() {...} })` then iterate; the getter
  is never stored/consulted during iteration, so the callback never sees the
  accessor value. Same root: no per-index accessor-descriptor storage on `$Vec`.
  (Scope narrowed 2026-07-23: the plain named-data EXPANDO-write half of the
  "array/function expando writes return NaN" symptom LANDED separately via
  **#3537 / PR #3506** — array expando own-properties on standalone `$Vec`
  receivers. It no longer belongs to this epic. What REMAINS here for expandos
  is the descriptor half: accessor entries, attribute enforcement, and
  ValidateAndApplyPropertyDescriptor legality through the overlay. Function
  receivers are the #3468 own-property family, not this epic.)

Total addressable ≈ **250–300 host-free-FAIL** once the overlay is coherent.

### Default (JS-host / gc) lane hits the SAME wall (2026-07-24, #3201 measurement)

The overlay is NOT a standalone-only lever — the default host/gc lane's Array
method residue bottoms out on the identical missing substrate. The #3201
fork-per-file measurement (default gc/"honest" lane, 2026-07-12→24 baseline)
found, across `built-ins/Array/prototype/{indexOf,lastIndexOf,slice,splice,
sort,concat,pop}`:

- **Indexed accessors** ~34 default-lane fails — `sort/precise-getter-*` /
  `precise-setter-*` (16) + the search/structural analogues. `Object.
  defineProperty(arr, i, {get/set})` then a method reads/sorts: the accessor is
  never stored/consulted (returns `undefined`). Same root as the ~204 host-free
  cluster above, on the host lane.
- **Prototype-chain index inheritance** — `Array.prototype.indexOf.call(
  {length:3}, v)` with `Object.prototype[i]=v` (indexOf/lastIndexOf `.call`
  cluster), and `Array.prototype[i] = v` inherited-index reads (pop/splice/sort
  `S15.4.4.*_A4`). The flat `$Vec` can't model inherited/own index descriptors,
  so these read the backing (or trap) instead of the prototype value.
- **Hole → `undefined` read** — `new Array(2); x[0]` reads **`null`**, not
  `undefined` (sort `S15.4.4.11_A1.1_T1` etc.). A hole must materialize as the
  `undefined` singleton on read; the flat vec serves a raw null. (Adjacent to
  #2001 sparse-holes-materialize-defaults.)

Same fix (per-index descriptor + hole/accessor coherence through the overlay)
unblocks both lanes. #3201 split its contained slices out (the sort/coercion
micro-fixes) and its species/@@isConcatSpreadable mass to **#3575**; this
accessor/proto-index/hole-read mass is recorded HERE as the shared host-lane
consumer of the overlay.

## Proposed direction (for the architect to spec)

Give a `$Vec` receiver a **companion per-index/expando descriptor map** that
ALL of these consult uniformly:
- `Object.defineProperty` (index + name) — store value + attributes, run the
  full §10.1.6.3 ValidateAndApplyPropertyDescriptor (reuse the
  `__defineProperty_value` S4 preflight) against the companion.
- element **read** (`arr[k]`) — an index carrying a non-default descriptor
  (accessor, or non-writable value) reads through the companion; plain dense
  elements keep the fast vec path.
- element **write** (`arr[k] = v`) — honor per-index `writable:false` (drop) +
  accessor `set`.
- `Object.getOwnPropertyDescriptor` / `getOwnPropertyNames` / for-in — merge
  the companion with the dense vec elements.
- array-`length` ArraySetLength (§10.4.2.1) with per-index non-configurable
  shrink-blocking (the 28 throw-only length tests).

Key design questions for the spec:
- **Storage**: a side `$Object` companion keyed by vec identity (ref.eq scan vs
  a hidden field on `$Vec`); the vec type layout is load-bearing across every
  array op, so a hidden field is a large blast radius — weigh vs a side table.
- **Fast-path preservation**: dense arrays with no defined descriptors must
  keep the zero-overhead `array.get`/`array.set` path (perf + no regression).
  Gate the companion consultation on "this vec has ≥1 special descriptor."
- **Host lane byte-identical**: all changes `ctx.standalone`-gated; host routes
  through `__defineProperty_desc` / `__vec_set_elem` (#3116) imports already.

## Acceptance criteria (epic-level; slice in the spec)

- Array-index `Object.defineProperty` stores value + attributes coherently;
  `arr[idx]` and `getOwnPropertyDescriptor(arr, idx)` agree.
- ValidateAndApplyPropertyDescriptor redefine-legality throws catchable
  TypeError for arrays (non-configurable redefine, non-writable value change,
  data↔accessor flip, etc.).
- `verifyProperty` passes for array-index defines (full read/write/enumerate/
  configure coherence).
- Array generic methods visit a defineProperty'd accessor index and invoke its
  getter (the ~204 `testResult`/`accessed` cluster).
- Dense-array fast path unchanged (no perf/behaviour regression); host/gc
  output byte-identical; standalone floor NET ≥ 0.

## Implementation Plan (fable-1, 2026-07-17 — replaces the needs_architect_spec gate)

### Verified routing (WAT-probed on 0f7ac132a0, all 7 repro probes fail as filed)

Both the dynamic (`any`) lane AND the typed local lane funnel through the SAME
runtime natives — the substrate has exactly four chokepoints:

- **Define**: `Object.defineProperty(arr, k, d)` → `__defineProperty_value` /
  `__defineProperty_accessor` (object-runtime-descriptors.ts) with the vec
  boxed to externref. Both open with `ref.test $Object`-else-return-obj — the
  lenient no-op. `__defineProperty_desc` + the plural loops dispatch INTO these
  two, so a vec arm here covers every define entry point.
- **Dynamic element read**: `arr[i]` (any lane) AND every `__hof_*` loop
  (map/filter/every/… — the ~204-test cluster iterates through `__hof_every`
  etc., confirmed by WAT) read through **`__extern_get_idx`** — one chokepoint.
- **Typed element read**: raw `array.get` inline — NOT hookable cheaply; kept
  fast by writing data-define VALUES INTO the vec (the #3116 host-mode trick).
- **gOPD**: `__getOwnPropertyDescriptor` — same `$Object`-gate miss.

Typed-lane call sites also PRE-GROW the vec (`maybeEmitVecLengthGrowth`,
object-ops.ts:468) before calling the native — which destroys the real-element
vs fresh-hole distinction (#3116 regression class 1). Standalone-gate it off so
the native sees the true length.

### Storage decision: side table of companions, NOT a hidden `$Vec` field

A hidden field is rejected: `$Vec` layout ({length, data} subtyping
`$__vec_base`) is load-bearing across every struct.new site, the `$__subview`
prefix, and the per-carrier dispatch arms — unbounded blast radius. Instead:

- New module `src/codegen/vec-overlay.ts`:
  - `$__overlay_pair` struct `{ vec: anyref, companion: (ref null $Object) }`,
    growable `$__overlay_tab` array + `$__vec_overlay_tab` /
    `$__vec_overlay_count(i32)` globals.
  - `__vec_overlay_lookup(anyref) -> (ref null $Object)` — count==0 fast path,
    then linear `ref.eq` scan (defineProperty-on-array is rare; table is ~0/1).
  - `__vec_overlay_ensure(anyref) -> (ref $Object)` — lookup-or-append (companion
    minted via `__new_plain_object`).
- **The companion is a plain `$Object`** — so the vec arms DELEGATE to the
  existing, already-correct `$Object` machinery (`__defineProperty_value` S4
  ValidateAndApply preflight, §10.1.6.3 merge, CompletePropertyDescriptor
  defaults, `__obj_find`, gOPD builder) instead of duplicating any of it.

### Coherence rules

- **Data defines**: full delegate to `__defineProperty_value(companionExt, key,
  value, flags)` (validation + attribute storage), THEN write the value back
  into the vec element per-carrier (`ensureVecElemSet` handles in-bounds +
  grow + length update). Kind-incompatible values (string value into `__vec_f64`)
  skip write-back and set a new `$PropEntry` flag bit `FLAG_COMPANION_VALUE
  (16)` so dynamic readers prefer the companion value.
- **Seeding**: an in-bounds index with NO companion entry is a REAL element →
  seed `{value: vec[i], w/e/c: true}` into the companion BEFORE delegating, so
  redefine-legality validates against the spec's implicit element descriptor
  (fresh OOB indices stay first-definitions → defaults false — correct, and
  the reason the call-site pre-growth must go).
- **Accessor defines**: delegate to `__defineProperty_accessor` on the
  companion (after the same seeding); NO vec length extension for OOB accessor
  defines (#3116 15.2.3.6-4-312 lesson — deferred with ArraySetLength).
- **Reads**: `__extern_get_idx` gets a finalize-spliced prologue (gated on
  `$__vec_overlay_count != 0` → zero cost for overlay-free modules): companion
  entry with FLAG_ACCESSOR → `__call_accessor_get(origReceiver, getter)`
  (correct `this`); FLAG_COMPANION_VALUE → companion value; else fall through
  to the existing per-carrier vec arms (vec value is authoritative — it was
  written back at define time and later plain writes keep it fresh).
- **gOPD**: vec arm — companion entry present → delegate to the `$Object`
  gOPD on the companion; no entry + in-bounds index → synthesize
  `{value: vec[i], writable/enumerable/configurable: true}` fresh (do NOT seed
  on reads); else undefined.
- **`length` key**: explicitly excluded (legacy no-op) — ArraySetLength with
  non-configurable shrink-blocking is slice 3.

### Emission-order discipline (the hazard part)

The define/gOPD natives are built EARLY (ensureObjectRuntime) but the
per-carrier vec types + `__str_to_number`/`number_toString` are only complete
at FINALIZE. Use the two proven patterns, nothing new:

- The vec arms baked early are a single `ref.test $__vec_base` → `call
  <reserved __vec_dp_value / __vec_dp_accessor / __vec_gopd>` → return.
  Reserved via the `reserveAccessorSetDriver` pattern (mintDefinedFunc +
  placeholder body + funcMap; `ctx.vecOverlayReserved` flag). Placeholders are
  SAFE NO-OPS (`return obj` / `return null-extern`), not `unreachable`, so a
  skipped fill degrades to today's behavior instead of trapping.
- `fillVecOverlayHelpers(ctx)` runs in index.ts finalize right after
  `fillExternSetVecArms` (#3190): fills the three bodies (carrier whitelist:
  elemKind f64 / externref / `$AnyString`-ref only — TypedArray carriers +
  subviews keep the legacy no-op), and splices the overlay prologue into
  `__extern_get_idx` (append-locals, splice-front, fresh Instr factories per
  the shared-instr double-remap hazard).
- Key→index: `__str_to_number` + NaN check + canonical round-trip
  (`number_toString(n)` `__str_equals` key) — the CanonicalNumericIndexString
  discipline; `"length"` via the `__str_flatten`+`__str_equals` pattern from
  `fillDynamicForinVecArms` (#3183).
- Strict number test for f64 write-back: `ref.test ctx.nativeBoxNumberTypeIdx`
  (+ `$AnyValue` tag 2/3 arm when `ctx.anyValueTypeIdx >= 0`) — NEVER the
  coercing `__unbox_number` alone (defineProperty must not ToNumber the value).

### Host-lane byte identity

Every emission is inside standalone-only builders (`ensureObjectRuntime`
natives) or `ctx.standalone`-gated (pre-growth removal, finalize fills). Host
mode routes defineProperty through the JS-import sidecar (#3116) untouched.
Verify: compile a defineProperty-using module in host mode on main vs branch —
byte-identical (the #1917 discipline).

### Slices

- **S1 (this PR)**: overlay core + define arms (value/accessor) + seeding +
  vec write-back + `__extern_get_idx` overlay prologue + gOPD vec arm +
  pre-growth standalone-gate. Covers probes A–F (define/readback coherence,
  redefine-throws, accessor+HOF ~204 cluster, gOPD).
- **S2**: write-side enforcement — `writable:false` drop + setter invoke in
  `fillExternSetVecArms`' arm and the typed/inline assignment lanes;
  `__extern_get`/`__extern_has` named-expando companion consult; for-in merge
  (enumerable:false filtering).
- **S3**: ArraySetLength (§10.4.2.1) — length define validation, RangeError,
  shrink stopping at non-configurable elements (the 28 throw-only tests),
  gOPD("length").

## S1 implementation notes (fable-1, branch `issue-3251-array-overlay-s1`)

- New module `src/codegen/vec-overlay.ts` (reserve + finalize fill); arms in
  `object-runtime-descriptors.ts` (3 gates), fill wired in `index.ts` between
  `fillDynamicForinVecArms` and `fillTaDynViewMopArms` (the TA dyn-view arm
  must keep the front slot of the read helpers); call-site pre-growth
  standalone-gated in `object-ops.ts`; `FLAG_COMPANION_VALUE = 0x20` claimed
  in the `$PropEntry` flag table.
- **Documented S1 boundaries** (deliberate, for S2/S3):
  - Plain writes do not yet honor `writable:false` / invoke setters (S2 — hook
    `fillExternSetVecArms`' arm + the typed/inline assignment lanes).
  - After a later plain write to an overlaid index, the companion's stored
    value goes stale; gOPD then reports the define-time value while element
    reads see the fresh vec value (S2 closes this by making gOPD read the vec
    for non-marker data entries).
  - OOB defines (value, kind-incompatible value, AND accessor) grow the vec
    to i+1 (`__vec_elem_set_<t>`, carrier default for value-less slots), per
    §10.4.2 — required by the dominant `var arr = []; defineProperty(arr,
    "2", {get}); arr.every(cb)` cluster shape (probes H/I/J/K). Intermediate
    holes read as the carrier default (null/0) rather than undefined; real
    hole semantics ride with ArraySetLength (S3). This deliberately diverges
    from #3116's host-mode deferral: there, hole reads had no overlay to
    consult; here the read prologue answers for overlaid indices and `[]`
    lowers to an externref carrier whose null default observes ≈undefined.
  - `"length"` defines/gOPD keep the legacy no-op/miss (S3).
  - Symbol keys on vec receivers keep the legacy no-op.
  - The typed inline `array.get` lane reads through the vec only — an
    accessor defined on an index read via a STATICALLY-typed local (not
    through the dynamic lane) is not consulted (the ~204-test cluster reads
    through `__hof_*`/`__extern_get_idx`, which are covered).

## 2026-07-23 claim reconciliation — stale `fable-1` claim RELEASED (lead-directed)

- The `ttraenkler/fable-1` in-progress claim was released as **stale** on all
  three liveness signals: no `3251.json` record on the `issue-assignments` ref,
  no open PR for #3251, and last branch activity 2026-07-18 (agent no longer
  active). Status returned to `ready` — the next senior-dev claims fresh via
  `claim-issue.mjs` (no `--force` needed; there is no live lock).
- **Do NOT restart from scratch — validated, UNMERGED S2+S3(+S4) work exists**
  on the fork (`ttraenkler/js2`):
  - `issue-3251-s2-write-enforcement` (tip `766af9b980`) — S2 write-side
    enforcement + S3 ArraySetLength + the plural `Object.defineProperties`
    vec-target fix, all implemented and validated per the Resume State below.
    It was gated on "open the S2 PR only AFTER #3327 lands" — and S1 PR #3327
    **has since merged** (2026-07-18). The next step is exactly: fresh
    `git merge origin/main` into that branch, re-validate, open the S2+S3 PR.
  - `issue-3251-s4-forin` (tip `be7b292cc0`) — stacked on S2; tip commit says
    "resume state — unpark clean, S4 validated, stack order recorded".
  - The **branch copies of this issue file carry fuller resume notes** (S2/S3
    validation detail, probe lists) than this on-main copy — read them first.
- The on-main Resume State below predates the release; ignore its "fable-1
  holds the claim-issue lock" line.

## Resume State (keep current — session-kill insurance)

- **Branch/worktree**: `issue-3251-array-overlay-s1`, checked out in the
  harness worktree `/workspace/.claude/worktrees/agent-a1966ecc04f08e87f`
  (fable-1 holds the claim-issue lock). Base `0f7ac132a0` (origin/main).
- **Implemented (S1 complete, validated)**: `src/codegen/vec-overlay.ts`
  (reserve + finalize fill: overlay side table, `__vec_dp_value`/`_accessor`/
  `__vec_gopd`, read prologues in `__extern_get_idx`/`__extern_get`, OOB
  grow-with-default); 3 vec arms in `object-runtime-descriptors.ts`;
  fill wired in `index.ts` (between `fillDynamicForinVecArms` and
  `fillTaDynViewMopArms` — TA arm MUST stay in front); pre-growth
  standalone-gated in `object-ops.ts`; ctx fields in `context/types.ts` +
  global-shift entry in `registry/imports.ts`; `tests/issue-3251.test.ts`
  (18 tests, all green pre-growth-change).
- **Validation state**: tsc clean; probes A–K all correct (`.tmp/probe-3251.mts`,
  `.tmp/probe-3251b.mts` in the worktree); host lane byte-identical vs main
  (`.tmp/probe-host-bytes.mts`, sha 2c52919a… both sides); scoped descriptor
  suite 119/120 with the single failure (`issue-2668` for-in proto-attrs)
  failing identically on main.
- **S1 validation COMPLETE (2026-07-18)**: issue-3251 suite 18/18 post-growth;
  descriptor suite 119/120 (single failure = pre-existing main failure);
  read-lane collateral (3183/2190/2190b/2186/3098) — exactly the same 3
  failures as main (pre-existing); host sha unchanged. S1 PR is up; epic stays
  in-progress for S2 (write-side enforcement + gOPD staleness) and S3
  (ArraySetLength). Next dev: pick S2 from the boundaries list above.
- **Known hazards**: `ref.null`/`ref.cast` abstract heap types — object-runtime's
  `NONE_HEAP=-18` is `any`, real `none` is `-15` (vec-overlay documents this);
  never busy-wait on a pegged box; one compile at a time.

## 2026-07-18 merge-queue park — diagnosed INFRA COLLATERAL (not this PR)

PR #3327 was auto-parked on its first merge_group run (29631783983). Diagnosis
(fable-1): the standalone lane collapsed to 4,508 pass / 43,469 compile_error,
every CE = `standalone target emitted host imports: env::console_log_externref,
env::structuredClone (#2961)` — HOST-wrapper import signatures recorded under
the standalone lane. UNRELATED PR #3322 failed its merge_group with
byte-identical counts; fresh-based #3325 passed the same hour on the same main
tip. Verdict: a stale-base merge-group precompile-cache/lane bug on main (post
#3380/#2961 overnight changes), NOT an overlay regression — S1+current-main
compiles standalone locally with zero imports (probes + 18/18 suite; those
import names have no standalone emission sites in the compiler). Actions:
main catch-up merged+pushed on the S1 branch, determination documented on the
PR, hold removed ONCE, escalated to the tech lead (#3322 owner needs the same
catch-up; a [CI-FIX] should own the lane bug). Diagnostic artifacts: the
merged-report jsonls under the worktree `.tmp/mg-merged/` + `.tmp/mg-3322-merged/`.

## Stale sibling branch (do not delete — hygiene-pass salvage)

`origin/issue-3251-array-descriptor-overlay` (pre-dates this work, from
opus-defineprop2) holds 2 unlanded docs commits (`plan/log/
standalone-assertion-fail-dispatch-map.md`, the #1781 dispatch map, ecd5bd2883)
on a base 1170 commits behind main. Per tech-lead 2026-07-17: leave in place,
harvest in a later hygiene pass — do NOT merge it into work branches (silent-
revert hazard, `feedback_longlived_branch_silent_revert`).

## Provenance

Filed from the #3246 follow-up scope-first analysis (tech-lead-directed). The
compile-time-`definedPropertyFlags`-for-indices interim was explicitly declined
(flips only the few index throw-only tests that don't read back — not worth the
complexity). This epic is the correct-sized fix.
