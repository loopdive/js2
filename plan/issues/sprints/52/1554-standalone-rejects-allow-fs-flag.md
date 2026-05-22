---
id: 1554
sprint: 52
title: "cli: --standalone should reject --allow-fs (logically mutually exclusive flags)"
status: ready
created: 2026-05-20
priority: low
feasibility: easy
reasoning_effort: low
task_type: bugfix
area: cli
goal: host-independence
related: [1470, 1471]
note: "Verified 2026-05-21: src/cli.ts has --allow-fs (L98) but NO --standalone flag exists yet. Issue may need to be re-scoped: either define what 'standalone' means in CLI (perhaps --target=wasi implies standalone?), or precede this fix with an issue that adds --standalone."
---

# #1554 — `--standalone` should reject `--allow-fs` at parse time

## Problem

`--standalone` and `--allow-fs` are logically opposed:
- `--standalone` compiles for pure-Wasm mode — refuses all JS-host imports
- `--allow-fs` enables JS-host `fs.*` imports (non-WASI)

Currently the CLI silently accepts both flags together, which leads to confusing
runtime behaviour (the --standalone constraint is violated without warning).

Caught during conflict resolution of PR #408 (#1470 no-js-host-string-ops)
by senior-dev-conflicts.

## Fix

In `src/cli.ts`, after flag parsing, add a mutual-exclusion guard:

```ts
if (options.standalone && options.allowFs) {
  console.error('error: --standalone and --allow-fs are mutually exclusive');
  process.exit(1);
}
```

## Acceptance criteria
- `js2wasm --standalone --allow-fs input.ts` exits with error message and code 1
- `js2wasm --standalone input.ts` continues to work
- `js2wasm --allow-fs input.ts` continues to work
- Equivalence tests still pass

## Test
Add a CLI flag test in `tests/cli.test.ts` (or wherever CLI flag tests live).
