---
id: 1933
title: "Runtime multi-instance isolation — module-level mutable state bleeds across instances and retains them forever"
status: backlog
sprint: Backlog
created: 2026-06-10
updated: 2026-06-10
priority: high
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: runtime
language_feature: compiler-internals
goal: correctness
---
# #1933 — Runtime multi-instance isolation + retention leak

## Problem

`src/runtime.ts` keeps **module-level mutable state** that is shared by all
instances on a page:

1. `buildImports` *resets* `_symbolCache = undefined;
   _symbolDescRegistry.clear()` (`runtime.ts:10053-10054`) — two concurrently
   live instances clobber each other's symbol-id↔description mapping.
2. `_legacyRegExpState` (`runtime.ts:3146`) is a single shared register —
   RegExp static state (`RegExp.$1` style) crosses instances.
3. **Retention leak**: `_subclassCtors: Map<string, Function[]>`
   (`runtime.ts:3634`) and `_userClassParents` (`:1320`) are string-keyed,
   module-level, never cleared; registered ctors close over their instance's
   exports — in hot-reload/test-runner scenarios, **whole instances are
   retained forever**.
4. Minor: `lastCaughtException` (`:10048`) pins the most recent exception
   graph until the next throw.

## Proposed approach

1. Move all four into the existing per-build `InstanceState`
   (`runtime.ts:10064`) / `callbackState`; thread through the closures that
   read them (mechanical but wide — the helpers already receive state in
   most paths).
2. `_subclassCtors` keyed per instance also fixes the leak.
3. Test: instantiate two modules in one realm; (a) symbols registered in A
   keep their descriptions after B instantiates; (b) after dropping all refs
   to A and a forced GC (`--expose-gc` is already in vitest config), a
   `WeakRef` to A's exports is collected despite B having registered
   subclasses.

## Acceptance criteria

- No module-level mutable `let`/`Map` in runtime.ts that holds per-instance
  data (grep-able allowlist for true constants).
- Two-instance test green; WeakRef collection test green.

## Source

Compiler quality review 2026-06. Related: #1934 (decomposition makes this
easier — coordinate ordering).
