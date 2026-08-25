---
id: 4552
title: "Fable-lane architect review: the #3954 phase 2 dialect split was implemented by the Opus lane and has not been reviewed by its owning lane"
status: done
sprint: current
created: 2026-08-17
updated: 2026-08-21
completed: 2026-08-21
priority: high
horizon: s
feasibility: easy
model: fable
reasoning_effort: high
task_type: analysis
area: ir
language_feature: compiler-internals
goal: backend-agnostic-ir
parent: 3954
related: [1616, 2135, 2949, 3029, 3030, 3954, 4523, 4551]
# id 4552 was reserved via claim-issue.mjs --allocate --allow-unscanned on
# 2026-08-17 in the same batch as 4551/4553, originally for a second-language
# proof that was dropped as duplicating #3954 phase 3. Reused here rather than
# allocating a fresh id, so the reservation does not become a permanent hole in
# the sequence. 4553 remains reserved and unused. Open-PR scan at file-creation
# time (GitHub MCP, gh CLI absent in this container): 4639, 4643, 4644 — none
# adds an issue file.
---

# #4552 — Fable-lane review of work the Opus lane did in Lane B's territory

## Why this exists

**`backend-agnostic-ir` is Lane B's goal** (`plan/method/lane-partition.md`:
Lane B = fable / porffor / symphony owns `backend-agnostic-ir`,
`ir-full-coverage`, the Porffor backend, `value-rep-substrate`, the standalone
gap). **#3954 phase 2 was nonetheless implemented by the Opus lane** on
2026-08-17, at the project lead's direction, in
[PR #4644](https://github.com/loopdive/js2wasm/pull/4644).

That was a deliberate cross-lane action, not an accident of routing, and it is
recorded here rather than left implicit. The lane partition exists because
duplicated and unreviewed work in shared territory has cost this project real
sessions (#3310/#3311/#3341/#3308 were re-implemented by both lanes on
2026-07-17). A cross-lane implementation that nobody from the owning lane ever
reads gets the cost without the check.

The reviewer this needs is the one who did **not** write it.

## What to review

PR #4644 on `claude/js-ir-generalization-9v7m8j`. All CI green,
`mergeable_state: clean`.

**This review is POST-MERGE, by project-lead decision (2026-08-17).** The PR was
held as a draft to gate on this review; the lead's call was to mark it ready
once it was a working checkpoint, which it is: the slice is self-contained,
behaviour-neutral by construction, and depends on neither #4551 nor phase 1.
Holding a green, finished checkpoint out of `main` to wait on a review costs
merge-conflict risk and blocks nothing else, so the review moves after the
merge rather than in front of it.

That changes the outcome options, not the questions. Everything below still
needs an owner's verdict — the difference is that "reject" now means a
follow-up or revert PR rather than closing an unmerged draft.

### 1. The boundary rule (the load-bearing decision)

`src/ir/dialect/js.ts` holds 23 ECMAScript instruction kinds; `src/ir/nodes.ts`
keeps the neutral core and remains the single core→dialect edge (it assembles
the `IrInstr` union and re-exports every dialect name).
`scripts/check-ir-dialect.mjs` enforces exactly two rules, and is in `quality`.

Questions worth an owner's judgement:

- Is **one dialect file** right, or should the dialect be split by family
  (`dyn`, `iter`, `gen`, `async`, `extern`) from the start? Splitting later is
  cheap; the import surface is what would churn.
- The union stays in `nodes.ts`. MLIR would put the op registry with the
  dialect. Is the union-in-core choice the one this codebase wants long-term,
  or a convenience that will need undoing?
- Should the gate also assert the **converse** — that no dialect declaration
  is referenced from core except through the union? R1/R2 as written do not.

### 2. The placements

The 23 moved: `dyn.*` (5), `iter.*` + `forof.iter` (6), `gen.*` (4),
`await`/`async.*` (3), `extern.*` incl. RegExp (5).

These were chosen as the **uncontested** set. If any one of them is arguably
neutral, say so — it is much cheaper to move now than after importers settle.
`extern.*` is the likeliest disagreement: it is arguably a *host*-boundary
concern rather than a language one, which is the same argument that kept
`coerce.to_externref` in core.

### 3. Sequencing — phase 2 before phase 1

#3954 orders the `TagDomain` seam (phase 1) before the dialect split (phase 2).
That order was **inverted** on a cost-of-delay argument: phase 2 is
O(instruction kinds), `IrInstr` arms went 51 → 78 in the three months to
2026-08-01, and `ir-full-coverage` is expected to add ~40 more, whereas phase
1's surface (**58 `JsTag.` member reads in 7 files** — an earlier "24 files"
figure counted files merely *mentioning* the name, several of them
`src/checker/oracle.ts`'s unrelated same-named string union) is not growing the
same way. See #4551 for the series.

The reviewer owns whether that inversion is right. A specific risk to weigh:
phase 1 may want `box`/`unbox`/`tag.test` placed differently than a
dialect-first world assumes, and those three are currently sitting in core.

### 4. Two corrections in the record

Both are places where the Opus lane's first reading was wrong and was
corrected; confirm the corrections rather than the originals.

- `IrInstr` has **78** arms and has not drifted. An earlier draft of #4551
  claimed 82 (it counted terminators and declaration kinds). #3954's original
  figure was right.
- `BackendEmitter` does **not** leak ECMAScript: 3 of 54 methods are JS-shaped
  (`emitPromise*`). An earlier claim of 12 was wrong —
  `emitToExternref`/`emitFromExternref` are host-boundary, `emitVecSetLength`
  is an ordinary length write, and the string primitives are parameterized by
  `IrStringEncoding`. #3954's "the backend half is the already-neutral half"
  holds.

### 5. Also in scope now — #4551's gate and #3954 phase 1

**Scope widened 2026-08-19.** When this issue was filed it asked for a review of
the dialect split alone. Two further pieces of Lane B territory have since been
implemented by the Opus lane on the same branch, and they need the same owner's
verdict rather than a second review issue:

- **#4551's `scripts/check-ir-kind-neutrality.mjs`** + baseline, in `quality`.
  It pins the population at 82 (78 `IrInstr` arms + 4 `IrTerminator` arms, the
  3 symbolic-reference kinds excluded and the disputed 85 `readonly kind:`
  fields reconciled every run) and assigns every kind a `neutral`/`js`/
  `unresolved` verdict with a cited `{file, quote}` the gate re-verifies.
  Current: 53 / 26 / 3.

  The question for the reviewer is whether **evidence-cited verdicts in a
  committed baseline** are the right enforcement shape, or whether a verdict
  belongs in the type system (a marker on the declaration) where it cannot
  drift from the code at all. The gate's answer to drift is a citation check;
  that is weaker than a compiler error and stronger than a comment.

- **#3954 phase 1, the `TagDomain` seam** — `src/ir/tag-domain.ts` (zero
  imports), `src/ir/js-tag-domain.ts`, `src/ir/producer.ts`, and
  `scripts/check-jstag-seam.mjs` in `quality`. `IrType`'s dynamic leaf is now a
  **branded** `TagId`, so the core cannot name an ECMAScript partition.
  Measured 4 files / 4 value imports / 57 refs → 2 / 2 / 42; both survivors are
  deliberate (`from-ast.ts` is the JS producer, `integration.ts` emits
  `$AnyValue.tag` constants at the wasm boundary).

  Three judgement calls to confirm or overrule:
  1. `producer.ts` is a **pure lookup**, deliberately not a mutable
     module-level slot — a compilation unit names its producer rather than
     installing one globally. #3954's phase-1 text says "wire it at the single
     place the producer is chosen", which reads either way.
  2. The **instruction-level** `jsTag` fields (`unbox`, `tag.test`) and the
     `IrDynamicLowering` handle contract (`backend/handles.ts`, frozen by
     #3029-S1) still speak `JsTag`. `jsTagOf` / `tagIdOfJsTag` are the two
     explicit crossings. Widening the seam to the frozen backend contract was
     left as a separately-reviewable move — is that the right cut?
  3. The domain's ECMA-262 predicates (ToBoolean §7.1.2, ToNumber §7.1.4,
     `typeof` §13.5.3, Annex B §B.3.6) are **stated but not consumed** — phase 1
     forbids moving bytes, so nothing folds on them yet. They are therefore
     untested-by-use in production paths, only by the spec-transcription test.

