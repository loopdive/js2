---
id: 3037
title: "Object-identity canonicalization substrate for standalone dynamic reads (foundation under #3027 / V2-S3b reader-arm)"
status: ready
sprint: current
model: fable
fable_role: spec
created: 2026-07-05
updated: 2026-07-17
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
task_type: analysis
area: standalone
language_feature: compiler-internals
goal: standalone-mode
related: [2719, 2734, 2175, 2984, 3027, 2860, 2585, 2040, 1888, 2141]
depends_on: [2175]
origin: "2026-07-05 — V2-S3b (reader-arm MOP) died on the standalone floor proving object-identity canonicalization is the real gate under the ~1,552-test #3027 keystone; the operand-site tag-6 fix is unsound (−299 via assert.sameValue)"
---

# #3037 — object-identity canonicalization substrate (standalone)

**This is a substrate / strategy spec, not a single PR.** It decides WHERE the
compiler canonicalizes object identity so that the same logical object always
yields one `ref.eq`-identical GC ref, which is the foundation the #3027 keystone
(the ~1,552-test `$Object`-dynamic-reader residual) and the #2175 V2-S3b/S3c
reader-arm sit on top of. It composes with — and does not fork — the landed
S3a reconciliation arm (#2175, `__any_strict_eq`) and the #2963 singleton /
per-brand-global anchors.

Verified against `upstream/main @ 27bfb9417` (V2-S3a landed). Line/symbol
anchors are from that HEAD; re-grep if drifted.

---

## The measured problem (traced, not narrative)

In standalone mode a JS object reaches `===` through the `$AnyValue` boxing
layer under **two representations of the same reference**:

- **tag-6** (`refval`, field 3): the raw GC ref, via `boxToAny`'s kind-`ref`
  arm → `__any_box_ref` (`value-tags.ts:228`). This is what a *syntactic* read
  (`RegExp.prototype.exec`, a struct field, a directly-held value) produces.
- **tag-5** (`externval`, field 4): the SAME ref externref-wrapped, via
  `boxToAny`'s kind-`externref` arm → `__any_box_string` (`value-tags.ts:213`).
  This is what a *dynamic* read produces: `__extern_get` returns
  `extern.convert_any(e.value)` (`object-runtime.ts:1138`), an externref, which
  the consumer boxes with the blanket tag-5 arm — the descriptor `.value`, an
  array/vec element, any dynamic member read.

`__any_strict_eq` (`any-helpers.ts:2233`) has three relevant regions:

1. **top `ref.eq` on the two boxes** (`:2242`) — same $AnyValue struct → 1.
   Only fires when both operands are the *identical box*.
2. **cross-tag arm** (`tagA != tagB`, `:2291-2355`) — the **landed V2-S3a
   reconciliation**: recover each operand's payload (refval if non-null, else
   `any.convert_extern(externval)`) to a common `eqref` and `ref.eq`. This
   fixes **tag-6 × tag-5** (mixed) object identity. Standalone/wasi-gated.
3. **same-tag tag-5 arm** (`:2418-2436`, `tag5ValueEqThen` /
   `tag5StringEqThen`) — GUARDED string-CONTENT compare (`ref.test $AnyString`
   on both; `0` for non-strings).

**The residual that killed V2-S3b:** two objects read through the **same**
dynamic reader are BOTH boxed tag-5 → they hit region (3), the same-tag tag-5
arm, whose guard fails for objects → **returns 0** for genuinely-identical
objects. Concretely (all standalone, verified in the V2-S2/S3a logs):

