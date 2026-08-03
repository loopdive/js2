---
id: 4138
title: "standalone: for…in over a nested dynamic object misses children — generic AST walk visits 1 of N nodes"
status: ready
sprint: Backlog
priority: high
goal: standalone-gap
feasibility: medium
horizon: m
created: 2026-08-03
requested_by: ttraenkler/claude-bench
related: [4088]
loc-budget-allow:
  - src/codegen/statements/loops.ts
func-budget-allow:
  - src/codegen/statements/loops.ts::compileForInStatement
---

# #4138 — standalone: for…in over nested dynamic objects yields 1 of N children

## Problem

A generic object-graph walk — the canonical "visit every AST node" loop — visits
only the root on `--target standalone`. 15-line repro, returns **1** where node
returns **3**:

```js
export function bench() {
  var root = { type: "A", kids: [{ type: "B" }, { type: "C" }] };
  var stack = [root]; var n = 0;
  while (stack.length > 0) {
    var node = stack.pop();
    if (node === null || typeof node !== "object") continue;
    if (typeof node.type === "string") n = n + 1;
    for (var k in node) { var v = node[k]; if (v !== null && typeof v === "object") stack.push(v); }
  }
  return n;
}
```

Either the `for…in` over the dynamic object enumerates no/too-few keys, or the
computed read `node[k]` answers null for object-valued properties — the repro
does not yet distinguish. A variant where the walk lives in a function taking
the object as an untyped parameter does not compile at all.

## Why it matters

This is what blocks a **correct** acorn self-parse checksum on standalone.
With PR #4088's three fixes, acorn 8.18 compiles and parses its own 233 KB
source **correctly** (`ast.body.length`/`ast.end` agree exactly with node
acorn, probe 422232958 both sides) — but the cross-engine benchmark's AST-walk
checksum computes 1,232,968 vs node's 32,692,356,805 because the walk sees ~1
node. Every other engine in the test262.fyi benchmark lane passes this
checksum; js2's standalone lane is marked invalid on the one whole-program
case. The walk shape (for…in + computed member read over heterogeneous
objects) is ubiquitous in real traversal code, not benchmark-specific.

## Progress

**Narrow slice landed 2026-08-03** (with PR #4088's branch): a receiver typed
`T | undefined` (the `Array.pop()` shape) hit the standalone static-unroll
path with a UNION type, whose `getProperties()` is the common set — empty —
so the loop silently enumerated nothing. The static shape is now read off
`getNonNullableType()`; `tests/issue-4138-forin-nonnullable-receiver.test.ts`
covers it. The repro above still returns 1, not 3: with heterogeneous
pushes the union's common property set is `{type}` alone, so children are
still never enumerated.

## What remains (the actual body of this issue)

1. A receiver that is POLYMORPHIC at runtime must not static-unroll one
   shape — it needs runtime key enumeration.
2. Runtime enumeration (`__object_keys_forin`) only sees `$Object` values;
   closed WasmGC structs (object literals with stable shapes, fnctor
   instances) are not enumerable through it. A generic walk needs either a
   reflection path over closed structs or a rep change.

## Acceptance

- The repro above returns 3 on `--target standalone` (and gc).
- acorn self-parse AST checksum matches node acorn on the same source.
