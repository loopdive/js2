---
id: 3376
title: "standalone strict-leak scan phase 2: ratchet WARNING→ERROR"
status: ready
depends_on: [2961]
sprint: Backlog
created: 2026-07-17
updated: 2026-07-17
priority: medium
horizon: s
feasibility: medium
task_type: feature
area: codegen
language_feature: compiler-internals
goal: standalone-mode
related: [2961, 3178]
origin: "2026-07-17 follow-up to #2961 phase 1 (PR #3288): the warning-first standalone host-import leak scan is in; this ratchets it to the same hard ERROR guarantee wasi has."
---

# #3376 — ratchet the standalone host-import leak scan from WARNING to ERROR

## Problem

#2961 (PR #3288) landed the standalone host-import leak scan **warning-first**:
`assertNoLeakedHostImports` (`src/codegen/index.ts`) fires for plain
`ctx.standalone` at **warning** severity — every leaked host import gets a
source-located advisory, but the binary is emitted unchanged and the compile
still succeeds. This surfaces the leak set (documented in #2961) without moving
the `host_free_pass` floor.

The end state, matching the hard structural no-leak guarantee `--target wasi`
already enforces, is a compile **error**: a `--target standalone` program that
leaks an un-allowlisted host import must fail loudly at compile time, never
emit a silently-trapping binary.

## Gate (do NOT flip until this is verified)

Flip the severity **only after #3288 has merged** AND a real
merged-report / test262 run shows the standalone **host-free floor**
(`check-standalone-highwater`, keyed on `host_free_pass`) is
**net-neutral-or-up**. This is the safety valve the #2961 directive called for —
a hard flip that regresses the floor must not land. The pre-approved
`host_import_leak` reclassification shape (leaky standalone passes → honest
fails) is documented in #2961's `regressions-allow` block (count 3150, single
category `host_import_leak`); traps/other categories must stay flat-or-down.

## Approach

1. In `assertNoLeakedHostImports` (`src/codegen/index.ts`), change the one
   severity ternary so plain `ctx.standalone` resolves to `"error"` (currently
   `"warning"`), i.e. standalone joins wasi/explicit-strict on the hard path.
   The `JS2WASM_STANDALONE_LEAK_SCAN=0` escape hatch stays.
2. Per-bucket disposition for the enumerated leaks (console string-bridge,
   `__timer_set_timeout`, DOM extern methods — see the #2961 enumeration table):
   decide **allowlist-with-retiring-issue** (tolerated transitional host path,
   like the existing `console_` entry) vs **`refuseStandalone*` loud error**
   (no fallback exists). Default expectation: refuse (these are genuine
   host-only features with no standalone substrate); allowlist only if a
   deliberate leaky-debug path is wanted, annotated `[allowlist-grow]`.
3. Update `tests/issue-2961.test.ts` (or add `tests/issue-3376.test.ts`) so the
   standalone-leak cases assert `success: false` + error severity.
4. Validate on merge_group: standalone floor net-neutral-or-up, traps flat/down.

## Acceptance criteria

- `--target standalone` compile of a program using an un-allowlisted host
  import **fails loudly** (severity error, `success: false`) — never emits a
  silently-trapping binary, never crashes with the `absoluteFuncIndex` internal
  error (guaranteed by #3009).
- Any allowlist growth is fully annotated (name → retiring issue).
- Host-free floor (`check-standalone-highwater`) net-neutral-or-up;
  merge_group validated; trap categories flat-or-down.
