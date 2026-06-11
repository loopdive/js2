---
id: 1999
title: "string += on a closure-captured variable traps 'illegal cast' (and emits invalid wasm when an i32 index is concatenated) — breaks the accumulator-in-callback idiom"
status: done
sprint: 61
created: 2026-06-10
updated: 2026-06-11
completed: 2026-06-11
priority: critical
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: closures
goal: core-semantics
related: [795, 816, 1115, 1950]
origin: "2026-06-10 spec-conformance sweep: found independently by arrays, strings, and async agents; verified on main"
---

# #1999 — compileStringCompoundAssignment ignores boxedCaptures

## Problem

```ts
let acc = "";
[1, 2, 3].forEach((x: number) => { acc += x; });
return acc;
// wasm: RuntimeError: illegal cast   node: "123"

// minimal: let log = "x"; function inner(): void { log += "a"; } inner(); return log;
// CE variant: a.forEach((v: number, i: number) => { s += i + ":" + v; });
//   → COMPILE-ERROR: WebAssembly.instantiate(): call[0] expected type
//     externref, found local.get of type (ref null 8) — invalid binary shipped
```

Controls that work: `acc = acc + s` inside the same closure; numeric
captured `+=`; uncaptured string `+=`; plain `acc = "y"`. The trap fires
whether the `+=` is inside the closure or in the outer scope, once the
variable is captured. This also blocks every async log-ordering pattern
(`let log = ""; async fn appends`).

## Root cause

`src/codegen/expressions/assignment.ts:4572` routes string `+=` to
`compileStringCompoundAssignment` (assignment.ts:4080) **before** the
boxed-captures check at :4658. That function loads the variable with bare
`local.get` / stores with `local.tee` and never consults
`fctx.boxedCaptures`, so the ref-cell struct `(struct (mut externref))` is
passed straight to js-string `concat` → illegal cast (and the write-back
would clobber the cell with a string). The dedicated boxed externref
string-concat path at assignment.ts:4692 is unreachable for
statically-string-typed vars because the :4572 branch returns first.
(The strings agent independently located the boxed-cell read at
assignment.ts:4674-4733 casting to a non-matching cell struct.)

## Fix direction

Move the boxedCaptures check ahead of the string-compound branch, or teach
`compileStringCompoundAssignment` to read/write through the ref cell
(`struct.get`/`struct.set`) when the binding is boxed.

## Acceptance criteria

- All three repros match Node (no trap, no invalid wasm)
- `acc = acc + x` and numeric captured `+=` unchanged
- Works for sync fns, arrows, array HOF callbacks, async fns

## Dupe check

#1115 (closure callable params, done), #686 (capture type preservation,
done), #795/#816 (introduced ref cells, done), #1950 (host-callback
direction). No open issue covers this. Found independently 3× this sweep.
