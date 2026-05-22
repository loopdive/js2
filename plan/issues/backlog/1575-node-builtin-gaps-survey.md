---
id: 1575
title: "Node.js built-in module support — gap survey (js2wasm → npm)"
status: survey
created: 2026-05-20
priority: high
owner: tech-lead
area: runtime, host-imports
goal: npm-library-support
related: [1032, 1033, 1044, 1287, 1289, 1400, 1471, 1472, 1473, 1474, 1480, 1481, 1482, 1483, 1484, 1490, 1491, 1492, 1493, 1494, 1535, 640]
---

# Node.js built-in module support — gap survey

Companion to the parallel surveys (axios, React, TypeScript, ESLint
next-layer). Those map a **per-package** failure surface; this one maps the
**LANGUAGE-INDEPENDENT host-import surface** that any npm package built on
Node will pull through `src/import-resolver.ts`.

## Method

1. Walked `NODE_BUILTIN_MODULES` (`src/import-resolver.ts:16-50`,
   33 entries).
2. For each module, classified support level by tracing the code path:
   - `preprocessImports` (line 89) replaces the import with `declare const
     X: any`; the binding is added to `nodeBuiltins[]`.
   - `registerNodeBuiltinImports` (`src/codegen/index.ts:7447`) emits a
     **single host import** `__node_<module>` typed `() -> externref` that
     returns the require(module) object verbatim.
   - At call sites, member access + invocation goes through
     `__extern_method_call` (`src/runtime.ts:3391`).
   - A handful of modules have **inlined codegen** that bypasses the
     externref path: `fs` (#1491 readFileSync/writeFileSync, #1035 WASI
     path_open), `crypto` (#1492 randomBytes/randomUUID), `console` (#1493
     stderr routing — global, not import), `process` (#1490 argv/env,
     #1482 WASI environ_get).
3. Confirmed by grepping `src/` for `node:<mod>`, `__node_<mod>`,
   `node_builtin_fn`, `<module>.<method>` codegen dispatch.

## Glossary — what the levels mean

| Level | What runs | What breaks |
|-------|-----------|-------------|
| **None** | The import resolves to a stub `declare const X: any`; calls go through the opaque-externref host import. With a JS host that has `require`, methods work via runtime extern dispatch. **Standalone (WASI/browser): traps or returns undefined.** | Anything that needs the *shape* of the module at compile time (instanceof, structural typing, dependency injection). No standalone fallback. |
| **Partial** | A few named functions get dedicated host imports (`__node_fs_readFileSync` etc.) bound at instantiation; the rest fall through to the externref path. | Surface beyond the wired names; standalone targets still fail. |
| **Functional** | Enough surface is wired (host imports + types) that common npm packages compile, instantiate, and run on Node host. | Still typically no standalone (WASI/browser) coverage; performance-sensitive paths re-enter JS. |

> Today, the *highest* level reached anywhere is **Partial**, and only for
> `fs`, `crypto`, `console`, `process` after the #1490–#1494 wave landed.
> All 26 other entries in `NODE_BUILTIN_MODULES` are **None** (opaque
> externref pass-through, JS host required at run time).

## Per-builtin matrix

| Builtin              | Support | Implemented today                                              | Missing                                                                         | Blocked-package signal* |
|----------------------|---------|----------------------------------------------------------------|----------------------------------------------------------------------------------|-------------------------|
| `fs`                 | Partial | readFileSync, writeFileSync (#1491 host + #1035 WASI path_open) | existsSync, mkdirSync, statSync, readdirSync, promises API, streams, watch     | **ESLint, prettier, TypeScript** |
| `path`               | None    | Opaque externref (`__node_path`)                               | All of join/resolve/dirname/basename/extname/sep/posix-vs-win32                  | **ESLint, prettier, axios, TypeScript** |
| `url`                | None    | Opaque externref (`__node_url`)                                | URL class, URLSearchParams, fileURLToPath, pathToFileURL, parse/format (legacy) | **ESLint, prettier, axios** |
| `process`            | Partial | argv/env/exit/cwd/platform (#1490 in-review; #1482 WASI environ_get) | versions, hrtime, nextTick (→ #1326c microtasks), pid, stdin, signals          | **everything: ~universal use** |
| `console`            | Partial | log/warn/error/info/debug; WASI fd routing (#1493 done)         | dir, table, group, time/timeEnd, trace, assert, count                            | Every package (logging) |
| `buffer` / `Buffer`  | None    | Opaque externref (no `Buffer.from`, no global)                  | Buffer class (alloc/from/concat), toString encodings, slice/copy/write/readUInt | **axios, zlib consumers, crypto** |
| `crypto`             | Partial | randomBytes, randomUUID (#1492 in-review)                       | createHash/createHmac/createCipheriv, pbkdf2, scrypt, webcrypto.subtle, keys     | axios (uuid only), Express, ORM |
| `http`               | None    | Opaque externref                                                | createServer, request, get, IncomingMessage / ServerResponse classes, Agent     | **axios, Express, node-fetch** |
| `https`              | None    | Opaque externref                                                | Same as http + tls plumbing                                                      | **axios** |
| `http2`              | None    | Opaque externref                                                | Whole surface                                                                    | grpc-js, fastify h2 |
| `stream`             | None    | Opaque externref                                                | Readable/Writable/Transform classes, pipeline, finished, async iterators        | **axios, zlib, fs.createReadStream** |
| `stream/web`         | None    | Opaque externref                                                | ReadableStream / WritableStream / TransformStream (Web Streams)                 | undici, fetch-shaped libs |
| `events`             | None    | Opaque externref                                                | EventEmitter class (.on/.emit/.once/.off), `once()` helper                       | **axios, http, fs streams — basically all node code** |
| `util`               | None    | Opaque externref                                                | promisify, callbackify, inherits, types.*, format, inspect, isDeepStrictEqual   | TypeScript, ESLint plugins |
| `zlib`               | None    | Opaque externref                                                | gzip/gunzip/deflate/inflate (sync + stream), brotli                              | **axios (gzip responses)**, npm package extract |
| `querystring`        | None    | Opaque externref                                                | parse, stringify, escape, unescape                                               | axios (legacy form encoder), Express |
| `assert`             | None    | Opaque externref                                                | strict / deepStrictEqual / throws / rejects                                      | **ESLint internals**, jest internals |
| `os`                 | None    | Opaque externref                                                | platform, arch, homedir, tmpdir, cpus, networkInterfaces, EOL                    | prettier, ESLint config-loaders |
| `net`                | None    | Opaque externref                                                | Socket / Server classes                                                          | axios Unix-socket adapter, pg, mongo drivers |
| `tls`                | None    | Opaque externref                                                | createSecureContext, connect, TLSSocket                                          | https chain, db drivers |
| `dns`                | None    | Opaque externref                                                | lookup, resolve4/6, promises.Resolver                                            | axios (when bypassing http.get), pg, redis |
| `dgram`              | None    | Opaque externref                                                | createSocket UDP                                                                 | DNS resolvers, mdns |
| `cluster`            | None    | Opaque externref                                                | fork / worker management                                                         | Server frameworks (rarely) |
| `child_process`      | None    | Opaque externref                                                | spawn, exec, fork, execFile                                                      | **prettier (plugin loader)**, ESLint (plugin loader, formatter spawn), npm CLIs |
| `readline`           | None    | Opaque externref                                                | Interface (createInterface)                                                      | CLI prompts (inquirer family) |
| `string_decoder`     | None    | Opaque externref                                                | StringDecoder class                                                              | stream consumers, axios body decoder |
| `timers`             | None    | Opaque externref (setTimeout/setInterval are globals, not from this module; #1484 WASI stubs in-review) | setImmediate, clearImmediate, promises.setTimeout                                | **axios timeout**, async/retry libs |
| `tty`                | None    | Opaque externref                                                | isatty, ReadStream/WriteStream                                                   | chalk/colorette autodetect |
| `vm`                 | None    | Opaque externref                                                | createContext, runInContext, Script class                                        | ESLint preprocessor plugins, jest |
| `worker_threads`     | None    | Opaque externref                                                | Worker class, parentPort, MessageChannel, workerData                             | esbuild, parallel test runners |
| `perf_hooks`         | None    | Opaque externref (performance.now via WASI #1483 separately)    | performance.timerify, monitorEventLoopDelay, PerformanceObserver                 | benchmarking, observability |
| `async_hooks`        | None    | Opaque externref                                                | AsyncLocalStorage, createHook, executionAsyncId                                  | next.js context, OpenTelemetry |
| `diagnostics_channel`| None    | Opaque externref                                                | channel, subscribe, publish                                                      | OpenTelemetry, frameworks |
| **(global) `__dirname` / `__filename` / `import.meta.url`** | Partial | #1494 in-review                                                | Per-module dirname when multiple ESM modules link                                | **anything that reads files relative to itself** |

\* "Blocked-package signal" tracks which of the four parallel-surveyed
target packages (axios, React, ESLint, prettier, TypeScript) named the
builtin as a requirement (per #1032, #1287, #1289, #1400, #eslint-next-layer).
React is intentionally absent from most rows — it's the "no Node deps"
control. ESLint/prettier/TypeScript form the "node-CLI" cluster; axios
forms the "node-network" cluster.

## How "None" actually behaves at runtime

For a "None" builtin, **the import is not a hard compile error**:

1. `preprocessImports` turns `import http from 'node:http'` into
   `declare const http: any` (`src/import-resolver.ts:402`).
2. `registerNodeBuiltinImports` emits `__node_http: () -> externref`.
3. `resolveImport` (`src/runtime.ts:4751`) calls `require("http")` and
   returns the actual module object as externref.
4. `http.createServer({...}, handler)` lowers to `__extern_method_call`,
   which JS-side does `mod.createServer.apply(mod, args)`.

**This works on Node** as long as the caller has `require` and the args
are JS-coercible. It **fails everywhere else** (browser, WASI, standalone
wasmtime) because:
- `_getNodeRequire()` returns `null`,
- The host import resolves to `() => {}`,
- The method call traps on a missing property.

It also fails *on Node* when:
- The user code does `instanceof http.IncomingMessage` — extern objects
  don't participate in WasmGC instance tests.
- The callback signature is non-trivial (Wasm-side closures get
  serialized as extern stubs; `EventEmitter.on("data", fn)` can fire `fn`
  with a Buffer argument the Wasm side can't unpack — see #983).
- The return value is a stream the Wasm code tries to consume by
  property access on a hot path.

## Top 5 highest-leverage builtins to invest in

Ranking by (a) number of distinct target packages blocked, (b) breadth of
the package class they unlock, (c) implementation effort needed for a
**Tier 0** (smoke test — minimal surface) milestone.

### 1. `node:path` — pure compute, blocks ESLint/prettier/axios/TS

- Why: every CLI assembles paths; `path.join`/`path.resolve`/`path.dirname`
  fire in every module loader. Pure-string functions — no I/O — so a
  standalone fallback is feasible (port the Node sources into a
  user-mode TS shim, similar to what we did for #1473's error helpers).
- **Tier 0 test**: `path.join("/a", "b", "../c") === "/a/c"` and
  `path.basename("/foo/bar.ts", ".ts") === "bar"`.
- Implementation tier: host import (#1490-style) for Node target, with
  a TS-port fallback for WASI/standalone (#1471/#1472 pattern). Cost: low
  to medium.
- Cross-ref: blocks #1400 (ESLint), #1032 (axios), TypeScript survey.

### 2. `node:url` — URL/URLSearchParams, blocks ESLint/prettier/axios

- Why: `new URL(...)`, `URL.fileURLToPath`, `URLSearchParams` are
  *constructor* shapes — not method calls on a require()'d object — so
  the current `__node_url` opaque-externref path can't even reach them
  (you need `new url.URL(...)`, which our extern bridge does support, but
  most code writes the global form). URL is also a **WHATWG global** in
  Node and browsers, which makes it cleaner to expose as a host
  constructor.
- **Tier 0 test**: `new URL("./b", "file:///a/").pathname === "/b"` and
  `new URLSearchParams("a=1&a=2").getAll("a")` is `["1","2"]`.
- Implementation tier: bind `URL` / `URLSearchParams` as host
  constructors (like `Date` is wired). Standalone fallback would mean
  porting a tiny URL parser — defer to a follow-up. Cost: medium.
- Cross-ref: ESLint module loader (file:// paths), axios request
  serialization.

### 3. `node:buffer` + global `Buffer` — required by axios + crypto + zlib

- Why: Buffer underlies every `node:http` body, every `node:fs` non-utf8
  read, every `node:crypto` digest. Compiled code that touches *any* of
  these crashes on the very first `Buffer.from(...)` because Buffer is
  also a *global* — not just from `require("buffer")`. The opaque-extern
  path **can't** handle the global form at all; codegen needs to
  recognise `Buffer` as an extern class similar to how `Date` is treated.
- **Tier 0 test**: `Buffer.from("hi", "utf-8").toString("utf-8") === "hi"`
  and `Buffer.concat([Buffer.from("a"), Buffer.from("b")]).length === 2`.
  Bonus: passing a `Uint8Array` to a host import takes a Buffer
  view in JS-land without copying.
- Implementation tier: bind `Buffer` constructor and a handful of static
  methods as host imports; map `Buffer.prototype.{toString,slice}` to
  externref method dispatch. Cost: medium-high (encoding matrix is the
  long-tail).
- Cross-ref: #1032 (axios), zlib consumers, anything talking to fs binary.

### 4. `node:events` / global `EventEmitter` — universal Node primitive

- Why: every Node IO API (`fs.createReadStream`, `http.IncomingMessage`,
  `process` itself) is an `EventEmitter`. Subscribing from compiled code
  requires passing a Wasm closure as a host-side callback. The current
  `__extern_method_call` path *can* pass closures (#1382 wasm-closure JS
  bridge), but the receiver expects `(arg) => ...` JS shape, and the
  argument types (Buffer, Error) need to round-trip cleanly. Wire a
  first-class `EventEmitter` extern class with constrained event shapes.
- **Tier 0 test**:
  ```ts
  import { EventEmitter } from "node:events";
  const e = new EventEmitter();
  let got = 0;
  e.on("tick", (n: number) => { got = n; });
  e.emit("tick", 42);  // got === 42
  ```
- Implementation tier: host-import constructor + one round-trip closure
  pattern. Standalone fallback is feasible (EventEmitter is pure JS, ~200
  lines). Cost: medium; the long pole is the closure-callback contract.
- Cross-ref: unlocks #1032 (axios uses streams under the hood), prepares
  #640 (WASI HTTP) by exercising the same callback wiring.

### 5. `node:http` (+ `node:https`) — direct unblocker for axios

- Why: axios is the highest-value real-world target on the backlog
  (#1032 high priority). HTTP is also a natural place to land **the
  bidirectional host-import contract**: Wasm passes a request descriptor
  out, host returns a response stream, Wasm reads via `EventEmitter`
  (depends on #4 above). A Tier 0 here is a single "GET URL → string"
  round-trip — that alone validates the whole chain.
- **Tier 0 test**:
  ```ts
  import { get } from "node:http";
  function fetchText(url: string, cb: (s: string) => void): void {
    get(url, (res) => {
      let body = "";
      res.on("data", (chunk: any) => { body += chunk.toString(); });
      res.on("end", () => cb(body));
    });
  }
  ```
  Then test against a localhost server in CI.
- Implementation tier: depends on #3 (Buffer), #4 (EventEmitter). After
  those, http is "wire the host import." Standalone HTTP belongs to
  #640 (WASI HTTP / wasi:http/incoming-handler) — out of scope for
  Tier 0.
- Cross-ref: #1032, #640, #1500 (browser fetch — parallel design).

## Honourable mentions / fast-follows

- `node:util.promisify` — one function, unblocks every old-style
  callback API. Tier 0: `promisify(fs.readFile)(path) → Promise<Buffer>`.
- `node:assert` (strict) — needed by ESLint internals; pure compute, no
  host needed once #1473 (Wasm-native exceptions) lands.
- `node:os.platform/.arch/.homedir/.tmpdir` — three string constants
  resolved at runtime. ~30 lines for a host import + a standalone fallback
  reading `__wasi_runtime` env. Useful for prettier's config search.
- `node:querystring` — pure compute; could share code with the
  `URLSearchParams` from #2.

## Cross-references to open issues (#1487–#1494 and adjacent)

| Issue | Title | Status |
|-------|-------|--------|
| #1044 | Recognise Node builtin module specifiers (anchor) | done |
| #1470 | host-independence: eliminate JS host string ops | in-progress |
| #1471 | host-independence: eliminate JS host boxing/unboxing | in-progress |
| #1472 | host-independence: eliminate JS host object/property ops | in-progress |
| #1473 | host-independence: eliminate JS host error/exception ops | in-progress |
| #1474 | host-independence: eliminate JS host RegExp | in-progress |
| #1480 | wasi: console.error/warn → stderr (fd=2) | in-review |
| #1481 | wasi: readStdin via fd_read | done |
| #1482 | wasi: process.env via environ_get | in-review |
| #1483 | wasi: Date.now / performance.now via clock_time_get | in-review |
| #1484 | wasi: setTimeout/setInterval via poll_oneoff (or fail loud) | in-review |
| #1490 | nodejs: runtime process.argv / process.env | in-review |
| #1491 | nodejs: fs.readFileSync / writeFileSync as JS-host imports (non-WASI) | done |
| #1492 | nodejs: crypto.randomBytes / randomUUID host imports | in-review |
| #1493 | nodejs: console.error/warn → stderr (fd=2) — JS host mirror of #1480 | in-review |
| #1494 | nodejs: __dirname / __filename / import.meta.url | in-review |
| #1032 | Compile axios to Wasm (target) | ready |
| #1535 | js-host-dependency-audit-and-standalone-gap-research | sprint 52 (parent of #1470–#1474) |
| #640  | WASI HTTP handler (unlocks serverless) | ready (backlog) |
| #1400 | eslint-package-entry-valid-wasm | sprint 52 |
| #1287 | eslint-extern-entry-invalid-wasm | backlog |
| #1289 | eslint-linter-array-set-type-mismatch | backlog |

## Recommended sprint slice (proposal, not a commitment)

The four packages this work unblocks split cleanly along the matrix:

- **`path` + `url` + `__dirname`** (#1494 already in-review): unblocks
  *every* Node CLI (ESLint, prettier, TypeScript). No I/O — pure compute
  — so they double as standalone-mode wins (relevant to #1535's audit).
- **`Buffer` + `events`**: foundation for everything in the "node-network"
  cluster (axios, http frameworks). Specifically gates the Tier-0 axios
  benchmark in #1032.
- **`http` + `https`**: the demonstrator; lands on top of the previous
  two. Pairs with #640 for the WASI variant.

## Out of scope for this survey

- Wiring the actual implementations. Each of the top-5 deserves its own
  ticket with the Tier 0 test as the acceptance criterion.
- Standalone (WASI) coverage for #3–#5; treat that as a follow-up
  alongside #1535 / #1470–#1474.
- Web-platform globals (fetch, Web Streams, TextEncoder); see
  #1500/#1501 in the browser-host track.
