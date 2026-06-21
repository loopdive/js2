---
id: 1533
title: "test: Node.js API host import unit tests (fs, crypto, process, console)"
status: ready
created: 2026-05-20
updated: 2026-06-19
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: test
area: runtime
language_feature: host-imports
goal: nodejs-support
sprint: Backlog
related: [1491, 1492, 1493, 1490, 1494]
---
# #1533 — Node.js API host import unit tests

## Problem

Sprint 52 landed several Node.js host import features (#1491 fs, #1492 crypto, #1493 console.error, #1490 process, #1494 __dirname). Each has narrow issue-specific tests but no unified suite that validates the complete Node host-import surface end-to-end.

## Goal

Create `tests/issue-1533.test.ts` covering Node API host imports compiled with the default JS-host target and run in Node via the js2wasm runtime.

## Test cases

1. **`fs.readFileSync(path, 'utf-8')`** — write a temp file, compile with `allowFs: true`, assert content read correctly
2. **`fs.writeFileSync(path, data)`** — compile with `allowFs: true`, write from Wasm, assert file exists with correct content
3. **`fs.existsSync(path)`** — assert true for existing file, false for missing
4. **`process.argv[2]`** — instantiate with argv set via runtime options, assert correct value
5. **`process.env.MY_VAR`** — set env in runtime options, assert correct value
6. **`process.exit(7)`** — assert exit throws / returns code 7
7. **`crypto.randomBytes(16)`** — assert result is Buffer-like with length 16, all bytes not identical
8. **`crypto.randomUUID()`** — assert result matches UUID format regex
9. **`console.error("msg")`** — capture stderr, assert message present
10. **`__dirname`** — assert it's a non-empty string (path to the source file)

## Approach

Compile each snippet with `compile(src, { fileName: 'test.ts', allowFs: true })` and run via `src/runtime.ts`'s `run()` or equivalent. Check `src/runtime.ts` `resolveImport` for the `node_builtin` case to understand how host bindings are wired.

## Acceptance criteria

- All 10 test cases pass locally
- `allowFs: true` snippets work (reads/writes real temp files)
- No `src/` changes — tests-only PR

## Files to create

- `tests/issue-1533.test.ts`

## Frontmatter reconcile (2026-06-12)

Was `in-progress` with no open PR, no active agent, and no Suspended Work section (session died sprints 42-52). Reset to `ready` during the sprint-62 issue review; re-validate against current main before claiming (#2148).
