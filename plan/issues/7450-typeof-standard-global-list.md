---
id: 7450
title: "`typeof` of a standard global: `typeof Iterator` answers \"undefined\"; DOM names refuse"
status: ready
created: 2026-11-22
updated: 2026-11-22
priority: medium
horizon: s
goal: core-semantics
sprint: Backlog
related: [7354]
---

# #7450 — `typeof` of a standard global: `typeof Iterator` answers "undefined"; DOM names refuse

## Problem

After slice T a name is absent only when neither the program nor the standard library declares it. Two gaps remain: newer standard globals missing from the checked library (`typeof Iterator` gives `"undefined"`, node gives `"function"`), and DOM-only names (declared by the DOM library, absent on standalone) which refuse instead of answering `"undefined"`.

Found on 2026-11-22 during the #7354 slices (Prepared whole-program IR path).

## Acceptance criteria

- `typeof Iterator` is a named refusal or `"function"`, never `"undefined"`.
- `typeof document` on the standalone target answers `"undefined"`.
- One list or one rule decides this, not two.
