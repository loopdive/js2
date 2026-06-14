---
id: 1490
title: "nodejs: runtime access to process.argv and process.env"
status: done
completed: 2026-06-12
created: 2026-05-20
updated: 2026-05-20
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: feature
area: runtime
language_feature: host-imports
goal: nodejs-support
sprint: 52
related: [1043, 1044]
---
# #1490 — Runtime access to `process.argv` and `process.env` (Node host mode)

## Problem

Compiled TypeScript running in Node has **no runtime access** to `process.argv`
or `process.env`. Today the only path is **compile-time substitution** via
`--define "process.env.NODE_ENV='\"production\"'"` (#1043). That covers
dead-code elimination but cannot handle:

- A CLI that reads arbitrary args (`process.argv[2]`).
- A library that reads `process.env.DEBUG` / `process.env.HOME` at run time.
- A standalone Node script whose behavior must change per-invocation.

The compiler currently:

- Has no `node_builtin` intent for `process` itself (only #1044 modules like
  `http`, `fs`).
- `src/codegen/index.ts:3073` recognises `process.exit()` as a call but only
  in WASI mode; non-WASI host mode never wires it.
- `process.argv` and `process.env` accesses fall through to `declare const
  process: any` (stub), producing extern reads that return `undefined` at run
  time because no host import binds them.

## Use case

```ts
// build-once, run-anywhere CLI compiled to Wasm:
function main(): void {
  const name = process.argv[2] ?? "world";
  const greeting = process.env.GREETING ?? "Hello";
  console.log(`${greeting}, ${name}!`);
}
main();
```

```sh
$ js2wasm cli.ts -o cli.wasm
$ GREETING=Hi node run.mjs cli.wasm Alice    # → "Hi, Alice!"
```

Without this, no `js2wasm` user can write a usable CLI tool.

## Implementation plan

1. **`src/index.ts`** (≈line 33): add a new `ImportIntent` variant
   `{ type: "node_process_argv" }` and `{ type: "node_process_env_get"; name?:
   string }`. (Or reuse `declared_global` + dispatch in `resolveImport`.)
2. **`src/runtime.ts`** `resolveImport` (≈line 1700, the big switch on
   `intent.type`): add cases that return host bindings:
   - `process_argv` → `() => process.argv.slice(2)` (vec/array of strings).
   - `process_env_get` → `(key: string) => process.env[key] ?? undefined`.
   - `process_exit` → `(code: number) => process.exit(code)` (non-WASI).
   - `process_cwd` → `() => process.cwd()`.
   - `process_platform` → `() => process.platform` (string constant).
3. **`src/codegen/expressions/calls.ts` / `member-access`**: detect
   `process.argv`, `process.env.X`, `process.exit(...)`, `process.cwd()`,
   `process.platform` and route to the new intents. Bind them like the
   existing `node:fs` writeFileSync path (`calls.ts:5153`) — only in non-WASI
   target (WASI already covers `proc_exit` via `wasi_snapshot_preview1`).
4. **Type declarations**: extend the bundled `lib.d.ts` shim with a
   `NodeJS.Process` interface exposing `argv: string[]`, `env: { [key:
   string]: string | undefined }`, `exit(code?: number): never`, `cwd():
   string`, `platform: string`. Without proper types compiled code can't
   compile-check the access.
5. **WIT mapping** (optional, follow-up): for the Component Model target,
   surface `process.argv` via the WASI `wasi:cli/environment` interface.

## Acceptance criteria

The following compiles in JS host (Node) target and prints `Hi, Alice!` when
run with `GREETING=Hi node run.mjs cli.wasm Alice`:

```ts
function main(): void {
  const name = process.argv[2] ?? "world";
  const greeting = process.env.GREETING ?? "Hello";
  console.log(`${greeting}, ${name}!`);
}
main();
```

Add at least one `equivalence.test.ts` case asserting that:
- `process.argv.length` matches what JS sees.
- `process.env.SET_BY_TEST` round-trips.
- `process.exit(7)` in host mode exits the harness with code 7.

## Files to modify

- `src/index.ts` (≈line 33) — add `ImportIntent` variants.
- `src/runtime.ts` (≈line 1700–1800) — `resolveImport` switch cases.
- `src/codegen/expressions/calls.ts` (≈line 5150) — recognise calls.
- `src/codegen/expressions/member-access.ts` — `process.argv`, `process.env.X`,
  `process.platform`, `process.cwd()` accesses.
- `src/lib.d.ts` (or wherever the project's ambient process shim lives) —
  declare `NodeJS.Process`.
- `tests/equivalence.test.ts` — new "process.argv / env runtime" block.

## Suspended Work

- **PR**: #396 — https://github.com/loopdive/js2/pull/396
- **Branch**: `issue-1490-nodejs-process-argv`
- **Worktree**: `/workspace/.claude/worktrees/issue-1490-nodejs-process-argv/`
- **HEAD SHA**: `7d80abd48916c3c936807b039df1547097acd4a3`
- **State**: PR open, in CI-wait. 8/8 local tests pass.

### Implemented (commit f812ee8 → 7d80abd4)
- `src/codegen/property-access.ts` — non-WASI detection of `process.{argv,env,platform,arch}` → late host imports returning externref. Shadow-aware.
- `src/codegen/expressions/calls.ts` — non-WASI detection of `process.exit(n)` (→ `__process_exit` f64) and `process.cwd()` (→ `__get_process_cwd`).
- `src/runtime.ts` — runtime resolvers (`__get_process_argv`, `__get_process_env`, `__get_process_cwd`, `__get_process_platform`, `__get_process_arch`, `__process_exit`) under the existing `builtin` intent path. Use `globalThis.process.*` with safe defaults.
- `tests/issue-1490.test.ts` — 8 tests: argv shape, argv.length, argv[i], env.KEY round-trip, env object identity, cwd, platform, mocked process.exit.

### Resume steps
1. Monitor `.claude/ci-status/pr-396.json` for HEAD-SHA match.
2. Run `/dev-self-merge 396`.
3. If MERGE: `gh pr merge 396 --admin --merge`; mark task #52 completed; remove worktree.
4. If ESCALATE: message tech lead with criterion + values.
