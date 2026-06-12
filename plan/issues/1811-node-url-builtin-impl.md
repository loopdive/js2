---
id: 1811
title: "node:url — URL / URLSearchParams as host constructors"
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
related: [1044, 1494, 1400, 1032]
---
# node:url — URL / URLSearchParams as host constructors

## Problem

`node:url` blocks ESLint, prettier, and axios (#1575 matrix). The current
`__node_url` opaque-externref path cannot reach the most common usage forms
because `URL` and `URLSearchParams` are **constructor** shapes, usually written
as the WHATWG globals `new URL(...)` / `new URLSearchParams(...)` rather than
method calls on a `require("url")` object. Codegen does not recognise these as
extern classes, so `new URL(...)` does not lower to the host constructor.

## Acceptance criteria

Tier 0 (JS-host target — standalone deferred):

- `new URL("./b", "file:///a/").pathname === "/b"`
- `new URL("https://x.com/p?q=1").searchParams.get("q") === "1"`
- `new URLSearchParams("a=1&a=2").getAll("a")` deep-equals `["1","2"]`
- `url.fileURLToPath("file:///a/b.js")` returns `/a/b.js`
- Both the global form (`new URL(...)`) and the import form
  (`import { URL } from "node:url"`) resolve to the same host constructor.

## Implementation approach

1. Bind `URL` and `URLSearchParams` as **host constructors**, modeled on how
   `Date` is wired (extern class with `new` lowering + method dispatch through
   `__extern_method_call`). The WHATWG globals are present in both Node and
   browsers, so the same binding serves both hosts.
2. Recognise the global identifiers `URL` / `URLSearchParams` in codegen so
   `new URL(...)` without an import still binds (they are ambient globals in TS
   lib.dom / lib.node).
3. Map `url.fileURLToPath` / `url.pathToFileURL` as named host imports
   (`__nodefn__url__fileURLToPath`).
4. Defer the standalone (WASI) fallback — a pure-TS URL parser port — to a
   follow-up; it can share the percent-encode/decode helpers with a future
   `querystring` shim.

## Test

`tests/issue-6402.test.ts` — compile each Tier 0 snippet under JS-host config
and assert the result against the host's native `URL`.

## Closed as duplicate (2026-06-12)

Duplicate of #1792 (node builtin filed twice — renumber artifact). #1792 is canonical; both were parked on the npm front.
