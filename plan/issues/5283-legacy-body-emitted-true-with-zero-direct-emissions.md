---
id: 5283
title: "`legacyBodyEmitted: true` on units where NO direct pass ran — 26 of 33 dogfood rows, and it inflates every legacy-body count built on that flag"
status: done
created: 2026-09-03
updated: 2026-09-03
completed: 2026-09-03
assignee: ttraenkler/opus-5283
sprint: current
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
area: ir
goal: backend-agnostic-ir
requested_by: ttraenkler/fable-ir-takeover
related: [3523, 3518, 3519, 3521]
---

## Problem

`IrObservedOutcome.legacyBodyEmitted` is supposed to mean "the direct front end
emitted a body for this unit". It is set on units where **no direct pass ran**,
and the same row records **no `directBodyEmissions` at all**.

Minimal confirmation — `tests/fixtures/extern-demo.ts`, one compile through the
`check:ir-only` single-host observer:

```json
{ "unitKind": "module-init", "kind": "unsupported",
  "code": "body-shape-rejected", "stage": "select",
  "legacyBodyEmitted": true, "irBodyEmitted": false }
```

`directBodyEmissions` and `prepareAttempts` are **absent**, not zero. The row
asserts a legacy body while recording nothing that emitted one.

This was predicted by the #3523 gap-6b census as P4 ("a truthfulness defect
adjacent to gap 4"), which instructed: confirm with one compile and file
separately. That is what this is.

## Scale — it is not one fixture

Counting rows with `legacyBodyEmitted === true` and `(directBodyEmissions ?? 0) === 0`:

| corpus / lane | legacyBodyEmitted | of which phantom |
| --- | --: | --: |
| `tests/dogfood/corpus`, single-host | 33 | **26** |
| `tests/dogfood/corpus`, standalone | 31 | **23** |
| playground uncovered eight, single-host | 10 | **0** |
| playground uncovered eight, standalone | 14 | **0** |

**Roughly four in five dogfood legacy-body rows are phantom; the playground has
none.** That the two corpora differ this sharply is itself the diagnostic: the
flag is not uniformly wrong, it is wrong for a population the playground does
not contain.

## Suspected mechanism (not yet proven)

`collectModuleInitPopulation` (`src/ir/module-init.ts:11-24`) skips
`FunctionDeclaration`, `ClassDeclaration`, `InterfaceDeclaration`,
`TypeAliasDeclaration`, `Import*`, `Export*` and `EmptyStatement` — but **not
`ModuleDeclaration`**, so `declare namespace Host { … }` counts as module-init
population even though a `declare` namespace emits nothing. That explains
`extern-demo.ts` exactly. Whether it explains all 26 dogfood rows is
**unverified** — those are `.js` files with no `declare namespace`, so at least
one other path must set the flag without a direct emission. Do not assume one
cause.

## Why this is worth priority

Every "how much does the direct front end still emit" number is built on this
flag, including the R9 denominator work on `#3518`. Measurements taken there on
2026-09-02/03 quote dogfood legacy-body counts of 33 and 31; the direct-emission
counts are **7 and 8**. Those figures have been corrected in place on `#3518`
with a pointer here. Any other consumer of `legacyBodyEmitted` — a ratchet, a
census, a slice's byte-neutrality argument — is overstating by the same shape.

## Acceptance

1. Root-cause every phantom row, not just the `ModuleDeclaration` one. The
   dogfood `.js` rows are the proof the `declare namespace` path is not the
   whole story.
2. Either `legacyBodyEmitted` becomes true only when a direct body was actually
   emitted, or it is renamed to what it really means and every consumer is
   updated. Do not leave a flag whose name and meaning disagree.
3. A pin per distinct phantom-producing path, each failing before the fix.
4. State whether any committed baseline or ratchet floor was seeded from
   inflated counts. If so, the reseed is part of this issue, not a follow-up.

## Reproduce

```ts
import { observeSingleHostLane } from "./scripts/check-ir-only.js";
const obs = await observeSingleHostLane(["tests/fixtures/extern-demo.ts"]);
// module-init row: legacyBodyEmitted true, directBodyEmissions absent
```

For the corpus scale, run the same observer over `tests/dogfood/corpus` and
filter `legacyBodyEmitted === true && (directBodyEmissions ?? 0) === 0`.

