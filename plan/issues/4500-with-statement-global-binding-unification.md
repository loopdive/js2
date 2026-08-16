---
id: 4500
title: "Standalone: `this.p` and bare `p` are different storage — global-binding unification"
status: ready
sprint: Backlog
created: 2026-08-15
updated: 2026-08-16
priority: high
horizon: l
feasibility: hard
task_type: bug
area: codegen
goal: standalone
related: [4206, 4495, 4205]
architect_spec: required
loc-budget-allow:
  - src/codegen/expressions/assignment.ts
  - src/codegen/property-access.ts
  - src/codegen/property-nullish-read.ts
func-budget-allow:
  - src/codegen/expressions/assignment.ts::compileAssignment
  - src/codegen/expressions/assignment.ts::compilePropertyAssignment
---

# Global-binding unification: `this.p` and bare `p` never reconcile

## Problem

At script global scope, `this.p1` and the bare name `p1` denote the **same
binding** in JavaScript. In `--target standalone` they are backed by **two
different storages** that never reconcile, in either direction.

The 2026-08-07 handoff on #4206 already named this as "the real head of this
cluster … unowned and unfiled", sized at ≥19 files. This issue is that item,
now with a controlled experiment separating it from #4495.

## Measured evidence — the type is held CONSTANT

**Provenance: measured 2026-08-15 on `9e17d34f3` + `5cde3f054`, `--target
standalone`, via `.tmp/same-type-probe.mts` and `.tmp/global-binding-probe.mts`.
Each case throws only when the observed value is WRONG, so "ok" means
spec-correct. No `with` statement appears in any row.**

Every value is the **same type throughout**, which is what rules out #4495's
slot-typing mechanism as an explanation:

| case | result |
|---|---|
| `this.p1 = 1; var f = function(){ p1 = 2; }; f(); p1 === 2` | **WRONG** |
| `var p1 = 1; p1 = 2; this.p1 === 2` | **WRONG** |
| `var p1 = 1; this.p1 = 2; p1 === 2` | **WRONG** |
| `this.p1 = 'a'; var f = function(){ p1 = 'b'; }; f(); p1 === 'b'` (string throughout) | **WRONG** |
| `var p1 = 1; var f = function(){ p1 = 2; }; f(); p1 === 2` (`var` global — control) | ok |

And the cases that do **not** fail, which localise it:

| case | result |
|---|---|
| `this.p1 = 1; p1 === 1` (bare read of a `this.`-assigned global) | ok |
| ~~`this.p1 = 1; p1 = 'x1'; p1 === 'x1'` (straight-line write then read)~~ | ~~ok~~ **PASSES FOR THE WRONG REASON — see below** |

> **FALSIFIED (Slice B diagnosis, 2026-08-15).** The struck row was recorded as
> evidence that the straight-line *write* path works. It is not. The write
> compiled to an **auto-allocated Wasm local**, and the read in the same function
> resolved to that same local — so the row passed without the global object ever
> being updated. The one-line disproof, measured on the same base:
>
> ```js
> this.p1 = 1; p1 = 2; this.p1 === 2   // FAILS — the object still holds 1
> ```
>
> Kept visible rather than deleted because it was evidence for a *wrong model*:
> "the write path is fine, only closures break it". The real statement is that
> the write never reached the global object in ANY of these rows; a same-function
> read merely hid it. Slice B fixes the write itself, which is why it also flips
> the `this.`-read row above.

## What the evidence says

- ~~The split is not observable on a straight-line write-then-read.~~ **Wrong —
  see the falsification above.** It IS broken there too; a same-function bare
  read hides it by sharing the auto-local.
- The split is **not** observable on a plain bare read of a `this.`-assigned
  global (that path genuinely works — `emitImplicitGlobalRead`).
- It becomes observable across a **closure boundary** (`f(){ p1 = 2 }` called
  from the same scope), across a **`this.`/bare direction change**, or on any
  read that does not share the writer's function.
- It is **independent of value type** — numeric-throughout and
  string-throughout both fail identically.
- A `var`-declared global with the identical closure shape is **correct**, so the
  closure-capture machinery itself is fine; what differs is the storage chosen
  for a `this.`-assigned global.