### 6. The payload-vocabulary leak — a design call this review inherits

#4551's gate found a shape neither issue anticipated: `binary` and `intrinsic`
are **`unresolved`**, and no declaration move settles them. The interface is
neutral while the *payload enum* is ECMAScript-tainted — `IrBinop` carries six
`js.*` ToInt32 composites, `IntrinsicId` carries `math.*`. Both pass R1 and R2
of the dialect gate while being exactly the leak the gate exists to catch.

The unit of the fix is the **enum**, not the file, which makes it the same
question as (1) under "Two schema questions" below, one layer down. The
reviewer owns whether that is a dialect-tagged op namespace, a split enum with
the JS composites behind the dialect, or an accepted residual.

Separately, `string.len` is recorded `unresolved` on a genuine policy call —
code units or code points — that is a language decision, not a placement one.

## Outcome

One of:

- **Accept** → set this issue `done`. Nothing else to do; the code is already
  on `main`.
- **Accept with changes** → list them here; they land as a follow-up PR, on
  this branch name or one Lane B opens. Cheap while the dialect is one file
  and 23 kinds.
- **Reject the boundary or the sequencing** → say what should have landed
  first. The remedy is a revert PR (public `main` is append-only — fix
  forward, never rewrite), then re-plan under #3954's original phase order.
  The split is 23 declaration moves plus a gate, so a revert is mechanical.

