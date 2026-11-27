---
id: 7516
title: "JS host: boundary gaps left after #7504 (nested args, host throws, callback strings, returned closures)"
status: backlog
sprint: Backlog
created: 2026-11-26
updated: 2026-11-26
priority: low
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: runtime
goal: core-semantics
related: [7504, 7501, 1795, 2701]
---

# #7516: `node:` builtin boundary gaps left after #7504 (JS host)

Low priority: the JS-host lane is being sunset (project-lead decision,
2026-10-10). #7504 (PR #7461) repaired **top-level primitive** arguments to
`node:` builtins. RV7461 found four remaining gaps on PR #7461 (comment
7190962859); this file records them with that review's repros. Nothing here is
fixed.

## 1. Nested options and arrays still reach Node as raw structs

An object or array argument arrives as an opaque `[Object: null prototype] {}`,
on main and after #7504 alike. With real `fs/promises`:

- `mkdir(p, { recursive: true })`: `recursive` is lost, so it fails with
  `ENOENT`;
- `writeFile(p, d, { flag: "wx" })`: `flag` is ignored;
- `writeFile(p, d, { encoding })` works only because utf8 is Node's default.

Called from an `async` export, the rejection becomes an unhandled rejection: the
same class of detector integrity error #7501 removes, though no root test hits
it today.

Possible fix (RV7461): for a non-closure struct, fall back to the existing
boundary view, the way `_nativeBoundaryToHost` does (`_wrapForHost`), not a new
converter.

## 2. A host `TypeError` escapes a Wasm `try/catch`

`https.get("not-a-valid-url")` throws `TypeError: Invalid URL` synchronously, and
the Wasm `try/catch` around the call does not catch it. It became visible only
because #7504 lets the URL reach Node.

- In `tests/issue-1795.test.ts` (`node:https get binds the same way`) this is
  a **test failure, not an unhandled error**. Measured on #7504's head
  db1b3c0fa3: 0 unhandled errors in that file. So it does not break the
  `issue-tests` gate's integrity step.
- It is an exception-boundary gap, not a raw-exports harness defect (class B).

## 3. Host-to-Wasm callback strings read as `typeof "object"`

A host string that a builtin passes into a Wasm callback reads as
`typeof a === "object"` inside Wasm, and `a === "host-string"` is `false`. This
matters for `res.on("data", chunk => ...)`-style APIs. `wrapUnknownCallable` is
unchanged by #7504. RV7461 observed this on #7504's head only; it is not A/B
checked on main.

## 4. The converter is injected through two seams

`wrapConsoleForHost(..., _nativePrimitiveToHost, _MISS)` and the new
platform-capability context fields (`nativePrimitiveToHost`, `nativeMiss`)
inject the same converter. The console path could use the context's
`nativePrimitiveToHost`. Also, the interface doc says "string, symbol, boxed
number", but the converter also handles boolean, BigInt and the null/undefined
carriers.

## 5. A closure returned to JS through `wrapCompiledExports` is not a function

Addendum from S25, measured on main 1a726b3e: an exported function that
returns a closure gives JS a null-prototype `{}` instead of a function.

```ts
export function getOrdinary(): any {
  return (): void => {};
}
```

A plain `mk() { return () => {}; }` does the same. The result is the same with
the IR on and off. S25 found it via the issue-3214 native rewrite; the
acceptance case is in #7520's file.

## Acceptance criteria (when picked up)

- Nested option objects reach Node as host objects (gap 1 repros pass).
- A host throw inside a Wasm `try` is catchable there (gap 2).
- A host string passed into a Wasm callback reads as a string (gap 3).
- One injection seam for the converter (gap 4).
- A closure returned through `wrapCompiledExports` is callable from JS (gap 5).
