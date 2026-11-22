---
id: 7449
title: "Prepared path: `Object.create` preparation and the #7338 table decide \"is this the built-in?\" by name"
status: ready
created: 2026-11-22
updated: 2026-11-22
priority: medium
horizon: s
goal: ir-full-coverage
sprint: Backlog
related: [7354]
---

# #7449 — Prepared path: `Object.create` preparation and the #7338 table decide "is this the built-in?" by name

## Problem

`src/frontend/builtins/prepare-object-create.ts` has a second route, and the #7338 table a predicate, that recognise a built-in global by its name. `pristineBuiltinGlobal` (`src/ir/builtin-global-binding.ts`) already answers this by binding. The name-based checks refuse programs that merely declare a same-named local, and are a second copy of one rule.

Found on 2026-11-22 during the #7354 slices (Prepared whole-program IR path).

## Acceptance criteria

- Both sites call `pristineBuiltinGlobal`; the name predicates are deleted.
- A program with a shadowing local of the same name is no longer refused for that reason (probe before/after).
