---
id: 7510
title: "`s === null` / `s !== null` on a `string` parameter folds to a constant; a JS caller passing null gets the wrong branch"
status: ready
sprint: Backlog
created: 2026-11-26
updated: 2026-11-26
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
goal: core-semantics
related: [2713, 6708]
---

# #7510: `string` parameter null-compare folds to a constant

## Problem

Measured on main `1a726b3e` (2026-11-26), default (JS) target and `target: "standalone"`:

```ts
export function eq(s: string): number { return s === null ? 1 : 0; }
export function ne(s: string): number { return s !== null ? 1 : 0; }
```

- `$eq` contains no `ref.is_null`: the compare is folded to `false` (and `!==` to `true`). Same WAT on both targets.
- Called through the JS value adapter (`wrapCompiledExports`) with `null`: `eq(null) === 0`, `ne(null) === 1`. JS gives 1 and 0.
- With `s: string | null` the check is emitted and the results are correct.

This is the miscompile that #2713 B2 fixed on the IR path. It is back, and the legacy and IR paths now agree on the wrong
answer, so `tests/issue-2713-ir-legacy-parity.test.ts`'s parity check passes while its spec check fails:

- `B2 — string null-compare not folded > s === null with s = null → 1` gets 0;
- `B2 … > s !== null with s = null → 0` gets 1.

The loose forms (`== null`, `!= null`) in the same describe pass.

The rest of that file is a stale harness (`nativeStrings: false`, removed by #6979 S7); lane S25 repairs it separately,
and these two cases stay red until this issue is fixed.

## Acceptance criteria

- `eq(null)` and `ne(null)` above return 1 and 0 through the JS value adapter; the WAT keeps a runtime null test.
- `tests/issue-2713-ir-legacy-parity.test.ts` B2 is green.
- No change to `string | null` or to non-null string inputs.