- ~~**Slice A's defect is STANDALONE-ONLY.** … rows 2 and 3 pass on `--target
  wasi` and fail only on `--target standalone`. That halves Slice A's search
  space…~~
  > **RETRACTED 2026-08-15, same day — this was a MEASUREMENT ARTIFACT, not a
  > fact.** The probe harness (`.tmp/sliceb-verify.mts`) invoked
  > `instance.exports.__module_init?.()`. `--target wasi` exports **`_start`**,
  > not `__module_init`, so the optional call was a **silent no-op** and every
  > wasi row reported `ok` **without executing anything**. The whole wasi column
  > was vacuous.
  >
  > Re-measured with a harness that REQUIRES the entry point and selects it per
  > target (`.tmp/slicea-probe2.mts`): rows 2, 3 and the pure-read row **fail
  > identically on `--target standalone`, `--target wasi` AND the default gc
  > lane**. There is **no wasi/standalone divergence to localize**, and Slice A's
  > search space is not halved.
  >
  > Independent confirmation via a value probe that reads the result through an
  > export instead of a throw (`.tmp/slicea-value.mts`): `this.p1` for a
  > `var`-declared global is **wrong on all three targets**.
  >
  > **Second instrument lesson (2026-08-15):** that probe reported the value as
  > `null`. It is actually **`undefined`** — the probe used
  > `export function getCode()`, which makes the file a **MODULE**, and top-level
  > `this` in a module is not the realm global object (`thisReceiverIsGlobalObject`
  > explicitly requires `!ctx.sourceIsModule`). So it measured module semantics,
  > not the script defect. Re-measured in **script** form with a per-hypothesis
  > binary oracle (`.tmp/slicea-value2.mts`): the value is `undefined`, while
  > `typeof this.p1` answers `'number'`. Adding an `export` to a probe silently
  > changes the language semantics under test — the same class of hazard as the
  > `__module_init?.()` no-op, and the reason a fix aimed at `null` would have
  > hunted the wrong bug.
- **Slice A's defect is UNIVERSAL — standalone, wasi and gc.** Because it also
  affects the **default gc lane**, gc is *not* a clean control for Slice A: it
  will gain rows too, so the gate is "zero pass→fail on every lane", not "gc
  unchanged".
- **The pure READ is already broken**, which is simpler than rows 2/3 and is
  likely the root: `var p1 = 7; this.p1 === 7` fails, with `this.p1` reading
  `null`. Rows 2 and 3 are downstream of that single read/write routing gap.
- **Latent inconsistency worth a look while in here:** `typeof this.p1 ===
  'number'` **passes** for a `var` global while the value read yields `null`
  (`typeof null` is `'object'`). So the `typeof` path answers from the static
  type while the value path answers from the env object — two different sources
  for the same expression. Not chased; recorded because a Slice A fix should
  make both agree rather than only fixing the value path.

That combination points at the *binding resolution* for globals introduced via
`this.<name>` rather than at closure capture or at slot typing.

## Relationship to #4495 — TWO heads, not one

#4495 (string/typed slot cannot represent a dynamic value ⇒ stores `null`) is a
**separate defect**. The clean separators, both measured:

- `function id(x){ return x }; var result = 'r'; result = id(1); '' + result`
  reproduces **#4495** with **no globals anywhere**.
- The type-held-constant table above reproduces **this issue** with **no type
  change anywhere**, so no slot can be blamed.

They **co-occur** throughout the `S12.10` `with` corpus because `this.p1 = 1`
does two things at once: it splits the storage (this issue) *and* makes the value
dynamic to the checker, which then hits #4495's slot path. That co-occurrence is
what caused an earlier revision of #4495 to wrongly merge the two — see the
correction recorded in that file. **Neither subsumes the other; both must land.**

## Residue arithmetic (#4206)

**Provenance: `language/statements/with`, `--target standalone`, 181 files,
measured 2026-08-15 with a working quickjs eval provider (`.tmp/with-base2.jsonl`).**

Baseline **113 pass / 55 fail / 13 CE** — i.e. a **68-row residue**. (An earlier
scan reporting 66/102/13 was instrument noise: 56 rows were "quickjs provider is
not built". See #4206 §0.)

How the 68 splits, and who owns each part:

| rows | cluster | owner |
|---:|---|---|
| 13 | `__str_concat` null deref | **#4495** — and worth **zero passes** on its own: in all 13 files every concat is inside `throw new Test262Error(...)`, so the crash is strictly on the already-failing path |
| 10 (+1) | `#1387` closed-shape CE gate | constructible-closure ABI — an ABI project, not a slice (per #4206's 2026-08-11 record) |
| 6 | `p1 === "x1"` actual `1` | **this issue** |
| 4 | `result === undefined` actual `null` | **#4495** (a native-string slot cannot represent `undefined` at function entry) |
| 2 | `theirObj.p1` actual `true` | not diagnosed |
| rest | singletons | not diagnosed |

