---
id: 2955
title: "De-polymorph the IR front-end on string mode: abstract IR string ops resolved at lower time"
status: done
completed: 2026-08-15
sprint: 78
created: 2026-07-02
updated: 2026-08-18
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: refactor
area: ir
language_feature: strings
goal: ir-full-coverage
related: [2953, 679, 2949]
origin: "2026-07-02 July Fable audit §5 (identical source builds different IR per string mode)"
loc-budget-allow:
  - src/ir/from-ast.ts
  - src/ir/integration.ts
---

# #2955 — identical source builds different IR depending on nativeStrings

## Problem

`src/ir/from-ast.ts` branches on `resolver.nativeStrings?.()` at
:2620, :2874, :2938, :3173, :3309 (and `lower.ts` consults it at :173,
:186): with native strings on, IR construction emits `__str_*` helper
calls; with host strings, it emits host-import shapes. So the **front-end
IR is representation-polymorphic** — a violation of the north star ("one
front-end; backends/modes differ at lowering") _within_ the WasmGC family,
and a drift breeding ground (June audit D4): every new string feature must
be implemented twice at IR-build time.

## Approach

1. Introduce abstract IR string ops (e.g. `IrInstrStrConcat`,
   `IrInstrStrCompare`, `IrInstrStrLen`, `IrInstrStrIndex`,
   `IrInstrStrFromLiteral` — audit the 5 branch sites for the exact op
   set) emitted unconditionally by from-ast.
2. Resolve the mode in `lower.ts` (or the emitter, coordinating with
   #2953's trait discipline): native mode lowers to `__str_*` helpers,
   host mode to the wasm:js-string imports — exactly the sequences emitted
   today, byte-identical per mode.
3. Verifier: string ops type as the existing string ref types; no new
   verifier surface beyond op signatures.

## Acceptance criteria

- from-ast.ts contains zero `nativeStrings` reads (grep-gated).
- Same source produces identical IR (structural compare) in both string
  modes; per-mode lowered bytes identical to before.
- Equivalence suite green in both modes; string-heavy test262 sample
  net-zero.

## Implementation analysis + Slice 1 (2026-07-03, dev)

Measured against `origin/main` @ e29c8c5b2. The five `nativeStrings` reads in
`from-ast.ts` are **not one uniform "5 abstract string ops" set** (the Approach
section's op list — `IrInstrStrConcat`/`StrCompare`/… — does not match these
sites; those ops are already abstract elsewhere). Each read is a _different
kind_ of polymorphism, with a different byte-inert path to lower time:

| site     | function                          | polymorphism kind                                                                             | de-polymorph blocker                                                                                                                                                                                                   |
| -------- | --------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ~2792    | `coerceToExpectedExtern`          | string→externref host-call arg coercion; **native throws (demote)**                           | native string CANNOT flow into a host-string externref position, so the throw is a **claim/demote decision** — must move to `select.ts` capability (#2135), not lower time. Not byte-inert as a plain "always coerce". |
| ~2912    | number `.toString()` host import  | claims `f64.toString()` **only in host mode**                                                 | native has no native number formatter yet; the mode read is a real capability gate. Needs native number-format feature before it can move.                                                                             |
| ~3142    | `lowerStringMethodCall`           | helper name `__str_X` vs `string_X` + i32/f64 arg reps + native-mode bails + sentinel padding | large mode-specific decision table; a faithful move relocates the whole table (incl. #2002/#1248 special-cases) to `lower.ts`. Own slice.                                                                              |
| **3467** | **`coerceYieldValueToExternref`** | **string→externref coercion for generator-yield / iter-host**                                 | **NONE — cleanly byte-inert. DONE in Slice 1.**                                                                                                                                                                        |
| ~3603    | `lowerForOfStatement` string arm  | native char-loop vs iter-host for-of strategy                                                 | both strategies are big loop builders living in from-ast; moving the _selection_ to lower time means the lowerer owns both loop builders. Own slice.                                                                   |

### Slice 1 (landed by this PR) — the coercion-elision site (3467)

The `coerce.to_externref` op unconditionally emitted `extern.convert_any`,
which is **invalid over an already-externref operand** (externref is not an
anyref subtype). That is exactly why from-ast guarded the coercion sites with
`!nativeStrings` — to avoid emitting the convert over a host-mode string
(externref). Fix: move the "is the operand already externref?" decision to
**lower time** (`lower.ts` `coerce.to_externref` case), resolving it via
`resolveString()`/the operand valtype — precisely where the issue wants mode
resolved. `from-ast.ts:coerceYieldValueToExternref` now emits the abstract
coerce **unconditionally** (one `nativeStrings` read removed); the lowerer
elides the convert in host mode and emits it in native mode.

- **Byte-inert proof**: identical compiled binaries (sha256) in BOTH modes
  before/after, over the IR string-iteration + generator-for-of corpus.
  Elision is dead for existing callers (from-ast guarded every site), so no
  other `coerce.to_externref` site changes.
- **Validation**: `issue-1374-ir-string-iter-inline`, `issue-1665-standalone-
generator-forof` (native-strings `(ref $AnyString)`→convert_any path),
  `ir-frontend-widening`, `issue-1470-string-iteration-standalone`,
  `issue-2157`/`2162` iterators — 63 tests green.

### Remaining (slices 2–5)

Sites 2792 / 2912 / 3142 / 3603 each need their own slice with real work
beyond a mechanical move (capability-model integration for the demote/claim
sites; native number-format + native string-method feature reach; relocating
the method-dispatch table and the for-of strategy builders). This is why the
issue as a whole is `reasoning_effort: high`, not a uniform refactor. `status`
stays `ready` — Slice 1 removes one of the five reads and establishes the
lower-time-resolution pattern the rest follow.

## Re-measured decomposition (2026-07-06, senior-dev, opus-2955)

Measured against `upstream/main` @ `07ad889185`. The Slice-1 table above has
**drifted** — there are now **7 functional `nativeStrings` reads** in
`from-ast.ts` (grep `cx.resolver?.nativeStrings?.()` → lines 3233, 3245, 3402,
3641, 4018, 4124, 5815), and reading each one shows they are **not one
problem**. They split into two distinct classes the original Approach section
conflated. This is the corrected map for whoever picks up slices 2+.

| line | function                              | class                                  | what the read gates                                                                                                                                               | why it's not a byte-inert one-liner                                                                                                                                                                                         |
| ---- | ------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3233 | `coerceToExpectedExtern`              | **string-rep**                         | host-mode string is already externref → return as-is; native string (`(ref $AnyString)`) CANNOT flow into an externref host-arg → falls to the throw (**demote**) | the guard is load-bearing for the native demote; de-polymorph = capability decision → move to `select.ts` (#2135), not lower time                                                                                           |
| 3245 | `coerceToExpectedExtern`              | **number-box capability** (NOT string) | f64→externref via `__box_number`, **host lane only**; standalone has no `__box_number` (boxes via `$AnyValue`) → demote                                           | `nativeStrings === false` is a **proxy for "JS-host lane has the box helpers"**. De-polymorph = route through a capability query + emit `$AnyValue` boxing in standalone; touches number-boxing → **standalone-floor risk** |
| 3402 | string→externref coercion arm         | string-rep                             | same host-externref rep assumption                                                                                                                                | abstract-op introduction                                                                                                                                                                                                    |
| 3641 | `lowerStringMethodCall` (`useNative`) | **string-rep, largest**                | `__str_<m>` native helper vs `string_<m>` host import + i32/f64 arg reps + native bails + sentinel padding (#2002/#1248)                                          | relocates the **entire mode-specific dispatch table** to `lower.ts`. Own slice, biggest.                                                                                                                                    |
| 4018 | `coerceReturnValue`                   | **number-box capability** (NOT string) | externref→f64 via `__unbox_number`, **host lane only**; standalone demotes                                                                                        | same proxy as 3245; mirror slice (box + unbox move together)                                                                                                                                                                |
| 4124 | string arm                            | string-rep                             | host-mode string rep                                                                                                                                              | abstract-op introduction                                                                                                                                                                                                    |
| 5815 | undefined-test on operand             | string-rep                             | host-mode string is externref-shaped → `__extern_is_undefined`; native rep takes the fold path below                                                              | needs an abstract "is-undefined-on-string" IR op that resolves rep at lower time; not a plain guard removal                                                                                                                 |

**Key correction for the next picker:** sites **3245 and 4018 are not string
polymorphism at all** — they read `nativeStrings === false` only as a stand-in
for "are we in the JS-host lane that owns `__box_number`/`__unbox_number`?". The
clean fix for those two is a **capability predicate** (e.g.
`resolver.hasHostNumberBox?()`), moved together as one mirror slice, and
validated against the **standalone floor** (not just equivalence) because the
standalone demote arm is load-bearing. They arguably belong in a separate
capability-model issue rather than being counted against #2955's string
de-polymorph.

**Recommended slice order (each its own PR):**

- **Slice 2 — number-box capability (3245 + 4018 together).** Introduce a
  `resolver.hasHostNumberBox()` capability; from-ast emits an abstract
  `coerce.f64↔externref` box/unbox op unconditionally; `lower.ts` resolves
  host-box vs standalone-`$AnyValue`-box vs demote. Byte-inert per mode.
  **Must validate the standalone floor** (`merge_group`), not just equivalence.
- **Slice 3 — string-rep coercion sites (3233 + 3402 + 4124).** Following the
  Slice-1 pattern: abstract string→externref coerce op, lower-time rep
  resolution; the native demote decision moves to `select.ts` capability
  (#2135 coordination). Byte-inert per mode.
- **Slice 4 — undefined-test on string (5815).** New abstract
  "is-undefined-on-string" IR op; lowerer picks `__extern_is_undefined` (host,
  externref-shaped) vs the native fold path.
- **Slice 5 — `lowerStringMethodCall` dispatch table (3641).** Largest;
  relocate the whole `__str_<m>`/`string_<m>` decision table (incl. #2002/#1248
  arg-rep + sentinel special-cases) to `lower.ts`. Own slice, do last.

**Why no code slice landed this pass (senior-dev, final-budget):** every
remaining site requires either an abstract-IR-op introduction (op-union +
verifier signature + `lower.ts` case + per-mode byte-identity proof over a
string corpus) or a new capability predicate touching the standalone floor —
none is a sub-25-min byte-inert land like Slice 1 was (Slice 1 exploited an
already-abstract `coerce.to_externref` op whose new elision arm was dead for
all existing callers). Banking this corrected map instead of sinking final
budget into a half-finished op introduction. `status` stays `ready`.

## Slice 2 (2026-07-10, fable-2856) — site 3641 `lowerStringMethodCall`: the mode table moves to the resolver

The WHOLE mode decision — target name (`string_<m>` vs `__str_<m>`),
index-arg representation (f64 vs i32-truncated), omitted-optional strategy
(#1248 slice-end / #2002 NaN-position / native defer), and the #2002
native-mode 4-method defer — is relocated into a single resolver callback,
`IrFromAstResolver.stringMethodPlan(method, argCount)`, implemented in
`integration.ts` (the lower-time side, next to the mode discriminator).
`lowerStringMethodCall` now reads NO `nativeStrings`: it applies the plan
mechanically, and a `null` plan is this mode's demote decision (demote set
unchanged).

**Why a resolver callback, not (yet) the abstract `str.method` op the Slice-5
sketch above wanted:** half of this site's polymorphism is CLAIM/DEMOTE
(native indexOf/includes/startsWith/endsWith; native omitted optionals) —
and demote decisions must be settled at build time (there is no lower-time
demote channel; post-claim demotion buckets are gated). So any faithful move
keeps a build-time mode-owned query; the callback IS that query, owned by
the lower side. The rep half (the `i32.trunc_sat_f64_s` insertion, which
still makes the IR differ per mode) can later move into a true abstract op
lowered per mode — that promotion (op-union + verifier + lower.ts case +
byte proof) remains the follow-up for this site and is what would satisfy
the "identical IR across modes" criterion here.

**Verification:** byte-inert in BOTH modes — sha256-identical compiled
binaries vs pristine base over a 13-function corpus covering every table
method incl. omitted-optional forms (host `01fa36e630951f86`, native
`ce91bb7087c850b7`; postClaim counts unchanged 0/7); `check:ir-fallbacks`
gate unchanged; `issue-1232`/`issue-1248`/`issue-2002`/`issue-2192b` suites
41/41; IR equivalence suites 73/73; tsc clean. `nativeStrings` reads in
from-ast: 4 remain (the 3263/3275/5846 coercion-demote class, 3432
number-toString capability, 4155 for-of strategy — Slices 2–4 in the map
above).

## Number-box capability slice (2026-07-10, fable-10th) — sites 3245+4018 (map lines) → `hasHostNumberBox`

The two **number-box** reads (the re-measured map's "NOT string polymorphism"
pair) are relocated: `coerceToExpectedExtern`'s f64→externref `__box_number`
arm and `coerceReturnValue`'s externref→f64 `__unbox_number` arm no longer
read `nativeStrings?.() === false` — they consult a resolver-owned capability
predicate, `IrFromAstResolver.hasHostNumberBox()`, implemented in
`integration.ts` (`makeFromAstResolver`) as exactly `!ctx.nativeStrings`.
Byte-inert relocation: the predicate's truth table is identical to the old
in-place proxy reads in both modes (including the resolver-absent case:
`undefined === false` and `undefined === true` are both false → demote).

Two constraints recorded for whoever widens this later (per the Slice-2
pattern discussion with fable-2856):

- **The capability answer must stay a build-time answer** — the demote arm
  (the `coerceToExpectedExtern` throw / the #1798-gate slip in
  `coerceReturnValue`) is a claim/demote decision and there is no lower-time
  demote channel. Same constraint as the Slice-2 `stringMethodPlan` callback;
  this predicate is the boolean sibling of that lower-time-owned query shape
  (a full plan-object wasn't needed — the arm bodies are mode-invariant, only
  availability varies).
- **Widening is a semantic follow-up, not this slice**: allowing the box pair
  under a native-strings HOST compile, or lowering to `$AnyValue` boxing in
  standalone instead of demoting, changes claim behavior and **must be
  validated against the standalone floor** (`merge_group`), because the
  standalone demote arm is load-bearing.

**Verification**: sha256-identical compiled binaries vs pristine base in BOTH
modes over a 17-source corpus (14 playground examples + targeted box/unbox +
string-iter snippets): host `b246b07133d1be80`, native `097a7d8abc01e23a`,
12 compiled / 2 pre-existing CEs per mode, unchanged. `tsc --noEmit` clean;
prettier clean; `issue-2856-extern-in-ir` + `issue-2856-vec-push` +
`ir-frontend-widening` 39/39; `ir-algorithms-cluster` (covers the
`coerceReturnValue` unbox arm) 18/18.

**Remaining after this slice** (from-ast functional `nativeStrings` reads):
the string-rep coercion/demote class (`coerceToExpectedExtern` string arm +
the string→externref arm + the undefined-test at the map's 5815), the
number-`toString` capability site (string-rep-coupled: the host import's
return IS host-mode's string carrier), `lowerStringMethodCall` (Slice 2, PR
#2857, landed 2026-07-10), and the for-of strategy switch. `status` stays
`ready`.

## Slice 3 (2026-07-17, fable-e) — the string-rep externref-shaped class → `stringIsExternref`

Re-measured against `upstream/main` @ `19e287460b`: the map had drifted again —
the standalone "string→externref arm" sites (old 3402/4124) are **gone from
main**, leaving 4 functional reads: 3366 (`coerceToExpectedExtern` string
arm), 3586 (number-`toString` capability), 4454 (for-of strategy), 6332
(`tryLowerUndefinedCompare` externref-shaped test). This slice takes the
string-rep class the Slice-2 wrap-up grouped together: **3366 + 6332**.

Both sites ask the identical rep question — "is `IrType.string`'s carrier
externref (host strings), so a string SSA value can flow unchanged into an
externref-expected position?" Following the Slice-2/number-box pattern, that
question is now a resolver-owned predicate,
`IrFromAstResolver.stringIsExternref()`, implemented in `integration.ts`
(`makeFromAstResolver`) as exactly `!ctx.nativeStrings` (byte-inert
relocation). The from-ast reads preserve each site's **legacy resolver-absent
default**, which differed between the two sites:

- 3366 read `!== false` (old `!cx.resolver?.nativeStrings?.()`: absent →
  host-shaped → pass-through); its native arm falls to the demote throw —
  a build-time claim/demote decision (no lower-time demote channel, same
  constraint as `stringMethodPlan`/`hasHostNumberBox`). Unlike the
  number-box capability there is **no widening follow-up** on this arm: a
  native `(ref $AnyString)` can never satisfy an externref host-arg position.
- 6332 read `=== true` (old `nativeStrings?.() === false`: absent → NOT
  externref-shaped → fold path / demote). The native fold arm could later
  move to a true abstract "is-undefined-on-string" op (the map's Slice-4
  promotion); this slice relocates the mode knowledge only.

**Verification**: sha256-identical compiled binaries vs pristine base in ALL
THREE regimes (host / native / standalone) over a 20-source corpus (13
playground examples + 7 targeted snippets covering: string→extern-class-arg,
strict `===`/`!==  undefined` on `string` and `string | undefined`, string
methods, string for-of, generator-yield-string, number-toString). Mutation
check: inverting the predicate CHANGES host-mode hashes (t2-undef-cmp +
dom/calendar/algorithms examples) — the corpus genuinely exercises both
sites. `tsc --noEmit` clean; prettier clean; `check:ir-fallbacks` gate
unchanged (0 post-claim demotions); `ir-frontend-widening` +
`issue-2856-extern-in-ir` + `ir-algorithms-cluster` + `issue-2949-s5-2-eq`
62/62; `logical-conditional-identity` 20/23 with the same 3 pre-existing
`void x` TS-diagnostic failures on pristine base (verified base-vs-branch,
unrelated).

**Remaining after slice 3** (from-ast functional `nativeStrings` reads, 2):
the number-`toString` capability site (~3600, slice 4 next) and the for-of
strategy switch (~4470, slice 5). `status` stays `ready`.

## Slice 4 (2026-07-17, fable-e) — number-`toString` capability → `hasHostNumberToString`

The `<number>.toString()` arm in `lowerMethodCall` read
`nativeStrings?.() === false` as a PROXY for "does this lane own the
`number_toString` `(f64) -> externref` host import?" (host-lane-only, and its
return IS host-mode's string carrier — the mode read was doing capability
duty). It now consults `IrFromAstResolver.hasHostNumberToString()`,
implemented in `integration.ts` as exactly `!ctx.nativeStrings` — the
boolean-capability shape of `hasHostNumberBox`, byte-inert truth table
including the resolver-absent case (old `undefined === false` and new
`undefined === true` are both false → demote).

Same recorded constraints as the number-box slice: the answer stays a
build-time answer (the native arm is a demote; no lower-time demote channel),
and widening — a native number formatter returning the `(ref $AnyString)`
carrier — is a semantic follow-up that must be validated against the
standalone floor.

**Verification**: sha256-identical compiled binaries vs the slice-3 parent
commit in ALL THREE regimes (host / native / standalone) over the same
20-source corpus; mutation check (predicate inverted) changes the
number-toString snippet + dom/style example hashes in host mode — the site is
genuinely exercised. `tsc --noEmit` clean; prettier clean;
`check:ir-fallbacks` unchanged.

**Also in this slice — selfhost build-resolver hardening (latent slice-3
gap).** `IrFromAstResolver` has three implementers: `makeFromAstResolver`
(integration, gets every predicate), `makeLinearIrResolver` (linear — omits
`nativeStrings` entirely, so the per-site preserved resolver-absent defaults
keep it byte-inert across all slices), and stdlib-selfhost's
`NATIVE_STRINGS_FROMAST_RESOLVER` (`nativeStrings() → true`). The last one
diverged after slice 3: site 3366's resolver-absent default is
**pass-through** (host-shaped), the opposite of the demote-throw a
native-strings build wants — a latent (corpus-unreachable, byte-diff- and
CI-verified-inert today) hazard where a `(ref $AnyString)` could flow into an
externref-expected position without the loud error. Fixed here by
implementing `stringIsExternref() → false` (plus `hasHostNumberBox`/
`hasHostNumberToString` → false explicitly — those absent-defaults already
demoted, made total rather than lucky). Slice 5 must likewise give this
resolver its for-of answer (`char-loop`), since the plan-absent default is
iter-host.

**Remaining after slice 4** (from-ast functional `nativeStrings` reads, 1):
the for-of strategy switch (~4470, slice 5 — last). `status` stays `ready`.

## Slice 5 (2026-07-17, fable-e) — for-of strategy → `stringForOfPlan`; `nativeStrings` OFF the from-ast interface

The LAST functional mode read: `lowerForOfStatement`'s string arm read
`nativeStrings?.()` to pick the native `__str_charAt` counter loop vs the
`__iterator` host protocol. Now a resolver-owned strategy query,
`IrFromAstResolver.stringForOfPlan(): "char-loop" | "iter-host"` (both loop
builders stay in from-ast; only the SELECTION is resolver-owned — same
build-time-selection shape as `stringMethodPlan`, since the two strategies
build structurally different IR). Implementations: integration =
`ctx.nativeStrings ? "char-loop" : "iter-host"`; the selfhost native-strings
build resolver pins `"char-loop"` (the plan-absent default is iter-host,
which a host-free build must never emit); linear omits it (iter-host
fallthrough, as before). Byte-inert truth table incl. resolver-absent.

**Capstone: `nativeStrings?()` is REMOVED from `IrFromAstResolver`** (and
from both implementers). With zero functional reads left, keeping the raw
discriminator on the front-end surface would leave a drift channel open —
now a new representation-polymorphic IR-build branch is a compile error.
`IrLowerResolver` (lower.ts) still carries its own `nativeStrings?()` — the
lower side legitimately owns mode knowledge.

**Verification**: sha256-identical compiled binaries vs the slice-4 parent
in ALL THREE regimes over the 20-source corpus; mutation check (strategy
inverted) flips native+standalone `string-forof` hashes — the read is live.
`tsc --noEmit` clean; prettier clean; `check:ir-fallbacks` unchanged;
`issue-1183` + `issue-1374-ir-string-iter-inline` +
`issue-1470-string-iteration-standalone` + `issue-3161` + `issue-3256`
52/52.

## Acceptance-criteria status after slices 1–5

- **from-ast.ts contains zero `nativeStrings` reads (grep-gated)** — ✅ MET;
  stronger than the criterion: the discriminator is no longer even on the
  from-ast resolver interface.
- **Same source produces identical IR in both modes** — ❌ NOT met, by
  design of the faithful byte-inert slices: the mode decisions are settled
  at IR-BUILD time through resolver-owned queries (they must be — demote/
  claim has no lower-time channel), so the built IR still differs per mode
  where plans differ (`stringMethodPlan` arg reps, for-of loop shape,
  capability demotes). Promoting the rep halves into true abstract IR ops
  lowered per mode (the "identical IR" bar) is the documented follow-up:
  each promotion is op-union + verifier + lower.ts case + byte proof, and
  the demote halves stay build-time queries regardless.
- **Per-mode lowered bytes identical to before** — ✅ every slice
  sha256-proven over the corpus in host/native/standalone.
- **Equivalence green both modes / string-heavy net-zero** — per-slice CI
  (slices 1–3 landed green; 4–5 stacked PRs follow the same gate).

## Status note (fable, 2026-08-15)

Live grep on main @ `7add6938`: `src/ir/from-ast.ts` has **zero
functional `nativeStrings` reads** — every remaining match is a comment
documenting the relocation (verified down to the one non-comment mention,
which is a thrown-message string in the slice-13c pad path, gated on the
plan value, not a mode read). Mode decisions route through resolver
capability queries and `resolveFunc` sentinels (the #3156/#3167 pattern).

**Grep gate now ENFORCED** (this session):
`tests/issue-2955-depolymorph-gate.test.ts` strips comments/strings from
`from-ast.ts` and fails on any `nativeStrings` token — criterion 1 of the
acceptance is met and ratcheted.

**Criterion 2 — CLOSED AS SUPERSEDED (accepted design deviation).** The
`IrFromAstResolver` doc block (from-ast.ts ~310) records the endpoint the
implementation converged on: the raw `nativeStrings()` discriminator is
deliberately OFF the front-end interface; every former mode read is a
narrow, named, resolver-owned capability/representation/strategy query
(`stringIsExternref`, `hasHostNumberBox`, `hasHostBooleanBox`,
`hasHostNumberToString`, `stringMethodPlan`, `stringForOfPlan`,
`stringFromCharCodePlan`). Representation sites build identical IR
(types are resolver-deferred `IrType.string`); STRATEGY sites (for-of
char-loop vs iter-host, per-method plans with differing arg reps)
legitimately build different IR by design — the alternative (lowering
owning both loop builders) was the original criterion's implied shape,
and the implemented design achieves the issue's actual goal (no drift
channel: a new representation-polymorphic branch is a compile error,
since the discriminator is not reachable from from-ast) at far lower
cost. Criterion 3 (per-mode byte identity + equivalence green) was
proven per-slice — see the ✅ notes above.

**CLOSED 2026-08-15**: criterion 1 met + CI-gated
(`tests/issue-2955-depolymorph-gate.test.ts`), criterion 2 superseded as
documented, criterion 3 proven per-slice.