The reviewer should also say whether the **schema** half is theirs or #3030's
(see "Two schema questions" below).

Also inherited: **#4551 is `status: blocked` on this same review.** It owns the
per-kind verdict for the families deliberately left in core (`vec.*`,
`class.*`, `object.*`, `string.*`, `box`/`unbox`/`tag.test`,
`forof.vec`/`forof.string`, `coerce.to_externref`). Unblocking or folding it
into #3954 is part of this review's outcome.

## Two schema questions with a clock on them

Surfaced while answering a follow-up on the MLIR shape; recorded here because
they expire in a way the in-tree questions do not.

`docs/ir/ir-module.schema.json` defines `instrKind` as a **closed enum of 60
entries, 19 of them JS ops**. An out-of-tree producer (#3954 phase 4, and
#3030's stated purpose) cannot emit an op outside that enum, so whether a
non-JS producer is possible at all is decided by the schema's namespace shape
— not by the in-tree union.

1. **Should `instrKind` become an open namespace?**
   `anyOf: [ {enum: [...60 known...]}, {type: "string", pattern:
   "^[a-z][a-z0-9]*\\.[a-z_][a-z0-9_]*$"} ]`. Known ops still validate against
   the enum, so docs and tooling keep the list; a foreign dialect can emit
   `py.getattr` without a spec revision. Op names are already `dialect.op`-shaped
   by convention, so only the closed-vs-open half is at stake.
2. **Should `IrInstr` gain an open arm in-tree?**
   `interface IrInstrForeign { kind: \`${string}.${string}\`; operands: IrValueId[] }`.
   **Measured, not assumed:** this KEEPS exhaustiveness over the closed arms —
   a new unhandled closed arm still fails to compile (`TS2322: Type
   'InstrForeign | InstrVecGet' is not assignable to type 'InstrForeign'`).
   The costs are elsewhere: a second, weaker instruction shape alongside the
   bespoke typed fields; a declared foreign behaviour in every pass (`effects.ts`
   conservative, `legality.ts` illegal-by-default); and #1924's re-derive
   guarantee weakening exactly where the op is least known.

Recommendation on the record, for the reviewer to accept or overrule: **do (1)
now, defer (2)**. (1) is one schema edit plus a version bump while consumer
count is plausibly zero — `IR_FORMAT_VERSION` is already at 5.1 with five bumps
behind it, and #3030 is still `status: ready`. (2) should wait for a producer
that actually needs it; the dialect split makes adding it later a contained
change rather than a refactor.

## Not in scope

Re-litigating #3954's four-phase design. The reviewer owns whether this slice
implements it faithfully and whether the phase inversion was sound — not
whether the tag-domain seam is the right idea.

## Fable-lane review (2026-08-21)

**Verdict: ACCEPT WITH CHANGES.** The split holds architecturally — boundaries
real, naming right, no reverse layering, gates honest and negative-tested by
this review. Two changes, neither blocking, listed at the end. No revert; the
code stays on `main`.

Verify-first re-audit on main @ `e4075140e` (the #4644 merge is `74600c112`
carrying slice 1 `22a4dbcab`; slice A / phase 1 / phase 3 / #4551's gate landed
via the #4649 merge `288d47ab2`). Every load-bearing figure below was
re-measured in this worktree, not read off the issue: `pnpm install
--frozen-lockfile`, then all three gates, typecheck, and targeted negative
tests.

### Verified sound (measured)

- **The boundary is real and singular.** `src/ir/dialect/js.ts` holds 26 kinds
  (23 slice-1 + 3 slice-A); a repo-wide grep finds exactly one `dialect/js`
  importer — `nodes.ts` (union assembly + `export type` block). All dialect
  imports are `import type`, so the core↔dialect cycle has no runtime edge;
  `pnpm run typecheck` (tsgo) exits 0.
- **Gate counters match the record exactly.** `check:ir-dialect`: OK, 26
  declarations re-exported. `check:ir-kind-neutrality`: OK — 82 population
  (78 `IrInstr` arms — independently counted 78 from the union — + 4
  terminators, 85 `readonly kind:` reconciled), verdicts 53/26/3, placement
  56 core / 26 dialect, `jsInCore` 0, move list empty. `check:jstag-seam`: OK,
  valueImports=1, refs=38, sole consumer `integration.ts`. All three are wired
  into the `quality` job (`ci.yml` ~L157–165), which is a required check.
- **The gates have teeth — negative-tested here, all four bite.** R1 (a
  dialect import added to `src/ir/verify.ts`) fails with file:line; R2 (the
  `IrInstrRegExpLiteral` re-export removed) fails naming the name; a mutated
  citation quote in `nodes.ts` fails `check:ir-kind-neutrality` with the
  rotted-evidence message; a `JsTag` value import + read added to
  `propagate.ts` fails `check:jstag-seam` per-file. All restored; tree clean.
- **Phase 1 / phase-3-follow-up state is as documented.** `nodes.ts` imports
  `js-tag.ts` not at all; `unbox`/`tag.test` carry `tagId?: TagId`;
  `verifyIrFunction(func, domain = defaultTagDomain())`; `emitUnbox(value,
  tagId: TagId)` answering from a builder-held domain. W2/W6 open exactly
  where stated: `lower.ts:1718/1777/1822` route through `jsTagOf`, and
  `backend/handles.ts:289–325` (`IrDynamicLowering`, frozen #3029-S1) is
  `JsTag`-typed member by member.
- **The two corrections in §4 are confirmed by measurement.** `IrInstr` has 78
  arms (counted). `BackendEmitter` (`src/ir/backend/emitter.ts`) has 52
  `emit*` methods of which exactly 3 are `emitPromise*`; "the backend half is
  the already-neutral half" holds.
- **The claimed pre-existing test failures reproduce on today's main**:
  `tests/ir-bytecode-proof.test.ts` (OP.CALL) and `tests/ir-scaffold.test.ts`
  (selector shape) — 2 failed / 28 passed, unrelated to this work.
- **Docs and spec-legibility ACs hold.** `docs/architecture/codegen-axes.md`
  has the producer-axis section + C++ non-goal; `js-tag-domain.ts` carries 32
  ECMA-262 clause citations.
- **The schema is still a closed 60-entry `instrKind` enum with 19 JS ops**
  (measured from `docs/ir/ir-module.schema.json`) — the "two schema questions"
  are still live, answered below.

### Defect (the one real finding)

- **D1 — `check-ir-dialect.mjs` R1 only scans `src/ir/`**
  (`scripts/check-ir-dialect.mjs:53`, `walk(IR_DIR)`). Demonstrated: adding
  `import type { IrInstrAwait } from "../ir/dialect/js.js"` to
  `src/codegen/peephole.ts` passes the gate (exit 0). So "only `nodes.ts`
  imports the dialect" is enforced inside the IR tree and merely true-by-luck
  outside it (repo-wide grep confirms zero violations today). Fix is a
  two-line scope widening: walk `src/` (minus `dialect/` itself), same rules.
  This also answers §1's converse-gate question — see below.

### Nits (recorded, no action required)

- `dialect/js.ts` imports six type names used only in doc prose (`irVal`,
  `IrInstrThrow`, `IrInstrWhileLoop`, `IrTerminatorReturn`, `IrType`,
  `IrFunction`). Lint accepts them; harmless, but they read as unused.
- `check-jstag-seam.mjs`'s `bindsOracleJsTag` exempts a whole file when it
  imports the oracle's same-named type; a file importing the oracle's `JsTag`
  aliased AND the real enum would go uncounted. No such file exists; edge case
  only.
- R1's regex is line-based `from "…"`; a dynamic `import("…dialect…")` would
  evade it. Moot while the dialect is type-only (nothing to import at
  runtime).

### The judgement calls the issue put to this review

1. **One dialect file vs split-by-family: one file, correctly.** At 26 kinds /
   700 lines a family split buys nothing. And the churn argument inverts: since
   every consumer imports via `nodes.js` re-exports, a later family split
   touches only `nodes.ts`'s import/re-export block — the import surface is
   exactly what does NOT churn. Split when a second dialect appears or the
   file stops being readable, not before.
2. **Union stays in core: correct for this codebase.** The closed discriminated
   union is what powers the repo's `never`-default exhaustiveness idiom
   (#1095's pattern); an MLIR-style registry-with-the-dialect only pays once
   `IrInstr` gains an open arm, which is deliberately deferred (schema Q2).
   Union-in-core is a choice, not a convenience to undo.
3. **Converse gate: not as phrased — fix D1 instead.** Core files *must*
   reference dialect kinds (verifiers and lowerers dispatch over the whole
   union); that is the union edge working as designed, not a violation. The
   enforceable converse is "no import path to the dialect except `nodes.ts`",
   which R1 already states and D1's scope widening completes.
4. **The 23 placements: confirmed, including `extern.*`.** The anticipated
   disagreement dissolves on the evidence: `coerce.to_externref` (a bare
   representation conversion) correctly stayed core as host-boundary, while
   `extern.new/call/prop` encode the JS host-class *protocol* (className
   registry, `$<class>_<method>` import surface) and `extern.regex` is an
   ECMAScript grammar form. The line is drawn where it belongs —
   representation neutral, protocol JS. If a generic FFI ever lands,
   re-neutralizing `extern.{new,call,prop}` is a cheap re-export move.
5. **Phase-2-before-phase-1 inversion: sound, and now outcome-confirmed.** The
   cost asymmetry was real (O(kinds), growing, vs 58 member reads in 7 files,
   static), and the named risk — that phase 1 might want `box`/`unbox`/
   `tag.test` placed differently — resolved the right way: all three came back
   *neutral*, stayed in core, and phase 3's follow-up made their fields
   domain-neutral (`tagId`) in place. Dialect-first misplaced nothing.
6. **#4551's enforcement shape (cited baseline vs type-system marker): the
   baseline is right.** A verdict's *evidence* is prose in doc comments — no
   type-level marker can carry it, and a marker drifts as silently as a
   comment while claiming more authority. The citation check demonstrably
   fails on rot (tested above), and the population-reconciliation rule pins
   the denominator. Accepted weakness, honestly stated in the gate: a quote
   can survive while its surroundings change meaning. The known cost that a
   declaration move must retarget its citations (slice-A lesson) is a feature.
7. **Phase 1's three calls: confirm all three.** (a) `producer.ts` as a pure
   lookup is right — a mutable module-level slot in a many-compilations
   process would let a stale domain reinterpret the next compile's tags; the
   pure form is also what made phase 3 testable. (b) Stopping the seam at the
   frozen #3029-S1 `IrDynamicLowering` contract was the right cut; after
   W4/W5/W3 the cut sits *exactly* on the frozen contract, which is where a
   separately-reviewed move should start. (c) Stated-but-unconsumed predicates
   are acceptable for a byte-neutral phase and are engine-cross-checked in the
   test; first consumer (a truthiness-folding pass) must read the domain, not
   re-derive.
8. **§6 payload-vocabulary leak: the enum is the unit; split it, don't open a
   namespace yet.** For `IrBinop`, move the six `js.*` ToInt32 composites
   (+ the `i64.rem_s` fast-path justification) into a dialect-owned opcode
   union — same declaration-move shape as the rest of phase 2, no open
   namespace needed in-tree. For `intrinsic`, settle the vocabulary question
   as the gate proposes: declare `math.*` IEEE/libm (neutral) and give
   `math.pow` an ECMAScript sibling only if the lowering actually honors
   §21.3.2.26's edge cases — measure before splitting. `string.len`: read
   `js` as ECMAScript-SPECIFIC — it stays core with its documented UTF-16
   code-unit commitment (shared with the whole UTF-16 family, hence not
   dialect material); the `utf16-string` family dialect is the answer only
   when a second UTF-16 language exists.

### The two schema questions

- **Q1 (open `instrKind` namespace): yes, do it now — and it is #3030's, in
  Lane B.** One `anyOf: [enum, "^[a-z][a-z0-9]*\\.[a-z_][a-z0-9_]*$"]` edit
  plus an `IR_FORMAT_VERSION` bump, while consumer count is plausibly zero.
  It expires: it stops being cheap the day anything consumes 5.x. Not in this
  PR (docs-only); it is a schema-contract change and belongs with the
  serialized-contract owner.
- **Q2 (open `IrInstr` arm in-tree): defer, per the recommendation.** The
  measured exhaustiveness-preservation is nice but the costs (a second weaker
  instruction shape, declared foreign behaviour in every pass, #1924
  re-derive weakening) buy nothing until a producer exists. Revisit when one
  does.

### #4551

Already `status: done` on main (2026-08-19) — the "#4551 is `status: blocked`"
line above is stale as of that date. Its verdicts are hereby confirmed by the
owning lane (spot-checked `vec.*`, `class.*`, `extern.*`, `binary`,
`intrinsic`, `string.len`, `coerce.to_externref` against the code and the
evidence quotes); nothing to unblock, nothing to fold.

### Changes accepted with (follow-up PR, Lane B; not this docs-only PR)

1. **C1 (defect D1):** widen `check-ir-dialect.mjs` R1's walk from `src/ir/`
   to `src/` (excluding `dialect/` itself), so a `src/codegen/` import of the
   dialect fails the gate instead of passing silently.
2. **C2 (schema Q1):** open the `instrKind` namespace in
   `docs/ir/ir-module.schema.json` + version bump, under #3030.

**C1 done in PR #4708** (2026-08-21) — R1 now walks all of `src/` with resolution-based matching; `tests/issue-4552-ir-dialect-gate-scope.test.ts` proves the gate fails on the demonstrated `src/codegen/peephole.ts` import (5 of its 8 tests fail against the pre-fix script). C2 remains open.
