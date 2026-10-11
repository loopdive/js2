---
id: 6962
title: "standalone: dynamic `.find()/.map()` on an untyped fnctor-instance receiver is routed to the Iterator-helper arm instead of the user's prototype method (Octane splay wrong size)"
status: done
completed: 2026-10-10
sprint: current
goal: standalone-gap
area: compiler
priority: high
horizon: s
feasibility: easy
# 2026-10-10 (#6962): the fix appends `ref.test $__fnctor_*` terms to the two
# #2903 iterator arms' exclusion test inside fillClosedMethodDispatch; the
# helper must sit beside its only caller (scope of this slice is that file).
loc-budget-allow:
  - src/codegen/closed-method-dispatch.ts
func-budget-allow:
  - src/codegen/closed-method-dispatch.ts::fillClosedMethodDispatch
---

# Problem

Octane **splay** on `--target standalone` fails with `Error: Splay tree has wrong
size` from `reps >= 110` (passes at 1..109). It is not a many-iterations bug per
se: rep 110 is the first time the deterministic RNG draws a key that is still
**live** in the tree (`InsertNewNode`'s `do { key = GenerateKey() } while
(splayTree.find(key) != null)` is supposed to retry). Measured with
`.tmp/splay-node-collide.mjs` (node, instrumented): exactly one live-key
collision in 170 reps, at rep 110.

In standalone `splayTree.find(key)` **never calls `SplayTree.prototype.find`**
(instrumented counter stayed at 0 across 8000 Setup inserts + the run). It
returns `undefined`, so the duplicate key is inserted → 8001 keys → TearDown
throws. Renaming `find` → `findKey` in the driver makes reps 110 pass
(`.tmp/patch-splay-rename.mjs`).

## Minimal repro — `.tmp/sp5.js`

```js
function Tree() {}
Tree.prototype.root_ = null;
Tree.prototype.find = function(key) { return this.root_ == key ? this : null; };
Tree.prototype.findMax = function(key) { return this.root_ == key ? this : null; };
Tree.prototype.map = function(f) { return "user-map"; };
Tree.prototype.insert = function(key) { this.root_ = key; };
var tree = null;                                   // receiver type unknown at the use site
function Setup() { tree = new Tree(); tree.insert(0.5); }
function Probe() {
  return "find=" + (tree.find(0.5) != null) + ",findMax=" + (tree.findMax(0.5) != null)
       + ",map=" + tree.map(function (x) { return x; });
}
export function main() { Setup(); return Probe(); }
```

| lane | result |
|---|---|
| node | `find=true,findMax=true,map=user-map` |
| standalone (`sa.mjs --script --no-eval`) | `find=false,findMax=true,map=[object Object]` |

`findMax` (a name no builtin owns) resolves correctly through the method cache /
`__extern_method_call`. `find` answers `undefined`; `map` answers a
`$LazyIterHelper` wrapper object.

# Root cause

`fillClosedMethodDispatch` (`src/codegen/closed-method-dispatch.ts`) builds the
`__call_m_<name>_<arity>` dispatcher for a receiver the call site could not type.
Two arms decide "is this receiver an iterator?" by **exclusion**:

- (#2903) eager Iterator-helper arm, ~L948–1013: `notIterTest = null ∨ $Object ∨
  $__vec_base ∨ $ObjVec`; **everything else** → `__iter_hof_<name>(recv, cb)`.
- (#2903 R3) lazy Iterator-helper arm, ~L1025–1085: same test; everything else →
  `__iter_lazy_<name>(recv, arg0)`.

A standalone instance of a sloppy function-constructor is a `__fnctor_<F>`
struct (`(struct (field $$constructor externref) (field $$bag externref))`, no
shared supertype; see the splay WAT: `$__fnctor_SplayTree`). It is neither
`$Object` nor a vec, so both arms treat it as an iterator carrier. The arms sit
**outside** the method-cache / `__extern_method_call` arm (which is the one that
would walk `__fnctor_proto_SplayTree`), so the prototype method is never
consulted. `__iter_hof_open` then returns its null sentinel for a non-iterator
and `__iter_hof_<name>` answers `undefined` by design (iter-hof-native.ts
~L351–366, "no-throw discipline").

Octane splay is the first corpus program where (a) the receiver is a module var
assigned in another function (`var splayTree = null; … splayTree = new
SplayTree()` in `SplaySetup`), so the call site is dynamic, and (b) the
prototype method name collides with an Iterator-helper name.

Affected names (standalone only): `NATIVE_ITER_HOF_METHODS` ∩ eager forms —
`find`, `every`, `some`, `forEach`, `reduce`, `toArray`; `LAZY_ITER_METHODS` —
`map`, `filter`, `take`, `drop`, `flatMap`, `chunks`, `windows`, … (check the
sets at the top of closed-method-dispatch.ts / iter-hof-native.ts /
iter-lazy-native.ts).

## Implementation Plan

### Change 1 — exempt fnctor-instance structs from both iterator arms (the fix)

**File: `src/codegen/closed-method-dispatch.ts`**, function
`fillClosedMethodDispatch`.

Build the exclusion once per dispatcher, before the eager arm, and reuse it in
the lazy arm:

```ts
// A raw `__fnctor_<F>` carrier is a plain object instance, never an iterator
// carrier: its methods live on `__fnctor_proto_<F>` and must reach the
// method-cache / `__extern_method_call` arm below.
const fnctorNotIter: Instr[] = [];
for (const [name, typeIdx] of ctx.structMap) {
  if (!name.startsWith("__fnctor_")) continue;
  fnctorNotIter.push({ op: "local.get", index: anyLocalIdx }, { op: "ref.test", typeIdx }, { op: "i32.or" });
}
```

Append `...fnctorNotIter` to `notIterTest` in BOTH arms (after the `$ObjVec`
test, ~L1003 and ~L1074). Follow the enumeration pattern of
`buildFnctorArrayHofTargetTest` (`fnctor-array-prototype.ts` L27–43), which
already iterates fnctor struct types for the #3098 HOF arm one level up; the
`#3098` arm must keep its precedence (a fnctor whose `F.prototype` IS an array
still gets `__hof_find`).

