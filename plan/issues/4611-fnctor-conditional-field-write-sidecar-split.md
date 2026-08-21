---
id: 4611
title: "fnctor: conditional ctor field write lands in the host sidecar while reads take the struct-field fast path — acorn ranges/comments families (24 tests)"
status: ready
sprint: current
created: 2026-08-21
updated: 2026-08-21
priority: high
horizon: m
feasibility: hard
reasoning_effort: high
task_type: bug
area: codegen
language_feature: constructors, objects
goal: npm-library-support
related: [4610, 3729, 4155, 4211, 1712]
files:
  - src/codegen/fnctor-escape-gate.ts
  - src/codegen/statements/variables.ts
  - src/runtime.ts
---

# fnctor conditional ctor writes split a field across three storages

## Problem

The acorn official suite's last 24 failures (ranges + onComment families,
3494/3518) reduce to one fnctor representation split. Reduction (verbatim
acorn shape, host-import traffic spied at the boundary):

```js
var Node = function Node(parser, pos) {
  this.type = ""; this.start = pos; this.end = 0;
  if (parser.options.ranges) { this.range = [pos, 0]; }   // ← conditional
};
var Parser = function Parser(options) { this.options = options; };
var pp = Parser.prototype;
function finishNodeAt(node, type, pos) {
  node.type = type; node.end = pos;
  if (this.options.ranges) { node.range[1] = pos; }
  return node;
}
pp.startNode  = function (pos) { return new Node(this, pos); };
pp.finishNode = function (node, type, pos) { return finishNodeAt.call(this, node, type, pos); };
// new Parser({ranges:true}); startNode(4); finishNode(n,"X",9)
// → n.range reads back null (want [4,9])
```

Spied traffic shows three disagreeing storages for `range`:

1. **ctor write** — `__extern_get 0/1` element reads then
   `__extern_set_strict("range", JSArr[4,0])`: the conditional assignment
   marshals the vec into a host JS ARRAY COPY and stores it in the SIDECAR.
2. **element write** (`node.range[1] = pos` in finishNodeAt) — no dynamic
   `range` read at all: the compiled code takes the ref-test struct fast
   path, `struct.get $range` reads the never-written STRUCT FIELD (null),
   and `__extern_set_strict(null, 1, 9)` no-ops silently in `_safeSet`.
3. **final read** (`n.range` via marshalling) — also prefers the struct
   field → null. The class-declaration variant of the same shape reads the
   SIDECAR instead (`[4,0]`), which is how the suite's range assertions see
   `[start, 0]`.

The same split blocks the onComment family: `options.onComment` array pushes
land in a storage the reader never consults, so all 5 comment-collection
tests report empty arrays.

## Implementation Plan (Fable; implement per the plan/implement split)

1. **Decide the canonical storage and make all three sites agree.** The
   struct FIELD is the right canon (the fnctor census already allocated a
   `range` slot — that is why the reader fast-paths). Two sub-fixes:
   a. The ctor's conditional write must emit the struct-field write (the
      same `__sset_`-writeback/struct.set the unconditional `this.start =
      pos` takes), NOT the dynamic host-set with a marshalled copy. Find
      where a conditional `this.<f> = <arrayLiteral>` inside a fnctor ctor
      routes to the dynamic lane (suspect: the conditional guard makes the
      write "dynamic" in the field census, or the array literal's
      externref routing in literals.ts wins over the field's vec carrier).
   b. `_safeSet`'s numeric-index arm must not silently no-op on a null
      receiver read from a struct field — but with (a) fixed the receiver
      is the live vec and `_trySetWasmVecElement` already works.
2. **Reduction tests**: the fnctor shape above (range `[4,9]` after
   finishNode) plus an onComment-style push-into-options-array shape.
3. **Validation**: acorn official suite ranges family (10 tests) +
   comments family (5) flip; `tests/issue-4537-method-this-call-receiver.test.ts`
   (the #4610 class-shaped twin) stays green; fnctor suites
   (`tests/issue-4155*`, `#4211` presence-bit tests) stay green.

## Acceptance criteria

- [ ] Reduction: fnctor conditional ctor field write is readable through
      both the struct fast path and the host marshaller, and element writes
      mutate the same storage.
- [ ] acorn official suite ≥ 3510/3518 (ranges + comments families fixed).
- [ ] No fnctor-lane regressions (presence bits, layout census).
