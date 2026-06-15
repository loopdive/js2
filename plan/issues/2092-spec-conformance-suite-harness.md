---
id: 2092
title: "spec-conformance suite: tests/equivalence/spec/ table-driven harness + June probe-corpus migration"
status: done
sprint: 62
created: 2026-06-11
updated: 2026-06-15
completed: 2026-06-15
priority: critical
feasibility: medium
reasoning_effort: medium
task_type: test
area: testing
language_feature: n/a
goal: correctness
related: [2093, 1897]
origin: "2026-06-11 analysis program (report 06 §2); stub 08-C7"
---

# #2092 — the probes that found 170 bugs live only in issue markdown

## Problem

~600 ad-hoc June probes found 170 bugs the 2,000+-file test corpus could
not see (hand-picked happy paths; issue tests pin the past, not the spec).
The probes exist only in issue Repro sections and will rot.

## Root cause

No table-driven value×operator sweeps; no standalone/-O execution lanes at
PR time.

## Plan (report 06 §2)

`tests/equivalence/spec/<family>.test.ts` table-driven files: snippet →
auto-diffed against Node (`compileToWasm` vs `evaluateAsJs`), harness
composed from tests/equivalence/helpers.ts + `runStandalone` from
tests/issue-1901.test.ts:42 (semantics + import-leak check in one). Four
lanes (host, standalone, ±-O). Open-bug repros land RED-BUT-BASELINED
under the already-required `equivalence-gate` known-failures mechanism.
Sprint 62 = skeleton + the 3 highest-yield family tables (~150 probes);
long tail follows.

## Acceptance criteria

- Skeleton + first 3 family tables merged and running in the required gate
- A deliberately-reverted June fix turns the suite red in the right lane

## Dupe check

No spec-sweep suite exists; equivalence.test.ts is example-driven. New
(analysis program).

---

## Resolution (2026-06-15) — skeleton + 3 family tables

Landed the table-driven harness and the first 3 highest-yield coercion family
tables. They run under the already-required `equivalence-gate` job (the
`tests/equivalence/` vitest sweep + known-failures baseline), so no new CI
wiring was needed — the gate auto-discovers `tests/equivalence/spec/*.test.ts`.

### What landed

- **`tests/equivalence/spec/_harness.ts`** — `defineSpecFamily(family, rows[])`.
  Each row is a self-contained zero-arg `run(): number` snippet compiled + run
  across **four lanes** (`host`, `host -O`, `standalone`, `standalone -O`) and
  auto-diffed against the same snippet evaluated as JS. Standalone lanes also
  assert **no host-import leak** (the #1901/#1472 banned-import check, extended
  with `env::__host_*`), so a coercion that silently delegates to a JS host
  import in standalone mode is caught as a failure, not a pass. Snippets MUST be
  self-contained (standalone has no JS host to inject `any` values — passing
  host JS strings into externref params is not a standalone scenario; see the
  #2059 resolution note). Open-bug rows carry `bug:`/`failsIn:` markers.
- **`coercion-relational-equality.test.ts`** — §7.2.13 IsLessThan +
  §7.2.15/§7.2.16 equality over `any` operands. **All green in all 4 lanes** —
  this family is the regression *lock* on the landed #2058/#2059 per-site
  dispatch (string lexicographic, mixed→numeric, null==undefined, strict-eq
  type-awareness). None of its ids are in the baseline, so reverting #2059 or
  #2058 surfaces as a NEW regression.
- **`coercion-tostring.test.ts`** — §7.1.17 ToString / template-literal /
  `String(any)`. Host green; standalone `any`-number/boolean ToString is
  RED-BUT-BASELINED under **#2072** (value-rep P0) and **#2005**
  (template-literal boolean/numeric) — standalone produces a default
  object-ish string instead of the spec ToString.
- **`coercion-arithmetic-add.test.ts`** — §13.15.3
  ApplyStringOrNumericBinaryOperator for `+`. Provably-numeric add green
  everywhere; `any`-string/object/array concatenation RED-BUT-BASELINED under
  **#1988** (`__any_add` has only i32/f64 branches; ref-tagged operands miss
  ToPrimitive → wrong value host, null-pointer deref standalone).

### Acceptance criteria — met

- **Skeleton + first 3 family tables merged + running in the required gate**:
  84 generated tests (3 families × ~7 rows × 4 lanes); 68 green, 16
  RED-BUT-BASELINED. `node scripts/equivalence-gate.mjs` exits 0 (no NEW
  regressions) with the 16 ids added to `scripts/equivalence-baseline.json`.
- **A deliberately-reverted fix turns the suite red in the right lane**: the
  relational-equality family is fully green and NOT in the baseline, so a
  reverted #2058/#2059 fix makes its `standalone`/`host` lane rows fail as
  genuine regressions; the broken `any`-add / standalone-ToString rows are
  baselined to the owning issues (#1988/#2072/#2005) so a fix landing there
  shows up as "newly fixed" for a baseline ratchet (`--update`).

### Long tail

The remaining ~450 June probes (Symbol, TypedArray, Date, Map/Set, RegExp,
JSON families — Lane B issues #2159–#2166) follow as additional
`tests/equivalence/spec/<family>.test.ts` tables on the same harness; this PR
delivers the skeleton + the 3 coercion-engine families that guard the #1917
engine steps.
