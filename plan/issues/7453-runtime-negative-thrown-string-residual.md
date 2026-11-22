---
id: 7453
title: "test262 runner: a thrown string \"TypeError: x\" still passes a runtime negative expecting TypeError"
status: ready
created: 2026-11-22
updated: 2026-11-22
priority: medium
horizon: s
goal: ci-hardening
sprint: Backlog
related: [7354]
---

# #7453 — test262 runner: a thrown string "TypeError: x" still passes a runtime negative expecting TypeError

## Problem

After slice X(a) (#7354) a runtime negative passes only when the thrown value's kind was read. On the ordinary standalone and gc lanes the reader splits the module's own rendered text at the first `": "`, so `throw "TypeError: x"` and an object whose `toString` returns that text still match. Closing it needs the module to export the kind itself (slice X2 in #7354's issue file).

Found on 2026-11-22 during the #7354 slices (Prepared whole-program IR path).

## Acceptance criteria

- `throw "TypeError: x"` fails a negative expecting TypeError on every lane.
- A real `TypeError` still passes.
- No test262 row flips, or `ORACLE_VERSION` is bumped.
