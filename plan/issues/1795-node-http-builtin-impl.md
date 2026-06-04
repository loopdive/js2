---
id: 1795
title: "node:http (+ https) — GET round-trip host import (axios unblocker)"
status: ready
sprint: 60
created: 2026-06-03
updated: 2026-06-04
priority: high
feasibility: hard
reasoning_effort: high
task_type: feature
area: host-interop
language_feature: node-builtins
goal: npm-library-support
parent: 1575
related: [1044, 1032, 640, 1500]
depends_on: [1793, 1794]
---
# node:http (+ https) — GET round-trip host import (axios unblocker)

## Problem

axios (#1032, high priority) is the highest-value real-world target on the
backlog and it requires `node:http`/`node:https`. Today both are the opaque
`__node_http` / `__node_https` externref imports: `http.createServer` /
`http.get` lower through `__extern_method_call`, but the response is an
`EventEmitter` stream the compiled code cannot consume (no first-class
EventEmitter — see #1794) and bodies are `Buffer`s the compiled code cannot
unpack (no first-class Buffer — see #1793).

## Acceptance criteria

Tier 0 (JS-host target) — a single GET → string round-trip:

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

- Compiles, instantiates, and against a localhost test server returns the
  served body string through `cb`.
- `import { get } from "node:https"` resolves the same way (TLS plumbing is the
  host's; no extra Wasm surface).

## Implementation approach

1. **Depends on #1793 (Buffer) and #1794 (EventEmitter)** — the response
   `.on("data", chunk => chunk.toString())` chain needs both. Land those first.
2. Wire `http.get` / `http.request` as host imports that return an
   EventEmitter-shaped response object (reusing the #1794 callback contract).
3. This is the natural place to land the **bidirectional host-import
   contract**: Wasm passes a request descriptor out, host returns a response
   stream, Wasm reads via EventEmitter.
4. `createServer` and the full IncomingMessage/ServerResponse class surface are
   out of scope for Tier 0 (client GET only).
5. Standalone HTTP belongs to #640 (wasi:http/incoming-handler) — out of scope
   here; browser fetch is the parallel #1500 track.

## Test

`tests/issue-1795.test.ts` — spin up a localhost server, compile the Tier 0
`fetchText`, assert the returned body. Gate behind #1793 + #1794 landing.
