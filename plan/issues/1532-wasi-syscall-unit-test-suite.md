---
id: 1532
title: "test: WASI syscall unit test suite (fd_write, environ_get, clock_time_get, fd_read, proc_exit)"
status: ready
created: 2026-05-20
updated: 2026-06-19
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: test
area: runtime
language_feature: wasi
goal: nodejs-support
sprint: Backlog
---
# #1532 — WASI syscall unit test suite

## Problem

The compiler's WASI target (`--target wasi`) has no dedicated unit tests. Correctness of WASI syscall bindings is only validated indirectly through the test262 suite (which doesn't test WASI at all) and manual ad-hoc checks. Regressions in `fd_write`, `environ_get`, `clock_time_get`, `fd_read`, or `proc_exit` routing are invisible until a user reports them.

## Goal

Create `tests/issue-1532.test.ts` (and optionally `tests/wasi.test.ts` as a permanent home) that compiles TypeScript programs with `--target wasi` + `nativeStrings: true` and runs them through Node's built-in `wasi` module, asserting correct syscall behavior.

## Test cases

1. **`console.log` → stdout via `fd_write`** — verify text appears on fd=1
2. **`console.error` / `console.warn` → stderr via `fd_write`** — verify text appears on fd=2, not fd=1
3. **`process.env.MY_VAR` → `environ_get`** — instantiate with env set, assert correct value returned
4. **`process.argv[2]` → `args_get`** — instantiate with args, assert correct value
5. **`process.exit(42)` → `proc_exit`** — assert WASI_EXIT thrown with status 42
6. **`Date.now()` → `clock_time_get`** — assert result > 1700000000000 (not 0, not NaN)
7. **`performance.now()` → `clock_time_get`** — assert result > 0
8. **Basic arithmetic in WASI mode** — sanity that codegen isn't broken by WASI flag
9. **String concat in WASI mode** — native strings round-trip

## Implementation approach

Use Node's built-in `wasi` module (no third-party dependencies):
```ts
import { WASI } from 'wasi';
import { openSync, readFileSync, closeSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

async function runWasi(binary, opts) {
  const stdoutPath = join(tmpdir(), `wasi-out-${Date.now()}.txt`);
  const stderrPath = join(tmpdir(), `wasi-err-${Date.now()}.txt`);
  const stdoutFd = openSync(stdoutPath, 'w');
  const stderrFd = openSync(stderrPath, 'w');
  let exitCode = 0;
  try {
    const wasi = new WASI({ args: opts?.args ?? ['test'], env: opts?.env ?? {},
      version: 'preview1', stdout: stdoutFd, stderr: stderrFd });
    const wasm = await WebAssembly.compile(binary);
    const instance = await WebAssembly.instantiate(wasm,
      { wasi_snapshot_preview1: wasi.wasiImport });
    try { wasi.start(instance); }
    catch (e) { if (e?.code === 'WASI_EXIT') exitCode = e.status ?? 0; else throw e; }
  } finally { closeSync(stdoutFd); closeSync(stderrFd); }
  const stdout = readFileSync(stdoutPath, 'utf-8');
  const stderr = readFileSync(stderrPath, 'utf-8');
  unlinkSync(stdoutPath); unlinkSync(stderrPath);
  return { stdout, stderr, exitCode };
}
```

## Acceptance criteria

- All 9 test cases pass locally with `npm test -- tests/issue-1532.test.ts`
- No regressions in `tests/equivalence.test.ts`
- PR is tests-only (no `src/` changes) — basic CI suffices, no test262 shards needed

## Files to create

- `tests/issue-1532.test.ts` — the test file

## Frontmatter reconcile (2026-06-12)

Was `in-progress` with no open PR, no active agent, and no Suspended Work section (session died sprints 42-52). Reset to `ready` during the sprint-62 issue review; re-validate against current main before claiming (#2148).
