---
id: 3341
title: "STRICT_IR_REASONS hardening — per-reason (NOT a corpus-zero flip); doc-correction shipped, real per-reason work remains"
status: done
completed: 2026-08-15
sprint: 78
created: 2026-07-17
assignee: ttraenkler/opus-dev
priority: medium
feasibility: hard
model: fable
horizon: m
task_type: feature
area: codegen
language_feature: compiler-internals
goal: compiler-architecture
related: [2855, 2856, 2857, 2858, 2859, 2950]
origin: "carved out of #2855's umbrella scope per the 2026-07-17 IR audit (plan/log/analysis-2026-07/01-ir-audit-2026-07-17.md §2) — the promotion half of #2855's AC has not started even though the underlying buckets are already zero"
loc-budget-allow:
  # (#3341) +15-line rationale comment at STRICT_IR_REASONS documenting the
  # necessary-but-not-sufficient corpus-zero condition (build-safety guardrail).
  # Slice C adds STRICT_IR_POSTCLAIM_CODES + isStrictIrPostClaimFailure with the
  # four-criterion promotion bar and the never-promote citations inline; the
  # comment IS the guardrail that stopped three unsafe promotions here.
  - src/codegen/index.ts
---

# #3341 — STRICT_IR_REASONS hardening (per-reason)

> **RE-SCOPED 2026-07-17 (opus-c, confirmed by tech lead).** The original
> premise — "the buckets are already zero, so promoting the reasons into
> `STRICT_IR_REASONS` is the cheapest unstarted hardening step" — is **UNSAFE**
> and has been corrected. Bucket-zero in `scripts/ir-fallback-baseline.json` is
> measured against the **13-file playground corpus only**; corpus-zero does
> **not** mean the reason is unreachable on real code. `external-call`,
> `call-graph-closure`, `param/return-type-not-resolvable`,
> `type-resolution-failure`, `class-method`, and the destructuring-param buckets
> all describe **legitimate IR-non-claimability** (an external dependency, an
> unclaimable callee, an unresolvable type, a computed/generator/abstract method
> name) that the legacy path must still catch. Adding any of them to
> `STRICT_IR_REASONS` would turn those legitimate fallbacks into **hard compile
> errors** and regress real programs — an unvalidatable-locally, broad-blast
> change. `ir-adoption.md`'s `class-method` row already documented exactly this
> ("corpus bucket 0 … NOT yet strict"); the same logic applies to every other
> corpus-zero reason.
>
> **What shipped (the doc-correction portion, DONE):**
>
> - Fixed the stale `src/codegen/index.ts:889–896` citations (actual demote
>   sites are `~1889` for a selector-claimed unresolvable-types fallback and
>   `~2390` for an IR-build throw) in `scripts/gen-ir-adoption.mjs` (→ regenerated
>   `plan/log/ir-adoption.md`) and `docs/architecture/codegen-axes.md`.
> - Added a code-comment at `STRICT_IR_REASONS` (`src/codegen/index.ts`)
>   explaining the necessary-but-not-sufficient condition, so no future dev
>   naively flips a corpus-zero reason and reddens the build.
> - Documented the per-reason (not corpus-flip) promotion rule in
>   `codegen-axes.md`'s escape-hatch section.
>
> **What remains OPEN (this issue stays `ready`):** the _actual_ per-reason
> hardening — pick ONE reason, do the real #2855-family IR-adoption work to make
> that construct genuinely unreachable in the IR (IR always claims+lowers it, so
> a rejection IS a bug), THEN add it to `STRICT_IR_REASONS` and validate on full
> CI. That is `feasibility: hard`, not a doc flip. The stale `lower.ts`
> "not yet moved" claim in `codegen-axes.md` (aggregate/closure/ref-coercion
> groups) was NOT touched here — it needs a `lower.ts` audit to confirm before
> editing; folded into the remaining work.

## Slice A — spec correction: DO NOT CLAIM as written (dev-h, 2026-07-17)

