---
id: 1791
title: "node:path — typed host import + standalone TS-port fallback"
status: done
created: 2026-06-03
updated: 2026-07-26
completed: 2026-06-26
priority: high
feasibility: medium
reasoning_effort: medium
task_type: feature
area: host-interop
language_feature: node-builtins
goal: npm-library-support
sprint: Backlog
parent: 1575
assignee: ttraenkler/sd-2668c
es_edition: n/a
related: [1044, 1471, 1472, 1494, 1400, 1032, 3654]
---
# node:path — typed host import + standalone TS-port fallback

## 2026-07-26 ESLint integration note

The isolated #1791 runtime/standalone behaviour remains complete, but
`compileProject("node_modules/eslint/lib/linter/linter.js", { allowJs: true })`
still reports TS2307 for `require("node:path")` before codegen. The same graph
also misses installed packages and existing relative modules, so this is
tracked as importer-context/type-resolution issue #3654 rather than reopening
the already-delivered `node:path` runtime implementation.

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

`tests/issue-1791.test.ts` — compile each Tier 0 snippet and assert the
returned value, once with default JS-host config and once with
`--target wasi` (standalone).

## Resolution — landed (sd-2668c, 2026-06-26)

### Chosen approach: ONE pure-TS posix shim, both modes (no host import)

`path` is pure string compute, so a single TS port serves BOTH the JS-host and
standalone targets — no host import, no standalone trap. The "typed host import"
half of the title is unnecessary for posix; win32 is deferred. This is simpler
than the dual host-import-plus-fallback the issue sketched.

**Mechanism** (`src/import-resolver.ts`, `preprocessImports`):
- A prepended prelude of top-level posix functions `__js2wasm_path_*`
  (`buildPathShim`) — faithful port of Node `lib/path.js` posix:
  `normStr`/`normalize`/`join`/`resolve`/`dirname`/`basename`/`extname`/
  `isAbsolute`/`relative`. Prepended once (alongside the timer shim; combined
  prepend length feeds the position map).
- **Named import** (`import { join } from "node:path"`) → forwarding function
  declarations (`function join(...a){ return __js2wasm_path_join(...a); }`) +
  `const sep = "/"`. Robust: top-level variadic calls + spread-in-call compile
  fine.
- **Default/namespace import** (`import path from "node:path"`) → a `const path =
  { join(...), …, sep: "/" }` object of FIXED-arity wrapper methods. Variadic
  dispatch through an object field is currently miscompiled, so `join`/`resolve`
  wrappers are fixed 8-slot (`a:string=""…`) forwarders to the variadic
  top-level functions — `join`/`resolve` skip empty args, so padding is inert.
- `path` is excluded from `nodeBuiltins` (no `__node_path`) when shimmed.

### Scope guards (no regression)

- A **default** import is shimmed only when EVERY `path.<member>` access is in the
  supported surface (`pathDefaultFullySupported`); otherwise it stays on the
  legacy opaque `__node_path` host route — so programs using `path.parse` /
  `path.win32` / etc. (out of Tier-0 scope) do not regress in JS-host mode.
- Unsupported **named** path exports fall through to the existing generic stub.

### Verify-first dev notes (saved for the next dev)

- **`resolve` WasmGC type-merge bug:** `let path = "/"; path = args[i]` merges a
  string-constant global (distinct WasmGC type) with an array-element string
  under `nativeStrings`, producing an invalid `struct.get` (standalone compile
  error). Fixed by reading only array elements in the loop and prepending the
  cwd-root via concat (`resolvedPath = "/" + resolvedPath`) instead of a
  reassigned `let`.
- Standalone cwd fallback is `/` (no host cwd); win32, `path.posix`/`path.win32`,
  `parse`/`format` deferred.

### Surface covered (= exactly what ESLint + deps call)

`resolve, sep, join, dirname, relative, isAbsolute, extname, normalize` (grep of
`node_modules/eslint/lib`) + `basename` (Tier 0). This unblocks linter.js's only
`node:` import.

### Test results

- `tests/issue-1791.test.ts` — 6 cases, each run in BOTH host and standalone
  (`--target wasi`), all green. Covers all Tier-0 acceptance snippets (default +
  named), relative, and join/extname/dirname edge cases.
- `tests/issue-1575.test.ts` updated (the node:path "gap survey" tests now assert
  the gap is CLOSED) — 7 green, incl. new guards for the shim binding + the
  unsupported-member legacy fallback.
- No regressions in path-importing tests (issue-1400/1043/1081/host-import-
  allowlist-gate). `tsc --noEmit` clean. (issue-1296 missing-fixture +
  issue-1492 crypto-fnName failures are PRE-EXISTING on `upstream/main`,
  unrelated.)