---

## Implementation Plan

Written 2026-09-03 (architect lane). Figures labelled **measured** were produced
in a worktree at `origin/main` `bee5ddd535`.

### Shared vocabulary — R2 accounting cluster (#5262 / #5263 / #5282 / #5283)

Identical block in all four plans. Use these words; they are not synonyms.

| term | meaning |
| --- | --- |
| **direct receipt** | one `compileFunctionBody` entry indexed by `IrBodyRouteAuditSession.#indexDirectFunctionBodyReceipt` (`src/codegen/legacy-body-audit.ts:303`). The ONLY source of `directBodyEmissions`. Recorded **only** for top-level free-function terminals; every other unit kind is dropped at `:312`. |
| **physical root** | any `IrLegacyBodyEntry` carrying a `unitId` — a superset of direct receipts that also includes `compileClassBodies`, `compileModuleInitBody`, `compileStatement`, `compileExpression`. This is what `snapshot()`'s `legacyEntryIds` uses, and it is the correct denominator for "did a direct pass run". |
| **the triple** | `(prepareAttempts, directBodyEmissions, irBodyEmissions)`. Present **only** on rows in the R2 population; absent (not zero) everywhere else. |
| **R2 population** | `indexR2FreeFunctionPopulations` (`ir-overlay-outcomes.ts:153`) — source-local, public, physical, last-named top-level function declarations with bodies. |
| **accounting arm** | one `if` branch inside `functionBodyAccountingFailure` (`ir-overlay-outcomes.ts:315-358`). |
| **root-cause outcome** | the outcome the precedence chain at `ir-overlay-outcomes.ts:905-967` computed, *before* the accounting block runs. |
| **owned-elsewhere unit** | a terminal whose ledger row is minted by the prepared-callable publication path, not by `reconcileIrOverlayOutcomes`. See #5263. |

### Premise correction — the 26/23 figures are an artifact of the filter, not the flag

**This is the most important finding in the plan; read it before scoping.**

The issue's filter is `legacyBodyEmitted === true && (directBodyEmissions ?? 0) === 0`.
But `directBodyEmissions` is populated **only** for the R2 population — every
`class-member` and `module-init` row is `undefined` by construction
(`ir-overlay-outcomes.ts:867-898` computes `bodyAccounting` only when
`r2FreeFunctionPopulation.unitIds.has(unit.unitId)`). So the filter counts
"unit kinds whose accounting was never migrated to receipts" and reports them as
"no direct emission".

Measured, by cross-referencing each `legacyBodyEmitted` row against
`irBodyRouteAudit.legacyEntries` (a physical root, per the vocabulary above):

| corpus / lane | `legacyBodyEmitted` | by unit kind | issue's "phantom" filter | **rows with NO physical root** |
| --- | --: | --- | --: | --: |
| `tests/dogfood/corpus`, single-host | 33 | 19 module-init, 7 class-member, 7 function | 26 | **1** |
| `tests/dogfood/corpus`, standalone | 31 | 16 module-init, 7 class-member, 8 function | 23 | **1** |
| `check:ir-only` playground five, single-host | 0 | — | 0 | **0** |
| `tests/fixtures/extern-demo.ts`, single-host | 3 | 2 function, 1 module-init | 1 | **1** |

The issue's 33 / 26 / 31 / 23 reproduce **exactly**. The right-hand column does
not. Twenty-five of the twenty-six dogfood "phantom" rows DID enter a direct-body
root — they simply have no `directBodyEmissions` field to prove it with.

