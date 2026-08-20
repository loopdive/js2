---
id: 4571
title: "Provide path-based node:fs and node:fs/promises through WASI preopens"
status: backlog
created: 2026-08-20
updated: 2026-08-20
priority: high
feasibility: hard
reasoning_effort: high
task_type: feature
area: runtime, linker, wasi
language_feature: node-fs-wasi-provider
goal: standalone-mode
sprint: Backlog
depends_on: [2512, 4570]
horizon: l
es_edition: n/a
related: [1035, 1772, 2632, 3640, 4565]
origin: "2026-08-20 Node API compatibility and portability review"
---
# #4571 — Provide path-based `node:fs` through WASI preopens

## Objective

Ship a linkable WASI provider for the initial path-based `node:fs` and
`node:fs/promises` surface, using explicit preopened-directory capabilities and
the shared observable contract from “Share Node-compatible filesystem
validation and errors across providers” (#4570).

## Architecture

The user module declares the real imports it needs, such as
`node:fs::readFileSync` or `node:fs/promises::stat`. Link-time provider
selection may satisfy those imports with the real Node modules, a JS adapter,
or the WASI provider. The compiled module must not expose an
implementation-specific shim namespace or inline WASI filesystem policy in
call-expression codegen. The observable contract is owned by “Share
Node-compatible filesystem validation and errors across providers” (#4570).

The provider owns:

- discovery and normalization of configured preopened directories;
- capability-safe relative path resolution;
- `path_open`, fd read/write/close, stat, directory creation, and unlink
  mappings needed by the initial surface;
- byte/string encoding and result marshalling;
- conversion of WASI errors into the shared stable Node error fields;
- asynchronous scheduling for `node:fs/promises` through the existing runtime
  provider, without presenting synchronous completion as Node-equivalent.

## Initial surface

- sync: `readFileSync`, `writeFileSync`, `statSync`, `mkdirSync`, `unlinkSync`;
- Promise: `readFile`, `writeFile`, `stat`, `mkdir`, `unlink`;
- `string`, `Uint8Array`/Buffer-compatible data, and the explicitly supported
  encoding/options forms selected by “Share Node-compatible filesystem
  validation and errors across providers” (#4570).

## Acceptance criteria

- [ ] The provider discovers configured preopens; it does not assume that the
      first directory is fd 3 or silently substitute the process cwd.
- [ ] Paths outside the granted preopen capability fail with a stable,
      Node-shaped error and cannot escape through `..`, separator, or symlink
      handling.
- [ ] The initial sync and Promise members pass their applicable differential
      fixtures against Node for values, stable errors, and ordering.
- [ ] Missing preopens and unsupported operations produce explicit capability
      results before any API-shaped placeholder can be returned.
- [ ] `node:fs/promises` uses the shared async runtime and settles exactly once;
      focused tests distinguish immediate, microtask, and event-loop ordering.
- [ ] Link tests prove that only used members and their transitive WASI imports
      appear, and that a program with no filesystem use links none of them.
- [ ] The provider works in both WasmGC and linear standalone lanes, or each
      unsupported lane reports a stable reason with a maintained denominator.

## Out of scope

- Ambient unrestricted filesystem access.
- `watch`, streams, file locking, ownership, or the complete metadata surface.
- Treating fd-based stdio operations as requiring filesystem preopens.
