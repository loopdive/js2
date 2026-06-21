---
id: 1766
title: "process.stdout.write backpressure / once('drain') pattern not supported"
status: blocked
created: 2026-06-01
updated: 2026-06-19
priority: medium
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: host-interop
language_feature: node-streams
goal: platform
sprint: Backlog
depends_on: [1042, 1326, 1575]
es_edition: n/a
related: [389, 1042, 1326, 1575, 1753]
origin: "GitHub #389 guest271314 comment 2026-06-01T00:17:59Z"
---
# #1766 — `process.stdout.write` backpressure / `once("drain")` pattern

## Problem

guest271314's Node-flavoured native-messaging chunk writer used the standard
stream backpressure pattern:

```js
const writeAndDrain = async (data) => {
  if (!process.stdout.write(data)) {
    await new Promise((resolve) => process.stdout.once("drain", resolve));
  }
};
```

In the working js2wasm version, he had to remove that code and call
`process.stdout.write(...)` synchronously. That is acceptable as a short-term
WASI example workaround, but it is a real Node API compatibility gap: Node's
`stdout.write()` returns a boolean and streams expose EventEmitter-style
`once("drain", ...)`.

Source: <https://github.com/loopdive/js2/issues/389#issuecomment-4588674539>

## Scope

This is not required for the immediate byte-exact native-messaging echo path,
but it should be tracked because `js2wasm` is intentionally mimicking Node APIs
rather than inventing bespoke builtins.

Needed pieces:

- `process.stdout.write(chunk)` / `process.stderr.write(chunk)` should expose a
  Node-compatible return shape. For the current WASI Preview 1 direct `fd_write`
  lowering, returning `true` is a reasonable first implementation.
- `process.stdout.once("drain", cb)` should compile. In the WASI synchronous
  path it can be a no-op or immediate callback if writes never report
  backpressure.
- The async wrapper should compile without invalid Promise/microtask output.

## Blocking context

This is blocked on broader async/EventEmitter work:

- #1042 — async/await state-machine lowering.
- #1326 — standalone microtask queue.
- #1575 — Node builtin / EventEmitter gap survey.

## Acceptance

- A minimal `writeAndDrain` helper compiles and runs under `--target wasi`.
- `process.stdout.write` returns `true` for the synchronous WASI implementation.
- `process.stdout.once("drain", cb)` is accepted and documented as an immediate
  no-op/never-needed path under WASI, or wired to a real stream bridge in
  JS-host mode.
- The #389 chunking code can keep the idiomatic Node backpressure helper without
  source edits.

## Implementation notes — 2026-06-01

Preview-1 direct-call WASI compatibility landed locally:

- `process.stdout.write(...)` / `process.stderr.write(...)` now leave `true`
  (`i32.const 1`) on the stack after the direct `fd_write` helper call, so
  `if (!process.stdout.write(bytes)) { ... }` does not enter the drain branch
  under WASI.
- `process.stdout.once("drain", cb)` / `process.stderr.once("drain", cb)` now
  compile as a WASI-only no-op for literal `"drain"`, avoiding JS-host
  EventEmitter imports.
- The lowering lives in `src/codegen/node-process-api.ts`, not inline in the
  generic call-expression compiler, and regression coverage imports
  `process` from `node:process` to keep this shaped like a Node API module.
- Regression coverage: `tests/issue-1766.test.ts` pins raw byte output,
  string-write return behavior, and absence of `__extern_method_call`,
  `__extern_get_method`, and `__node_process` imports.

Remaining blocked scope: the fully idiomatic async helper
`await new Promise((resolve) => process.stdout.once("drain", resolve))` still
depends on the broader async/EventEmitter work tracked by #1042/#1326/#1575.
Future implementation work should stay in the Node process API lowering module
(`src/codegen/node-process-api.ts`) rather than drifting back into generic call
expression lowering.
