---
id: 3325
title: "declare function host-dep call is silently dropped (env import bound but never called)"
status: done
created: 2026-07-16
updated: 2026-07-26
completed: 2026-07-17
priority: medium
feasibility: medium
task_type: bugfix
language_feature: host-interop
goal: npm-library-support
sprint: 72
assignee: ttraenkler/opus-b
es_edition: ES2015
horizon: s
related: [2693, 3657]
loc-budget-allow:
  - src/runtime.ts
---
# #3325 — `declare function` host-dep call silently dropped

## 2026-07-26 IR follow-up boundary

The runtime dependency-wiring fix below remains the correct owner once an
ambient call reaches the import manifest. #3657 is a separate, earlier-stage
IR failure: a class method calling an ambient function with a boolean result is
rejected as `unknown function` before Wasm/import resolution. Do not reopen
#3325 or change runtime fallback semantics to address that compiler rejection.

## Problem

Found while validating #1793 (Buffer host class). A user-level ambient host
function is imported but the call site never invokes it:

```ts
declare function inspect(u: any): void;
export function test(): number {
  inspect(7);   // <- never reaches the JS dep
  return 5;
}
```

Compiled with default JS-host config and instantiated via
`buildImports(r.imports, { inspect: (v) => console.log("DEP", v) }, r.stringPool)`
(+ `setExports`): `test()` returns 5 and the dep NEVER runs — no throw, no
log. The module manifest DOES contain `env.inspect` and the WAT has
`(import "env" "inspect" (func $inspect_import ...))` plus a
`string_constants.inspect` global, so the import is declared and bound; the
CALL is what goes missing (dropped, or routed through a dynamic-dispatch path
that resolves something else, e.g. the string-constant global).

## Impact

Host-dep injection via ambient function declarations is a documented
test-injection route (`compileAndRunRuntimeDeps`, cluster I) and the natural
FFI for embedders. A silently dropped call is worse than a compile error.
Note `tests/issue-1042.test.ts` already records that `declare function`
returning `number` marshals NaN — this is the void/any-arg variant of the
same neglected path.

## Repro

`.tmp/probe-dep.mts` shape above; also `declare function inspect(u: any): void`
with a `Uint8Array` arg (the #1793 zero-copy probe).

## Acceptance criteria

- `declare function f(x: any): void` + `deps: { f }` → the dep runs with the
  marshaled arg.
- A missing dep at instantiation produces a clear link/runtime error, not a
  silent no-op.

## Resolution (opus-b, 2026-07-17)

**Not a codegen drop — a runtime resolution miss.** WAT inspection confirmed
the call site is emitted correctly: `$test` does `f64.const 7` → `call
$__box_number` → `call $inspect_import`. The import intent for an ambient
`declare function f` is `{ type: "builtin", name: "f" }`. In
`resolveImport` (`src/runtime.ts`, the `case "builtin"` block), every
recognised builtin — the internal `__*` helpers and the named runtime
primitives (`parseInt`, `JSON_stringify`, `Promise_*`, …) — returns before the
terminal fallback `return () => {};`. A user-level ambient name matches nothing,
hit that fallback, and resolved to a **no-op that ignored `deps`** — so the
call ran but did nothing.

**Fix** (`src/runtime.ts`, terminal fallback of the `builtin` case):

1. If `deps[name]` is a function → wire the import to it (`(...args) =>
   userDep(...args)`).
2. If `deps[name]` is a non-function value → expose it as a zero-arg accessor.
3. If no dep → keep the historical no-op.

**Scope note — acceptance criterion 2 (missing dep → clear error) is deferred.**
An earlier revision returned a stub that threw a clear `TypeError` for a
called-but-undepped user-facing (non-`__`) ambient name. That **regressed the
merged-state test262 gate** (bot park on PR #3211): the test262 harness
legitimately declares ambient host functions it does not always supply (print/
log-style stubs) and relies on the no-op, so throwing flipped passing tests to
failing. The dep-wiring (1–2) is the real fix for the reported bug; the
"missing dep" diagnostic would need to be gated to non-harness embedder contexts
— tracked as a possible follow-up.

**Tests:** `tests/issue-3325.test.ts` (6) — numeric/string arg marshaling,
per-call-site invocation, missing-dep-is-no-op, unused-import instantiation,
non-function dep exposure. Adjacent declare-function / host-interop suites
(issue-1042/1052/1494/1347/2903*/2635/2693*/2752/1636/3125*/3137/1695/
promise-combinators) show no NEW failures — the pre-existing issue-820m (4) and
import-resolver (8) failures reproduce identically on clean `main`.