**Consequence for scheduling:** no further `with`-lane slice is takeable until
this issue and #4495 land. #4206 should be treated as blocked on the two heads
rather than as a source of ready work.

## Blast radius — read before starting

Global binding resolution is load-bearing for every script-goal program, and the
`var`-global path is currently **correct** — so a fix must not disturb it. The
risk is a change that unifies the two storages but regresses the common
`var`-global fast path, which is exercised far more widely than the `this.`-global
one. `feasibility: hard` and `architect_spec: required` for that reason.

**A Fable-lane implementation plan is required BEFORE dispatch.** Do not start
implementation off this file alone.

## Acceptance criteria

1. Every row in the type-held-constant table above is `ok`.
2. The bare-read localisation row stays `ok`. (The straight-line
   write-then-read row is NOT a valid control — it passed for the wrong reason;
   see the falsification note. Use `this.p1 = 1; p1 = 2; this.p1 === 2` instead,
   which is a genuine write-path assertion and must flip to `ok`.)
3. The `var`-global control stays `ok`, with a measured check that the
   `var`-global path did not regress.
4. Measured, two-sided A/B on `language/statements/with` standalone against the
   68-row baseline above, plus a gc-lane control (this is not carrier-gated).
5. Zero `pass → non-pass` transitions on either lane.

## Instrument warning

Measuring this needs a **working eval provider**, or ~56 of the 181 `with` rows
report a false failure and the delta is meaningless. `TEST262_FULL_RUNTIME_EVAL=1`
selects the *interpreter* tier, but since #4242 the default engine is **quickjs**
and the selector never builds it. Build both bundles first, then the provider —
and rebuild both bundles **per A/B arm**, since the test262 pool worker imports
`scripts/compiler-bundle.mjs`, not `src/`:

```sh
node_modules/.bin/esbuild src/index.ts   --bundle --platform=node --format=esm \
  --outfile=scripts/compiler-bundle.mjs --external:typescript --external:binaryen
node_modules/.bin/esbuild src/runtime.ts --bundle --platform=node --format=esm \
  --outfile=scripts/runtime-bundle.mjs  --external:typescript --external:binaryen
NODE_OPTIONS=--max-old-space-size=3072 node scripts/build-quickjs-eval-provider.mjs
```

## Falsified hypotheses (kept visible)

- ~~"This is the same defect as #4495; global-binding is just one of its
  sources."~~ **False**, and it was written into #4495 before being disproved.
  The type-held-constant table fails with no type change anywhere, so no slot
  can explain it.
- ~~"It is a `with`-scope-chain resolution bug."~~ **False.** Every failing row
  above has no `with` statement. The `with` corpus merely *contains* the shape;
  removing `with` entirely preserves the failure.
- ~~"Closure capture is broken."~~ **False.** The identical closure shape over a
  `var`-declared global is correct; only the `this.`-assigned global fails.

## Implementation Plan (fable, 2026-08-15)

Source picture (verified against source 2026-08-15): script-goal globals have
TWO storages today —

- **`var`-declared** → wasm module globals (`ctx.moduleGlobals`,
  `global.get/set`, e.g. assignment.ts ~L208-217).
