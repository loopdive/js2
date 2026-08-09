---
id: 1032
title: "Compile axios to Wasm — Node builtins routed as host imports; harvest error patterns"
horizon: l
status: ready
created: 2026-04-11
updated: 2026-07-17
priority: high
feasibility: hard
model: fable
reasoning_effort: high
goal: npm-library-support
sprint: current
depends_on: [1044]
---

# #1032 — Compile axios to Wasm as a real-world I/O stress test

## Goal

Use [axios](https://github.com/axios/axios) as an out-of-band stress test for the js2wasm compiler, with a specific focus on **Node.js built-in dependencies being treated as host imports** rather than compile errors.

axios is structurally different from the lodash stress test (#1031):

- **lodash** is pure compute — exercises language semantics, iteration, closures, prototype chain
- **axios** is I/O-oriented — exercises the _host boundary_: HTTP, streams, URL parsing, buffers, events, zlib, timers, environment detection

Compiling axios forces us to decide how js2wasm's runtime model handles Node.js builtins: they are not part of the ES spec, they are **host services**. The goal of this issue is to treat them as such — route them through host imports — rather than trying to compile or polyfill them. If we can compile axios's _pure_ code paths while the Node builtins flow through as imports, we get:

1. A working HTTP client that reuses the host runtime's Node implementation
2. A clean line between "compile it" and "import it"
3. An inventory of which Node builtins need first-class host import support

## Why axios specifically

- **Node-first library** with a browser adapter: both code paths exist side by side, letting us test both
- **TypeScript-typed:** ships `@types/axios` or its own `index.d.ts`
- **Production-grade:** used in millions of projects, so the code paths are well-exercised
- **Clear host boundary:** all I/O goes through `http`/`https`/`stream`, all serialization through `JSON`/`URLSearchParams`/`FormData`, all timing through `setTimeout`/`clearTimeout`. Nothing ambiguous about where the host starts.
- **Benchmark value:** once it works, axios becomes a reusable "can we run a real network client" integration test.

## Core design — Node builtins as host imports

**Principle:** when js2wasm encounters `import http from 'http'` (or the modern `import { request } from 'node:http'`), it should NOT attempt to compile the `http` module source. Instead:

1. Mark `http` as a host import module
2. Emit host imports for the specific symbols accessed (`http.request`, `http.createServer`, etc.) with externref types
3. At runtime, the Wasm instance receives those host functions from the JS Node runtime

This is the same pattern as `__extern_method_call` for generic JS object method dispatch, but applied at the module level. The list of Node builtins to treat as host imports:

- `http`, `https`, `http2`
- `url`, `querystring`
- `stream`, `stream/web`
- `events`
- `buffer`, `Buffer` (also a global)
- `zlib`
- `util` (limited — `util.promisify`, `util.inherits`, `util.types`)
- `path` (rarely used by axios, but included for completeness)
- `process` (global, needs careful handling — env detection is a common pattern)
- `net` (if axios uses Unix socket adapter)
- `tls` (https underlying)
- `fs` (axios doesn't need this — guard against compiling file uploads)
- `crypto` (axios uses for random IDs in interceptors)

**With or without the `node:` prefix.** Both `'http'` and `'node:http'` should resolve to the same host import set.

## Approach

### Step 1 — Pick a tractable subset

Compiling the whole axios entry point at once is ambitious. Start with the browser adapter only (no Node builtins), then add the Node adapter:

**Tier 1 — axios pure code, no adapter:**

- `axios/lib/utils.js` — utility helpers
- `axios/lib/helpers/bind.js`, `cookies.js`, `isAbsoluteURL.js`
- `axios/lib/core/buildFullPath.js`, `mergeConfig.js`
- `axios/lib/defaults/transitional.js`

**Tier 2 — core module graph without network:**

- `axios/lib/core/Axios.js`
- `axios/lib/core/InterceptorManager.js`
- `axios/lib/core/AxiosError.js`
- `axios/lib/core/CancelToken.js`
- `axios/lib/cancel/isCancel.js`

**Tier 3 — browser adapter (uses `XMLHttpRequest` / `fetch` — host imports):**

- `axios/lib/adapters/xhr.js`
- `axios/lib/adapters/fetch.js`

**Tier 4 — Node adapter (the main target of this issue):**

- `axios/lib/adapters/http.js` — imports `http`, `https`, `url`, `zlib`, `stream`, `util`, `follow-redirects`
- `axios/lib/helpers/buildURL.js`
- `axios/lib/helpers/formDataToStream.js` — imports `stream`
- `axios/lib/platform/node/*` — Node-specific platform helpers

**Skip entirely:**

- `follow-redirects` — third-party dependency, out of scope. Treat as host import.
- `form-data` — third-party dependency. Treat as host import.
- `proxy-from-env` — third-party. Host import.

### Step 2 — Extend the compiler to treat Node builtins as host imports

Currently js2wasm compiles TypeScript source and resolves `import` statements. For Node builtins, add a resolver hook:

```ts
// src/codegen/imports.ts (approximate)
const NODE_HOST_IMPORT_MODULES = new Set([
  "http",
  "https",
  "http2",
  "url",
  "querystring",
  "stream",
  "stream/web",
  "events",
  "buffer",
  "zlib",
  "util",
  "path",
  "process",
  "net",
  "tls",
  "fs",
  "crypto",
  // and the node: prefix variants
  ...[...above].map((m) => `node:${m}`),
]);

function resolveImport(modulePath: string): ResolvedImport {
  if (NODE_HOST_IMPORT_MODULES.has(modulePath)) {
    return {
      kind: "host",
      hostModule: modulePath.replace(/^node:/, ""),
      // emit externref import for each named symbol used
    };
  }
  // ... existing resolution
}
```

The import emission path should then generate a WIT-style externref import per used symbol, with the module name as the interface.

**At runtime** (JS host mode), the runtime.ts resolveImport handler receives the Node module name and imports the actual Node module:

```ts
if (importModule === "http" && importName === "request") {
  return require("http").request;
}
```

### Step 3 — Build a harness

Create `scripts/axios-stress.ts`:

```ts
import { compile } from "../src/index.ts";
import { readFileSync } from "node:fs";

const modules = [
  "axios/lib/utils.js",
  "axios/lib/helpers/bind.js",
  // ... tier list
];

for (const mod of modules) {
  const src = readFileSync(`node_modules/${mod}`, "utf-8");
  const result = await compile(src, {
    fileName: mod,
    nodeBuiltinsAsHostImports: true, // new compile flag
  });
  if (!result.success) {
    console.log(`FAIL ${mod}: ${result.errors[0]?.message}`);
  } else {
    console.log(`OK   ${mod}  (host imports: ${result.hostImports.join(", ")})`);
  }
}
```

### Step 4 — Categorize failures

Same technique as #1031 and `/regression-triage`: normalize error messages, bucket by pattern, sample each bucket, file follow-up issues. Expected buckets for axios:

- **Node builtin not yet in host-import list** → add to the set
- **Stream API coverage gap** — Node streams have a complex surface (Readable, Writable, Transform, pipe, pipeline, async iteration)
- **EventEmitter patterns** — `on`, `once`, `emit`, `removeListener`
- **Buffer/Uint8Array interop** — axios uses `Buffer` heavily; our Uint8Array story needs to interop
- **Promise chains with error handling** — axios wraps everything in Promise chains
- **Dynamic property access** — axios config objects are loosely typed; expect a lot of `any`-typed reads
- **Prototype inheritance** — `AxiosError extends Error`, interceptor chain
- **Async/await + cancellation** — CancelToken + Promise.race patterns

### Step 5 — Smoke test one real GET

Once Tier 4 compiles without errors, the ultimate acceptance test is:

```ts
const axios = await loadCompiledAxios();
const res = await axios.get("https://httpbin.org/get");
assert(res.status === 200);
assert(res.data.url === "https://httpbin.org/get");
```

This proves:

1. The compile pipeline handles Node-builtin imports correctly
2. The runtime wiring delivers real Node modules to the Wasm instance
3. Promise/async flow through the host boundary works
4. The response parsing path (JSON + headers) works end-to-end

### Step 6 — File follow-up issues

Same pattern as #1031: for each concentrated bucket, file an issue in `plan/issues/ready/` with `parent: 1032`.

Expected follow-ups (hypothetical):

- "Node http/https host imports — basic request/response flow"
- "Node stream Readable/Writable externref surface"
- "Buffer global + Buffer.from host import"
- "EventEmitter externref wrapper for 'on'/'emit' patterns"
- "process.env access as host getter"

### Step 7 — Update sprint doc

Append findings to `plan/issues/sprints/41/sprint.md`:

```markdown
## axios stress results

Total modules attempted: N
Compile OK: X (Y%)
Compile error: X
Runtime error: X

Node builtins used: <list>
Smoke test (GET httpbin.org): <PASS|FAIL>

Top error buckets:
<count> <pattern> → #<followup-issue>

Follow-up issues filed: #NNNN, #NNNN
```

## Acceptance criteria

- [ ] `scripts/axios-stress.ts` exists and runs against a local axios install
- [ ] `NODE_HOST_IMPORT_MODULES` set defined in the compiler (with the `node:` prefix handled)
- [ ] At minimum Tier 1 + Tier 2 compile cleanly (≥ 10 modules)
- [ ] Error bucket report committed/linked
- [ ] ≥ 3 follow-up issues filed
- [ ] Sprint 41 doc updated
- [ ] **Stretch goal:** one real HTTP GET against httpbin.org succeeds from Wasm

## Non-goals

- Compiling third-party axios dependencies (`follow-redirects`, `form-data`, `proxy-from-env`) — they are host imports
- Runtime parity with axios — partial is fine
- Standalone-mode support — Node builtins as host imports is by definition a JS-host-mode feature
- Browser adapter work (unless it falls out for free from Tier 1-3)

## Design notes

**Why not polyfill Node builtins?**

Because it's a bottomless pit. Node's `stream` module alone is ~5K lines of deeply stateful code with undocumented edge cases, and axios uses the _observable behavior_ of Node streams (including callback timing, backpressure semantics, and non-obvious async quirks). Re-implementing that in WasmGC is more work than js2wasm's compiler itself. The right call is: **let the host's Node do what Node does, and just import the symbols.**

**Why not compile them from the Node source?**

Even if we could, compiling Node builtins produces a second copy of their state (EventEmitter instances, stream buffers, etc.) that has to synchronize with the host's Node for I/O to work. That's a distributed systems problem masquerading as a compile target. Sharing the host's instances through externref is the correct factoring.

**The `node:` prefix.**

Modern Node modules can be imported with `node:http` as a disambiguator. The resolver should normalize — `node:http` and `http` are the same target.

**Runtime mode.**

This feature is JS-host-mode only. In `--target wasi` standalone mode, there is no Node to import from. The compiler should error cleanly when a module needs a Node builtin but WASI is the target.

## Related

- Sibling of: **#1031** (lodash stress test — complementary: lodash = compute, axios = I/O)
- Feeds into: future generic "compile any npm package" story
- Unblocks: future runtime benchmark using a real HTTP call path

---

## Architect Assessment (arch-npm-stress, 2026-04-11)

**Baseline commit:** 07ac0224

### Required compiler features

- Compile-time routing of `import ... from 'node:http'` (and `node:stream`, `node:buffer`, `node:zlib`, `node:events`, `node:util`, `node:url`, `node:querystring`, `node:process`, `node:path`, `node:crypto`, `node:net`, `node:tls`) to host-provided externrefs, **without** the `node:` prefix being significant (`'http'` === `'node:http'`).
- `Buffer` as a global extern class with common static methods (`Buffer.from`, `Buffer.concat`, `Buffer.byteLength`, `Buffer.isBuffer`).
- Real `async` / `await` suspension — axios is Promise-chain all the way down and its I/O completion depends on host microtask scheduling.
- `class AxiosError extends Error` with `Error.captureStackTrace` — already mostly works through extern classes, but `instanceof AxiosError` across the Wasm boundary is fragile.
- `Promise.all` / `Promise.race` with real concurrency (for CancelToken and timeouts).
- Dynamic property access on loosely-typed config objects (externref reads).
- EventEmitter `on`/`once`/`emit` as pass-through externref calls.

### Leverage TypeScript type information

axios ships its own `index.d.ts` (bundled via the `types` field in `package.json`). `ts.resolveModuleName` surfaces this automatically via `resolvedModule.extension === ".d.ts"` when `allowJs: true` is set on the `ts.Program`. Use the bundled types directly for axios signatures — no `@types/*` install needed. For the Node builtins flowing through **#1044** as host imports, use the `@types/node` declaration set to type `http.request`, `stream.Readable`, `Buffer`, etc., so the externref host-import emission picks up precise per-symbol signatures instead of generic `any`.

### Correction (2026-04-11): module graph already exists

Earlier wording claimed `node:http` imports fall through `preprocessImports` as `declare const http: any`. That is the single-file fallback path only. `compileProject` uses `ModuleResolver` (`src/resolve.ts:27`) + `resolveAllImports` (`src/resolve.ts:204`) + `compileMultiSource` (`src/compiler.ts:406`) to run a real ts.Program over the full transitive closure. Node-builtin _source_ will be walked into the ts.Program too, which is wrong for a different reason — Node builtins should be host imports, not compiled from Node's source — but the framing "no module resolver" was incorrect.

### Current compiler gaps

- **No Node host-import routing.** When `compileProject` encounters `import http from 'node:http'`, `ModuleResolver` either resolves to Node's built-in module shim (producing nonsense codegen) or to `null` (falls through to the single-file fallback in the calling layer). Neither path recognizes that `http`/`https`/`stream`/`buffer`/... should be external host imports. The fix is a pre-resolver hook that short-circuits Node-builtin specifiers to an extern-import mode _before_ the file walker tries to read them. Filed as **#1044**.
- **`await` is a no-op** at src/codegen/expressions.ts:973 (verified 2026-05-21 — was L790). `AwaitExpression` recurses into its operand and returns unchanged — no Promise integration, no microtask suspension, no state-machine lowering. Any code path that exercises real I/O completion observes synchronous resolution only. Tracked as **#1042**.
- **`Buffer` global not registered** as an extern class (unlike `Map`/`Set` at src/codegen/index.ts:2661). Needs to be added to the extern-class set with method signatures.
- **`process.env` reads** — axios reads `process.env.NODE_ENV` and `process.env.HTTP_PROXY` at startup. Partial handling today; **#1043** tracks compile-time `process.env.NODE_ENV` substitution + DCE specifically.

### Projected readiness (JS-host mode, via `compileProject`)

| Tier                                                                                  | Modules | Readiness                                                                           |
| ------------------------------------------------------------------------------------- | ------- | ----------------------------------------------------------------------------------- |
| Tier 1 — pure helpers (`utils.js`, `bind`, `cookies`, `buildFullPath`, `mergeConfig`) | ~8      | **~60%** once bundled; most fail on `Buffer` refs or ambient Node types             |
| Tier 2 — core (`Axios.js`, `InterceptorManager`, `AxiosError`, `CancelToken`)         | ~6      | **~30%** — interceptor chains use Promise chains heavily; `await` no-op breaks them |
| Tier 3 — browser adapter (`xhr.js`, `fetch.js`)                                       | ~2      | **~10%** — XHR/fetch globals undefined                                              |
| Tier 4 — Node adapter (`http.js`, `formDataToStream.js`, `platform/node/*`)           | ~6      | **~0%** until Node host-import scaffold lands                                       |

### Top 3 blockers

1. **`NODE_HOST_IMPORT_MODULES` compile-time routing (#1044)** — the core feature this issue proposes. Short-circuits `node:*` specifiers at the `ModuleResolver` entry so they never get walked as source.
2. **Real `async`/`await` state-machine lowering (#1042)** — research-level; depends on #680 (Wasm-native generators). Without this, Tier 4 smoke test (real GET) cannot succeed.
3. **`Buffer` global as extern class** — easy addition following the `Map`/`Set` pattern in src/codegen/index.ts:4100.

### Host-import scaffold status

**Nothing landed yet.** #1035 is the closest parallel work (WASI `node:fs`) but it routes through compile-time syscall translation, not externref host imports — two different mechanisms with overlapping surface. Recommend #1044 (Node externref host imports) and #1035 (WASI syscall translation) share the specifier-recognition hook at the top of `ModuleResolver.resolve` (`src/resolve.ts:130`).

### Implementation sketch

```ts
// src/resolve.ts — new pre-check inside ModuleResolver.resolve
const NODE_BUILTIN_MODULES = new Set([
  'http', 'https', 'http2', 'url', 'querystring',
  'stream', 'stream/web', 'events', 'buffer',
  'zlib', 'util', 'path', 'process',
  'net', 'tls', 'fs', 'crypto',
]);

function isNodeBuiltin(spec: string): boolean {
  const normalized = spec.replace(/^node:/, '');
  return NODE_BUILTIN_MODULES.has(normalized);
}

resolve(specifier: string, containingFile: string): string | null {
  if (isNodeBuiltin(specifier)) {
    // Return a sentinel that compileMultiSource recognizes as "do not walk as source,
    // emit externref host imports per used symbol at codegen time."
    return HOST_IMPORT_SENTINEL;
  }
  // ...existing ts.resolveModuleName call
}
```

At runtime, `src/runtime.ts` receives the `importModule` + `importName` and resolves via `require(importModule)[importName]`. Same pattern as today's `__extern_*` dispatch but scoped to Node builtins.

**Recommendation:** axios Tiers 1-3 can be attempted today via `compileProject` — they are pure compute and their only multi-file dependency is on other axios files, which `ModuleResolver` already handles. Tier 4 (Node adapter, real GET) is gated on **#1044** (Node host imports) and **#1042** (real `await`). Even Tiers 1-3 compile-cleanly is a valid sprint-41 result.

---

## Progress (2026-07-17, dev-1044) — incremental slice; #1044 now merged

**Context:** the core dependency **#1044** (Node builtins routed as host imports)
merged via **#3233**, so the compile-time routing this issue proposed now exists.
Re-ran the Tier 1 ladder against current `main` (axios@1.16.1) to bank recovered
ground and re-map the frontier. This is an incremental slice — axios is NOT
fully compiling yet (the flagship goal remains open).

### Landed this slice

- **Tier 1g `lib/utils.js` now compiles AND validates** (~84 KB module,
  deterministic across runs). The historical **#TBD-3** blocker (`isBuffer` —
  `fallthru[0] expected i32, got f64`, the i32/f64 `&&`/`fallthru` unification
  family shared with ESLint #1558 and React-tier1 `mapIntoArray`) no longer
  reproduces. Unskipped the Tier 1g rung in `tests/stress/axios-tier1.test.ts`
  as a permanent regression guard, and refreshed the file's blocker-status
  header to current reality.

### Current frontier (verified 2026-07-17, where axios's compile stops next)

| Rung  | Entry                                   | State                         | Next blocker                                                                                                                                                                                                                                                                                                                            |
| ----- | --------------------------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1a/1b | `import axios from "axios"` (type-only) | OK + validates                | —                                                                                                                                                                                                                                                                                                                                       |
| 1c    | `dist/node/axios.cjs` (direct)          | **compile-FAIL**              | `Cannot find module 'form-data'` — a third-party bare import. Per this issue's design, `form-data`/`follow-redirects`/`proxy-from-env` should route as **host imports**, not module-not-found. Next tractable resolver slice.                                                                                                           |
| 1g    | `lib/utils.js`                          | **OK + validates**            | — (recovered this slice)                                                                                                                                                                                                                                                                                                                |
| 1h    | `lib/core/AxiosError.js` (direct)       | **compile-FAIL (entry-only)** | TS1093 "Type annotation cannot appear on a constructor declaration" (JSDoc `@returns {Error}` on the ctor) + TS2339/2353 cascade. These are `checkJs`-style diagnostics that are fatal **only for an entry JS file** — as a graph _dependency_ they are filtered by `compiler.ts` `isEntryDiag`, so this does NOT block the real graph. |
| 1e    | `lib/axios.js` (real graph)             | **hang/OOM**                  | `compileProject` non-termination on the `lib/core/Axios.js` graph — tracked as **#3339**; the dominant real-graph blocker.                                                                                                                                                                                                              |

### Recommended next slices (ordered by tractability)

1. **Third-party bare-specifier → host-import stub** (unblocks 1c): treat an
   unresolvable non-relative import (`form-data`, `follow-redirects`,
   `proxy-from-env`) as an extern host import instead of a hard
   module-not-found — the exact `NODE_HOST_IMPORT_MODULES` pattern #1044
   established, widened to allowlisted third-party deps. Medium.
2. **#3339** — the `Axios.js`-graph hang/OOM. Hard; the real Tier 1e/1f gate.
3. Optional: relax entry-file `checkJs` semantic diagnostics for `allowJs` JS
   entries (unblocks isolated 1h/1d probing only; not the real graph).