**The arch Implementation Plan's Slice A (in #3244) is UNREACHABLE against the
current code — claiming it would add a dead reason + a vacuous strict entry.**

Slice A proposes peeling a `param-type-internal-desync` reason off
`param-type-not-resolvable` for the case "the param has an explicit primitive /
known-class annotation yet `resolveParamType` returned `null`." **That state
cannot occur.** `resolveParamType` (`src/ir/select.ts:1159–1207`):

- returns a concrete kind for **every** primitive keyword —
  `number → "f64"` (:1161), `boolean → "bool"` (:1162), `string → "string"`
  (:1163), `any → "dynamic"` (:1173) — never `null`;
- returns `"object"` for **every** class/interface `TypeReferenceNode`,
  `TypeLiteralNode`, and `ArrayTypeNode` (:1192) — never `null`.

The only `null` returns with an annotation present are **legitimate
rejections**, not desyncs: an inexpressible function-type/closure signature
(:1178–1179) and genuinely non-lowerable type nodes (unions, tuple, literal,
conditional, keyof, …, the fall-through :1193). Promoting any of those to a
hard error would regress real programs. So there is **no safe, non-vacuous
per-reason peel at these `select.ts` sites** — the reason is entirely
legitimate here.

**Where a real invariant DOES live (needs re-spec, > M):** the genuine
"selector-claimed-but-can't-lower" desync is at the **`resolvePositionType`
layer** (`src/codegen/index.ts`) — `resolveParamType` says `"object"`
(claimable) but `objectIrTypeFromTsType` / `resolvePositionType` then fails to
materialize the `IrType`. Peeling _that_ into a strict reason requires tracing
the select→codegen handoff (the override-map placeholder path), which is a
larger analysis than the current M sizing. **Slice A needs re-spec before any
dev claims it.** (Slice B — the `STRICT_IR_BUILD_ERRORS` name-repoint-invariant
promotion — shipped independently in PR #3249 and is unaffected by this.)

## Original problem (premise now corrected — see re-scope note above)

## Problem

`STRICT_IR_REASONS` (`src/codegen/index.ts:1511`) is still the empty set.
Per `docs/architecture/codegen-axes.md` and CLAUDE.md's IR Fallback Budget
section, once an "unintended" fallback bucket hits zero on the corpus, its
reason is supposed to be promoted into `STRICT_IR_REASONS` — turning any
_future_ regression of that reason from a silently-demoted legacy fallback
into a hard compile error. Nobody has done this promotion, even though the
following reasons are already at zero on the `scripts/ir-fallback-baseline.json`
corpus as of 2026-07-17 (verified via `pnpm run check:ir-fallbacks -- --verbose`):

- `call-graph-closure` (#2858, done)
- `class-method` (#2857 + #3000 B/C/E, done)
- `param-type-not-resolvable` (#2859, done)
- `external-call`, `param-shape-rejected`, `destructuring-param-complex`,
  `return-type-not-resolvable`, `type-resolution-failure` — already absent
  from the baseline's `unintended` section.

This is the single cheapest, already-unblocked hardening step available in
the #2855 umbrella — no new codegen work needed, just closing the loop on
work already done.

**Note**: `body-shape-rejected` (still 14, #2856 in-progress) and
`async-function`/`type-parameters`/`non-export-modifier`/`unnamed` (deferred
category) are NOT in scope here — only the reasons already at zero.

## Task

1. Move the reasons listed above from the demote-to-warning channel into
   `STRICT_IR_REASONS` (`src/codegen/index.ts:1511`).
2. **Caveat that must be handled, not skipped** (per the audit): baseline
   zero is measured against the 13-file playground corpus only. A reason
   can be zero-on-corpus but still legitimately fire on real user code —
   promoting it to a hard error is only safe if firing it SHOULD actually be
   an error (i.e. the fallback reason represents a case the IR is now
   expected to always handle), not just "we happen not to have a test for
   it." Check `plan/log/ir-adoption.md`'s per-reason notes (the class-method
   row already flags this exact distinction: "corpus bucket 0 … NOT yet
   strict") before promoting each reason — promote only the ones where
   zero-on-corpus genuinely means "should never happen," and leave the rest
   demoted with a note explaining why.
3. Run the full existing test suite + `pnpm run check:ir-fallbacks` to
   confirm no live corpus code trips a newly-strict reason (if it does,
   that's real signal the promotion was premature for that reason — back it
   out, don't suppress).
4. Fix the two stale demote-channel line-number citations found by the
   audit while you're in this code (`plan/log/ir-adoption.md` still says
   `index.ts:889-896`; actual location is ~1891/2390 as of 2026-07-17) and
   in `docs/architecture/codegen-axes.md` (same stale citation, plus a
   stale "not yet moved" claim about the aggregate/closure/ref-coercion
   groups in `lower.ts` — see #2855's audit-note for detail).

## Acceptance criteria

- Every reason promoted is justified in the commit/PR body with the
  corpus-vs-strict reasoning, not just "it was zero so I promoted it."
- Full test suite green; `check:ir-fallbacks` gate green.
- Stale line-number citations in `ir-adoption.md` and `codegen-axes.md`
  corrected.
- `plan/issues/2855-ir-frontend-migration-ratchet-buckets-to-zero.md` updated
  to reflect this slice as done against its own AC (don't close #2855 itself —
  `body-shape-rejected` remains open via #2856).

## Implementation Plan (arch, 2026-07-17)

### The core problem this plan solves

The re-scope note is correct: a raw `IrFallbackReason` (e.g.
`param-type-not-resolvable`) fires at **several** sites in `select.ts`, some
of which are **legitimate IR-non-claimability** (a genuinely unannotated /
dynamic param the IR cannot yet lower) and some of which are **internal
invariant violations** (the selector had everything it needed and STILL
failed to resolve — a bug). Promoting the whole reason to a hard error would
red the build on the legitimate cases. **The tractable move is therefore a
REASON SPLIT: peel the "should-never-happen" sub-case off into its OWN reason
and promote only that.** This gives a real, mergeable, low-blast-radius first
promotion that satisfies #2855's AC without an open-ended "make every param
type resolvable" project.

Two independent, separately-claimable promotion vectors exist. Slice A (the
selector-reason split) is the one the issue text asks for; Slice B (the
build-error vector) is an orthogonal, even-lower-risk promotion that is
already wired and unused. Do them as separate PRs.

### Current mechanism (anchors)

- **`STRICT_IR_REASONS`** — `src/codegen/index.ts:1511` (empty set +
  the #3341 rationale comment at `:1512–1532`).
- **Promotion loop** — `src/codegen/index.ts:1831–1840`: iterates
  `selection.fallbacks`, and for any `fb.reason ∈ STRICT_IR_REASONS`
  calls `reportErrorNoNode(...)` (hard compile error). `trackFallbacks`
  auto-enables when the set is non-empty (`:1796`).
- **`STRICT_IR_BUILD_ERRORS`** — `src/codegen/index.ts:1534` (empty array);
  `isStrictIrBuildError` (`:1542`) substring-matches the per-function
  `compileIrPathFunctions` build-error message; `formatIrPathFallbackDiagnostic`
  (`:1562`) promotes a match from `severity:"warning"` to `"error"`.
- **Reason emission** — `src/ir/select.ts`: the `IrFallbackReason` union at
  `:70–105`; `param-type-not-resolvable` is returned at `:929`(return),
  `:961`/`:965`(binding-pattern param), `:979`/`:981`(identifier param),
  `:1065`/`:1068`(generator). `resolveParamType` / `resolveReturnType` are the
  resolvers whose `null` return drives these.

### Slice A (M) — split `param-type-not-resolvable`, promote the invariant half

**Root cause of the split.** At `select.ts:979`,
`if (paramResolved === null) return "param-type-not-resolvable"`.
`resolveParamType(p, mapped)` returns `null` when NEITHER the AST annotation
NOR the propagated TypeMap entry yields a concrete primitive. There are two
disjoint worlds inside that one `null`:

1. **Legitimate** — the param has **no** explicit primitive TS annotation and
   the TypeMap could not infer one (genuinely dynamic/unknown). The IR cannot
   yet lower this; the legacy fallback MUST still catch it. → keep reason
   `param-type-not-resolvable`.
2. **Invariant violation** — the param **has** an explicit primitive
   annotation (`n: number` / `s: string` / `b: boolean` / a class type the
   `classShapes` registry knows) yet `resolveParamType` returned `null`. The
   resolver should never fail here; a `null` means a resolver bug, not an
   unlowerable program. → new reason `param-type-internal-desync`, which is
   **genuinely unreachable on correct code** and therefore safe in
   `STRICT_IR_REASONS`.

**Changes:**

**File: `src/ir/select.ts`**

- Add `| "param-type-internal-desync"` to the `IrFallbackReason` union
  (`:70–105`).
- At each `param-type-not-resolvable` param site (`:961`, `:965`, `:979`,
  and the generator sites `:1065/:1068` if they carry an explicit annotation),
  before returning the legitimate reason, check whether the param carries an
  explicit primitive/class annotation (`p.type` present AND
  `resolvePositionType(p.type)` yields a concrete `IrType`). If it does yet
  `resolveParamType` returned `null`, return `param-type-internal-desync`
  instead. Factor this into a small helper
  `paramNullReason(p, mapped): "param-type-not-resolvable" | "param-type-internal-desync"`
  so the classification lives in one place.
- Do the analogous split for the return position (`:929`) only if a
  concrete return annotation is present → a follow-up; keep Slice A to params
  to bound the blast radius.

**File: `src/codegen/index.ts`**

- Add `"param-type-internal-desync"` to `STRICT_IR_REASONS` (`:1511`) and
  document why (annotation-present-but-null-resolve is a resolver bug, not an
  unlowerable construct — the exact "genuinely unreachable" bar the `:1512`
  comment sets).

**File: `plan/log/ir-adoption.md`** (regenerate via `pnpm run gen:ir-adoption`
after editing `scripts/gen-ir-adoption.mjs`) — add the new `BUCKETS` row
`param-type-internal-desync` (category `unintended`, note "strict — invariant
violation, must be zero"). The generator cross-checks the union in
`select.ts`, so this edit is REQUIRED or the `quality` gate fails.

**Guardrails / edge cases:**

- The new reason must NOT appear in `scripts/ir-fallback-baseline.json` (it is
  strict, not budgeted). If `check:ir-fallbacks` reports it on the 13-file
  corpus, that is a REAL resolver bug surfaced by the split — fix the resolver,
  do not suppress.
- Because `STRICT_IR_REASONS` becoming non-empty flips `trackFallbacks` on for
  every compile (`:1796`), Slice A has a global reach — validate on **full CI /
  merge_group**, not just local (per `project_broad_impact_validate_full_ci`).
  A `trackFallbacks: true` run collects fallbacks it previously skipped; confirm
  no other reason's collection path has a side effect (it shouldn't — collection
  is pure).
- Do not promote `param-type-not-resolvable` itself, `external-call`,
  `call-graph-closure`, `class-method`, or the destructuring buckets — all
  describe legitimate non-claimability (the `:1512–1527` comment enumerates
  why).

### Slice B (S) — activate the `STRICT_IR_BUILD_ERRORS` vector (orthogonal, lower risk)

This vector promotes a **post-claim IR-BUILD throw** (the selector already
said "I can lower this," then `compileIrPathFunctions` threw) — which is
**always a bug** by construction, so it is the safest possible promotion and
needs no split.

**File: `src/codegen/index.ts`**

- Pick ONE build-error class that is known-permanently-fixed and add its
  message substring to `STRICT_IR_BUILD_ERRORS` (`:1534`). Candidate strings
  are already sketched in the comment (`:1537–1539`), e.g.
  `"class-method typeIdx parity mismatch"` — but the dev must first grep
  `compileIrPathFunctions` (and the IR builder in `src/ir/`) for a throw whose
  message is stable and whose underlying cause is closed, then confirm the
  corpus never trips it (`JS2WASM_LOG_IR_FALLBACKS=1 pnpm run check:ir-fallbacks
-- --verbose` shows the build-error channel).
- `isStrictIrBuildError` + `formatIrPathFallbackDiagnostic` already do the
  promotion; no wiring change needed — this slice is purely "add one vetted
  substring + a test."

**Test:** a fixture that would previously demote-to-warning on that build
error now hard-errors; assert `compile()` surfaces `severity:"error"`.

**Slice B — done (dev-h, 2026-07-17).** Activated the
`STRICT_IR_BUILD_ERRORS` promotion vector. Promoted the IR name-repoint
**invariant** class — the three `ir/integration: unknown {function,global,type}
ref` throws (`src/ir/integration.ts:1647/1651/1656`) — from a silent legacy
demotion (`severity:"warning"`) to a hard compile error (`severity:"error"`).
Rationale: when the selector CLAIMS a function, the IR builder emits refs by
name to entities it created; a resolve miss is a builder↔finalize desync bug
(late-funcidx name-repoint family), never an unlowerable program. Promotion
can therefore only fire on a compiler regression — a strict no-op on all
valid code (the 13-file corpus reports zero of these; `check:ir-fallbacks
--verbose` confirmed corpus-clean, "Post-claim demotions … (none)").
Changes: `src/codegen/index.ts` (three substrings added to
`STRICT_IR_BUILD_ERRORS`, was empty, with rationale comment);
`tests/issue-3341-slice-b.test.ts` (asserts `formatIrPathFallbackDiagnostic`
promotes each invariant message to `severity:"error"` and still demotes an
ordinary non-strict build error to `warning`, mirroring the
`tests/issue-1850.test.ts` seam-level test pattern). The `#1923`
injected-build-throw seam is deliberately NOT promoted (it drives the
demotion-metering test; promoting it would break that path). **Remaining:**
Slice A and Slice C — issue stays `in-progress` until the headline
per-reason promotion (Slice A) lands.

### Slice C (S) — doc/citation reconciliation (can fold into A or B)

- The `## Task` item 4 stale-citation fixes were partly shipped by the
  #3214/#3221 doc-correction PRs; re-verify `plan/log/ir-adoption.md` and
  `docs/architecture/codegen-axes.md` cite the ACTUAL demote sites
  (`index.ts:~1889` selector-claimed unresolvable-types fallback and `~2390`
  IR-build throw — confirm against current HEAD, they drift) and the
  `lower.ts` "not yet moved" claim reflects #2953's aggregate/closure/
  ref-coercion move.
- Update `plan/issues/2855-ir-frontend-migration-ratchet-buckets-to-zero.md`
  to mark the promoted reason done against its AC (do NOT close #2855 —
  `body-shape-rejected` stays open via #2856).

### Test strategy

- `pnpm run check:ir-fallbacks -- --verbose` (per-file rejection breakdown) —
  confirm the newly-strict reason is absent on the corpus.
- Full equivalence suite (`npm test -- tests/equivalence.test.ts`) — a strict
  reason that fires on real code fails the build; that is the signal the
  promotion was premature. Back it out, do not suppress.
- **Full CI / merge_group** for Slice A (global `trackFallbacks` flip).

### Horizon / slice breakdown

- **Slice A (M)** — split `param-type-not-resolvable` → promote
  `param-type-internal-desync`. Dev-claimable now; the concrete "first
  per-reason promotion" the issue asks for.
- **Slice B (S)** — activate `STRICT_IR_BUILD_ERRORS` with one vetted build-error
  substring. **Done (dev-h, 2026-07-17)** — see completion note above.
- **Slice C (S)** — doc/citation reconciliation + #2855 AC update. Fold into A/B.

All three are ≤M and independently claimable. Recommended order: B (lowest
risk, proves the promotion lifecycle end-to-end) → A (the headline per-reason
split) → C alongside.

## Review (Fable, 2026-07-24)

Status check on main @ `7652f0337`: `STRICT_IR_REASONS`
(`src/codegen/index.ts:1492`) is still an **empty set** — no selector-
rejection reason has ever been promoted, and the in-code comment now
documents this issue's necessary-but-not-sufficient rule. The re-scope is
validated by history, not just argument: the Slice-B strictness that DID
land (branch `issue-3341-strict-ir-buildorerrors`, merged in GitHub PR
#3249, 2026-07-17 — `STRICT_IR_BUILD_ERRORS` for the name-repoint
invariant) over-promoted and had to be narrowed twice: `8b7547a1d`
(fix(#680): restore standalone generators — "narrow #3341/#3519 STRICT-IR
over-promotion") and `b6d1da941`/`4f703c939` (fix(#3565): restore 3+1
designed demote-to-legacy contracts). Any future per-reason promotion must
carry standalone/generator-lane regression evidence, not corpus-zero.
Recommend keeping this parked until after R2 (#3521), when
prepare-before-emit makes per-reason unreachability provable. Note for
auditors: bare `#3341` in merge subjects matches an unrelated GitHub PR
number — use branch names / `fix(#3341):` scopes.

## Slice C re-spec — strict POST-CLAIM stages, not selector reasons (fable, 2026-08-15)

Slice A is dead as specced (see the dev-h note above: no non-vacuous peel
exists at the `select.ts` sites). The safe promotion vector is one layer
down, and it is already structured and already corpus-zero:

**Mechanism (verified on main @ 7add6938):** a claimed unit that fails
AFTER claim goes through `recordIrOverlayPreparationFailure` /
`irPostClaimErrors` with a structured `stage` (`resolve` | `build` |
`verify` | `lower` | `backend-legality`) and `code` (e.g.
`type-resolution-unsupported` at `src/codegen/index.ts` ~2685). The
fallback gate baselines these per-stage in
`scripts/ir-fallback-baseline.json` `postClaim` — **all buckets empty
today and gated must-not-increase**. So "claim is a commitment" is
already measured; what's missing is turning a regression from a
warning-demote into a hard error.

**What must stay demotable (the legitimacy allowlist):**

1. The **four #3565-documented demote-to-legacy contracts** (element-store,
   element-access slice-12, verify #1798 return gate, compound-assign
   non-f64 RHS) — deliberately restored design decisions, never strict.
2. **`resolve`-stage `type-resolution-unsupported`** — the #1921 contract:
   a class-typed cross-function return the IR can't yet represent is a
   legitimate capability gap, and hard-failing it regresses real programs
   (the code comment at the catch site documents this).

**The promotable set:** per-CODE (not per-stage) strictness for
`build`/`verify`/`lower`/`backend-legality` codes that are (a) zero on
the corpus baseline, (b) zero on a test262-scale stride sweep (production
`compile()` with telemetry, stride ≤ 40 — reuse the #2949 slice-2
`.tmp/claim-sweep.mts` pattern), and (c) documented in
`plan/log/ir-adoption.md` as "IR must always handle" rather than
"capability gap". Introduce `STRICT_IR_POSTCLAIM_CODES` alongside the
(still-empty, still-correctly-empty) `STRICT_IR_REASONS`; a matching
post-claim failure calls `reportErrorNoNode(..., "error")` instead of the
warning demote.

**Why this satisfies the issue:** it is the first promotion where
zero-on-corpus genuinely means should-never-happen — the demote channel's
own comments distinguish invariant regressions from capability gaps, and
the #2138 IR-first skip contract ALREADY hard-errors the same class when
the skip set is live, so strictness here aligns the default path with the
flip-target semantics instead of inventing a new policy.

**Acceptance (Slice C):** `STRICT_IR_POSTCLAIM_CODES` non-empty; the
sweep evidence (per-code counts, corpus + test262 stride) recorded in
this issue; #3565's four contracts + `type-resolution-unsupported`
explicitly excluded with citations; full CI green; a synthetic
regression test proving a strict code hard-fails (inject a failure via a
test-only hook or a crafted shape, not by weakening production code).

**Blocked until:** the 2026-08-15 four-stream wave (#2951 generators,
#2952 slice 6, #3583 adoptions, #3518 standalone lane) merges — each
widens the claim surface and could add legitimate post-claim codes; run
the sweep AFTER they land. Queue position: first backfill after the wave.

## Slice C — DONE (2026-08-15, opus lane, branch `claude/ir-3341-strict-postclaim`)

Implemented on top of the four-stream wave branch
(`claude/ir-path-migration-kaqtxs` @ `61abc584`), i.e. the sweep below
measures the POST-wave claim surface as the re-spec requires.

### What shipped

- **`STRICT_IR_POSTCLAIM_CODES`** (`src/codegen/index.ts`, next to the
  still-empty and still-correctly-empty `STRICT_IR_REASONS`) plus
  `isStrictIrPostClaimStage` / the exported `isStrictIrPostClaimFailure`
  predicate. `formatIrPathFallbackDiagnostic` now hard-errors a matching
  post-claim failure instead of demoting it to `severity: "warning"`.
- **Stage scope** = `build` / `verify` / `lower` / `backend-legality` — exactly
  the four `postClaim` baseline buckets. `select` is pre-claim (that is
  `STRICT_IR_REASONS`' territory); **`resolve` is excluded structurally**, which
  is how the #1921 `type-resolution-unsupported` contract is excluded — by
  stage, not by an easily-lost per-code entry. `abi-signature-parity`,
  `late-preparation-unsupported` and `new-target-threading` fall out with it.
- **Promoted set (one code): `class-member-unsupported`.**
  Its ONLY post-claim site (`src/ir/integration.ts`, the `isCtorMember` arm)
  demotes when `collectIrClassInstanceInitializers(...)` returns `undefined`
  (a dynamically computed instance-field name). The **selector calls that exact
  helper first** — `constructorFieldInitializersAreIrSafe` in `src/ir/select.ts`,
  reached from both the explicit-constructor gate and the implicit-constructor
  gate — and refuses the claim on the same `undefined`. One predicate, two call
  sites, same argument: a *claimed* constructor member cannot legitimately reach
  the build arm, so reaching it means the selector gate drifted or was bypassed.
  This is the first promotion where corpus-zero genuinely means
  should-never-happen, rather than "we have no test for it".
- **Documentation (criterion c)**: a new **Post-claim codes** table in
  `plan/log/ir-adoption.md`, classifying every `IrUnsupportedCode` with a live
  post-claim site as `strict` or `capability gap` with the reason. The generator
  (`scripts/gen-ir-adoption.mjs`) now **cross-checks its `strict` rows against
  `STRICT_IR_POSTCLAIM_CODES`** and fails the `quality` job if they diverge, so
  the documentation cannot drift away from the set that actually hard-errors.
- **Test**: `tests/issue-3341-strict-postclaim.test.ts` (7 cases) at the same
  narrow typed seam as the Slice B test. The negative cases are the load-bearing
  half — they pin the four #3565 contracts, the #1921 resolve contract, the
  #3784/#4035 members of the same class, the two sweep-nonzero codes, and the
  #680 target-omitted-host-import narrowing as still-demotable.

### Sweep evidence (the (a)/(b) criteria)

**Corpus** — `pnpm run check:ir-fallbacks` on this branch, before and after:
`Post-claim demotions (gated; must not increase): (none)` — every `postClaim`
bucket empty, unchanged by this PR.

**test262 stride-40** — production `compile()` with `trackIrOutcomes: true`
over `test262/test`, stride 40 (every 40th file), run as 8 shards:
**1340 files swept, 1340 compiled, 0 harness throws, 20 IR units emitted.**

Post-claim rows (stage ≠ `select`) across all 1340 files — **three, total**:

| count | outcome | verdict |
| ----- | ------- | ------- |
| 1 | `unsupported` / `build` / `module-init-legacy-coupling` | NOT promoted — designed legacy-coupling withdrawal, and non-zero |
| 1 | `unsupported` / `resolve` / `abi-signature-parity` | NOT promoted — `resolve` is out of scope by design |
| 1 | `invariant` / `build` / `unexpected-internal-throw` | already a hard error pre-#3341-C; unchanged |

`class-member-unsupported` measured **154 at `select`** (the claim gate working
as designed) and **0 at any post-claim stage** — non-vacuous vocabulary, zero
post-claim occurrences.

### Codes deliberately NOT promoted, with citations

- The four #3565 restored contracts: `element-store-unsupported`,
  `element-access-unsupported`, `return-type-legacy-coupling`,
  `compound-assign-unsupported`.
- `type-resolution-unsupported` @ `resolve` — the #1921 contract (excluded by
  stage scope).
- `unboxed-number-local-unprovable` (#3784), `throw-value-unsupported` and
  `unknown-class-construction` (#4035) — the same class, found later.
- `body-shape-rejected` @ `build` — one of its two post-claim arms fires when
  `dynamicForInPlan` is absent, which is REAL on the **linear** backend (its
  resolver does not supply that plan). Sweep-zero would have hidden this;
  reading the sites did not.
- `array-representation-unsupported` — three arms mirror the selector's
  holey-Array gate exactly, but the fourth (widening/heterogeneous sink) is a
  deliberate demote to the safe boxed lowering.
- `constructor-arity-unsupported` @ `build` — `new Number()` / `new Boolean()`
  reach it and there is no selector arity gate for primitive wrappers.
- Every remaining capability gap (`method-call-unsupported`,
  `operand-coercion-unsupported`, `nullish-value-unsupported`,
  `property-write-unsupported`, `string-evidence-unsupported`,
  `void-call-expression`, `imported-call-planning-unsupported`) — see the new
  table in `plan/log/ir-adoption.md` for the per-code reason.

### Local validation

`pnpm run typecheck` clean · `pnpm run lint` clean ·
`pnpm run check:ir-fallbacks` OK (no increases) ·
`pnpm run gen:ir-adoption -- --check` up to date ·
`check:loc-budget` / `check:func-budget` OK (growth granted by this issue's
`loc-budget-allow`) · `tests/issue-3341-strict-postclaim.test.ts` +
`tests/issue-3341-slice-b.test.ts` 10/10.

Two red spots exist on the wave branch and **neither is caused by this slice** —
each was measured as a file-copy A/B (revert `src/codegen/index.ts` to `HEAD`,
run, re-apply, run), not assumed:

| suite | base | with Slice C |
| ----- | ---- | ------------ |
| `equivalence/{logical-conditional-identity,arguments-nested-and-loops}` | 4 failed \| 65 passed | 4 failed \| 65 passed |
| `issue-3529-selector-preclaim` (the largest consumer of `class-member-unsupported`) | 4 failed \| 62 passed | 4 failed \| 62 passed |

The equivalence failures are TS-diagnostic compile failures (`Argument of type
'undefined' is not assignable to parameter of type 'number'`, the `void x` → NaN
family), not IR-fallback promotions. The other four `class-member-unsupported`
consumers (`issue-3520-selection-identity`, the three `issue-4259` accessor
suites) are fully green with Slice C applied.

Caveat, stated rather than papered over: the WHOLE `tests/equivalence`
directory does not finish in this container — it dies with
`ERR_IPC_CHANNEL_CLOSED` before printing a summary, on this branch, with and
without the change. So the full-directory pass count is **not established
locally**; CI's `equivalence-gate` is the authority for it.

### Residual (NOT in this slice)

Slice A stays dead as specced (see the dev-h note above). Widening the promoted
set further needs the same site-by-site proof this slice applied — the honest
finding is that most `unsupported` codes are designed demotes *by construction*,
so growing this set means **typing the desync arms distinctly first** (the
mirror image of #3565/#3784/#4035), not adding existing codes wholesale.
