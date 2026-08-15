---
id: 4422
title: "No way to import a MODULE OBJECT as an external — `import ts from \"typescript\"` cannot be externalized"
status: ready
sprint: Backlog
created: 2026-08-14
updated: 2026-08-14
priority: medium
horizon: l
feasibility: hard
reasoning_effort: high
task_type: feature
area: compiler
goal: correctness
---

## Problem

There is no way to say "this module is provided by the host, import it as an
opaque object". Today:

```
compile('import * as ts from "typescript"; … ts.SyntaxKind.Identifier')
  → imports: env.__extern_get, env.__throw_reference_error      // ts is UNBOUND
compileProject(…, { externals: ["typescript"] })
  → (func $kindOf … ref.null extern  ref.is_null (if (then throw 0)))
```

`externals` (`src/index.ts:659`) is **graph pruning, not import generation** —
it is read only by `ModuleResolver` (`src/resolve.ts`), used only by
`compileProject`, and means "do not pull this package's files in". It does not
produce a Wasm import.

The only external shape that becomes a real import is a **named function**:
`preprocessImports` rewrites `import { foo } from "pkg"` into
`declare function foo(...): any`, which `collectExternDeclarations`
(`extern-declarations.ts:667`) registers as `env.foo`. A binding that is not
*called as a function* degrades to `declare const X: any` — i.e. nothing. And
that rewrite runs **only on the single-source `compile()` path**; the
multi-file paths never call `preprocessImports`.

That is exactly the wrong shape for the case that matters. `src/ts-api.ts:62`
is `import ts from "typescript"; export { ts };`, **657 of 768** files reach it,
and they use it as `ts.isIdentifier(...)` / `ts.SyntaxKind.X` — a module object
whose members are read, called, and re-exported across module boundaries.

## What is needed

An imported module object represented as an `externref`-valued import that:

- binds the specifier to a host-provided handle,
- supports member reads and method calls through the existing
  `__extern_get` / `__extern_method_call_N` dispatch,
- **survives re-export** (`ts-api.ts` re-exports `ts`, so the handle has to
  cross compiled-module boundaries),
- works on the multi-file paths, not only single-source `compile()`.

**The model already exists.** `node:*` does precisely this: an
`env.__node_<module>` handle of type `() -> externref`, with member dispatch
through the same extern helpers (`registerNodeBuiltinImports`,
`extern-declarations.ts:1530-1570`). Generalising that from a hardcoded builtin
list to an arbitrary declared-external specifier is the work.

## Why it is Backlog and not current

This is a genuine new capability rather than a bug fix — the only item of the
five self-hosting findings that is. It is also not on the critical path until
#4421 and #4419 land, since `ts-api.ts` cannot compile at all today.

## Acceptance criteria

- [ ] A declared external specifier lowers to a module-handle import on the
      single-source AND multi-file paths.
- [ ] Member reads, method calls, and re-export of the handle all work.
- [ ] `src/ts-api.ts` compiles with `typescript` externalized, and the emitted
      module imports a handle rather than throwing a ReferenceError.
- [ ] An unresolvable external fails loudly instead of binding `ref.null`
      (see #4419 for the same failure mode on `node:*`).

## Provenance

Found by the self-hosting investigation. Measurements and repros in
`.tmp/selfhost/`.