Independent corroboration from a detector that already exists: the route audit's
own `missing-legacy-entry-evidence` violation
(`src/codegen/legacy-body-audit.ts:500-506` — *"terminal reports a legacy body
without entering an audited direct-body root"*) fires **exactly once** per
corpus run, on the same single row. The compiler already computes the correct
number; the issue's filter is a wrong proxy for it.

So the corrected scale is **2 distinct genuinely-phantom rows**, both
`module-init`, both `unsupported/body-shape-rejected/select`:

- `tests/fixtures/extern-demo.ts`
- `tests/dogfood/corpus/import-attributes.module.js`

The issue's core claim — *the flag is asserted where no direct pass ran* — is
**true and reproduced**. Its magnitude is not. Rescope accordingly: this is a
two-row truthfulness defect plus a naming problem, not a 26-row one.

### Root cause(s)

**Path 1 — `ModuleDeclaration` in the module-init population (the issue's
suspicion, confirmed).** `collectModuleInitPopulation` (`src/ir/module-init.ts:9-28`)
skips eight statement kinds but not `ModuleDeclaration`. Measured on
`extern-demo.ts`: the population is exactly `["ModuleDeclaration"]` (a
`declare namespace Host`), which mints a module-init terminal
(`src/ir/identity.ts:878-898` mints when `modulePopulation.length > 0`), while
the direct route emits nothing — measured `legacyEntries` for that file contain
`compileFunctionBody` roots for `makeBox` and `area` and **no**
`compileModuleInitBody` root at all.

**Path 2 — a second, different path (the issue predicted this; confirmed, cause
still open).** `import-attributes.module.js` is two statements, an
`ImportDeclaration` and an `ExportDeclaration`, both of which
`collectModuleInitPopulation` *does* skip. Measured: re-parsing that file's text
with `ts.createSourceFile` and calling `collectModuleInitPopulation` returns
`[]` — yet the compile produces a module-init terminal with
`legacyBodyEmitted: true`. **The source file the inventory scanner sees is not
the one a raw re-parse produces** (the `.module.js` route applies a pre-scan
transform), so the population is non-empty at scan time.

The implementer must instrument the **actual scanned `ts.SourceFile`** — add a
temporary dump inside `buildIrPlanningIdentityContext`
(`src/ir/planning-identity.ts:487`) or the scanner at `src/ir/identity.ts:878` —
and name what is in `modulePopulation` for that file. Do not guess, and do not
assume path 2 is the same as path 1: the issue's own instruction ("do not assume
one cause") is correct, it is just about two rows rather than twenty-six.

### Changes

**File: `src/codegen/ir-overlay-outcomes.ts`, `reconcileIrOverlayOutcomes` (`:878-879`)**

This is the line that makes the flag an inference:

```ts
const legacyBodyEmitted =
  bodyAccounting?.legacyBodyEmitted ?? (unit.legacyBodyAvailable && !input.skippedBodyUnitIds.has(unit.unitId));
```

For non-R2 rows the fallback means *"a legacy body was available and we did not
skip it"*, which is a **prediction**, not a receipt. Two options, pick one and
say which in the PR:

- **(A) Make it a receipt.** Thread the set of physical-root unit ids
  (`IrBodyRouteAuditSession`'s `#entries`, exposed as a new
  `physicalRootUnitIds(): ReadonlySet<IrUnitId>` accessor next to
  `directFunctionBodyReceiptAudit` at `legacy-body-audit.ts:246`) into
  `ReconcileIrOverlayOutcomesInput`, and set
  `legacyBodyEmitted = bodyAccounting?.legacyBodyEmitted ?? physicalRootUnitIds.has(unit.unitId)`.
  This is the fix the acceptance criteria ask for and it makes both phantom rows
  read `false` regardless of which path minted them.
  **Sequencing hazard:** the audit session's `#entries` are still being filled
  while `recordObservedIrOutcomes` runs for earlier sources in a multi-source
  graph. Verify the read happens after the source's own bodies are compiled, or
  the flag flips from over-reporting to under-reporting.
- **(B) Rename it.** `legacyBodyPredicted` / `legacyBodyAvailableAndUnskipped`,
  and update every consumer: `outcomeRoute` (`legacy-body-audit.ts:160-165`),
  `summarizeLane` (`scripts/check-ir-only.ts`), the `legacyBodyEmittedCeiling`
  baseline key, and the dashboard. Larger blast radius, no truthfulness gain for
  the R9 denominator.

**Recommendation: (A).** It is the smaller diff at the call site, and it makes
the flag mean what its name says — which is what "do not leave a flag whose name
and meaning disagree" asks for.

**File: `src/ir/module-init.ts`, `collectModuleInitPopulation` (`:9-28`)** — add
a skip for `ts.isModuleDeclaration(stmt)` **with a `declare` modifier only**: a
non-ambient `namespace N { … }` with executable content genuinely belongs in the
module-init population, and skipping it unconditionally would drop real work
from the ledger. `hasDeclareModifier` exists at `src/codegen/ast-modifiers.ts`,
but importing codegen from `src/ir/` is the wrong direction — prefer a local
`stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword)`.

This function is read by three callers (`planning-identity.ts:487`,
`identity.ts:11`, `select.ts:10594`) and by
`buildNonExecutableModuleInitOutcome` (`ir-overlay-outcomes.ts:711`). Changing it
moves `extern-demo.ts` from "module-init terminal with a phantom legacy body" to
"one truthful `non-executable` row" — which is the #3523 gap-4 shape and needs
its `nonExecutableFloor` accounted for. **Expect baseline movement here and say
so in the PR.**

**Path 2** gets its own change once instrumented. If it turns out to be another
population-membership defect, fix it in the same function; if it is a transform
artifact, fix it where the transform runs and note that
`collectModuleInitPopulation` was innocent.

**Do not touch** `functionBodyAccountingFailure` or the precedence block
(`:969-978`) — those are #5262's, and #5263 edits the same loop head.

### Tests — a pin per distinct phantom-producing path

Acceptance item 3 asks for one pin per path, each failing before the fix. Build
them from the two measured fixtures:

1. `extern-demo.ts` (or a minimal `declare namespace Host { }` plus one exported
   function): the module-init row must not claim a legacy body, and
   `irBodyRouteAudit.violations` must contain no `missing-legacy-entry-evidence`.
2. The path-2 fixture, once identified, with the same two assertions.
3. A **guard against over-correction**: a source whose module init *does* run
   (a top-level `const x = 1;`) must still report `legacyBodyEmitted: true` with
   a `compileModuleInitBody` root. Without this, setting the flag to `false`
   unconditionally would pass items 1 and 2.

Prefer asserting on `missing-legacy-entry-evidence` **count === 0** as the
headline check — it is the compiler's own detector, it already exists, and it is
immune to the filter error this issue was originally scoped around.

### Baselines and ratchets seeded from the flag (acceptance item 4)

`scripts/ir-only-baseline.json` carries `legacyBodyEmittedCeiling` per lane,
computed by `summarizeLane` in `scripts/check-ir-only.ts` from exactly this flag.
Measured today: the **single-host** lane's playground five produce **zero**
`legacyBodyEmitted` rows, so its `legacyBodyEmittedCeiling: 0` cannot be
inflated. The **standalone** lane's ceiling is `26` and I did **not** re-measure
it — the implementer must, before deciding whether a reseed is in scope. Also
check `nonExecutableFloor` (currently `3` single-host), which the
`collectModuleInitPopulation` change can move.

The R9 dogfood figures on #3518 (legacy-body 33 / 31 against direct-emission
7 / 8) were already corrected in place with a pointer here. **Correct them
again**: 33 and 31 are the honest `legacyBodyEmitted` counts, and 7 / 8 are the
honest direct-receipt counts — they are simply not comparable, because the
denominators are different populations. The number that answers "how much does
the direct front end still emit" is the **physical-root** count, which nobody is
currently reporting. Say that on #3518 rather than swapping one wrong ratio for
another.

