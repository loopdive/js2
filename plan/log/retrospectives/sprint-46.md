---
sprint: 46
written: 2026-05-20
written_by: project-review
retroactive: true
---

# Sprint 46 Retrospective

**Sprint**: 46
**Dates**: 2026-04-30 → 2026-05-02 (closed)
**Theme**: IR Phase 4 follow-on + closed-world specialisation triage
**Baseline at start**: 25,830 / 43,168 (59.8 %)

> Written retroactively from `plan/issues/sprints/46/sprint.md`, the diary,
> and the carry-over list in the sprint frontmatter. Lighter than a
> contemporaneous retro — included so the sprint history is complete and
> the sprint hygiene pattern documented in #1523 has a precedent.

---

## Carry-overs recorded in frontmatter

| Issue | Status at close | Note |
|-------|-----------------|------|
| #742  | blocked         | compileCallExpression refactor — moved to backlog |
| #1166 | blocked         | closed-world integer specialisation — moved to backlog |
| #1169 | ready           | IR Phase 4 umbrella tracker — rolls forward through S47+ |

## What worked

- IR Phase 4 slice work progressed enough to unblock S47's planning.
- The carry-over annotation pattern in sprint frontmatter
  (`carry_overs: [...]`) was used cleanly and survived into later sprints.

## What didn't

- **Retro was never written at closure** — this file is reconstructed
  two weeks later. Direct cause for #1523 acceptance criterion C:
  consistency gate must flag closed sprints without retros.
- Two of three carry-overs (#742, #1166) were blocked rather than
  completed. Both moved to backlog without a clear unblock plan.

## Process notes (looking back)

The retro hygiene gap that bit S46 also hit S48 and S52. The fix is in
flight as #1523 — sprint frontmatter + a CI consistency check that flags
closed sprints with `retro_written: false`.

## Pointers for future review

- Sprint file: `plan/issues/sprints/46/sprint.md`
- Diary entries from 2026-04-30 → 2026-05-02 in `plan/log/diary.md`
- Issue files: `plan/issues/sprints/46/*.md`
