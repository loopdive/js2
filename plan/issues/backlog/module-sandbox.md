---
id: module-sandbox
title: "Module sandbox — compile npm packages with explicit imports, no ambient host access"
status: planned
priority: high
feasibility: hard
reasoning_effort: max
goal: security
task_type: design+implementation
area: codegen
language_feature: module-system
created: 2026-04-23
---

# Module sandbox — compile npm packages with explicit imports

## Problem

When js2wasm compiles an npm package to Wasm, the compiled module runs inside
a host (browser or Node.js). The current JS-host mode grants the module broad
access to host globals through the import mechanism and through the `eval`
escape hatch. A malicious or compromised dependency could:

- Access `window`, `document`, `localStorage`, cookies, DOM
- Call `fetch`, `XMLHttpRequest`, arbitrary network APIs
- Use `Function(...)` / `eval(...)` to generate and run arbitrary code
- Access `process.env`, `require`, `__dirname`, Node.js internals
- Exfiltrate secrets or sensitive data visible in JS global scope
- Escalate to further code execution via prototype pollution

The compiled Wasm binary **should** be a sandboxed capability boundary. Today
it is not — any npm package compiled through js2wasm inherits the full JS
global scope of its host.

## Goal

Define a compilation strategy and runtime import adapter so that:

1. **All host access is explicit** — the compiled module's Wasm import section
   declares every host capability it needs. Nothing is granted implicitly.
2. **Dangerous APIs are denied by default** — `eval`, `Function`, dynamic
   `import()`, `require`, `process`, `fetch`, `XMLHttpRequest`, DOM APIs are
   blocked unless the host explicitly grants them.
3. **npm imports are resolved at compile time** — `import { readFile } from 'fs'`
   becomes an explicit Wasm import `(import "node:fs" "readFile" ...)`, not
   ambient `globalThis.require('fs')`.
4. **The import adapter is auditable** — a host instantiating the module passes
   a typed `imports` object; any API not in that object is unavailable to the
   module. The adapter can be statically analyzed for what it exposes.

---

## Part 1 — Import analysis: what does an npm package actually need?

### 1.1 Categories of host access

| Category | Examples | Risk level |
|---|---|---|
| Pure computation | Math, Date, JSON, TypedArray | Low — no side effects |
| Console / logging | `console.log`, `process.stdout` | Low — write-only |
| Filesystem | `node:fs`, `node:path` | Medium — read/write |
| Network | `fetch`, `http`, `XMLHttpRequest` | High — exfiltration |
| Environment | `process.env`, `os.homedir()` | High — secrets |
| Crypto | `node:crypto`, `SubtleCrypto` | Medium — key material |
| DOM | `document`, `window`, `localStorage` | High — ambient scope |
| Code generation | `eval`, `Function`, dynamic `import()` | Critical — sandbox escape |
| IPC / child process | `child_process`, `worker_threads` | Critical |

### 1.2 Typical npm package import surface

A survey of common npm packages (express, lodash, chalk, zod, date-fns, axios,
uuid, etc.) shows most pure utility packages need only:

- `Math.*`, `Date`, `JSON`, `Array`, `Object`, `String` — all pure
- `console.*` — write-only, no secrets
- `process.env.*` — only for config packages
- `node:crypto` (uuid, bcrypt, etc.) — bounded, auditable
- `node:fs` (config loaders, build tools) — bounded

Very few utility packages need network or DOM access. A whitelist covering
the above eliminates 95% of the attack surface.

---

## Part 2 — Compiler strategy: explicit import lowering

### 2.1 Current behavior

Today, when a compiled module calls `Math.random()`, the codegen emits a
host import `(import "js" "Math.random" (func ...))`. This works but is
**unstructured** — the import name is an opaque string, and there's no
enforcement at instantiation time.

For npm packages, `import { foo } from 'some-package'` is resolved by the
bundler/TypeScript compiler before js2wasm sees it. The resulting code calls
`foo()` as if it were a local function. js2wasm needs a strategy for
cross-package imports.

### 2.2 Proposed: module-scoped Wasm imports

Each npm package import becomes a Wasm import namespace:

```wat
;; import { readFileSync } from 'node:fs'
(import "node:fs" "readFileSync" (func $node_fs_readFileSync (param externref i32) (result externref)))

;; import { createHash } from 'node:crypto'
(import "node:crypto" "createHash" (func $node_crypto_createHash (param externref) (result externref)))
```

The host instantiates the module with an explicit `imports` object:

```js
const imports = {
  "node:fs": {
    readFileSync: (path, opts) => sandboxedFs.readFileSync(path, opts),
  },
  "node:crypto": {
    createHash: (alg) => sandboxedCrypto.createHash(alg),
  },
  // "fetch" not present → any fetch call traps at the Wasm boundary
};
const instance = await WebAssembly.instantiate(binary, imports);
```

Any import not in the `imports` object causes `WebAssembly.instantiate` to
throw — the module cannot be instantiated without explicitly granting each
capability. This is enforced by the Wasm spec itself.

### 2.3 Global scope interception

The current codegen accesses `globalThis.*` implicitly. In sandbox mode, the
compiler should:

1. **Intercept known globals** — `Math`, `JSON`, `Date`, `console`, `Array`,
   `Object`, `String`, `Number`, `Boolean` are imported explicitly as
   `(import "globals" "Math" ...)` rather than accessed via `global.get`.
2. **Deny unknown globals** — any `globalThis.X` access where X is not in the
   allow-list emits a compile-time warning and a runtime trap.
