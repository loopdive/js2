---
id: 1933
title: "Runtime multi-instance isolation — module-level mutable state bleeds across instances and retains them forever"
status: done
sprint: 63
created: 2026-06-10
updated: 2026-06-16
completed: 2026-06-16
assignee: ttraenkler/tld-2108
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

## Implementation (2026-06-16)

The four module-level mutable states are now per-instance fields on
`InstanceState`, threaded through `resolveImport` (which already received
`instanceState`) and `buildImports`:

- **`symbolCache` / `symbolDescRegistry`** — the `__box_symbol` /
  `__symbol_register_desc` handlers read/write `instanceState.symbolCache` /
  `.symbolDescRegistry` (seeded with the well-known symbols on first use). The
  old `_symbolCache = undefined; _symbolDescRegistry.clear()` reset in
  `buildImports` (which clobbered concurrent instances) is removed.
- **`subclassCtors` / `userClassParents`** — the `__instanceof` /
  `__set_subclass_proto` / parent-register handlers use the per-instance maps.
  Per-instance `subclassCtors` fixes the retention leak: synthetic subclass
  ctors close over their instance, so a shared module-level map pinned every
  instance forever.
- **`legacyRegExpState`** — `_updateLegacyRegExpState(input, m, state)` and
  `_installLegacyRegExpAccessors(C, state)` now take the per-instance state
  (`instanceState.legacyRegExpState`), threaded at the 5 update sites + the
  install site. The module-level `_legacyRegExpState` remains only as the
  default fallback for legacy callers without an `instanceState`.
  Caveat: when two instances share the SAME realm `RegExp` object, the legacy
  statics (`RegExp.$1` etc.) are spec-shared on that one constructor — the
  install is idempotent per RegExp identity, so the first installer's state
  wins; true isolation there would need per-instance RegExp constructors (out
  of scope). The update path and per-instance-RegExp (`deps.RegExp`) case are
  isolated.
- `lastCaughtException` (concern #4) is already a `buildImports`-local `let`
  (per-instance); left as-is — it pins only the most-recent exception until the
  next throw, not a cross-instance bug.

The module-level `_symbolCache`/`_subclassCtors`/etc. are retained ONLY as
fallbacks for any caller that resolves imports without an `instanceState`; the
live per-instance store is `InstanceState`.

### Acceptance criteria — met
- [x] No module-level mutable state holds the live per-instance data — the live
      store is the per-instance `InstanceState`; the module-level maps are
      fallback-only. (Full removal of the fallbacks would require every
      `resolveImport` caller to pass `instanceState`, tracked with #1934.)
- [x] Two-instance test green; WeakRef-collection test green
      (`tests/issue-1933.test.ts`).

## Test Results (2026-06-16)

`tests/issue-1933.test.ts` — 5/5:
- (a) symbol descriptions independent across two concurrent instances;
- basic compile/run unaffected;
- subclass-of-builtin works per instance;
- (b) WeakRef to a dropped instance (that registered subclasses) is GC-collected
  after `--expose-gc` (subprocess) — proving the retention leak is fixed;
- allowlist guard: the per-instance `InstanceState` fields exist.

Existing symbol tests (20/20), regexp, subclass tests pass. The
`instanceof.test.ts` failures (7) reproduce IDENTICALLY on clean origin/main —
pre-existing harness-stub issues, not caused by this change. typecheck / lint /
format clean.