### Ordering constraints

- **Land after #5262 + #5263.** All three edit `reconcileIrOverlayOutcomes`;
  this one edits `:878-879`, which sits inside the same loop whose head #5263
  changes and whose tail #5262 changes. Going last means one merge, not three.
- **#5282 is independent** (different file); no coordination needed.
- If (A) is chosen, the new `physicalRootUnitIds()` accessor lands in
  `legacy-body-audit.ts`, which none of the other three touch.

### PR grouping

**#5283 alone, third — after the #5262+#5263 PR merges.** Its `:878-879` edit is
inside the loop the other two restructure, and it is the only one of the four
that can move a committed baseline, so it deserves its own reviewable diff.

### Edge cases

- A source with **only** `declare namespace` and no executable statements must
  end up with exactly one `non-executable` row and zero module-init terminals —
  `buildNonExecutableModuleInitOutcome`'s conjunction (`:710-711`) requires
  both, and the doc comment above it explains why the disagreeing state records
  nothing at all.
- A **non-ambient** `namespace N { export const x = 1; }` must keep its
  module-init terminal. This is the case the narrow `declare`-only skip protects.
- Class static initialization: `identity.ts:878` also mints on
  `firstStaticInitialization`, independently of the population. Do not let the
  population change break that arm.
- Multi-source: the whole-program `__module_init` root carries no unit identity
  and is reported as `unresolved-legacy-entry` (#3523 gap 1). Option (A)'s
  physical-root set must not accidentally attribute it to a source — the
  existing guard at `legacy-body-audit.ts:437-443` shows the established shape;
  reuse it.

### Acceptance measurements

1. `missing-legacy-entry-evidence` count: **1 → 0** on `tests/dogfood/corpus`
   single-host, **1 → 0** on standalone, and **1 → 0** on
   `tests/fixtures/extern-demo.ts`. These are the honest before-numbers; use
   them, not 26 / 23.
2. `legacyBodyEmitted` counts after the fix: expect **32** single-host and
   **30** standalone on the dogfood corpus (33 − 1, 31 − 1) if only the two
   phantom rows change. A larger drop means the fix is over-correcting a
   population that really does emit legacy bodies — investigate before shipping.
3. `pnpm run check:ir-only` READY. Report any baseline key that moved and why;
   if `legacyBodyEmittedCeiling` or `nonExecutableFloor` changes, the reseed goes
   in this PR with a dated rationale in this file's frontmatter.
4. Three pins per the Tests section, each red before the fix. The over-correction
   guard (pin 3) is not optional.
5. `npm test -- tests/issue-3523-*` and `tests/issue-3519-ir-outcomes.test.ts`
   green.

---

## Landing record — 2026-09-03 (`ttraenkler/opus-5283`)

Base `origin/main 42a0adf7d4` (after PR #5530 reshaped `reconcileIrOverlayOutcomes`;
the plan's `:878-879` anchor is now `:898-899`). Shipped: **option (A), the
receipt**, in `src/codegen/ir-overlay-outcomes.ts` +
`src/codegen/legacy-body-audit.ts`. `src/ir/module-init.ts` is **unchanged** —
see "Deliberately not done" below, which is the one substantive departure from
the plan and it is measured.

### What changed

`legacyBodyEmitted` now requires a PHYSICAL direct-body root for the unit, on
top of the existing prediction:

```ts
bodyAccounting?.legacyBodyEmitted ??
  (unit.legacyBodyAvailable && !skippedBodyUnitIds.has(unit.unitId) && (physicalRootUnitIds?.has(unit.unitId) ?? true))
```

`physicalRootUnitIds` is a new accessor on `IrDirectFunctionBodyReceiptAudit`
(`legacy-body-audit.ts`), attributed from EXACT inventory identity, so the
multi-source whole-program `__module_init` (which resolves to no unit) is
attributed to nobody — the `snapshot()` `moduleInitRootSourceIds` shape, reused.
It rides the audit object the caller already passes, so `src/codegen/index.ts`
is untouched.

**The root is a NECESSARY condition, never a sufficient one.** The pure form the
plan sketched (`legacyBodyEmitted = physicalRootUnitIds.has(unitId)`) was
implemented, measured, and rejected: a root attributed to a unit can be the
dispatcher entering for a sibling obligation. Measured on a class with a static
block, `compileClassBodies` records a root against the implicit constructor
`Counter_new` while that constructor's own body is skipped and IR-patched — the
pure form reported compile-twice on a unit that compiled once (it turned
`tests/issue-3519-ir-outcomes.test.ts` red). Intersecting with the existing
skip-awareness means the change can only ever turn a `true` into a `false`.

### Measured — 34-case corpus (20 dogfood + 12 playground + `extern-demo.ts` + `add.ts`), both lanes

| metric | gc before → after | standalone before → after |
| --- | --- | --- |
| `legacyBodyEmitted` rows | 45 → **43** | 45 → **43** |
| `missing-legacy-entry-evidence` | 2 → **0** | 2 → **0** |
| rows claiming a legacy body with NO physical root | 2 → **0** | 2 → **0** |
| outcome rows total / `non-executable` | 105 / 12 (unchanged) | 105 / 15 (unchanged) |
| sha256 of the emitted binary, per row | 34/34 identical | 34/34 identical |

Dogfood-only subset reproduces the plan's acceptance numbers exactly: **33 → 32**
single-host and **31 → 30** standalone. Four outcome rows change in total (two
sources × two lanes); the `(prepareAttempts, directBodyEmissions, irBodyEmissions)`
triple, `kind`, `code` and `stage` are unchanged on every row in the corpus.

### Root cause of both phantom rows — one class of defect, two spellings

Instrumented `buildIrUnitInventory`'s scanned `ts.SourceFile` (temporary dump,
reverted), which is what the plan asked for and what a raw re-parse cannot show:

| source | scanned statements | module-init population |
| --- | --- | --- |
| `tests/fixtures/extern-demo.ts` | `[ModuleDeclaration, FunctionDeclaration ×3]` | `[ModuleDeclaration]` — `declare namespace Host` |
| `tests/dogfood/corpus/import-attributes.module.js` | `[VariableStatement, ExportDeclaration]` | `[VariableStatement]` — a SYNTHESIZED `declare const data: any;` |

Path 2 is not a different mechanism: the import resolver rewrites the JSON
import into an ambient `declare const`, which is why re-parsing the file's own
text shows an empty population while the compile still mints a terminal. **Both
are ambient declarations counted as executable module-init population.**

### Deliberately NOT done — the population fix, with the measurement that stopped it

Skipping ambient statements in `collectModuleInitPopulation` was implemented and
measured (both lanes, full corpus): it removed both phantom terminals, replaced
them with truthful `non-executable` rows (gap-4 shape), took corpus violations
to **zero of any code**, and moved zero bytes. It was **reverted anyway**,
because that population is also the **R1 inventory's SCAN list**:
`identity.ts:896` scans each population statement for nested declarations, and
the import resolver's wrappers arrive as
`declare namespace events { class EventEmitter { … } }`. With the skip,
`inventory.classes` silently lost both synthetic import-wrapper classes and two
`tests/issue-3520-*` pins went red
(`tags ambient import classes without inventing executable constructors`,
`orders transformed unitless import classes beside a member-backed nested class`).

Splitting "executable population" from "scan roots" belongs in
`src/ir/identity.ts`, which is outside this slice's file scope (W1-C).
**Follow-up, ready to brief:** give `identity.ts:878` an executable-population
predicate (ambient statements excluded) while `scanNode` keeps walking the full
population. Expected effect, already measured on this branch: two dogfood/fixture
module-init terminals become `non-executable` rows, `nonExecutable` 12 → 14 (gc)
and 15 → 17 (standalone), zero byte movement.

A second residual, found the same way and also out of scope: an
**anonymous default class** records no direct-body root at all (its only entry is
a `compileDeclarations` root with no unit identity), so its two class-member rows
move from `legacyBodyEmitted: true` + `missing-legacy-entry-evidence` ×2 to
`false` + `missing-terminal-evidence` ×2. Same violation count, honest label:
the audit stops asserting a body it cannot see. Attributing those roots is the
#3523 gap-1 unattributed-entry debt. `tests/issue-3519-ir-outcomes.test.ts` is
updated with this reasoning in place.

### Acceptance item 4 — baselines and ratchets

Nothing to reseed. `scripts/ir-only-baseline.json` carries
`legacyBodyEmittedCeiling: 0` for BOTH lanes today (the plan's "standalone is 26"
is stale — #4577 drove it to 0), and `pnpm run check:ir-only` reports the
identical lane summary before and after: 41 terminal units / 38 emitted / 0
unsupported / 0 invariants / **0 legacy body emitted** / 38 IR body emitted / 3
non-executable, verdict **READY**. `nonExecutableFloor: 3` is untouched because
the population change is not in this PR. No committed baseline or ratchet floor
was seeded from an inflated count.

### Correction owed to #3518 (acceptance item 4, second half)

The R9 dogfood figures 33 / 31 (legacy-body) against 7 / 8 (direct-emission)
are both honest and **not comparable** — different populations, as the plan
says. The honest post-fix `legacyBodyEmitted` counts are **32 / 30**, and the
number that actually answers "how much does the direct front end still emit" is
the **physical-root** count, which nobody reports yet.

### Pre-existing reds, unchanged by this PR (measured on base `42a0adf7d4`)

22 tests across `tests/issue-3520-*`, `tests/issue-3523-module-init-discovery-static`,
`tests/issue-3525-multi-prepared-module-init`, `tests/issue-4588-*` and
`tests/standalone-cutover-audit` fail identically with and without this change.
The failing-name set diff (base → branch) is **empty**.
