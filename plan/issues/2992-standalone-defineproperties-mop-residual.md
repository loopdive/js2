---
id: 2992
title: "Standalone defineProperties MOP residual (~250: array/arguments own-prop MOP + accessor-attribute fidelity + destructive verifyProperty/tombstone survival)"
status: in-progress
sprint: Backlog
priority: high
horizon: l
feasibility: hard
model: fable
area: codegen, runtime
goal: standalone-mode
related: [2965, 2985, 2667]
oracle-ratchet-allow:
  # S6 pre-pass stores raw ts.Type INSTANCES in objectHashConsumerTypes
  # (identity-keyed, #2944 provenance guard via symbol.declarations) — oracle
  # TypeFacts cannot express that; OracleTypeKey migration is #1930 Slice 5.
  # property-access.ts needs NO allowance: its S6 callable-prop gate routes
  # through ctx.oracle.signatureOf.
  - src/codegen/declarations/object-shape-widening.ts
loc-budget-allow:
  - src/codegen/declarations.ts
  - src/codegen/object-runtime.ts
  - src/codegen/object-ops.ts
  - src/codegen/declarations/object-shape-widening.ts
  - src/codegen/property-access.ts
  - src/codegen/binary-ops-in.ts
  - src/codegen/typeof-delete.ts
origin: "#2985 sizing-pass split — the substrate-scale MOP remainder after the illegal-cast slice shipped in #2985"
---

# #2992 — standalone defineProperties MOP residual (~250)

## Problem

Split out of #2985. #2985 was the whole `defineProperties` 5-b/6-a slab residual
(~250, mixed bucket). The bounded, discrete sub-bug (the `__obj_find`
illegal-cast on non-string computed keys) shipped in #2985. This issue carries
the **remaining ~250 substrate-scale MOP work**, which is genuinely
large/hard and wants further slicing:

- **array / arguments own-property MOP** — `defineProperty`/`defineProperties`
  on array indices and `length` with full attribute semantics.
- **accessor-attribute fidelity** — get/set descriptor round-trips through
  define → gOPD must preserve accessor identity and attribute flags.
- **destructive `verifyProperty` survival** — test262's `verifyProperty`
  mutates then restores the property; the standalone MOP must survive the
  define→delete→redefine cycle.

## Concrete evidence (measured 2026-07-02, standalone)

The destructive-`verifyProperty` sub-class has a reproducible root cause that is
**not key-type-specific** — a plain string-keyed delete→re-read already fails:

```ts
const o: any = {};
o["k"] = 1;
delete o["k"];
o["k"] === undefined; // FALSE in standalone (returns the stale value)
```

i.e. after `__delete_property` tombstones an entry, a subsequent read on the
same key does not consistently observe the tombstone. This is the mechanism
behind verifyProperty's define→delete→redefine failures and should be the first
slice (it is bounded and high-leverage). Suspect area: the tombstone-skip /
open-addressing read path in `__obj_find` / `__extern_get`
(`src/codegen/object-runtime.ts`).

## Acceptance

- Measured flip count on the `built-ins/Object/defineProperties` (and
  `defineProperty`) standalone subset, per sub-class, with zero regressions on a
  passing-test sweep.
- gc/host lane byte-inert (standalone-gated).

## Notes

Wants slicing into separate PRs:

1. delete-tombstone-read survival (bounded — start here). **SHIPPED — see slice-1 findings below.**
2. array/arguments index + `length` own-prop MOP. **BLOCKED on the vec-receiver own-prop substrate (see slice-3 findings) — no bounded slice (#2986 agrees).**
3. accessor-attribute (get/set) define→gOPD fidelity. **SHIPPED (with the broader §10.1.6.3 partial-descriptor MERGE) — see slice-3 findings below.**
4. (NEW, found during slice 1) nominal-struct field delete fidelity — see below. **SHIPPED (standalone `{}`-widening shape) — see slice-4 findings below.**
5. (NEW, found during slice 3) accessor/own-prop MOP on CLOSED-STRUCT receivers (`__extern_get` accessor arm misses; hasOwnProperty/delete invisible) — the biggest residual cluster (4-75/4-82-\* family), substrate-adjacent to slice 2 and slice 4. **SHIPPED for the empty-`{}`-widening receiver shape — see slice-5 findings below.**

## Slice 1 findings (measured 2026-07-10 on main 569e29b761, fable-18th)

The headline repro was re-measured and confirmed still failing — but the root
cause is NOT the tombstone machinery (`__obj_find`/`__extern_get` in
`object-runtime.ts` handle tombstones correctly; delete→read inside a function
works in every lane):

- **Actual root cause:** the module-level statement collector in
  `src/codegen/declarations.ts` recognises New/Call, ++/-- and assignment
  BinaryExpressions, but `delete o.k` is a `ts.DeleteExpression` — its own
  node kind, NOT a `PrefixUnaryExpression` — so a **top-level `delete`
  statement was silently dropped from `__module_init`** (the issue's repro is
  top-level). Reads then observed the stale value and `"k" in o` stayed true.
  Affected ALL lanes (gc / standalone / wasi) identically, not just standalone.
- **Fix (slice-1 PR):** collect `DeleteExpression` statements into
  `__module_init`; also unwrap `void <expr>` in top-level statement position
  (it was dropped the same way). Tests: `tests/issue-2992.test.ts` (12 cases,
  gc + standalone: read-after-delete, `in`, define→delete→redefine→delete
  cycle, parenthesized/void-wrapped, in-function control).
- **NEW sub-bug (slice 4, standalone only, pre-existing):** when shape
  inference promotes an all-prop-access object to a nominal struct
  (`o.k = 1; delete o.k; o.k === undefined` with every site using `.k`), the
  field is f64-typed: `delete` writes an `f64.const NaN` sentinel via the
  post-`__delete_property` arm and `o.k === undefined` is constant-folded to
  `i32.const 0` — the read can never observe undefined. Mixed elem/prop access
  keeps the object dynamic and passes. Not a regression from slice 1 (failed
  identically before, via the top-level drop).

## Slice 3 findings (measured 2026-07-11 on main 026f40f771, fable-sub2)

Fresh-baseline re-measure (2026-07-11 standalone jsonl, post-slice-1): the
`defineProperty`/`defineProperties` standalone-fail/host-pass gap is **560**.
Root-caused via the real runner pipeline (`runTest262File(..., "standalone")`
— reduced probes MISLEAD here because the runner wraps the test body in
`export function test()`, which changes shape inference):

- **Partial-descriptor redefine CLOBBERED (fixed this slice):**
  `__defineProperty_value` / `__defineProperty_accessor` blanket-inserted on
  redefine — unspecified attributes reset to false, a flags-only define
  clobbered [[Value]] with null, and FLAG_ACCESSOR (+ live get/set halves) was
  wiped. Both appliers now MERGE in place per §10.1.6.3, driven by the
  specified-bits (3/4/5 existing; NEW bits 8/9 = get/set specified,
  standalone-gated at call sites, legacy no-bits ⇒ replace-both).
- **Accessor identity (fixed):** `get: someIdentifier` re-synthesized a fresh
  closure from the AST (`emitAccessorRefValue` standalone arm) — gOPD read
  back a different function (`desc.get === getFunc` false). Identifiers now
  compile to their live closure VALUE (driver-invocable; verified via the
  dynamic-descriptor path which always stored raw values).
- **Explicit `get: undefined` / `set: undefined` (fixed):** dropped at the
  call site; now routed as PRESENT accessor fields (specified bit + null
  half), so 15.2.3.6-4-439-style gOPD `hasOwnProperty("get")` passes and a
  later data-redefine on the non-configurable accessor throws.
- **Non-configurable accessor validation (fixed):** the accessor applier had
  NO §10.1.6.3 rejections — configurable/enumerable flips, data→accessor
  conversion, and get/set SameValue changes on a non-configurable property
  now throw catchable TypeErrors; new-key define on a non-extensible object
  throws (was a silent no-op).
- **Explicit `get: null` → TypeError is implemented but only observable under
  the `undefinedSingleton` regime (#2106, default OFF)** — legacy regime
  cannot distinguish stored null from undefined, so those ~6 tests stay red.
- **Out of slice (measured, blocked on the vec/closed-struct receiver
  substrate — same wall as #2986's sizing):** (a) exotic DESCRIPTOR receivers
  (array/arguments/function/Error descriptors, incl. inherited fields) — even
  plain expando reads fail on those receivers; (b) array-index/length
  attribute MOP (~109 "expected TypeError" tests, slice 2); (c) accessor
  define on CLOSED-STRUCT receivers (runner-wrapped `var obj = {}` with pure
  prop access) — `__extern_get` accessor-arm reads miss; affects the large
  4-75/4-82-\* residual. All shapes fail identically on unmodified main
  (verified) — no regression from this slice.

Measured sample flips (runner pipeline, standalone): 11 of 144 sampled gap
tests flip to pass (4-439, 7-6-a-105, 7-6-a-38-1, 4-336, 4-373, 4-381, 4-430,
4-448, 4-454, 4-457, 4-508); merge semantics also serve every
verifyProperty-style partial redefine outside these buckets. Regression
sweeps: 142/142 baseline-passing tests (defineProperty/ies, freeze, seal,
preventExtensions, create, gOPD, Reflect, Array.prototype, Boolean) still
pass; equivalence `object-define-property*`, `define-property-typeerror`,
`hasownproperty-call`: 46/46; `tests/issue-2992.test.ts` 12/12;
new `tests/issue-2992-accessor-merge.test.ts` 18/18 (gc + standalone).

## Slice 4 findings (measured 2026-07-11 on main 2ff0db4f0a, fable-sub2)

The headline nominal-struct delete repro is fixed for the **empty-`{}`-widening
shape** (the issue's documented case): `delete varName.prop` /
`delete varName[k]` is now an `$Object`-hash consumer for the widening
decision in `src/codegen/declarations.ts` (`markStandaloneDeleteTargets`,
standalone-gated). A widened closed-struct field can only take a type-shaped
SENTINEL on delete (f64 → NaN, ref → null; `typeof-delete.ts`), and the
statically-typed read const-folds `o.k === undefined` to false — so the var
now stays a `$Object`, where the slice-1 `__delete_property` tombstones give
correct delete → read / `in` / hasOwnProperty / typeof semantics.

Measured: probe matrix 10/10 (top-level + in-function, f64 + string fields,
delete→redefine cycle, parenthesized target, elem-access delete, no-delete
widening control, cross-var control); `tests/issue-2992-delete-widening.test.ts`
12 pass + 2 documented gc-lane skips; +3 flips in the 80-file defineProperty
gap sample and +2/9 in the `language/expressions/delete` standalone gap;
142/142 baseline-pass sweep and the 50-test equivalence regression set clean.

**Documented residuals (fail identically on unmodified main — NOT regressions):**

- **gc-lane twin**: the top-level widened-struct delete has the same
  sentinel/const-fold bug in the gc/host lane; this slice is standalone-gated
  (host poison needs the #2937/#2944 `objectHashConsumerTypes` escape
  discipline — separate risk profile).
- **Non-empty literal receivers** (`const o = { name: "hello" }; delete
o.name`) — closed-struct-literal shape (fails in gc too; the pre-existing
  `delete-sentinel` equivalence failure). Extending #2837's
  `collectGrowableObjectLiterals` triggers with delete-targets is the likely
  lever, but its consumer-safety guard needs its own validation pass.
- **Two-`{}`-var type-interning hazard**: when ANOTHER var's widening interns
  the shared `{}` literal ts.Type in `anonTypeMap`, the poisoned var's `{}`
  initializer can still compile to the OTHER var's struct (pre-existing
  type-identity hazard, fails identically on main).

## Slice 5 findings (measured 2026-07-16 on main f01f7fbb6e, fable-mop)

The slice-3-documented closed-struct-receiver accessor cluster (4-75/4-82-\*
family) is fixed for the **empty-`{}`-widening receiver shape**: an
ACCESSOR-descriptor `Object.defineProperty(varName, k, {get/set…})` (or any
`defineProperties` member descriptor with a get/set key — present key counts
even with value `undefined`) is now an `$Object`-hash consumer for the widening
decision (`markStandaloneAccessorDefineTargets` in
`src/codegen/declarations/object-shape-widening.ts`, standalone-gated, slice-4
pattern). Root cause: the widened closed-struct field can only store a plain
value — reads never invoke the getter, writes never route through the setter,
and gOPD never observes accessor-ness. On the `$Object` representation the
slice-3 (#2893) accessor machinery serves define → read → gOPD correctly.
Verified via the real runner pipeline (reduced probes mislead — the reduced
form of 4-82-10 passes on unmodified main).

Measured (264-file deterministic sample: 4-75..4-82 accessor family + every
4th accessor-matching defineProperty + every 5th accessor-matching
defineProperties + every-12th broad regression stride over both dirs):
**+29 flips, 0 regressions** (140 → 169 pass, all 140 control passes stay
passing). gc/host lane byte-inert (SHA-identical binaries pre/post on the
wrapped 4-82-10 + inline accessor probes). New
`tests/issue-2992-accessor-widening.test.ts` 14/14 (gc + standalone);
`tests/issue-2992.test.ts` 12/12; `issue-2992-delete-widening` 12 + 2
documented skips; equivalence family sweep 46/47 (the 1 failure is the
documented pre-existing `delete-sentinel` string-property case).

**Documented residuals (fail identically on unmodified main — NOT from this slice):**

- **PRE-EXISTING main regression (flagged 2026-07-16):** 4 of 18
  `tests/issue-2992-accessor-merge.test.ts` standalone cases now fail on
  unmodified main (3× `illegal cast`, 1 value mismatch) — the
  dynamic-descriptor (`var d: any = {get…}; Object.defineProperty(o, k, d)`)
  - bracket-poisoned-receiver shapes from slice 3. They passed 18/18 on main
    026f40f771 (2026-07-11), so something later regressed them. Not caught by
    CI (the quality gate runs scoped suites only). Tracked as **#3316**
    (bisect + fix).
- **Exotic DESCRIPTOR receivers** (array/arguments/function/Error descriptor
  objects) and **array-index/length attribute MOP** — still the slice-2 wall
  (vec/closed-struct receiver substrate, #2986).
- **Non-empty literal receivers** (`var o = {a: 1}; defineProperty(o, k,
{get…})`) — closed-struct-literal shape, same class as the slice-4
  non-empty-literal residual (the widening pre-pass only decides empty-`{}`
  vars; `collectGrowableObjectLiterals` guards would need their own pass).

## Slice 6 findings (measured 2026-07-17 on main 279731ac1a, fable-epsilon)

The slice-4/5-documented **non-empty-literal receiver** residual is fixed for
the standalone lane (branch `issue-2992-s6-nonempty-literal-widening`):

- `collectGrowableObjectLiterals` grew a standalone-gated S6 arm: a non-empty
  PURE-DATA literal var that is a `delete` target (prop or elem form) or an
  accessor-define target (reusing the S4/S5 markers) is routed to the
  externref `$Object` builder (`growableObjectLiteralVars`) AND its checker
  type is struct-refused (`objectHashConsumerTypes`, #2944
  provenance-guarded) so every position stays externref. Consumer-safety:
  a genuine concrete-struct-typed value use (call/new arg, return,
  assignment) suppresses the marking (#1897 discipline); `Object.<mop>(o,…)`
  args are excluded from that guard (generic `T` binding is not a struct
  consumer).
- Three checker-type folds were unsound for such receivers and got
  growable-root guards (standalone-gated): the member-read result coercion
  (new `tryStandaloneGrowableDynamicGet` in property-access.ts returns the
  RAW externref — the #2179 gc-lane fix's standalone analogue), the `in`
  operator's `tsTypeHasProperty` fold (binary-ops-in.ts → `__extern_has`),
  and the `typeof`-comparison fold (typeof-delete.ts).

Measured: 14/14 semantic probes (delete num/str/typeof/in/hasOwnProperty/
elem/redefine/any-typed, accessor infn + const-alias, forin-after-delete,
struct-consumer guard); `tests/issue-2992-s6-nonempty-literal.test.ts` 11/11;
2992 suites 56 pass + 2 documented skips (accessor-merge 18/18); delete
family 41/41; 290-file standalone A/B (delete dir + every-8th
defineProperty/defineProperties) **0 flips, 0 regressions** vs base; host
lane byte-identical (4/4 SHA probes).

**Documented residuals (unchanged):**

- gc/host-lane twin (the `delete-sentinel` string-property equivalence
  failure) — fails identically on base; host poison needs the #2937/#2944
  escape discipline (separate risk profile).
- Struct-consumer-guarded vars keep the closed-struct path and its
  delete/accessor gap (when-in-doubt-don't-mark).
- Slice-2 wall (exotic descriptor receivers, array-index/length attribute
  MOP) — #2986 substrate, not touched.

## Test Results (slice 1)

- `tests/issue-2992.test.ts`: 12/12 pass (gc + standalone).
- Delete-family sweep (`tests/equivalence/delete-operator`, `delete-sentinel`,
  `issue-1821`, `issue-2130`, `issue-2726*`, `issue-1364b`): 43/44 pass — the
  one failure (`delete-sentinel > delete string property makes it undefined`)
  fails identically on unmodified main (pre-existing, in-function nominal-struct
  case — same mechanism as the slice-4 sub-bug above).
- Object/property sweep (`object-define-property*`, `object-keys`,
  `object-mutability`, `hasownproperty-call`, `empty-object-widening`,
  `numeric-key-object`): 52/52 pass.