If `ctx.structMap` also holds non-instance `__fnctor_*` helper types, prefer
`ctx.fnctorPrototypeObject` keys (`__fnctor_${fnctorName}`) as the source, as
the HOF helper does — but note that map only contains fnctors whose prototype
object was materialized; a fnctor with prototype methods always has one.

Class instances are NOT affected (probed: `.tmp/sp6.js`, `class T { find(k){}
map(f){} }` held in an untyped module var → standalone matches node), because
class methods get closed-struct entry arms that win before the iterator arms.
Only the raw `__fnctor_*` carrier lacks such an arm.

### Change 2 — make the misroute loud (secondary, do not block on it)

**File: `src/codegen/iter-hof-native.ts`** ~L351–366 and the lazy twin in
`iter-lazy-native.ts` (`__iter_hof_open` null sentinel): for a receiver that is
a `__fnctor_*`/class struct the spec answer is a TypeError (`x.find is not a
function` if the prototype has none). Keep the `undefined` answer for the
remaining carriers this slice does not classify, but add a comment pointing at
this issue. (A thrown TypeError would have surfaced this in Setup instead of as
a silent wrong size 110 reps later.)

### Edge cases

- `find` on a fnctor whose prototype IS an Array (`F.prototype = []`) → still
  `__hof_find` (outer #3098 arm, unchanged).
- Fnctor instance whose prototype has NO `find` → falls to
  `__extern_method_call`, which answers undefined / throws per its existing
  rule (unchanged behaviour for names that are not iterator-helper names).
- Receiver `null` → unchanged (legacy open-arm route).
- gc lane unaffected (`ctx.standalone` gate on both arms).

### Acceptance

- `.tmp/sp5.js` → standalone prints `find=true,findMax=true,map=user-map`.
- `node --import tsx .tmp/octane-sa.mjs splay --script --no-eval --reps 170`
  → `run -> 170`, `teardown ok`.
- `pnpm run -s benchmark:octane -- --only splay --lanes node,standalone
  --timeout 600` → standalone `ok` at node-calibrated reps.
- Add `tests/equivalence/` case from `sp5.js` (plus the `every`/`some`/
  `forEach`/`reduce`/`filter` names) — standalone + gc.

### Side observation (not this issue)

In the same probe, calling `Probe` through an array of functions
(`var steps = [Setup, Probe]; steps[1]()`) made `main()` return `undefined` in
standalone (node: the string). Worth a separate 2-line issue if it reproduces
in isolation.

## Implementation Notes (2026-10-10)

- Change 1 landed as planned: `fnctorNotIterTest(ctx, anyLocalIdx)` in
  `closed-method-dispatch.ts` ORs `ref.test` for every `structMap` entry named
  `__fnctor_*` (instance carriers and `__fnctor_proto_*` objects — both are plain
  objects) into `notIterTest` of the eager (#2903) and lazy (#2903 R3) arms.
  Enumerating `structMap` rather than `fnctorPrototypeObject` also covers
  fnctors whose prototype object was never materialized. Structural collisions
  with iterator carriers are already excluded by #2853 shape branding.
- Change 2 (loud misroute) not done: out of the file scope of this slice.
- Precedence: the #3098 vec/fnctor-Array-prototype HOF arm wraps outside and
  is unchanged. Known limit: a fnctor whose prototype really is an Iterator
  (`F.prototype = Object.create(Iterator.prototype)`) now reaches
  `__extern_method_call` instead of the native helper.
- Tests: `tests/issue-6962-fnctor-receiver-iter-hof-arm.test.ts` (standalone).
- Pre-existing, not touched here: a typed local generator `var g = gen();
  g.find(cb)` answers null on standalone (base and head); `new AP()` with
  `AP.prototype = [10,20,30]` and `ap.find(cb)` answers undefined (base and head).
- Side observation (`var steps = [Setup, Probe]; steps[1]()` → undefined)
  reproduces in isolation without any fnctor or iterator-helper name, on both
  standalone and gc (`function P(){return "s"} var steps=[P]; steps[0]()`),
  so it is unrelated to this issue and needs its own issue.