- `gOPD(p,"exec").value === gOPD(p,"exec").value` → **0** (both reads tag-5).
- `const o:any={z:1}; f(o); /* two reader reads of o */` → **0**.
- The 20-test `Array.indexOf` object-element cluster (#2734) was this class in
  the search helper; the general `===` surface is still exposed.

### Why the obvious patches are ALL unsound (the floor minefield)

Region (3) — the tag-5 same-tag arm — is the single most floor-regression-prone
site in the compiler, because **tag-5 is triple-overloaded**: its `externval`
holds genuine strings, `$BoxedNumber` carriers, AND non-string GC
objects/closures (`any-helpers.ts:1566-1570`). Two independent attempts to give
it object-identity are recorded as hard floor regressions:

- Adding a `#2585` object-identity `ref.eq` arm (and a `#2040` numeric arm) to
  the tag-5 same-tag classifier regressed **−162** (ejected from the standalone
  highwater floor): it flips tag-5 boxed-VALUE equality that the
  destructuring / generator-iterator lowering implicitly relies on
  (`any-helpers.ts:1574-1587`).
- Flipping the generic `boxToAny` externref arm (`value-tags.ts:187-213`) to
  honest classification (`honestAnyBoxing`) regressed **−788 / −794**: the
  test262 harness comparator `assert.sameValue` / `isSameValue` routes ALL
  `any` operands through the externref ABI and depends on main's tag-5
  box-the-externref behaviour (`value-tags.ts:206-212`).
- Boxing operands to tag-6 **at the `===` operand-site** (V2-S3b's attempt)
  regressed **−299** deterministically: forcing internalize-then-`ref.eq` at
  the comparison breaks exactly the harness-comparator tag-5 identity above.

**The lesson (the thesis of this spec):** identity CANNOT be patched at the
equality operand-site, and the tag-5 same-tag arm CANNOT be taught object
identity. Identity must be canonicalized **where values are read/produced**, so
that a GC object never reaches `===` boxed tag-5 in the first place — objects
box **tag-6** (identity in `refval`), tag-5 stays **strings-only**, and the
already-correct tag-6 same-tag `ref.eq` arm (`any-helpers.ts:2404-2416`) does
the work with **zero** new equality-site risk.

### Grounding fact the strategy rests on

In pure standalone there are **no host externrefs** — every externref is
`extern.convert_any` of a GC ref (native strings are `$AnyString` GC arrays,
not `wasm:js-string`). Therefore `any.convert_extern ∘ extern.convert_any` is
the identity on GC refs (WasmGC internalize/externalize is bijective for
GC-origin externrefs). So a stored `e.value` GC ref read back through the
reader and re-internalized IS `ref.eq`-identical to the original — **the ONLY
way identity is lost is a production site that (a) mints a FRESH GC allocation
for the same logical object, or (b) boxes the ref tag-5 so `===` lands in the
overloaded same-tag arm.** Both are production-site defects, not equality-site
defects. (In host mode, host externrefs are genuinely non-`eq` and the host
`isSameValue` owns identity — every arm here is `ctx.standalone`-gated and host
stays byte-identical.)

---

## Implementation Plan (strategy decision + slices)

### Options considered

#### Option A — canonical-ref INTERN table (identity map)

A module structure mapping "logical object key" → the one canonical GC ref, so
every read of the same logical object returns it.

- **Where/keyed on what:** an intern table only helps objects that have an
  *external* identity key BEFORE you hold the canonical ref (chicken/egg: a
  plain user object simply IS its GC ref — there is no prior key to intern on).
  It is well-defined only for **synthesized / reflective** objects that are
  materialized on demand: builtin protos (key = brand), builtin method/getter
  values (key = `(brand, member)`), ctor carriers (key = name), well-known
  symbol carriers (key = id).
- **Memory cost:** for the synthesized classes it is O(distinct reflective
  objects the program touches) — small, and it is **already implemented** as
  per-key module globals: `__native_proto_<brand>` (#2175 S1), the #2963
  `pushBuiltinFnSingletonValueInstrs` per-`(brand,member)` global, the #3006
  ctor carriers, `ensureSymbolCarrier`. A *general* user-object intern map would
  be a per-allocation hash table (large, and pointless — see below).
- **Soundness on the #2661 flipped cases:** fixes `getPrototypeOf` (returns the
  per-brand global) and synthesized-value identity. Does **nothing** for
  aliased user-object array elements or a plain user object round-tripped
  through `__extern_get` — those have no synthesized key.
- **Verdict:** A is the correct MODEL for synthesized objects and is largely
  DONE. It is not, and should not become, a general user-object substrate.

#### Option B — externref-identity-preserving equality (keep operands externref through ===)

- **Why it looks attractive:** the tag-5 path "already preserves" host identity
  in host mode; keep `===` at the externref layer and never unbox.
- **Why it is unsound / insufficient:** WasmGC has **no `ref.eq` on
  externref** — to compare two externrefs you must `any.convert_extern` them,
  which is precisely the operand-site internalization that regressed −299, and
  for genuine host externrefs internalize yields non-`eq` refs (unreliable
  identity). It also does not touch `getPrototypeOf` / reflective visibility at
  all (those are production, not equality). B collapses into either the
  forbidden operand-site tag-6 approach or a no-op.
- **Verdict:** REJECTED. This is the class the task forbids.

#### Option C — canonicalize at the production / box site (RECOMMENDED)

Guarantee that every logical object has exactly ONE canonical GC ref and that
every read path yields THAT ref boxed **tag-6** (never a fresh allocation,
never tag-5). Then S3a's landed machinery (tag-6 same-tag `ref.eq`, plus the
cross-tag reconciliation for any transitional mixed pair) answers identity
with **no equality-site change**.

- **Soundness on ALL #2661 flipped cases:** each reduces to "same logical
  object ⇒ same canonical GC ref, boxed tag-6":
  - `gOPD(p,"m").value` vs `p.m`: both resolve to the ONE stored `e.value` /
    #2963 singleton, boxed tag-6 → `ref.eq` true.
  - `arr[0]` vs `arr[1]` aliasing one object: the array stores ONE ref; both
    reads return it boxed tag-6 → true (S3a already flips this for the mixed
    case; C removes the tag-5 same-tag exposure entirely).
  - `getPrototypeOf`: returns the per-brand `$NativeProto` global (Option-A
    anchor) → true.
- **Standalone floor risk:** the risk is *localized to the enumerated
  production sites* and is byte-inert everywhere else. The generic `boxToAny`
  externref arm (the −788 chokepoint) and the tag-5 same-tag arm (the −162
  chokepoint) are **NOT touched** — that is the whole point.
- **Blast radius:** the dynamic-read consumer sites (standalone) + the reader
  natives; host/gc lanes and every non-reflective program are byte-identical.
- **Enables V2-S3c + the guard-flip:** once objects the reader produces are
  tag-6-canonical, the V2-S3b `$NativeProto`/closed-shape reader arms can land
  WITHOUT any `===` change (the exact thing that killed the last attempt), and
  V2-S3c's instance-chain arm + the STRICT-IR guard-flip stack on top.

**Recommendation: Option C**, implemented as scoped production-site
representation canonicalization, resting on S3a for the transitional window and
folding Option A's memoization only for synthesized anchors. Reject B. Never
touch the tag-5 same-tag arm or the generic externref boxing arm.

### The invariant this substrate establishes (state it, gate on it)

> **INV-1 (representation canonicalization):** in `ctx.standalone`, a GC object
> value flowing into an `any` slot via a dynamic reader or descriptor synthesis
> is boxed **tag-6** (`refval`); tag-5 (`externval`) is reserved for genuine
> `$AnyString` strings (+ the legacy `$BoxedNumber` carrier). Equivalently:
> `typeof x === "object"/"function"` values never reach `===` boxed tag-5.

> **INV-2 (allocation canonicalization):** a production site never mints a fresh
> GC allocation for a logical object that already has a canonical ref (stored
> `e.value`, #2963 singleton, per-brand proto global, ctor carrier). Reads
> thread the stored/anchored ref; they never re-wrap into a new struct.

INV-1 makes `===` land in the tag-6 arm (safe); INV-2 makes the tag-6 arm's
`ref.eq` actually true. Both are production-side; neither touches `===`.

### Sub-slice decomposition (each byte-inert-off-path; each merge_group floor-gated)

> **Every slice MUST validate on the full `merge_group` + `check-standalone-highwater.mjs`**, never a scoped sweep — this is THE floor-regression minefield (documented −162 / −299 / −788 / −794 / −7228 incidents). Each slice is `ctx.standalone`-gated and must keep `scripts/prove-emit-identity.mjs` (the 39-hash corpus) IDENTICAL for host/gc and for any module that never pulls the dynamic reader.

- **CS0 (S) — characterization + invariant lock (byte-inert).** No codegen
  change. Add a standalone characterization suite that pins the residual and
  the invariant as a table: (a) `gOPD(p,"exec").value === gOPD(p,"exec").value`
  → currently `.toBe(0)` (the boundary that later slices flip to `1`);
  (b) two dynamic reads of one aliased user object → `.toBe(0)`;
  (c) anti-vacuity negatives that must STAY 0 (`{x:1} === {x:1}`, distinct
  strings, `exec !== test`); (d) a "reader value tag" probe asserting an
  object read dynamically is NOT `typeof "string"` (proves it should be tag-6).
  This slice makes the flip auditable and prevents a coincidental-pass
  (builtin-proto surfaces hide coincidental passes — use inject/contrast).

- **CS1 (M) — production-site honest object boxing at the dynamic-reader
  consumers.** THE keystone substrate slice. Enumerate every standalone site
  that takes a dynamic-reader externref result (`__extern_get`, vec/array
  element read, descriptor `.value`/`.get` synthesis) and boxes it to `any`,
  and route it through a **scoped honest classify** — `$AnyString` → tag-5,
  else eq-castable GC → tag-6 — instead of the blanket `__any_box_string`. The
  honest classifier ALREADY exists as `__any_from_extern`'s `honest` arm
  (`any-helpers.ts:427-469`, `$AnyString`→tag-5, other eq→tag-6); reuse it —
  do **not** mint a second classifier. **Hard constraint:** touch ONLY the
  enumerated dynamic-read consumers; do **NOT** flip the generic `boxToAny`
  externref arm (`value-tags.ts:187-213`, the −788 chokepoint) and do **NOT**
  add anything to the tag-5 same-tag arm (the −162 chokepoint).
  - *Files:* the dynamic member-read lowerings in `property-access.ts` /
    `element-access` that box an `__extern_get` result to `any`; the #2885
    gOPD descriptor synthesis in `calls.ts` (store the raw ref, box tag-6);
    the vec/array element→any read path. Grep for `__any_box_string` /
    `__any_box_extern` reached from a reader result under `ctx.standalone`.
  - *Gate:* CS0's boundary (a),(b) flip `0 → 1`; a string read dynamically
    still concatenates (`const o:any={s:"ab"}; o.s + o.s === "abab"`, tag-5
    intact); anti-vacuity negatives stay 0; `typeof (dynamically-read object)`
    unchanged. Full merge_group floor + prove-emit-identity green.
  - *Floor-risk: HIGH* (adjacent to the harness-comparator chokepoint). The
    scoping to enumerated sites is the safety boundary — a reviewer MUST
    confirm the generic externref arm and the tag-5 same-tag arm are untouched
    (diff-audit gate).

- **CS2 (S) — synthesized-anchor audit + lock (Option A completion).** Confirm
  every synthesized reflective object is memoized to ONE canonical ref and add
  swap-guarded identity tests where missing: protos (`__native_proto_<brand>`),
  method/getter values (#2963 singleton — done V2-S2), ctor carriers (#3006),
  well-known symbol carriers. Fill any gap where a synthesis path still mints
  fresh (INV-2). Mostly audit + regression-lock; no new mechanism.
  - *Gate:* `RegExp.prototype === RegExp.prototype`;
    `X.prototype.m === gOPD(X.prototype,"m").value`;
    `getPrototypeOf(Int8Array.prototype) === %TypedArray%.prototype` (once the
    chain fields are filled — may defer the last to V2-S3b). Swap-guards prove
    discrimination.

- **CS3 (L) — V2-S3b reader-arm MOP, RE-ENABLED on top of CS1.** This is the
  #2175 v2 C3 reader arm (`$NativeProto`/`$Object`/closed-shape step-3/4 arms
  across the 7 reader natives) that died last attempt. It lands here as a
  **consumer** of the substrate: because CS1 guarantees any object the reader
  produces is tag-6-canonical, the reader arm needs **zero** `===` change (the
  exact thing that caused −299). The reader arm's raw-anyref `$PropEntry.value`
  carrier (v2 D4) + CS1's honest boxing together make
  `const p:any = RegExp.prototype; p.exec === RegExp.prototype.exec` hold at the
  runtime layer. Keep on its own CI evidence (the v2 spec's "do not fold S3+S5"
  rule stands). *This slice is #2175 V2-S3b; #3037 is its precondition, not its
  replacement.* Owned by the #2175 wave; listed here to make the dependency
  explicit.

**Order:** CS0 → CS1 → CS2 (CS2 parallel-able with CS1) → CS3 (= V2-S3b).
CS1 is the substrate keystone; V2-S3b/S3c and the STRICT-IR guard-flip stack on
CS1. Do not attempt CS3 before CS1 lands — that reproduces the #2661 death.

### Edge cases

- **Native strings must NOT mis-box tag-6.** The honest classifier tests
  `ref.test $AnyString` FIRST (`any-helpers.ts:430-443`); a string read
  dynamically stays tag-5. CS1 must reuse that ordered classifier, never a bare
  `ref.test $eq`.
- **`$BoxedNumber` carriers** parked in tag-5 externval (`any-helpers.ts:1567`)
  must stay tag-5 (numeric-class arm + `__any_to_f64` recovery depend on it) —
  the honest classifier's `$AnyString`-first / eq-second order already excludes
  `$BoxedNumber` from the tag-6 arm only if `$BoxedNumber` is not `eq`-castable;
  verify `$BoxedNumber`'s heap type is not an `eq` subtype that would wrongly
  take the tag-6 arm, else add an explicit `$BoxedNumber`→tag-5 pre-test.
  **(Open — must be checked in CS1 review; a mis-tag here re-breaks numeric
  `===`.)**
- **Host mode / gc lane byte-identity.** Every arm `ctx.standalone`-gated;
  host `isSameValue` (#1888) and the host externref proxy identity untouched.
- **Frozen / `Object.create(null)` objects** keep current semantics — CS1 only
  changes the TAG of the boxed result, not the reader's lookup.
- **Transitional mixed pairs** (one operand tag-6 from CS1, one still tag-5
  from an un-migrated site) are covered by S3a's cross-tag reconciliation arm —
  so partial CS1 coverage never regresses, it only under-fixes. This is why CS1
  can land incrementally per consumer site if needed.

### What this spec explicitly does NOT do

- Does NOT patch identity at the `===` operand-site (proven unsound, −299).
- Does NOT add an object-identity arm to the tag-5 same-tag classifier (−162).
- Does NOT flip the generic `boxToAny` externref arm / `honestAnyBoxing`
  globally (−788/−794).
- Does NOT build a general user-object intern map (pointless — user objects are
  their GC ref; only synthesized objects need Option-A memoization, already
  done).
- Does NOT change host mode; no new host imports.
- Does NOT implement the reader-arm MOP itself (that is #2175 V2-S3b / CS3,
  which this substrate unblocks).

### Risks & honest assessment

1. **CS1 is genuinely hard and floor-risky.** It sits one arm away from the two
   worst floor-regression chokepoints in the codebase. The mitigation is strict
   scoping (enumerated consumers only) + a mandatory diff-audit that the generic
   and same-tag arms are untouched + full merge_group evidence. Estimate: L in
   care even though M in code size.
2. **`$BoxedNumber` eq-castability** (edge case above) is the single most likely
   silent regression — it must be settled with a `ref.test` probe on current
   main BEFORE writing CS1, not assumed.
3. **Enumeration completeness.** If a dynamic-read consumer is missed, that path
   stays tag-5 and under-fixes (safe via S3a, not a regression) — but the #3027
   number won't fully move until all consumers migrate. Expect CS1 to iterate
   per consumer family (property read, element read, descriptor synthesis).
4. **The bijection assumption** (no host externrefs in standalone) is load-
   bearing. If any host-string-mode externref leaks into a `ctx.standalone`
   read, the honest classifier could mis-tag. The `$AnyString`-first ordering
   plus standalone gating contains this, but CS1 review must confirm no
   host-string leak path reaches the migrated consumers.

**Bottom line:** the object-identity foundation under #3027 is a
**production-site representation-canonicalization** problem (Option C), not an
equality problem. The landed S3a arm already handles the mixed-tag window; the
missing piece is CS1 — making dynamic-reader object values box tag-6 at the
enumerated production sites so they never enter the overloaded tag-5 same-tag
arm. Once CS1 lands, the V2-S3b reader-arm re-lands with no `===` change and the
#3027 keystone + guard-flip stack on top. The hardness is concentrated in CS1's
floor-adjacency, managed by strict scoping and merge_group-only validation.

---

## RE-SCOPE (2026-07-05, arch) — the `any`-object CARRIER, not the reader site

> **This section SUPERSEDES the CS1 framing above.** A senior-dev
> (opus-identity-cs1) traced CS1 against the actual code and landed the CS0
> characterization (PR #2683, `tests/issue-3037-cs0-identity-characterization.test.ts`).
> The measurement — verified, not narrative — disproves the "dynamic-reader
> production site" premise. Grounded on `upstream/main @ af6eff6c1` + PR #2683.
> The Options A/B/C analysis, the tag-5-minefield facts, and INV-1/INV-2 above
> all still hold; only the *location and shape* of the fix change.

### What CS0 actually measured (correcting the reader-only premise)

1. **There is no migratable "reader production site."** A temporary
   `emitAnyEqOperands` probe (`coercion-engine.ts:454`) confirmed the `===`
   operand of a dynamic `any`-member read has ValType **externref**
   (`isAnyValue = false`): the reader returns a **bare externref**, and tag-5 is
   decided **downstream** at the operand-marshalling site —
   `emitAnyEqOperands` → `coerceType(externref → $AnyValue)` → the generic
   `boxToAny` externref arm → `__any_box_string` (`value-tags.ts:213`). That
   site *is* the #1888 **−788 chokepoint** / the **−299** operand site this
   spec already forbids. "Box at the reader" has no site to target.

2. **The defect is UNIVERSAL, not reader-specific.**
   `const inner: any = {z:1}; inner === inner` → **0** — an object is not `===`
   to *itself*. Any object value materialised in a contextually-`any` position
   is carried as **externref** and boxed **tag-5**. The controls prove the fix
   direction: a *typed* object (`const inner = {z:1}`) stays a raw `ref $Object`
   → `__any_box_ref` → **tag-6** → the tag-6 `ref.eq` arm answers identity
   (`pos1`/`pos3`/`pos4` all `1`; `arr[0]===arr[1]` on a typed `any[]` already
   `1`). So the fix must convert the **externref** carrier of an any-object into
   the **tag-6** carrier the typed path already uses — narrow reader-site boxing
   would not move #3027.

3. **`$BoxedNumber` eq-castability is settled (must respect):**
   `__box_number_struct` (`index.ts:11690`) is a plain WasmGC struct → an `eq`
   subtype → `ref.test (ref eq)` returns 1 for it. A **bare** eq classifier
   would mis-route a boxed number to tag-6 and re-break numeric `===`. Any
   carrier boxing MUST reuse the **FULL** `__any_from_extern` classifier, which
   peels `$BoxedNumber`→tag-3 (`any-helpers.ts:497-512`) and `$BoxedBoolean`→
   tag-4 (`:513-528`) via `ref.test nativeBox*TypeIdx` **before** the
   `$AnyString`-first / eq-second `fallbackStringAny` classification (`:427-469`)
   — **never** the bare `fallbackStringAny` eq fragment.

### The two candidate carrier mechanisms (floor-risk for EACH)

Both make an any-object reach `===` as tag-6. They differ in WHERE the tag is
decided.

#### Mechanism A — honest classification at the externref→`$AnyValue` boxing seam

Make `coerceType(externref → $AnyValue)` (equivalently the generic `boxToAny`
externref arm, i.e. the `honestAnyBoxing` classification) route objects to tag-6
instead of the blanket `__any_box_string` tag-5.

- **Coverage:** total in one edit — every any-object funnels through this seam
  at `===`.
- **Floor risk: SEVERE — this is the forbidden class.** The seam is exactly
  where the test262 harness comparator (`assert.sameValue`/`isSameValue`) marshals
  its `any` operands; flipping it is the measured **−788/−794** (global honest
  flip) and **−299** (operand-site tag-6, V2-S3b's death). It cannot be scoped
  to "objects only at ===" without still being the `===` operand site, because
  the harness comparison *is* an `===` over any operands. **REJECT** — this is
  the operand-site the spec forbids, re-discovered.

#### Mechanism B — canonical `any`-object carrier (upstream tag-6 production) — RECOMMENDED

Never externalize an object into an `any` slot. At each site where a GC-ref
value is *produced into* an `any`-typed slot, carry it as a **`ref $AnyValue`
tag-6** box (the typed path's representation) rather than an externref, reusing
the FULL `__any_from_extern` classifier. Objects then flow as `$AnyValue`
(`isAnyValue = true`); at `===`, `emitAnyEqOperands` skips the coercion seam
entirely (line 458/463 `isAnyValue` guard) and the tag-6 `ref.eq` arm answers
identity. **The generic externref arm (−788) and the `===` operand site (−299)
are both untouched — the change is at value-production-INTO-any, upstream of
equality.**

- **Coverage:** per production-site; grows as sites migrate.
- **Floor risk: MODERATE and localizable.** It changes the ValType a producing
  site hands to the any-flow (externref → `ref $AnyValue`). Blast radius = the
  non-`===` consumers of that value (method call, string concat, host handoff),
  which must accept `$AnyValue` and `coerceType` back to externref on demand —
  `coerceType($AnyValue → externref)` already exists (`:1663-1664`,
  `extern.convert_any` of refval/externval), so the round-trip is in place.
  **Partial coverage is SAFE by construction:** a migrated tag-6 operand paired
  with an un-migrated tag-5 operand of the *same* object hits S3a's cross-tag
  reconciliation arm (`any-helpers.ts:2291-2355`) → `ref.eq` → 1 (standalone
  internalize is bijective), so no half-migration ever regresses — it only
  under-fixes. This is what makes B decomposable and merge_group-gateable.

**Recommendation: Mechanism B.** A is the clean single-site fix but lands
squarely on the −788/−299 mine; B trades one clean site for a wider but
*floor-safe* set of production sites, each independently gateable and each
never-regressing under S3a.

### Exact `any`-object-carrier box sites (Mechanism B targets)

The broken sites are precisely those that produce **externref-into-any** where
the typed path would produce `ref`→tag-6. Enumerated from CS0's FLIP-TARGETs:

1. **Object/array literal in a contextually-`any` position** (`case c`, `case e`):
   the object-literal / array-literal lowering, when the target/contextual type
   is `any`/externref, externalizes instead of boxing tag-6. Emit the
   `ref $Object` and box via the full classifier. *This is the tightest,
   lowest-risk site — start here.*
2. **Dynamic `any`-member / element read result** (`case a`, `case b`, `case e`,
   `case num-lit`): the property-access / element-access lowering for an
   `any`-typed access returns the `__extern_get` externref bare. When the static
   result type is `any` and the value flows into an any context, box the result
   to `$AnyValue` tag-6 at the read expression (honest classifier). *Highest
   breadth — the bulk of #3027 — split per read family (member / element /
   descriptor `.value`).*
3. **`Object.getPrototypeOf` / reflective producers returning externref**
   (`case d`): return the per-brand `$NativeProto` global boxed tag-6 (composes
   with CS2's synthesized-anchor audit).
4. **`any` param binding / `any` return / `any[]` element store** — verify these
   already carry tag-6 (the `pos1/pos3/pos4` controls pass, so the typed→any
   path is fine); only add coverage if a measured case regresses.

### Re-scoped slices (each merge_group-floor-gated; partial coverage safe via S3a)

- **CS0 (S) — DONE (PR #2683).** Characterization + invariant lock; byte-inert;
  `prove-emit-identity` 39/39. 5 FLIP-TARGETs (`0`), 10 INVARIANTs.
- **CS1a (M) — object-literal-into-`any` carrier.** Site (1). Box a
  contextually-`any` object/array literal to `$AnyValue` tag-6 via the FULL
  `__any_from_extern` classifier. *Gate:* `case c` (`inner===inner`) → 1;
  `neg1` distinct-shape stays 0; `str3` string stays tag-5/`typeof "string"`;
  `num-lit` stays 1. Full merge_group + `check-standalone-highwater`.
- **CS1b (L, decompose per read family) — dynamic-read-into-`any` carrier.**
  Site (2), split: (i) member read, (ii) element read, (iii) gOPD `.value`/`.get`.
  Box the any-typed read result to tag-6 at the read expression; consumers
  `coerceType` back to externref on demand. *Gate per sub-slice:* the matching
  FLIP-TARGET (`a`/`b`/`e`) → 1; all INVARIANTs hold; a non-`===` consumer probe
  (`o.m()`, `o.s + o.s`) still works. Merge_group only.
- **CS1c (S) — `getPrototypeOf`/reflective producer carrier.** Site (3);
  composes with CS2. *Gate:* `case d` → 1.
- **CS2 (S) — synthesized-anchor audit + lock** (unchanged from above).
- **CS3 (L) — V2-S3b reader-arm MOP**, now stacked on the carrier (unchanged;
  owned by the #2175 wave). With CS1 the reader-arm needs no `===` change.

**Order:** CS1a → CS1b(i) → CS1b(ii) → CS1b(iii) → CS1c → CS2 → CS3. CS1a is the
lowest-risk beachhead that flips the pivotal `inner===inner` case and proves the
carrier mechanism end-to-end before the higher-breadth read-family slices.

### Floor-risk verdict

Mechanism **B** is the only path that does not re-detonate the −788/−299 mine.
Its residual risk is the ValType change at each producing site (a value that was
externref becomes `ref $AnyValue`), contained by (a) the pre-existing
`coerceType($AnyValue → externref)` round-trip for non-`===` consumers, (b) S3a
making every half-migrated pair a safe `1`, and (c) per-site merge_group
gating. **CS1a is low risk; CS1b is the genuine breadth risk** (it changes the
result ValType of the most common dynamic-read lowerings) and must land per read
family with isolated merge_group evidence — never folded, never scoped-swept.
Mechanism A is recorded here only to document *why* the obvious one-site fix is
forbidden.

---

## CS1a — LANDED (opus-3037-cs1a): object-literal-into-`any` tag-6 carrier

**PR:** object-literal-into-`any` carrier. **Flips CS0 case (c)**
(`const inner: any = {z:1}; inner === inner` → **1**). All 10 CS0 INVARIANTs and
the other 4 FLIP-TARGETs (a/b/d/e) stay unchanged (those are CS1b/CS1c).
`prove-emit-identity` **39/39 IDENTICAL** (host/gc/standalone/wasi) — byte-inert
off-path.

### What changed vs. the RE-SCOPE Mechanism-B framing (important correction)

The RE-SCOPE section recommends carrying the any-object as a **`ref $AnyValue`
tag-6** box (via the honest classifier). Tracing that against the actual code
**disproved** it as the CS1a carrier: `coerceType($AnyValue → externref)` routes
through `__any_to_extern`, whose tag-6 arm (`any-helpers.ts:873-887`) keeps the
box **wrapped** (`extern.convert_any` of the whole `$AnyValue` struct) rather than
unwrapping the `$Object` payload — deliberately, so re-boxing through an `any`
boundary round-trips. Consequence: an `$AnyValue`-typed any-object local **breaks
every dynamic member read** — `__extern_get`'s `ref.test $Object` sees the
`$AnyValue` struct, not the `$Object`, and returns null/0 (verified: `o.z`,
`o.s+o.s`, `typeof` all regress). The honest classifier is therefore **not**
needed at CS1a and was **not** used.

**The carrier that works is a raw `ref $Object`** — exactly the representation the
already-passing typed control (`pos1`) uses:

- At `===`, `boxToAny`'s `ref` arm (`value-tags.ts:228`) boxes a `ref $Object` as
  **tag-6** via `__any_box_ref` (identity in `refval`) → `__any_strict_eq`'s
  tag-6 same-tag `ref.eq` arm (`any-helpers.ts:2404-2416`) answers identity. No
  classifier, no honest helper — the value is statically a plain `$Object`.
- Dynamic `any`-typed member reads coerce the ref back to externref via the
  ordinary `extern.convert_any` (a NON-`$AnyValue` ref → externref, NOT
  `__any_to_extern`) → `__extern_get` succeeds. Reads/writes/method-calls/`typeof`/
  spread/`Object.keys`/`delete`/destructuring all keep working (battery-verified).
- The `===` operand seam (−299) and the generic externref boxing arm (−788) are
  **untouched** — the change is purely the local's storage ValType at a
  production site.

### Where (files)

1. `src/codegen/literals.ts` — new exported predicate
   `objectLiteralIsStandaloneAnyObjectCarrier(ctx, expr)`: true for a **non-empty,
   spread-free, data-only, statically-named** object literal in a genuine
   `any`/`unknown`/`object` context under `ctx.standalone` — exactly the
   `isAnyContextNonEmpty` branch of `compileObjectLiteral` that builds an open
   `$Object` externref. Spreads/accessors/computed-keys/dictionaries are excluded
   (they route via other gates / need the externref carrier).
2. `src/codegen/statements/variables.ts` — when a `const/let x: any = <carrier>`
   declaration matches the predicate (and is not a closure-captured slot), slot
   the local as `ref_null $Object` (`ensureObjectRuntime(ctx).objectTypeIdx`)
   instead of externref. Because let/const slots are **pre-hoisted** as externref
   by `hoistLetConstWithTdz`, the `wasmType` decision alone is bypassed — an
   explicit slot retype after `localIdx` resolution covers the reused pre-hoisted
   slot (skipped for boxed/promoted-global captures — those stay externref, safe
   via S3a). The store coerces the object externref → `ref $Object`
   (`any.convert_extern` + guarded `ref.cast`).

### Scope / partial-coverage safety

Scoped to **variable declarations** whose initializer is the carrier literal —
the CS0 flip case (c) is exactly that. Other any-context object-literal positions
(function args, returns, nested values) still produce externref and stay tag-5;
per S3a's cross-tag reconciliation arm a transitional tag-6 × tag-5 pair of the
same object still `ref.eq`s to 1, so partial coverage **never regresses, only
under-fixes**. CS1b (dynamic-read carrier — cases a/b/e) and CS1c (reflective
producer — case d) remain the next slices and are cleanly separable: they change
the result ValType of the dynamic reader, a wider (breadth-risk) surface that must
land per read-family with isolated merge_group evidence.

### Tests

- `tests/issue-3037-cs0-identity-characterization.test.ts` — case (c) updated
  `0 → 1` (`FLIPPED by CS1a`); all other rows unchanged.
- `tests/issue-3037-cs1a-objlit-carrier.test.ts` — new: pins the identity flip
  (self-`===`, fn round-trip) AND the non-`===` consumer invariants (member
  read/write, method call, `typeof`, distinct-object anti-vacuity, reassign,
  typed-struct control) so a future change can't restore identity by breaking
  reads.

### Floor discipline

CS1a is low-risk (byte-inert corpus) but floor-sensitive: **not self-merged on
PR-green alone** — flagged the lead for a monitored `merge_group` standalone
`host_free_pass` floor enqueue (expect NET-POSITIVE / neutral). Any floor
regression ⇒ a non-object leaked into tag-6 → diagnose, don't force.

---

## CS1b (member-read family) — LANDED (opus-3037-cs1b): dynamic `any`-member-read tag-6 carrier

**PR:** dynamic `any`-member-READ carrier (member-read family only; element
access + the reflective producers are separate follow-up PRs). **Flips CS0
FLIP-TARGETs (a) `gOPD.value === gOPD.value`, (b) `o.a === o.b` (aliased object),
and (e) `o.n === o.n` (dynamic number)** — all three are `PropertyAccessExpression`
reads, so one member-read interception covers them. (c) stays 1 (CS1a); (d)
`getPrototypeOf` stays 0 (its reads land in identifier locals, not member reads →
that is CS1c). All 10 CS0 INVARIANTs + all CS1a tests unchanged.

### The mechanism (CORRECTS the RE-SCOPE "reader has no migratable site" premise)

CS0 measured that the reader returns a **bare externref** and the tag is decided
downstream at the operand seam. The re-scope concluded "box at the reader" has no
site. **CS1b resolves this by making the reader context-aware:** a member read is
re-classified to the tag-6 carrier **only when it is a direct operand of a
standalone `any`-equality** — the EXACT shape (`leftIsAny && rightIsAny &&
isEqualityOp`, binary-ops.ts) that routes through `compileAnyBinaryDispatch →
emitAnyEqOperands`. So the carrier can only ever flow into the equality helper's
`isAnyValue` fast-path and NEVER into a subsequent read/store — side-stepping the
CS1a finding that a `$AnyValue`-typed value breaks dynamic reads (`__any_to_extern`
keeps the box wrapped). This is why the carrier here is a `$AnyValue` (not the
`ref $Object` CS1a used for a statically-known object): a dynamic read is
statically `any`, so it needs the FULL runtime classifier, and the equality-operand
scoping makes `$AnyValue` safe.

- **Carrier production:** `maybeWrapAnyReadEqualityCarrier` (property-access.ts),
  called at the single member-read choke point in `compileExpression`
  (expressions.ts, `ts.isPropertyAccessExpression` arm). When `ctx.standalone`,
  the read compiled to `externref`, and `isAnyEqualityOperand(expr)` holds, it
  appends `call __any_from_extern_honest` and returns `(ref $AnyValue)`. Every
  precondition unmet → the bare externref is returned unchanged (byte-inert).
- **Classifier reuse (NO second classifier):** `ensureAnyFromExternHelper` gains a
  `{ forceHonest }` option that emits its honest body (the SAME `$AnyString`→tag-5,
  `$BoxedNumber`→tag-3, `$BoxedBoolean`→tag-4, other-eq→tag-6 arms) under a
  DISTINCT name `__any_from_extern_honest`, irrespective of the module-wide
  `honestAnyBoxing` flag (default OFF). The flag-driven generic instance that the
  −788 chokepoint depends on is neither renamed nor mutated. `$BoxedNumber`
  eq-castability (a plain struct → `eq` subtype) is handled because the classifier
  peels tag-3/tag-4 BEFORE the eq test (the settled CS0 probe).
- **Untouched:** the generic `boxToAny` externref arm (−788), the tag-5 same-tag
  arm (−162), and the `===` operand seam / `emitAnyEqOperands` (−299) — all
  byte-identical. The change is purely the reader's result ValType at the enumerated
  shape.

### Partial-coverage safety (S3a)

Scoped to member reads that are direct `any`-equality operands. A member read
stored in a local first (`const x:any=o.a; x===o.b`) leaves `x` tag-5 and migrates
only `o.b` → the mixed tag-6×tag-5 pair reconciles via S3a's cross-tag arm → still
`1` (verified). So partial coverage **never regresses, only under-fixes** — the
element-access and reflective-producer families can land independently later.

### Files

- `src/codegen/any-helpers.ts` — `ensureAnyFromExternHelper(ctx, { forceHonest })`
  → forced-honest `__any_from_extern_honest` sibling (same body).
- `src/codegen/property-access.ts` — `isAnyEqualityOperand` +
  `maybeWrapAnyReadEqualityCarrier` (exported).
- `src/codegen/expressions.ts` — call the wrapper at the member-read choke point
  (applied before the getter-writeback resync, which is net-zero on the stack).
- `tests/issue-3037-cs0-identity-characterization.test.ts` — (a)/(b)/(e) updated
  `0 → 1` (`FLIPPED by CS1b`); (c) stays 1 (CS1a), (d) stays 0 (CS1c).
- `tests/issue-3037-cs1b-member-read-carrier.test.ts` — new: pins the 3 flips,
  negation, the S3a half-migrated pair, anti-vacuity negatives, and the
  classification/consumer invariants (string/number/boolean by value, chained read
  `o.a.z`, arithmetic, `typeof`).

### Floor discipline

Higher breadth-risk than CS1a (it changes a common reader lowering's result
ValType) — the equality-operand scoping is the safety boundary. **NOT self-merged
on PR-green alone**; flagged the lead for a monitored `merge_group` standalone
`host_free_pass` floor enqueue (expect NET-POSITIVE — drives #3027). Any floor
regression ⇒ a non-object leaked into tag-6 → diagnose, don't force.

### Remaining CS1b families (separate PRs, isolated merge_group evidence each)

- **CS1b(ii) element access** — LANDED (opus-3037-cs1bii). See the section below.
- **CS1b(iii) descriptor `.value`/`.get` producer** — RE-PROBED: no
  carrier-addressable descriptor-specific gap remains. See the section below.
- **CS1c** getPrototypeOf/reflective producer carrier (case d).

---

## CS1b(ii) (element-access family) — LANDED (opus-3037-cs1bii): dynamic `any`-element-read tag-6 carrier

**PR:** dynamic `any`-element-READ carrier (`arr[i] === arr[j]`, `o[key] === o[key2]`).
Applies the SAME context-aware carrier CS1b (member-read) landed, now at the
`ts.isElementAccessExpression` choke point in `compileExpression`
(expressions.ts). `maybeWrapAnyReadEqualityCarrier` / `isAnyEqualityOperand` are
REUSED verbatim (both already `expr: ts.Expression`-generic) — no new classifier,
no re-mint of `__any_from_extern_honest`. Flips `const a: any = [inner, inner];
a[0] === a[1]` (aliased) `0 → 1` and the `o["a"] === o["b"]` computed-member
analogue. All CS0/CS1a/CS1b member-read tests (45) stay green;
`prove-emit-identity` **39/39 IDENTICAL** (host/gc/standalone/wasi).

### Two carrier-support fixes this slice required (traced, not assumed)

The blanket element carrier initially regressed three probe classes; the
re-probe (on current main) + WAT disassembly pinned two real defects that the
member-read family never triggered because `__extern_get` (member) is better
behaved than `__extern_get_idx` (element) and because the member cases always had
`$AnyValue` pre-registered. Both fixes are `ctx.standalone`-gated and byte-inert
off-path.

1. **Gate: `isAnyEqualityOperand` must key on the RAW CHECKER, not `ctx.oracle`.**
   The carrier's premise is "the operand only ever flows into
   `emitAnyEqOperands`'s `isAnyValue` fast-path". That holds iff binary-ops routes
   the pair through `compileAnyBinaryDispatch`, whose gate is
   `leftTsType.flags & TypeFlags.Any` on both sides (binary-ops.ts:1082-1084 —
   the RAW `ctx.checker.getTypeAtLocation(...)`). For **element** operands the
   oracle and the checker DISAGREE: `const a: any = [5,5]; a[0]` reads as
   `oracle.kind === "any"` but the checker narrows it, so binary-ops does NOT
   dispatch and the carrier's `ref $AnyValue` lands in the raw `ref.eq`
   struct-identity arm → value-equal numbers/strings wrongly `!==`. Switching the
   gate to the checker flag (mirroring binary-ops **exactly**) fires the carrier
   iff the pair truly routes through `__any_strict_eq`. (Member-read cases pass
   both gates identically, so this is byte-neutral for CS1b member-read — the 15
   member tests confirm.)

2. **`$AnyValue` operand pairs at binary-ops.ts:1937 route to `__any_strict_eq`,
   not `ref.eq`.** Even with the checker gate, a module that registers `$AnyValue`
   **lazily** (the carrier / element read is the FIRST any-value in an otherwise
   number-only module) makes binary-ops' line-1081 `anyValueTypeIdx >= 0`
   dispatch-gate evaluate to `false` at the binary expression's ENTRY — so
   binary-ops commits to its numeric/`ref.eq` path, and the carrier's later
   `ref $AnyValue` reaches the raw `leftIsRef && rightIsRef` strict-eq arm. That
   arm's `ref.eq` is the WRONG strict-eq for a discriminated `$AnyValue` union
   (two boxes of the same value have distinct struct identity but must compare by
   TAG). The fix: when **both** operands are exactly `ctx.anyValueTypeIdx` (in
   standalone), call `__any_strict_eq` (tag-aware); non-`$AnyValue` ref pairs
   (class instances, nominal structs) keep genuine `ref.eq` identity — verified by
   the class-identity / switch-strict-eq suites (85 tests) staying green.

The carrier itself also now checks `ctx.anyValueTypeIdx >= 0` BEFORE
`ensureAnyFromExternHelper` (which lazily registers the type) so it stays inert in
a module that has no any-machinery at all.

### Files

- `src/codegen/expressions.ts` — call `maybeWrapAnyReadEqualityCarrier` at the
  `ts.isElementAccessExpression` arm (both the getter-writeback and normal
  return paths), mirroring the member-read arm.
- `src/codegen/property-access.ts` — `isAnyEqualityOperand` re-gated to the raw
  checker `Any` flag; carrier's `anyValueTypeIdx`-before-`ensure` guard.
- `src/codegen/binary-ops.ts` — `$AnyValue`-pair strict-eq routes to
  `__any_strict_eq` (standalone, both operands `anyValueTypeIdx`).
- `tests/issue-3037-cs1bii-element-read-carrier.test.ts` — new: the aliased-object
  flips, the computed-member (`o[key]`) flip, negation, the S3a half-migrated
  pair, anti-vacuity negatives, the value-tag regression guards (number/string
  by value/content, undefined/null/OOB by value), and the typed-array control.

### Known limitation (pre-existing reader gap, NOT introduced here)

A **typed-nominal-element** array boxed to `any` (`const a: any = [{z:1},{z:2}]`)
compiles to a `sub final $7` vec whose element array is a nominal-struct array —
a shape `__extern_get_idx` does NOT handle (it tests only the externref / f64 /
`$1` vec variants), so `a[i]` returns **null** (a #2186-class reader gap;
`a[i].z` already TRAPs on main). The honest classifier maps that null to the
undefined singleton, so two such reads compare `===` **1** (where main
accidentally gave `0`). This surfaces ONLY under an explicit TS
`const a: any = [<object literals>]` annotation — a construct that **does not
occur in test262 (pure JS)** and whose reads are already broken on main.
JS-realistic forms (`var a = [{}, {}]`, no `: any`) are unaffected: their
operands are not TS-`any`, the carrier does not fire, and the ordinary
typed-struct identity path answers correctly (`distinct → 0`, `aliased → 1` —
covered by the control test). Fixing `__extern_get_idx` for nominal-element vecs
is out of CS1b(ii) scope (its own #2186-class slice).

### Floor discipline

Same as CS1b: the equality-operand scoping is the safety boundary. **NOT
self-merged on PR-green alone** — flagged the lead for a monitored `merge_group`
standalone `host_free_pass` floor enqueue (expect NET-POSITIVE — drives #3027).
Any floor regression ⇒ a non-object leaked into tag-6 → diagnose, don't force.

---

## CS1b(iii) (descriptor `.value`/`.get` producer) — RE-PROBED (opus-3037-cs1biii): no carrier-addressable gap

**PR:** byte-inert regression-LOCK test only (no `src/` change).
`prove-emit-identity` **39/39 IDENTICAL**. The task framed CS1b(iii) as "apply
the same equality-operand carrier at the descriptor-`.value` choke point". A
per-choke-point re-probe against current `upstream/main` (7eb51a2c5) **disproves
that premise** — the same way CS0 disproved the "reader production site" premise
and CS1a disproved the "`$AnyValue` carrier" premise. There is **no remaining
carrier-addressable descriptor-specific gap** to implement.

### What the re-probe measured (traced, not narrative)

Every descriptor `.value`/`.get` read that is a **DIRECT operand** of a
standalone `any` `===`/`!==`/`==` comparison **already answers identity
correctly** on current main (identical → 1, distinct → 1 under `!==`). Two
already-landed paths cover the entire descriptor equality-operand surface:

1. **Direct gOPD Site-2 synthesis** —
   `Object.getOwnPropertyDescriptor(RegExp.prototype,"exec").value` materialises
   the per-`(brand,member)` **singleton** (`pushBuiltinFnSingletonValueInstrs`,
   property-access.ts:1214/1233), a raw `ref` → boxed **tag-6** (`__any_box_ref`)
   → the tag-6 `ref.eq` arm answers identity with **no carrier needed**. This is
   also why `gOPD(RegExp.prototype,"exec").value === RegExp.prototype.exec` holds.
2. **User-object descriptor read** —
   `Object.getOwnPropertyDescriptor(p,"m").value` routes `.value` through the
   **generic `compilePropertyAccess`** member-read choke point, where the
   CS1b(i) member-read carrier (`maybeWrapAnyReadEqualityCarrier`,
   expressions.ts:1356) **already fires** because `.value` is a direct
   `any`-equality operand. So descriptor `.value` was **absorbed by CS1b(i)'s
   placement at the generic choke point** — there is no separate descriptor site
   that returns a bare externref the carrier misses. (`defineProperty` accessor
   `.get`, data `.value` on an object value, `.writable` boolean, distinct-`!==`
   — all verified 1 / correct.)

### The one residual `0` is NOT descriptor-specific and NOT carrier-addressable

The only descriptor `.value` case that still returns **0** is when the `.value`
result is stored in an **intermediate `any` local** and the **locals** are
compared:

```ts
const d1: any = Object.getOwnPropertyDescriptor(p, "exec");
const v1: any = d1.value;
const v2: any = d1.value;
return (v1 === v2) ? 1 : 0;   // → 0
```

This is **identical** to a plain member read stored in a local
(`const v1: any = o.a; const v2: any = o.a; v1 === v2` → **0** — same root
cause, verified as the control). The equality operands here are **locals, not
reads**, so the operand-scoped carrier cannot fire; and the value must flow as a
general `any` usable anywhere, so it cannot be slotted as a `$AnyValue` local
(that breaks dynamic reads — the CS1a finding) nor as a raw `ref $Object` (a
dynamic read is statically `any`, a union of string/object/number). **Making a
reader result canonical into an `any` LOCAL independent of downstream use is the
UNIVERSAL-reader carrier = CS3 / V2-S3b — the −299 minefield**, not a bounded
CS1b sub-slice. (Note: the harness-comparator shape — descriptor `.value`
passed as a function ARG and compared inside the callee — already returns 1, so
the test262-realistic pattern is not blocked by this residual.)

### Deliverable

`tests/issue-3037-cs1biii-descriptor-value-carrier.test.ts` — a byte-inert
**regression-LOCK**: 10 descriptor equality-operand cases pinned at their
correct answers (so a future refactor of the member-read carrier or the gOPD
Site-2 synthesis can't silently regress descriptor `.value` identity), 3
anti-vacuity invariants, and the 2 KNOWN-GAP rows pinned at `0` (descriptor +
plain-read control) marked **CS3-owned** so the eventual universal-reader flip
is auditable. No `src/` change; no floor movement expected.

## CS1c (getPrototypeOf / reflective producer) — RE-PROBED (opus-3037-cs1c): case (d) is a null-canon symptom, no bounded carrier win

**PR:** byte-inert regression-LOCK test only (no `src/` change).
`prove-emit-identity` **39/39 IDENTICAL**. The task framed CS1c as "apply the
carrier at the getPrototypeOf result choke point, flipping CS0 case (d) 0→1". A
per-choke-point re-probe against current `upstream/main` (7eb51a2c5) shows there
is **no bounded, floor-safe operand-carrier win** here, and — crucially — that
**CS0 case (d) is not an object-identity carrier target at all**.

### What the re-probe measured (traced, not narrative)

1. **Plain-object / array `[[Prototype]]` is NULL in standalone.**
   `__getPrototypeOf` (`object-runtime.ts:2761`) returns
   `struct.get $Object.$proto` for a `$Object`, else **NULL**. A plain object
   literal's `$proto` is unset (Object.prototype is not modeled as a standalone
   `$Object`), and an array `[1]` is a vec (not a `$Object`) so `ref.test
   $Object` fails → NULL. Hence `Object.getPrototypeOf([1]) === null` **and**
   `Object.getPrototypeOf({z:1}) === null` are BOTH `1`. **CS0 case (d)
   (`const a:any=[1]; p1=gpo(a); p2=gpo(a); p1===p2`) is a null comparison, not
   object identity.**

2. **Case (d)'s residual 0 is a stored-in-local NULL-canonicalization symptom.**
   A `null` LITERAL stored in two `any` locals compares `===` → **1** (it boxes
   the null/undefined SINGLETON, tag-0/1 → `ref.eq`). But getPrototypeOf's
   `ref.null.extern`, stored in an `any` local, is boxed **tag-5**
   (externval-null) at the `===` operand seam → the guarded tag-5 same-tag arm →
   **0**. This asymmetry is the **same reader-result-into-`any`-local defect as
   CS1b(iii)'s residual** — the operand-scoped carrier cannot reach it (the
   equality operands are LOCALS, not reads). Flipping case (d) = canonicalising a
   reader/producer result INTO an `any` local independent of downstream use =
   the **UNIVERSAL-reader carrier (CS3 / V2-S3b, the −299 minefield)**.

3. **The genuine object-identity getPrototypeOf gaps are ALSO out of reach.** A
   class instance has a real proto struct anchor (`emitLazyProtoGet` singleton):
   `getPrototypeOf(f) === getPrototypeOf(f)` direct → already 1; stored in `any`
   locals → **0** (the same stored-in-local CS3 problem); `getPrototypeOf(f) ===
   Foo.prototype` → **0** and **NOT carrier-flippable** — `Foo.prototype` is
   typed `Foo` (the instance type), not `any`, so the `isAnyEqualityOperand`
   both-operands-`Any` gate never fires.

### Verdict — the operand carrier has hit its coverage ceiling

The operand-scoped carrier (CS1a → CS1b(i) → CS1b(ii)) can only fix a value that
appears as a **DIRECT `any===any` operand**. Every remaining identity gap under
#3027 — descriptor/member/element/getPrototypeOf results stored in a local,
passed as a function arg / returned, or paired with a non-`any` operand — reduces
to the **reader-result-INTO-`any` universal carrier = CS3**, the −299 minefield.
**CS3 is not a bounded slice; it needs its own architect pass** (see the CS3
readiness assessment below).

### Deliverable

`tests/issue-3037-cs1c-getprototypeof-carrier.test.ts` — a byte-inert
**regression-LOCK**: the null-proto facts (`gpo([1])===null`, `gpo({})===null`,
null-literal-stored identity, the coincidental direct null===null the #3013
lesson warns about), the class-proto direct-operand pass, and 3 KNOWN-GAP rows
(case (d) null-canon stored-in-local, class-proto stored-in-local CS3, and the
non-`any`-operand `gpo(f)===Foo.prototype`) pinned at `0` so the eventual CS3
flip is auditable. No `src/` change; no floor movement expected.

---

## CS3 readiness assessment (opus, 2026-07-05) — needs its own architect pass; NOT a bounded slice

**Question posed:** now that CS1a–CS1c establish the identity carrier, is the
V2-S3b reader-arm (CS3, the ~1,552-test #3027 driver) safe/dispatchable, or does
the universal-reader ValType change still detonate the −299 consumer-breadth
mine?

**Verdict: CS3 still detonates the −299 mine. It is NOT a bounded slice and
requires its own architect pass.** The evidence is the convergent finding across
CS1b(iii) + CS1c (both re-probed on current main):

- The landed carrier (CS1a/b) is **strictly operand-scoped**: it re-classifies a
  reader result to tag-6 **only** when the read is a DIRECT operand of a
  standalone `any===any`/`!==`/`==`/`!=` (the exact shape routing through
  `emitAnyEqOperands`). That scoping is precisely what keeps it floor-safe — the
  value can only ever flow into the equality helper's `isAnyValue` fast-path,
  never into a subsequent read/store (a `$AnyValue` local breaks dynamic reads —
  the CS1a finding; `__any_to_extern` keeps the box wrapped).
- **Every remaining #3027 identity gap is OUTSIDE that scope.** Measured classes,
  all reducing to one root cause (reader/producer result carried as externref
  INTO an `any` slot, tag-5-boxed downstream): (i) result stored in an
  intermediate `any` local (`const v=o.a; v===w`); (ii) result passed as a
  function ARG and compared inside the callee — the `assert.sameValue`/
  `isSameValue` harness comparator shape, which is the DOMINANT test262 form;
  (iii) result paired with a non-`any` operand (`gpo(f)===Foo.prototype`);
  (iv) getPrototypeOf/null-proto canonicalization. The operand carrier cannot
  reach any of these.
- Fixing them means changing the ValType a reader/producer hands to the any-flow
  **independent of whether it is a direct `===` operand** — i.e. the UNIVERSAL
  reader carrier (Mechanism A / V2-S3b), which lands on the harness-comparator
  seam. That seam is the documented **−788 / −794 / −299** chokepoint: the
  test262 comparator marshals ALL its `any` operands through the externref→
  `$AnyValue` boxing arm and depends on main's tag-5 behaviour. #2661 and V2-S3b
  both died here.

**Why the substrate does NOT unblock it yet.** The #3037 thesis is that once
objects reach `===` tag-6-canonical, the reader arm needs no `===` change. But
CS1a–CS1c only make objects tag-6 at the *direct-operand* seam — they do NOT make
a reader result tag-6 when it enters an `any` local/arg/return. The harness
comparator receives its operands as `any` PARAMS (produced by the general
externref→`$AnyValue` boxing, tag-5), not as direct reads. So the substrate the
reader arm needs — objects tag-6 *at production into any*, universally — is
exactly the piece CS1 deliberately did NOT build (it is the −788 arm). CS3 is
that piece.

**Recommendation (report to lead):**
1. CS3 is a **hard, architect-owned** slice, not a dev carrier PR. It needs a
   dedicated spec that solves the universal reader/producer → tag-6 carrier
   WITHOUT touching the harness-comparator externref boxing arm — likely by
   canonicalizing at the `$Object` dynamic-READER natives (`__extern_get` et al.)
   returning a tag-6-carrying `$AnyValue` for object payloads while keeping
   strings tag-5, gated so the comparator's own operand marshalling is untouched.
   That is a genuinely different seam from the operand site and must be proven
   against the full `merge_group` floor per micro-step.
2. The carrier families (CS1a/b/ii) have banked their bounded wins; CS1b(iii)
   and CS1c are **RE-PROBED no-ops** (regression-locks only) — the operand
   carrier's coverage ceiling is reached. Do not spend further dev effort trying
   to flip stored-in-local / harness-comparator cases with the operand carrier.
3. Keep the CS1b(iii)/CS1c KNOWN-GAP test rows as the auditable CS3 flip targets.

---

## CS2-METHOD (synthesized-anchor: class METHODS) — LANDED (fable-identity, 2026-07-09, with #2963)

The Option-A synthesized-anchor model ("a reflective/synthesized value is
memoized to ONE canonical ref") now covers **class prototype methods reached
through the DYNAMIC `any`-receiver read path** — INV-2 for method values:

- The `__get_member_<name>` dispatcher gained miss-gated method arms answering
  the canonical `__method_closure_<Owner>_<m>` singleton — the SAME anchor the
  typed `C.prototype.m` read mints — so `c.m === C.prototype.m` holds without
  any equality-site change (production-site canonicalization, exactly this
  spec's thesis). The value reaches `===` as a plain externref of ONE GC
  struct; both the standalone inline strict-eq chain and host `__host_eq`
  answer identity on the shared ref. Neither the tag-5 same-tag arm, the
  generic `boxToAny` externref arm, nor the `===` operand seam were touched;
  `prove-emit-identity` 39/39 IDENTICAL vs main.
- #3080 (private-method value identity) folded in: the non-`this`-receiver
  private-method value read returned the RECEIVER; it now answers the same
  singleton. See `plan/issues/2963-builtin-first-class-reification.md`
  ("Class-METHOD value identity") for the full mechanism + the
  `collectDeclaredFuncRefs`-ordering trap.
- Housekeeping: the CS0 case (d) pin (`getPrototypeOf` results stored in `any`
  locals) was stale-RED on main — an intervening landed change already
  canonicalizes the stored-null comparison to the correct `1`; the pin is
  updated (verified failing on pristine main BEFORE this branch's changes).

**CS3 (universal reader carrier) remains open and architect-owned** per the
readiness assessment above — this slice extends the Option-A anchor family,
it does not attempt the −299 universal-carrier seam.
