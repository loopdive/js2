---
id: 3341
title: "STRICT_IR_REASONS hardening — per-reason (NOT a corpus-zero flip); doc-correction shipped, real per-reason work remains"
status: ready
sprint: current
created: 2026-07-17
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
