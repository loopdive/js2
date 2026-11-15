---
id: 7348
title: "SCRATCH ONLY — #7348 Step 0 probe switch (branch scratch/7348-step0, never a PR, never merged)"
status: in-progress
sprint: Backlog
created: 2026-11-15
loc-budget-allow:
  # 2026-11-15 (#7348 Step 0): throwaway measurement switch on a scratch branch that is never merged.
  - src/ir/select.ts
func-budget-allow:
  # 2026-11-15 (#7348 Step 0): throwaway measurement switch on a scratch branch that is never merged.
  - src/ir/select.ts::isPhase1Expr
  - src/ir/select.ts::isPhase1StatementListInScope
---

# Scratch grant file for the #7348 Step 0 probe

Exists only so the ratchet hooks accept the probe commit on `scratch/7348-step0`.
The real issue file is `7348-ir-owned-file-mode.md` (PR #7245).
