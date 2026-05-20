---
sprint: 52
written: 2026-05-20
written_by: project-review
retroactive: true
status_at_writing: active-but-winding-down
---

# Sprint 52 Retrospective

**Sprint**: 52
**Dates**: 2026-05-20 → 2026-05-20 (planned & started same day; sprint 53 created in parallel)
**Theme**: Spec-completeness continuation + Wasm closure bridge
**Baseline at start**: 28,147 / 43,160 (65.2 %)
**Baseline at writing**: 28,168 / 43,160 (65.3 %)

> Written before formal closure. Sprint 52's frontmatter still says
> `status: active`, but sprint 53's planning doc already references
> "carry-forward 5 S52 issues" and "~60 open PRs from S52 most of which
> are in flight" — i.e. the sprint is functionally winding down. This
> retro captures the pattern up to 2026-05-20; a final tally goes in
> when S52 formally closes.

---

## Scope at start

Carried 16 unstarted S51 issues plus 10 audit PRs (#341–350). Theme:
spec-gap fixes (#1431–#1438, #1443, #1445, #1450, #1460, #1467, #1468,
#1511, #1513–#1516, #1519), IR async groundwork (#1373, #1373b), and the
Wasm closure bridge (#1382), method closure caching (#1394).

## What landed

- The bulk of the spec-completeness wave (multiple PRs merged in series).
- The dev-self-merge gate was exercised at scale across ~60 PRs.
- Host-independence epics (#1470–#1474) made it to `in-progress` status,
  although no visible PRs landed for them in S52 — they carry into S53.

## What didn't (carry-forward to S53)

| Issue  | Status | Reason |
|--------|--------|--------|
| #1373  | ready  | IR async function — no agent picked it up, architect spec still needed |
| #1373b | ready  | IR async CPS lowering — blocked on #1373 |
| #1382  | ready  | Wasm closure / host-import bridge — architect-grade, no impl plan |
| #1394  | ready  | Method closure caching — architect-grade |
| #1400  | ready  | ESLint package-entry valid Wasm |
| #1387  | ready  | `with` statement architect exploration |
| #1470–#1474 | in-progress | Host-independence epics — no PRs visible yet |

## What worked

- 60-PR parallel queue: the dispatch model continues to scale.
- Spec-gap clustering: grouping #1431–#1438 etc. allowed similar fixes
  to share infrastructure (test262 worker classification, etc.).
- Host-independence framing gave a structured way to enumerate the
  WASI/standalone gaps (#1470–#1474).

## What didn't

- **Duplicate issue IDs accumulated**: discovered during this review:
  - `plan/issues/sprints/52/` has two `1521-*.md` files.
  - `plan/issues/sprints/50/` has three `1335-*.md` files.
  Direct cause for #1523 — sprint/folder/ID consistency gate.
- **Documentation drift**: ROADMAP (35.9 %), goal-graph (59.8 %),
  CLAUDE.md (65.3 %) all carry different headline conformance numbers.
  Direct cause for #1522 — auto-update conformance numbers.
- **Dual-mode is aspirational, not enforced**: the host-independence
  epics were dispatched but nothing prevents *new* code from adding a
  host-only path. Direct cause for #1524 — strict mode + CI gate.
- **IR fallback budget grew, didn't shrink**: the gate caught growth but
  the unintended buckets still total 29. Direct cause for #1530 —
  ratchet to zero.
- **`as unknown as Instr` casts grew from 158 → 379** since the count
  was last documented. Direct cause for #1526 — cast budget gate.
- **`sprint-current.md` was two months stale during the sprint** and
  nobody noticed because nobody read it. Direct cause for #1523 — phase
  out the file.

## Process changes for S53

All filed as issues in sprint 53. See:

- #1522 conformance number auto-update
- #1523 sprint doc programmatic generation + consistency gate
- #1524 dual-mode enforcement (strict mode + CI)
- #1525 GitHub branch protection
- #1526 `Instr` cast budget
- #1527 IR adoption strategy doc
- #1528 baseline JSONL → js2wasm-baselines repo
- #1529 repo rename to loopdive/js2
- #1530 IR fallback phase-out prioritised

## Pointers

- Sprint file: `plan/issues/sprints/52/sprint.md`
- Sprint 53 carry-forward analysis: `plan/issues/sprints/53/sprint.md`
- Project-review session: 2026-05-20 (this retro originated there)
