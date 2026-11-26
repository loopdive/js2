---
id: 7413
title: "An omitted iterator next(v)/return(v) argument is passed as null, not undefined (class iterators via for-of, spread, destructuring)"
status: done
sprint: current
created: 2026-11-19
updated: 2026-11-19
completed: 2026-11-19
priority: high
horizon: s
feasibility: easy
reasoning_effort: high
task_type: bugfix
area: codegen
goal: core-semantics
related: [3024, 2864]
---

# #7413: the omitted `next(v)` / `return(v)` argument reads as `null`

## Problem

Found by the missing-helper audit
(`plan/log/missing-helper-silent-emit-audit-2026-11-19.md`). Measured on main
`89e47482`, on gc, standalone and wasi:

```ts
class It { n = 0; next(v?: any) { this.n++; return { value: v === undefined ? 1 : 100, done: this.n > 2 }; }
  [Symbol.iterator]() { return this; } }
export function main() { let t = 0; for (const x of new It()) t += x; return t; }
```

- **Ours: 200. Node: 2.** The method sees `v === null`, not `undefined`.
- Spread (`[...new It()]`) and array destructuring (`const [a, b] = new It()`)
  give the same wrong answer.
- `return(v)` on `break` gives 100 (node: 1).
- **gc is also wrong**: the host `__get_undefined` import is not present in
  these modules.

## Root cause

`emitIteratorMethodExport` (`src/codegen/index.ts`) builds the
`__call_next` / `__call_return` dispatchers. These call
`<struct>_next(receiver)` and pad each declared formal with `padMissingArg`.

For an externref formal, `padMissingArg` used the host `__get_undefined`
when it was imported, and `ref.null.extern` otherwise. The dispatchers are
built at finalize, so they cannot add the import, and `ref.null.extern` is
JS `null`.

## Fix

When the host import is absent, the pad is `canonicalUndefinedExternInstrs`.
That is the tag-1 `$undefined` singleton, which is reserved in every
native-strings module: the canonical `undefined` of those lanes, as #2864
wave 2 established for the same "absent slot reads null" defect.

## Acceptance

- `tests/issue-7413-iterator-next-undefined-pad.test.ts` pins node's answer
  on gc, standalone and wasi for four shapes: for-of, spread, array
  destructuring, and `return(v)` on `break`. All four fail on the base
  code.
- Byte identity: 1,200 files × {gc, standalone}, so 2,400 outputs, with 0
  differences. None of the sample's programs pads an iterator method
  argument. The sample is test262 `built-ins/{Map,Set}` and
  `language/expressions/{optional-chaining,compound-assignment,addition,conditional}`,
  plus the playground, benchmarks and examples.

## Not changed here

The same bridge has two more spots with this shape, both recorded as
unconfirmed in the audit:

- `appendResultBoxing` answers a `void` method result with
  `ref.null.extern`;
- `applyUndefinedInstrs` (`apply-closure-args.ts`) uses the flag-gated
  `undefinedExternInstrs`, which falls back to `ref.null.extern` while the
  #2106 regime is off.
