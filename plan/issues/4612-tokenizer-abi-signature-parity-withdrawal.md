---
id: 4612
title: "acorn tokenizer post-claim withdrawal: abi-signature-parity IR=182 vs legacy=151 on the runtime-dynamic lane"
status: ready
sprint: current
created: 2026-08-21
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: ir
language_feature: compiler-internals
goal: backend-agnostic-ir
parent: 3518
related: [2949, 3520, 4730]
origin: "#2949 census re-measurement (PR #4730): main acquired this withdrawal on its own between fd679233f (2026-07-30, 0 withdrawals) and fec977606 — byte-identical before and after #4730's selector change"
# id 4612 reserved via claim-issue.mjs --allocate --allow-unscanned on
# 2026-08-21 (gh CLI offline in this container; pr_scan=degraded). MCP
# open-PR scan at reservation: open PRs 4732/4733 introduce no issue files
# with ids near 4612.
---

# #4612 — `tokenizer` withdraws post-claim on ABI signature parity

## Problem

The #2949 runtime-dynamic acorn driver (npm-compat `--only acorn --lane
standalone-dynamic`, inline form) shows **1 post-claim withdrawal** on
current main that did not exist on the 2026-07-30 baseline: `tokenizer`
withdraws with `abi-signature-parity` — the IR path derives a signature
of **182** entries where the legacy path derives **151**. The prior bar
for this driver was **zero** post-claim withdrawals; main broke that bar
on its own somewhere after `fd679233f`.

A post-claim withdrawal is worse than a pre-claim decline: the selector
accepted the function, work was done, and the claim was retracted at the
parity check — the exact failure mode the #4520 differential gate exists
to catch at the carrier level.

## Acceptance criteria

- [ ] Bisect or otherwise identify which landed change moved the IR-side
      (or legacy-side) signature count for `tokenizer` (182 vs 151 — the
      31-entry delta likely names the family).
- [ ] Either restore parity (fix the divergent side) or, if the IR side is
      CORRECT and legacy under-counts, record that verdict with evidence
      and adjust the parity rule's expectation — never silence the check.
- [ ] Driver back to zero post-claim withdrawals, emitted count not
      reduced (currently 31/42).
- [ ] `check:ir-fallbacks` / `check:ir-only` unchanged.