3. **Deny `eval` / `Function`** — compile-time error in sandbox mode (or
   route through #1164's capability-gated eval shim).

### 2.4 Compiler flag: `--sandbox`

Add a `--sandbox` flag to the compiler CLI:

```
js2wasm input.ts --sandbox [--allow node:fs] [--allow node:crypto]
```

In sandbox mode:
- All globals require explicit `--allow` or are denied
- `eval` / `Function` / dynamic `import()` are blocked
- Output includes a manifest of all declared imports (JSON sidecar)
- The import manifest is machine-readable for policy enforcement

---

## Part 3 — Import adapter: capability-safe wrappers

### 3.1 Node.js adapter

A sandboxed Node.js host adapter wraps each allowed module:

```ts
// sandbox/adapters/node-fs.ts
export function createNodeFsAdapter(options: {
  allowedPaths: string[];     // path prefix allow-list
  readonly: boolean;
}): typeof import('node:fs') {
  return {
    readFileSync(path, opts) {
      if (!options.allowedPaths.some(p => path.startsWith(p))) {
        throw new Error(`sandbox: fs access denied: ${path}`);
      }
      return fs.readFileSync(path, opts);
    },
    writeFileSync(path, data, opts) {
      if (options.readonly) throw new Error('sandbox: fs is readonly');
      // ...
    },
    // unlisted methods throw by default
  };
}
```

### 3.2 Browser adapter

```ts
// sandbox/adapters/browser.ts
export function createBrowserAdapter(options: {
  allowConsole: boolean;
  allowFetch: string[];   // URL prefix allow-list, [] = deny all
}): Record<string, unknown> {
  return {
    console: options.allowConsole ? console : noopConsole,
    fetch: options.allowFetch.length > 0
      ? (url, init) => {
          if (!options.allowFetch.some(p => url.startsWith(p))) {
            throw new Error(`sandbox: fetch denied: ${url}`);
          }
          return fetch(url, init);
        }
      : () => { throw new Error('sandbox: fetch not allowed'); },
    // eval / Function / document / window — always absent
  };
}
```

### 3.3 Adapter manifest

Each adapter emits a static manifest of what it exposes:

```json
{
  "granted": ["node:fs.readFileSync", "node:crypto.createHash", "console.log"],
  "denied": ["fetch", "eval", "Function", "process.env", "document"],
  "restricted": ["node:fs.writeFileSync (readonly mode)"]
}
```

The manifest can be committed to a repo and reviewed in PRs — any capability
expansion shows up as a diff.

---

## Part 4 — Escape prevention

### 4.1 Known escape vectors

| Vector | Mitigation |
|---|---|
| `eval(str)` | Compile-time error in `--sandbox` mode; or route through #1164 capability-gated shim |
| `new Function(str)` | Same as eval |
| `import(dynamic)` | Blocked at compile time in sandbox mode |
| `require(dynamic)` | Blocked — require is not in the import adapter |
| `globalThis[key]` | Dynamic property access on globalThis emits a compile-time warning; in strict sandbox, traps |
| `Object.prototype.__proto__` | Prototype pollution — WasmGC structs have no JS prototype; not applicable |
| `process.binding()` | process not in adapter → traps |
| `Buffer.allocUnsafe` | Buffer not granted by default |
| `XMLHttpRequest` | Not in browser adapter unless explicitly added |
| `WebSocket` | Same |
| `SharedArrayBuffer` + Atomics | Deny by default (side-channel risk) |

### 4.2 Static analysis pass

Add a compile-time `--sandbox-audit` flag that reports:
- Every global access in the module (direct + transitive through imports)
- Every import from the allow-list
- Every blocked access (would trap at runtime)
- Confidence level: "proved safe" / "dynamic (may escape)" / "unknown"

---

## Part 5 — npm package compilation workflow

```
npm install some-package
js2wasm node_modules/some-package/dist/index.js \
  --sandbox \
  --allow node:fs \
  --allow node:crypto \
  --output some-package.wasm \
  --manifest some-package.imports.json
```

The `.imports.json` manifest is shipped alongside the `.wasm` binary. At
instantiation time, the host reads the manifest, constructs the adapter, and
instantiates:

```js
import { createAdapter } from 'js2wasm/sandbox';
import manifest from './some-package.imports.json';

const adapter = createAdapter(manifest, {
  'node:fs': { allowedPaths: ['/tmp/'], readonly: false },
  'node:crypto': true,  // grant with defaults
});
const { instance } = await WebAssembly.instantiate(wasmBinary, adapter.imports);
```

---

## Acceptance criteria

1. `--sandbox` flag exists; in sandbox mode `eval` / `Function` / dynamic
   `import()` are compile errors
2. npm package imports lower to explicit Wasm import namespaces
   (`"node:fs" "readFileSync"`) rather than ambient globals
3. A module compiled with `--sandbox` cannot be instantiated without
   explicitly providing every import it declares
4. Reference adapters for Node.js (`node:fs`, `node:crypto`, `node:path`)
   and browser (`console`, `fetch` with URL allow-list) ship in `src/sandbox/`
5. `--sandbox-audit` outputs a capability manifest (JSON) listing granted,
   denied, and dynamic-access imports
6. Equivalence tests for a sandboxed uuid package and a sandboxed lodash
   subset pass
7. No regressions in `tests/equivalence.test.ts`

## Related

- #1164 — dynamic eval via Wasm JS API (eval escape hatch — sandbox mode gates this)
- #1163 — static eval inlining (safe; inlined at compile time, no runtime escape)
- CLAUDE.md "dual-mode" principle — sandbox adapter is the JS-host side of the capability boundary
- Wasm Component Model / WIT — longer term, WIT interfaces formalize the capability surface
