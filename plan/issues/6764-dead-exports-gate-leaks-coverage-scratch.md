---
id: 6764
title: "check:dead-exports leaves an ~80 MB `.tmp/core-node-execution-*` V8-coverage directory behind on every run"
status: ready
sprint: Backlog
created: 2026-09-29
updated: 2026-09-29
priority: medium
horizon: s
feasibility: easy
task_type: bug
area: tooling
goal: ci-hardening
requested_by: ttraenkler/claude-lead
related: []
---

# `check:dead-exports` fills the disk

## Symptom

Every `npm run -s check:dead-exports` (a required pre-commit gate) leaves a
`.tmp/core-node-execution-XXXXXX/` directory in the tree, about 80 MB each,
almost all of it `source-map-content/` V8 coverage output. On 2026-09-29 three
parallel lanes running the gate before each commit drove a container disk to
99 % full; they had to be deleted by hand on every check-in.

## Cause

`scripts/lib/core-node-execution-gate.mjs`:

```js
const scratch = mkdtempSync(join(scratchRoot, "core-node-execution-"));
const coverageDirectory = join(scratch, "source-map-content");
...
launch = { ..., coverageDirectory }   // becomes NODE_V8_COVERAGE for the child
```

Nothing removes `scratch` afterwards. The file's own comment says coverage
output "is NOT read or used as caller evidence". Only `execution.json` is read,
and its path is kept as `group.evidencePath`.

## Fix

After the verdict is computed, `rmSync(coverageDirectory, { recursive: true,
force: true })` in a `finally`. Keep `execution.json` only when a `--keep-evidence`
style flag or env var asks for it; otherwise remove `scratch` too. Do not
weaken what the gate checks.

## Acceptance

- Running `npm run -s check:dead-exports` twice leaves no
  `.tmp/core-node-execution-*` directory, or only a small evidence file when
  explicitly kept.
- The gate's verdict is byte-identical before and after the change on current
  `main`.
