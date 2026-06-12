---
id: 1810
title: "node:path — typed host import + standalone TS-port fallback"
status: wont-fix
sprint: Backlog
created: 2026-06-03
updated: 2026-06-12
priority: high
feasibility: medium
reasoning_effort: medium
task_type: feature
area: host-interop
language_feature: node-builtins
goal: npm-library-support
parent: 1575
related: [1044, 1471, 1472, 1494, 1400, 1032]
---
# node:path — typed host import + standalone TS-port fallback

## Problem

`node:path` is the single highest-leverage Node builtin gap (blocks ESLint,
prettier, axios, TypeScript per the #1575 blocked-package matrix). Today it
resolves to the opaque whole-module externref import `__node_path`
(`registerNodeBuiltinImports`, `src/codegen/index.ts:9801`), so:

- Named imports (`import { join } from "node:path"`) compile to a generic
  `env` function stub `join`, never reaching the module object (see the
  2026-06-02 validation note in #1575).
- Standalone (WASI/browser) targets have no fallback at all — `path.join`
  traps.

`path` is pure string compute (no I/O), which makes it the cleanest builtin to
give a real standalone implementation.

## Acceptance criteria

Tier 0 (smoke test — must pass on **both** JS-host and standalone WASI):

- `path.join("/a", "b", "../c") === "/a/c"`
- `path.basename("/foo/bar.ts", ".ts") === "bar"`
- `path.dirname("/foo/bar.ts") === "/foo"`
- `path.extname("/foo/bar.ts") === ".ts"`
- `path.resolve("/a", "b") === "/a/b"`
- `path.sep === "/"` (posix)
- Both default-import (`import path from "node:path"`) and named-import
  (`import { join } from "node:path"`) forms resolve to the same code.

## Implementation approach

1. **Standalone fallback (preferred path):** port the posix subset of Node's
   `path` source into a TS shim compiled into the module — these are pure
   string functions, mirroring the #1473 error-helper TS-port pattern. Wire it
   so `import ... from "node:path"` binds to the shim's exports when no JS host
   `require` is available.
2. **Named-import recognition:** extend the `NODE_BUILTIN_FN_TYPED_STUBS` table
   (`src/import-resolver.ts:68`) — or a new pure-compute path-shim resolver — so
   `import { join } from "node:path"` no longer falls through to a generic
   `env` stub.
3. **JS-host fast path (optional):** for Node target, a `__nodefn__path__*`
   host import can short-circuit to the real `require("path")` for win32
   semantics; the standalone shim covers posix.
4. Defer win32 path semantics and `path.posix`/`path.win32` namespace objects
   to a follow-up; Tier 0 is posix-only.

## Test

`tests/issue-6401.test.ts` — compile each Tier 0 snippet and assert the
returned value, once with default JS-host config and once with
`--target wasi` (standalone).

## Closed as duplicate (2026-06-12)

Duplicate of #1791 (node builtin filed twice — renumber artifact). #1791 is canonical; both were parked on the npm front.