- **Implicit / `this.`-assigned** → the realm global-environment object:
  pre-scan `recordSloppyImplicitGlobalNames` populates
  `ctx.sloppyImplicitGlobals` (see module-init-collection.ts ~L160-176,
  index.ts ~L3714); reads go through `emitImplicitGlobalRead`
  (identifiers.ts ~L929 → global-environment.ts ~L335); writes through
  `ensureGlobalEnvironmentOperation("__extern_set")`
  (assignment.ts ~L885, unresolvable-assign.ts ~L181/L246/L258). The env
  object exists natively in standalone (probes' bare-read row works).

The unification rule: **one canonical storage per name, decided statically.**
`var`-declared in the compiled script ⇒ module global. Otherwise ⇒ env
object. Each defect row is a path that picks the WRONG storage for its name.

### Slice A — `this.p` ⇄ module global (probe rows 2 and 3)

Where a member access's receiver is the realm global object
(`receiverIsRealmGlobalObject` / `isGlobalObjectExpr`,
sloppy-this-global.ts ~L164/~L191, global-environment.ts ~L613) AND the
property name is in `ctx.moduleGlobals`: compile the access as
`global.get`/`global.set` on the module global instead of the env-object
op. Sites: the member-read dispatch and member-write path that currently
route such receivers to `__extern_get`/`__extern_set` (find them by tracing
the row-2 probe: `var p1 = 1; p1 = 2; this.p1` — the `this.p1` read's arm).
Coerce through the module global's declared type with the existing
`coerceType` (the #3534 box-on-store invariant applies if the global is
externref). `delete this.p1` on a var global: emit `false` (var globals are
non-configurable) — add a probe row for it.

### Slice B — closure bare-write of an implicit global (probe row 1)

> **SUPERSEDED by the measured diagnosis below (2026-08-15).** The
> four-candidate list in the original text is kept for the record, but **none of
> those four arms fires**. Do not use it as a starting point.

**Original hypothesis (all four candidates FALSIFIED):**

~~`this.p1 = 1; var f = function(){ p1 = 2; }; f(); p1 === 2` fails, yet the
write path at assignment.ts ~L885 already consults `sloppyImplicitGlobals`.
So EITHER the closure's write compiles through a different arm (the
auto-local at ~L899, or an unresolvable-assign arm that allocated a local
before the set was consulted), OR the pre-scan runs after the closure body
compiles, OR the checker resolves `p1` inside the closure to something
else entirely. Diagnose FIRST: instrument all four candidate arms
(assignment.ts L885/L899, unresolvable-assign.ts L181/L246) and compile the
row-1 probe; record which arm fires.~~

**Measured diagnosis** (instrumented all four candidates plus the identifier
dispatch and `ensureGlobalEnvironmentOperation`, then compiled the row-1 probe):

- **assignment.ts L885 / L899 never fire.** Both live in
  `emitIdentifierWriteFromLocal`, which is only reachable from the **`with`**
  cascade write paths. The row-1 probe contains no `with`, so they were never
  candidates for it.
- **unresolvable-assign.ts L181 / L246 never fire.** `isUnresolvableIdent` is
  **false** for `p1` — `this.p1 = 1` gives the name a checker symbol — so
  `tryCompileUnresolvableIdentifierAssign` returns `NOT_UNRESOLVABLE` and the
  module is never entered.
- **The pre-scan is HEALTHY.** The dispatch trace shows `sloppyImplicit=true`
  for `p1` inside the closure. `ctx.sloppyImplicitGlobals` has the name; nothing
  on this path consults it. (So the "pre-scan ordering" hypothesis is also
  falsified, and **Slice A's baseline is unaffected**.)
- **The arm that fires is the FINAL auto-local fallback** at the end of
  `compileAssignment`'s identifier branch (base `assignment.ts` ~L678-690, the
  "graceful fallback for other unresolved identifiers"). It mints a Wasm local
  for the name.
- **That same arm fires for the case the probe table recorded as WORKING.** The
  auto-local makes the write function-local, so a same-function read shares it
  and looks correct while the global object is never updated — see the
  falsification note in the evidence section above.

**Fix (implemented):** in that final fallback, when
`ctx.sloppyImplicitGlobals.has(name)`, compile the RHS to a temp and write it
through the global-environment object (`emitGlobalEnvironmentObject` +
`emitGlobalEnvironmentKey` + `__extern_set`), leaving the RHS value as the
expression result — instead of minting a local. This is the ordinary-identifier
counterpart of the #4231 RC-F arm, which applies the same rule on the
`with`-cascade path and whose comment documents why minting a local is
destructive. If the env object or setter is unavailable the arm falls through to
the unchanged auto-local, so no program loses its write.

### Order

Slice B first (it is the closure row, likely the bigger test262 share and
carries no representation change), then Slice A. Separate boundaries, each
with its own measurement. If Slice B's diagnosis reveals the pre-scan
ordering is the defect, fixing the ordering may also change Slice A's
baseline — re-measure between slices.

### Measurement (both slices)

1. The probe tables in this file: all WRONG rows flip to ok, all ok rows
   (incl. the var-global control and the two localisation rows) stay ok —
   both targets.
2. Scoped test262 A/B, standalone: `language/statements/with` against the
   68-row baseline (quickjs provider per Instrument warning; rebuild bundles
   per arm) — expect the 6 `p1 === "x1"` rows to flip; plus
   `language/eval-code` and `language/global-code` as global-semantics
   control buckets. Zero pass→non-pass.
3. gc-lane control on the same buckets. Zero pass→non-pass.
4. The `var`-global fast path must not change bytes for programs with no
   `this.`-global interplay: compile 2-3 var-global-only samples before/after
   and diff the binaries — byte-identical expected (Slice A only adds arms
   behind a `receiverIsRealmGlobalObject && moduleGlobals.has` test that such
   programs never take; Slice B is behind `sloppyImplicitGlobals`).

## Slice B — measured result (2026-08-15)

**Provenance:** base = the tree at `0670015b3` with `assignment.ts` reverted by
file copy; branch = the same tree with the Slice B arm. Same in-process
`runTest262File` driver both arms, back-to-back, quickjs eval provider built per
the Instrument warning. Artifacts `.tmp/sb-{base,branch}-{standalone,gc}.jsonl`.

Buckets: `language/statements/with` (181) + `language/eval-code` (347) +
`language/global-code` (42) = **570 files per arm per lane**.

| lane | base pass | branch pass | fail→pass | **pass→fail** |
|---|---:|---:|---:|---:|
| standalone | 442 | **445** | 3 | **0** |
| gc | 277 | **283** | 6 | **0** |

`with`-bucket only, standalone: **113 → 116** pass (fail 55 → 52, CE 13
unchanged) — the 113 matches the #4206 authoritative baseline exactly, which
cross-checks the instrument.

Every flipped row is a `p1 === "x1"` row, i.e. precisely the cluster this issue
predicted — no incidental flips:

- standalone (3): `S12.10_A3.11_T1/T2/T4`
- gc (6): `S12.10_A1.11_T1/T2/T4` + `S12.10_A3.11_T1/T2/T4`

**The gc lane gains more than standalone (6 vs 3).** The `A1.11_*` rows still
fail on standalone after Slice B; they are gated behind the standalone-only
Slice A defect and/or #4495, consistent with the residue split recorded above.

Probe table (`.tmp/sliceb-verify.mts`): row 1, the string-throughout row and the
`this.`-read row all flip to `ok`; all six control rows stay `ok`. Rows 2 and 3
remain WRONG — Slice A's rows, by the plan's own split.

> **Correction to this table's coverage (2026-08-15).** Its **wasi column was
> vacuous** — the harness called `__module_init?.()`, which does not exist on
> `--target wasi` (that target exports `_start`), so no wasi row executed. The
> **standalone column was real**, and the two decisive Slice B arms — the
> 570-file test262 A/B (standalone + gc) and the byte-identity check — were
> never affected, so **Slice B's measured result stands unchanged**. Only the
> claim "verified on both targets" was overstated.
>
> Re-verified afterwards with a corrected harness (`.tmp/slicea-probe2.mts`,
> entry point required and target-selected): **Slice B's row-1 fix passes on
> standalone, wasi AND gc**, and the var-global control passes on all three. So
> the fix is now genuinely confirmed on all three lanes rather than assumed.

Byte-identity (measurement arm 4): 4 var-global-only / no-global samples ×
{standalone, wasi, gc} = 12 binaries, **all byte-identical** base vs branch. The
`var`-global fast path is untouched, as designed — the new arm sits behind
`sloppyImplicitGlobals`, which such programs never populate.

**Caveat on the gc numbers:** the in-process driver runs many test262 files in
one process, so gc absolute counts are depressed by cross-test global pollution
(the `pnpm run test:262` pool isolates per file). Both arms use the identical
driver back-to-back, so the **delta** is sound; treat the gc absolutes as a floor,
not a conformance figure.

**Regression gate (`tests/equivalence`, the sanctioned gc gate):** all 214 files
run in memory-bounded batches. **16 failures across 8 files — byte-for-byte the
same 16 that were A/B-proven pre-existing at this base during the #2867 boundary**
(`arguments-nested-and-loops`, `array-inline-return`, `delete-sentinel`,
`logical-conditional-identity` ×3, `optional-direct-closure-call` ×2,
`reflect-api`, `tdz-reference-error` ×6, `yield-as-expression`). **Zero new
failures.** `npm run typecheck` and `biome lint` clean.

### Slice B status

Slice B is **complete and measured**. Slice A (probe rows 2 and 3) is untouched
and remains open — and per the standalone-only finding above, its search space is
now narrowed to the standalone lane's realm-global member-access path.

## Slice A — measured result (2026-08-15/16)

**Provenance:** base = this tree with the three Slice A files reverted by file
copy (i.e. `f652b3c4f`, Slice B landed); branch = the same tree with Slice A.
Same in-process driver both arms, back-to-back, quickjs eval provider per the
Instrument warning. **Note the base is two `main`s behind** (PR #4595 merged
during this work) — the A/B is internally consistent, but the absolutes are not
comparable to a current-main run. Artifacts `.tmp/sa-{base,branch}-{standalone,gc}.jsonl`.

Buckets: `language/statements/with` + `language/eval-code` + `language/global-code`
= 570 files per arm per lane.

| lane | base pass | branch pass | fail→pass | **pass→fail** |
|---|---:|---:|---:|---:|
| standalone | 445 | **446** | 1 | **0** |
| gc | 283 | **284** | 1 | **0** |

The single flip on both lanes is the same test: **`language/global-code/S10.4.1_A1_T1.js`**
— a *global-code* row, not a `with` row. That is the expected shape: Slice A is a
**correctness/consistency** fix to `this.p` ⇄ module-global routing, not a volume
lever (the six `p1 === "x1"` rows were Slice B's). It also vindicates adding
`global-code`/`eval-code` to the measurement buckets — a `with`-only scope would
have scored this slice at zero and hidden the one real gain.

### Gates

- **Probe table**: all 8 rows pass on **standalone, wasi AND gc**, including
  `delete this.p → false` and Slice B's row-1.
- **typeof/value agreement (acceptance criterion)**: met, and it was the gate
  that did the work — it exposed a THIRD read path (see below). Value `7`,
  `typeof` `'number'`, and nullish comparisons all agree with the
  bare-identifier path.
- **Functional identity** (replacing byte-identity, which Slice A necessarily
  breaks for var-globals): 5 samples × {standalone, wasi, gc} = 15 runs, all
  correct — including a var-global round-tripped through `this.`.
- `npm run typecheck` and `biome lint` clean.

### Three read paths, not one

The fix is +92 lines across three files, and all three were required:

1. `property-access.ts` — the main read arm
   (`receiverIsRealmGlobalObject && moduleGlobals.has(name)` → `global.get`).
2. `expressions/assignment.ts` — the symmetric write arm. **Not optional**: with
   the read alone, `this.p = 2; this.p === 2` REGRESSED, because the read
   consulted the module global while the write still updated the object. Caught
   mid-slice by the probe table; the pair must land together.
3. `property-nullish-read.ts` — nullish comparisons (`=== undefined`, `== null`)
   never reach `compilePropertyAccess`; they route through
   `compileNullishObservedExpression` to a **second function with the same name**
   (`compilePropertyAccessForNullishObservation` exists in BOTH
   `property-access.ts` and `property-nullish-read.ts`). With 1+2 fixed this left
   a live contradiction in one program — `this.p1 === 7` true AND
   `this.p1 === undefined` true. Patching the wrong copy first, and seeing the
   trace not move, is how the duplicate was found.

Slice A is complete. Both #4500 slices have landed; the residue split recorded
above (4 rows to #4495, the `#1387` CE gate to the constructible-closure ABI)
is unchanged by this slice.

**Regression gate (`tests/equivalence`) — Slice A.** Not in Slice A's original
gate list, but run anyway: Slice A touches `property-access.ts`, the compiler's
central property-read path, which is *more* core than the `assignment.ts` change
that Slice B ran this gate for. All 214 files, memory-bounded batches:
**16 failures across 8 files — byte-for-byte the same 16 A/B-proven pre-existing
at this base (twice: at the #2867 boundary and again on Slice B). Zero new.**
