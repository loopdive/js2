---
id: 1774
title: "wasi preview3 async stream semantics for Node stdout/stderr"
status: ready
created: 2026-06-01
updated: 2026-06-19
priority: medium
feasibility: hard
reasoning_effort: high
task_type: architecture
area: wasi
language_feature: wasi
goal: platform
sprint: Backlog
depends_on: [1042, 1326, 1575]
es_edition: n/a
related: [389, 1651, 1484]
origin: "Follow-up from guest271314's PR #1016 comment on fd_write synchrony wording."
---
# #1774 - wasi preview3 async stream semantics for Node stdout/stderr

## Problem

#1766 landed a narrow compatibility shim for `process.stdout.write(...)` /
`process.stderr.write(...)` under the current `wasi_snapshot_preview1` target.
That path emits a direct `fd_write` host call, returns `true`, and accepts
`once("drain", cb)` without modeling Node's EventEmitter or backpressure
semantics.

The implementation comment must not imply that the WASI Preview 1 specification
mandates synchronous stream semantics for `fd_write` or `fd_read`. The current
compiler behavior is an implementation shape of this target, not a general WASI
statement. Full stream/backpressure support belongs with WASI 0.3 / Preview 3
and the Component Model async ABI.

## Current grounding

- `--target wasi` currently imports from `wasi_snapshot_preview1` and lowers
  stdout/stderr writes to direct `fd_write` calls.
- WASI's public roadmap says 0.3 adds native async support to the Component
  Model, including `stream<T>` and `future<T>` in function parameters and
  results: https://wasi.dev/roadmap
- The Component Model explainer marks async as outside the Preview 2 stability
  milestone and part of a future gated feature set:
  https://github.com/WebAssembly/component-model/blob/main/design/mvp/Explainer.md
- The WASI I/O proposal is the right neighborhood for stream and pollable
  behavior when mapping host I/O to component-model interfaces:
  https://github.com/WebAssembly/wasi-io

## Acceptance

- Document the distinction between Preview-1-style direct host-call lowering
  and spec-level async stream semantics.
- Design how Node-compatible `Writable.write()` backpressure, `drain`, and
  callback/error behavior can map to WASI 0.3 `stream<u8>` / `future` shapes.
- Identify whether stdout/stderr should remain compile-away direct calls in
  Preview 1 while a separate component-model backend handles async I/O.
- Add tests or design fixtures that distinguish:
  - current direct `fd_write` lowering with `write()` returning `true`;
  - async backpressure/drain behavior when a WASI 0.3 stream backend exists;
  - unsupported mixed-mode behavior with clear diagnostics.
- Keep #1766's narrow shim intact until the compiler has a component-model
  backend capable of expressing the async stream contract.

## Notes

This issue deliberately does not reopen #1766. #1766 is a pragmatic Preview 1
compatibility fix. #1774 tracks the larger architecture needed to compile
Node-style stream semantics onto the async component-model surface once the
backend exists.
