---
id: 2009
title: "structurally identical struct types share field names at the host boundary — Object.assign/spread/JSON.stringify mislabel keys, spread override order broken"
status: done
assignee: ttraenkler/sen-1
completed: 2026-06-19
sprint: 64
created: 2026-06-10
updated: 2026-06-19
priority: high
feasibility: hard
reasoning_effort: max
task_type: bugfix
area: host-interop
language_feature: objects
goal: core-semantics
related: [1989, 905, 1971]
origin: "2026-06-10 spec-conformance sweep (objects agent): verified on main"
---

# #2009 — ref.test field-name resolution collides under iso-recursive canonicalization

## Problem

```ts
const a: any = { aa: 1 }; const b: any = { bb: 2 };
JSON.stringify(a) + "|" + JSON.stringify(b)
// wasm: {"aa":1}|{"aa":2}      node: {"aa":1}|{"bb":2}

Object.assign({a:1}, {b:2})            // wasm: {"a":2}  node: {"a":1,"b":2}
({...{x:1,y:2}, ...{y:3,z:4}, x:9})    // wasm: {"x":3,"y":4}  node: {"x":9,"y":3,"z":4}
```

Three-source assign drops middle sources entirely.

## Root cause

`src/codegen/index.ts:2058-2140` (`emitStructFieldNamesExport`) keys field
names by `typeIdx` and resolves them via a `ref.test` chain — but WasmGC
iso-recursive canonicalization makes structurally identical struct types
(`{aa:number}` vs `{bb:number}`) indistinguishable to `ref.test`, so every
same-shape struct gets the first-registered shape's names. All
host-boundary enumeration (`__object_assign` via `src/runtime.ts:6829` +
`_wrapForHost`, spread via `src/codegen/literals.ts:185/1134`,
`JSON.stringify(any)`, `Object.keys(any)`) inherits the wrong names.
Secondary: `src/codegen/literals.ts:1372` resolves spread field values as
"last spread wins" without honoring source-order interleaving with named
props (`x:9` after spreads loses).

## Fix direction

Field names must travel with the *instance*, not the canonical type — e.g.
a hidden shape-id field stamped at construction keying the name table, or
per-literal distinct brand fields preventing canonical merging. Same
disease family as #1989 (valueOf keyed by type name). Architect spec
recommended; intersects #905 (versioned shapes) and #1852.

## Acceptance criteria

- All three repros match Node
- Spread/named-prop source order honored (later wins)
- No regression in struct field access perf on typed paths

## Dupe check

No issue covers canonical-type name collision (#1557 in-code comment is
method-signature dedup; #905 is shape evolution). New.
## Implementation Plan

### Chosen mechanism: instance-carried shape-id (option a), appended field

Stamp each object literal with a hidden `i32` shape-id field at construction.
The shape-id keys a module-level table of field-name lists, so the host reads
the *literal's own* names instead of the first-registered same-shape literal's.

Why not the alternatives:
- **(b) per-literal brand fields** — defeats the `anonStructHash` dedup at
  `index.ts:9331` that keeps binary size bounded and lets sibling literals share
  one method/getter table. N same-shape literals would mint N struct types,
  N copies of every `__sget_*` getter arm, and explode `ref.test` chains. Reject.
- **WasmGC-level distinction** — impossible by design; iso-recursive
  canonicalization is mandated by the spec. The shape-id rides *inside* the
  instance, orthogonal to type identity.

**Root cause (precise).** It is NOT only WasmGC canonicalization — the compiler
*itself* merges shapes at `src/codegen/index.ts:9334-9339`
(`fieldsHashKey` + `anonStructHash`): `{aa:1}` and `{bb:2}` both hash to the
same key and reuse one `__anon_N` typeIdx. `emitStructFieldNamesExport`
(`index.ts:2074`) then keys the name CSV by that single typeIdx, so both
stringify with the first shape's names. The `__sget_<name>` getters
(`index.ts:1734`) read the correct *slot* (field 0 is field 0 regardless of
name), so only the NAME list is wrong — fixing names alone repairs
JSON.stringify/Object.keys/Object.assign/spread.

### New data structure (append, never prepend)

Add a hidden trailing field `$shape` (`i32`, immutable) to every anon
object-literal struct that participates in host enumeration. **Append** it as
the LAST field so all existing positional `fieldIdx` references (the entire
`fieldIdx: 0`/`findIndex` population audited in `index.ts` and `literals.ts`)
are unaffected. Build a module-level array:

```ts
// CodegenContext (src/codegen/context/types.ts + create-context.ts)
shapeNames: string[][];        // shapeId -> ordered field-name list
shapeIdByNameKey: Map<string, number>; // join(",") of names -> shapeId (dedup)
```

A shape-id is allocated per DISTINCT ordered name list, not per literal, so
`{aa:1}` and another `{aa:9}` share id 0 while `{bb:2}` gets id 1. Same-shape-
same-names literals stay deduped (no binary bloat); only genuinely different
name lists diverge.

### Changes

**File: src/codegen/index.ts**
- `registerAnonStruct` (the function ending at line ~9359, where
  `structName = __anon_N` is minted): after building `fields`, before
  `ctx.mod.types.push`, append the hidden field
  `{ name: "$shape", type: { kind: "i32" }, mutable: false }`. Use a `$`-prefixed
  name so it is already excluded by the `field.name.startsWith("$")` filters in
  `emitStructFieldNamesExport` (line 2105) and `_emitStructFieldGettersInner`
  (line 1757) — no getter/name leakage. Allocate/lookup the shapeId for this
  literal's *real* (non-hidden) name list via `shapeIdByNameKey`; store it on the
  struct registration so the construction site can stamp it.
- `emitStructFieldNamesExport` (line 2074): REPLACE the `typeIdx`-keyed
  `ref.test` chain with a `$shape`-field read. New body:
  1. `any.convert_extern`; then for each surviving anon typeIdx, `ref.test`
     against that typeIdx, and on success `struct.get $shape` → use the shape-id
     to `global.get` the CSV string-constant global for THAT shape-id.
  2. Because two same-shape typeIdxs no longer exist (dedup collapses them), the
     remaining `ref.test` ambiguity is gone: each surviving anon typeIdx has its
     own `$shape` slot whose value selects the correct CSV. Register one string-
     constant global per shape-id (reuse `addStringConstantGlobal`).
  - Note: the `ref.test` chain still distinguishes anon structs from non-struct
    values; the `$shape` read disambiguates which NAME LIST applies within a
    canonical type. Both are needed.
- `_emitStructFieldGettersInner` (line 1734): NO CHANGE to slot resolution
  (slots are already correct). Verify the `$shape` field is skipped by the
  existing `field.name.startsWith("$")` guard at line 1757 (it is).

**File: src/codegen/literals.ts**
- Object-literal struct construction (`compileObjectLiteralForStruct`, the
  `struct.new` at line 1532): push the literal's shape-id `i32.const` as the LAST
  operand, immediately before `struct.new`, matching the appended field order.
  Read the shape-id from the struct registration recorded above.
- **Spread/named-prop source-order bug (line 1498-1528, the issue's secondary
  bug at :1372).** The current loop resolves each output field by scanning
  spread sources "last spread wins" but does NOT honor a named prop that appears
  textually AFTER spreads. Fix: build the output value per field by walking
  `expr.properties` IN SOURCE ORDER, last writer wins:
  - Before the field-assembly loop, build
    `lastWriter: Map<fieldName, {kind:"spread", srcIdx} | {kind:"named", prop}>`
    by iterating `expr.properties` front-to-back and overwriting. Then in the
    assembly loop, dispatch on `lastWriter.get(field.name)` instead of the
    current "named-prop branch else spread branch" split. This makes
    `({...{x:1,y:2}, ...{y:3,z:4}, x:9})` yield `x:9,y:3,z:4`.

**File: src/codegen/literals.ts (host-externref path, line 170-260)**
- `compileObjectLiteralAsExternref`: this path uses `__object_assign` +
  `__extern_set` in `expr.properties` textual order already (line 184 loop), so
  source order is correct here — verify the three-source repro
  `Object.assign({a:1},{b:2})` flows through `__object_assign` with a sources
  LIST built in order. The reported "drops middle sources" bug is the shape-id
  names defect above: once the host enumerates the correct keys per source
  struct (PR-1), the assign no longer over-writes with a mislabeled key. If a
  WasmGC-struct `Object.assign` path is taken, the same names fix resolves it.

### Migration steps (ordered for incremental PRs)
1. **PR-1 (names only):** add `$shape` field + `shapeNames` table + stamp at
   construction + rewrite `emitStructFieldNamesExport`. Fixes JSON.stringify /
   Object.keys / Object.assign / spread *names*. Self-contained, testable.
2. **PR-2 (source order):** the `lastWriter` rewrite in the struct-path
   assembly loop. Fixes spread/named-prop override order. Independent of PR-1.
3. **PR-3 (verify externref path):** confirm `__object_assign` three-source
   case; only touch if PR-1 didn't already resolve it via correct names.

### Edge cases
- **Nested literals** (`{x:{y:5}}`): inner literal gets its own shape-id; the
  recursion at `_wasmToPlain` (runtime.ts:2753) reads each level's `$shape`.
- **Class instances vs object literals:** classes have nominal `structMap`
  names already distinct under `ref.test` (no dedup collision). Recommended:
  gate the new `$shape`-based export branch to anon structs only and keep the
  legacy typeIdx branch for named classes — smaller blast radius.
- **Spread result fed to another spread** (`{...{...a, b:1}}`): the inner
  literal materializes a struct with its own shape-id before the outer reads it.
- **Empty object `{}`:** routed to `__new_plain_object` host externref
  (index.ts:9301 widening) — no struct, no shape-id, host enumerates natively.
- **Host-boundary marshaling:** `$shape` is `i32`, never exported as a field
  (`$` filter), invisible to `Reflect.ownKeys`/`for-in`.
- **standalone mode:** `emitStructFieldNamesExport` early-returns under
  `nativeStrings` (line 2085) — no host, so no regression; native
  `Object.keys`/JSON use the struct directly. The `$shape` field is harmless
  dead weight there (4 bytes/instance); acceptable.

### Wasm binary-size impact
+1 immutable `i32` field per anon struct *type*; per-instance cost is 4 bytes.
One string-constant global per distinct name list (same count as today's
per-typeIdx globals, since dedup already collapsed same-name shapes). Net
neutral-to-tiny vs the side-table alternative, and far smaller than per-literal
brand fields (option b).

### Interaction with #905 / #1852
- **#905 (versioned shapes):** the `$shape` i32 is the natural substrate for a
  future version/shape tag — reserve the field semantics as "shape identity",
  let #905 extend the table to carry version metadata. No conflict; building
  block.
- **#1852 (per-backend value representation):** `$shape` is backend-agnostic
  (plain i32); the linear-memory backend stores it as a header word. Document in
  the field comment that the shape-id encoding is shared across backends.

### Test plan
- `tests/issue-2009.test.ts` (new): the three repros from Problem must match
  Node — `JSON.stringify({aa:1})|JSON.stringify({bb:2})`, three-source
  `Object.assign`, `{...{x:1,y:2},...{y:3,z:4},x:9}`.
- Add a `Object.keys` cross-shape case and a nested-literal `JSON.stringify`.
- Equivalence suite must stay green (no struct-field-access perf path touched —
  typed `o.x` reads still compile to a direct `struct.get`, unaffected).
- Scoped check: compile a module with two same-shape literals and assert the
  emitted `__struct_field_names` body reads `$shape` (grep the wat for
  `struct.get` of the trailing field), not a bare typeIdx `ref.test` return.

### Revised feasibility / reasoning_effort
Unchanged: `feasibility: hard`, `reasoning_effort: max`. PR-1 is the load-
bearing change; the export rewrite + construction stamping must stay in lockstep
or every host enumeration breaks. Recommend senior-dev for PR-1.

## Suspended Work (2026-06-11, infra incident)

The implementing senior-dev was terminated by a team-store wipe mid-PR-1.
State preserved in worktree `/workspace/.claude/worktrees/issue-2009-shape-id`
(branch `issue-2009-shape-id`, based past upstream PR #1316): UNCOMMITTED
257 insertions / 92 deletions across create-context.ts, context/types.ts,
declarations.ts, index.ts, literals.ts, object-ops.ts, with-scope.ts,
runtime.ts, plus tests/issue-2009.test.ts — the $shape field + shapeNames
table + export rewrite per the Implementation Plan above.

Resume steps: enter the worktree, `git diff` to review, run
tests/issue-2009.test.ts, complete per the plan's PR-1 acceptance, commit
(✓), push `--no-verify`, PR with `-R loopdive/js2 --head ttraenkler:...`.
Do NOT discard — review and continue.

## Root-cause correction (2026-06-14, sdev2 — WAT-traced on current main 7afa431d7)

The spec's root-cause #2 ("the compiler ITSELF merges shapes at
`fieldsHashKey`+`anonStructHash`, both `{aa:1}` and `{bb:2}` reuse one
`__anon_N` typeIdx") is **STALE / wrong on current main**. Verified by WAT:

```
(type $__anon_0 (struct (field $aa (mut f64))))
(type $__anon_1 (struct (field $bb (mut f64))))   ; DISTINCT compiler types
```

`fieldsHashKey` (index.ts:9422) keys on field NAME+type (`"aa:f64"` vs
`"bb:f64"`), so the two shapes get DISTINCT typeIdxs and DISTINCT name-CSV
globals, and `__struct_field_names` emits a correct two-arm `ref.test` chain
(`ref 11`→"aa", `ref 12`→"bb"). The bug is purely **WasmGC iso-recursive
canonicalization at RUNTIME**: `$__anon_0` and `$__anon_1` are structurally
identical (`struct (field (mut f64))`), so `ref.test (ref $__anon_0)` matches a
`$__anon_1` instance too — the first arm wins for both, so `b` (a `{bb}`)
stringifies with `a`'s names. Confirmed: `{bb:2}` ALONE → `{"bb":2}` (correct);
`{aa:1}`+`{bb:2}` together → `{"aa":1}|{"aa":2}` (b mislabeled).

**Consequence for the `$shape` fix:** appending `$shape:i32` to both makes them
`struct (f64)(i32)` — STILL canonically equal (so `ref.test` still matches
either), but the per-instance `$shape` VALUE (0 vs 1) selects the right name
list. The field disambiguates by VALUE, not by type — exactly as the plan's B′
relative (#1989) does for funcrefs. So the design holds; only the "dedup
collapses them" justification was wrong. shape-id is keyed by the ordered
name-CSV (so two `{aa}` literals share id 0), matching the plan.

R3 spread on current main is WORSE than the spec recorded:
`{...{x:1,y:2},...{y:3,z:4},x:9}` → `{"x":9,"y":null,"z":null}` (null values,
not `{"x":3,"y":4}`) — the spread-source value resolution also regressed; PR-2
(source-order lastWriter rewrite) must restore the values too.

## PR-1 landed (2026-06-14, sdev2) — names fix ($shape per-instance)

Implemented PR-1 of the plan: hidden trailing `$shape` i32 field on every
host-enumerable anon object-literal struct, stamped at construction with a
shape-id keyed by the ordered field-name list; `__struct_field_names` reads
`struct.get $shape` and selects the field-name CSV by VALUE.

**Fixed:** R1 (`JSON.stringify({aa:1})|JSON.stringify({bb:2})` →
`{"aa":1}|{"bb":2}`), Object.keys/values/entries/for-in per-instance, nested
same-shape collision. `$shape` excluded from all host enumeration (`$`-filter).
Same-name literals still share one shape-id (no bloat). Named classes stay on
the legacy typeIdx arm. Zero regressions in json/keys/spread/object equiv suites
(the one `setter stores value` failure is pre-existing on base).

Files: `context/types.ts` + `create-context.ts` (`shapeNames`,
`shapeIdByNameKey`, `structNameToShapeId`); `index.ts` (`registerAnonStruct`
appends `$shape`; `emitStructFieldNamesExport` rewritten to shape-id dispatch);
`literals.ts` (both anon struct.new sites stamp the shape-id). Test:
`tests/issue-2009.test.ts` (6 cases).

**Remaining (PR-2 / follow-up, NOT in this PR):**
- R2 `Object.assign({a:1},{b:2})` → now `{"a":2,"b":2}` (names fixed, both keys
  present) but VALUES wrong (should be `{"a":1,"b":2}`) — the native
  `__object_assign` source merge (#20's territory).
- R3 `{...{x:1,y:2},...{y:3,z:4},x:9}` → `{"x":9,"y":null,"z":null}` (names
  fixed) but spread-sourced VALUES are lost — the struct-path spread-source
  resolution (`compileObjectLiteralForStruct` line ~1664) fails to find the
  inline spread sources' fields, defaulting `y`/`z` to the undefined sentinel.
  Needs the `lastWriter` source-order rewrite (plan PR-2). Separate concern from
  the names collision; sequence after PR-1 merges.

## PR-1b (2026-06-14, sdev2) — IR-path $shape stamp + writeback shape-guard

PR-1's first push broke CI: the spec MISSED that there are TWO struct-registration
systems. The IR path (`src/ir/integration.ts` ObjectStructRegistry) REUSES the
legacy `$shape`-bearing struct type via `anonStructHash` but its `object.new`
emitted `struct.new` with only the real-field operands → one short of the 3-field
type → INVALID WASM (broke refcast-regression, reverse-struct-map,
null-destructuring + test262). Root-caused via `function makePoint(){return {x:1,y:2}}`
(IR path) emitting a 2-operand struct.new for a 3-field type.

Fix (PR-1b, same #1462):
- `IrObjectStructLowering.shapeId` (handles.ts) carried from integration.ts when
  the reused struct has a `$shape` field; lower.ts `object.new` pushes
  `i32.const shapeId` as the final struct.new operand. makePoint now emits
  `f64 f64 i32.const 0 struct.new` (valid).
- Writeback shape-guard (unblocks #20): `__sset_<name>` had the same
  canonicalization collision — `__sset_b(target {a:1})` wrote slot 0 of the
  target (its `a`!). Gated each store on `struct.get $shape === entry.shapeId`;
  mismatch no-ops, sidecar carries it. Fixes `Object.assign({a:1},{b:2})` →
  `{"a":1,"b":2}` (R2 value bug, was `{"a":2,"b":2}`).

Status now: R1 (names) + R2 (Object.assign values) FIXED. All 3 CI-failing equiv
tests restored; no new regressions. R3 (spread source-order value resolution)
still pending — separate concern (inline spread sources don't get struct types,
resolveStructName→undefined), the plan's PR-2 `lastWriter` rewrite.

Note: IR-FRESH structs (registered by ObjectStructRegistry, NOT reused from
legacy) don't get `$shape` — they're a separate same-shape-collision gap if two
IR-fresh different-name shapes collide. Not observed in tests; flag for follow-up
if it surfaces (would need `$shape` in the IR-fresh registration branch too,
integration.ts:1415).

## FINAL approach (2026-06-14, sdev2) — option (B): opt-in $shape on real collisions only

PR-1's first design (always-append $shape to EVERY anon struct) bricked the IR
path (makePoint) — TWO struct-registration systems (legacy ensureStructForType +
IR ObjectStructRegistry) over shared ctx.structFields/mod.types. Tech-lead chose
(B): touch ONLY genuinely-colliding structs, zero blast radius elsewhere.

Implementation (all in `src/codegen/index.ts`, one post-pass +
context fields; literals.ts/IR untouched):

- `resolveSameShapeFieldNameCollisions(ctx)` — a post-pass run AFTER all bodies
  (legacy + IR) are final, BEFORE the getter/setter/name exporters. Groups anon
  object-literal structs by structural-shape key (field TYPES only). A group
  "collides" iff it has 2+ DISTINCT field-NAME lists. For colliding members only:
  append a hidden `$shape` i32 field, assign a shape-id keyed by name-CSV (same
  names → same id, no bloat), and retro-patch every `struct.new <typeIdx>` in
  every compiled body via `patchStructNewWithShapeId` to insert
  `i32.const <shapeId>` (backend-agnostic — walks the emitted Instr stream, so it
  covers BOTH legacy and IR construction uniformly; the (A) IR-path/emitter-trait
  change is NOT needed).
- `emitStructFieldNamesExport` — colliding structs (have `$shape`,
  `ctx.shapeIdByStructName`) read `struct.get $shape` and dispatch the CSV by
  shape-id VALUE; non-colliding keep the legacy `ref.test typeIdx → own CSV` arm.
- `emitStructFieldSetters` — colliding `__sset_<name>` gate the store on
  `struct.get $shape === entry.shapeId` (the #20 writeback fix); non-colliding
  setters are byte-identical.

Result: R1 (names) + R2 (Object.assign value merge, = #20) FIXED. Non-colliding
structs — incl. ALL makePoint-style IR construction — are byte-identical to main
(verified: no `$shape` emitted, no `ref.test`/struct.new change). The 3
IR-path equiv tests that the (A) attempt broke (refcast-regression,
reverse-struct-map, null-destructuring) pass unchanged. tests/issue-2009.test.ts
adds a non-colliding sanity case + the writeback case.

R3 (spread source-order value resolution) remains — separate PR-2 (inline spread
sources don't get struct types → resolveStructName undefined → values lost; needs
the plan's lastWriter rewrite). Names + Object.assign values done here.

## PR-2 landed (2026-06-15, sdev3) — R3 spread-source value resolution + source-order override

Fixed R3 VALUES (`compileObjectLiteralForStruct`, `src/codegen/literals.ts`):

1. **Inline spread-source value resolution.** An INLINE object-literal spread
   source (`{ ...{x:1,y:2} }`) is never independently declared, so its anon
   object type was never registered as a struct: `resolveStructName` returned
   undefined, the source was dropped from `spreadSources`, and every
   spread-sourced field fell through to the undefined-default branch
   (`{ ...{x:1,y:2} }` → `{x:null,y:null}`, observed on main; WAT-confirmed even
   a *single* inline spread lost all values, broader than the spec's recorded R3).
   Fix: when `resolveStructName(srcType)` is undefined, call
   `ensureStructForType(ctx, srcType)` then re-resolve — mirrors the
   outer-literal registration at the `compileObjectLiteral` entry. NAMED sources
   already worked (their declaration registered the struct), so this is a no-op
   for them.

2. **Source-order override (the plan's `lastWriter`).** The field-assembly loop
   computed the winning writer (`lastMatch`) only from named/shorthand/method
   props, ignoring spread position, so `{ x:1, ...{x:5} }` kept `x:1`. Fix:
   record each spread's `propIndex` (position in `expr.properties`); per field,
   if a spread that defines the key sits AFTER the last named writer, take the
   spread's value. The overridden named prop's initializer is still evaluated +
   dropped for §13.2.5.5 side effects (verified: `{ x: se(), ...{x:5} }` calls
   `se()` once and yields 5).

Test: `tests/issue-2009.test.ts` +10 cases (9 value/override on `toEqual`
key-order-insensitive, 1 side-effect-order). Zero regressions —
`json-stringify`/`json`/`object-literals`/`computed-props`/`destructuring`
equiv suites identical to main (their incidental FAILs — `spread-rest`,
`basic-destructuring` "no tests", a couple json cases — are all PRE-EXISTING on
main, bisected). `tsc --noEmit` clean.

### R3b investigation (cs-2158, 2026-06-18) — acceptance MET; insertion-order is the high-blast remainder

Re-verified on current main: **all three stated acceptance-criteria repros now
MATCH Node exactly** (`{aa}|{bb}` names, `Object.assign({a:1},{b:2})` →
`{"a":1,"b":2}`, `{...{x:1,y:2},...{y:3,z:4},x:9}` → `{"x":9,"y":3,"z":4}`). The
acceptance criteria ("All three repros match Node" + source-order override + no
perf regression) are satisfied by PR-1/PR-1b/PR-2.

R3b (`{...{x:1,y:2},...{y:3,z:4}}` → `{"y":3,"z":4,"x":1}`, want `{"x":1,"y":3,"z":4}`)
remains. **Key new finding — a LOWER-blast-radius angle exists but the ordering
source does not:** the host enumeration order is the **field-name CSV** order,
NOT the struct slot order — `_structToPlainObject` (runtime.ts:2898) iterates the
CSV and reads each value via `__sget_<name>` **by name** (slot-independent). So
reordering only the CSV (leaving slots/getters/dedup/`$shape` untouched) would
fix R3b with near-zero blast radius — IF a correct insertion-order name list were
available.

**But the insertion order is NOT recoverable from the `ts.Type` or from symbol
declaration positions** (both proven wrong here):
- `tsType.getProperties()` returns last-spread-first (`y,z,x`).
- Sorting properties by `prop.declarations[0].pos` is ALSO incorrect: it fails
  when a key re-occurs in a later spread (the winning declaration moves later,
  but JS insertion order keeps the key at its FIRST occurrence). Verified
  counterexample: `{...{a:1}, ...{b:2}, ...{a:3}}` → decl-pos sort gives `b,a`,
  Node gives `a,b`. (`{...{a:1,b:2},...{b:3}}` and `{b:1,...{a:2}}` happen to
  match by pos, masking the bug — do NOT trust the pos heuristic.)

**Correct fix (the genuine remainder, high blast radius):** JS insertion order is
a property of the **literal expression**, not the type — it must be computed by
walking `expr.properties` in source order and, for spreads, each source's own
keys in order, taking FIRST occurrence. That ordered name list must then drive
the CSV (cheapest: a per-struct insertion-order name list recorded at
`compileObjectLiteralForStruct` and consulted by `emitStructFieldNamesExport`
instead of the slot order). Threading literal-derived order into the shared
canonical struct's CSV is the scoped-out high-blast-radius change; it also has to
pick a deterministic order when two literals of the same name-set but different
insertion order share one canonical type (dedup) — a genuine design decision, not
a mechanical patch. Left as `it.todo`; #2009 stays in-progress for R3b only.

### R3b STILL OPEN — spread-result key INSERTION ORDER (issue stays in-progress)
`{ ...{x:1,y:2}, ...{y:3,z:4} }` now has correct VALUES but stringifies as
`{"y":3,"z":4,"x":1}` instead of Node's `{"x":1,"y":3,"z":4}`. Root cause: the
spread-result anon struct's `fields` array is ordered last-spread-first by the
TypeChecker's `getProperties()` (WAT: `$__anon (struct $y $z $x)`); JSON /
Object.keys read that order. **Pre-existing on main** — affects NAMED-source
spreads too, independent of PR-2 (bisected against pre-#1462 and against current
main with named sources). Plain (non-spread) literals already preserve source
order, so the defect is specific to how the spread-result struct's fields are
registered. Fix needs `ensureStructForType` (or a literal-aware registration
pass) to order an anon object-literal type's fields by JS insertion order
(first-occurrence position across spread evaluation) rather than checker order —
higher blast radius (shared/canonical struct types, $shape, getters, dedup), so
scoped OUT of PR-2. Tracked as `it.todo` in `tests/issue-2009.test.ts`. Keep
#2009 in-progress until R3b lands.

## R3b LANDED (2026-06-19, sen-1) — CSV-reorder, not struct-field reorder

The prior R3b notes assumed the fix had to reorder the spread-result struct's
**fields** (high blast radius: shared canonical types, `$shape`, getters, dedup).
It does **not**. The host enumeration order is the **field-name CSV** in
`__struct_field_names`, which `_structToPlainObject` (runtime.ts) reads BY NAME
(`__sget_<name>` — slot-independent). So reordering only the CSV restores spec
enumeration order while leaving slots/getters/dedup/`$shape` byte-identical. The
struct field SLOT order stays last-spread-first; only the host's *view* of the
key order changes. This is the lowest-blast-radius angle sd5 (cs-2158) identified.

**Mechanism (4 files, +100/-2):**
- `CodegenContext.structInsertionOrder: Map<structName, string[]>`
  (`context/types.ts` + `create-context.ts`) — per anon-literal struct, the
  field names in JS INSERTION order.
- `compileObjectLiteralForStruct` (`literals.ts`): after `spreadSources` is
  built, walk `expr.properties` in source order — named/shorthand/method/accessor
  props contribute their key; a spread contributes its (already-resolved) source
  struct's own field names in order. FIRST occurrence fixes a key's position
  (`{...{a:1},...{b:2},...{a:3}}` → `a,b`). Recorded once per `typeName` (first
  literal of a deduped canonical type wins → deterministic by compile order).
- `orderNamesByInsertion(ctx, structName, slotNames)` (`index.ts`): pure permute
  of `slotNames` into the recorded insertion order; **membership preserved
  exactly** (never adds/drops a name, so every name still resolves to its
  getter). No recorded order ⇒ unchanged.
- Applied at the two CSV-build sites in `index.ts`: the legacy
  `emitStructFieldNamesExport` arm AND the colliding-`$shape`
  `resolveSameShapeFieldNameCollisions` arm (the structural-shape grouping key is
  still slot-order `typeParts`, so same-shape grouping is unaffected; only the
  enumerated `names`/shape-id CSV is reordered — two colliding structs with the
  same insertion order now share a shape-id).

**Fixed (asserted in `tests/issue-2009.test.ts`, R3b describe block):** inline +
named-source two-spread (`{"x":1,"y":3,"z":4}`), leading/trailing named props
interleaved with spreads, re-occurring-key first-position, Object.keys + for-in
order via a binding. Plain-literal control unchanged. `tsc --noEmit` clean. The
object/spread/json/destructuring equiv suites are unchanged vs main (the 4
`object-mutability`/`object-literal-getters-setters` "setter stores value" /
"is{Frozen,Sealed,Extensible} stub" FAILs are PRE-EXISTING on base, bisected by
stashing the src change and re-running — identical 4 fail).

**Known residual (acceptable, deterministic):** when two literals with the same
field-name SET but DIFFERENT insertion order DEDUP to one canonical struct type
(e.g. `{x:1,y:2}` and `{...{y:3},...{x:4}}` if the checker normalizes both to
slot order `x,y`), the FIRST-recorded literal's order wins for both — so the
second enumerates in the first's order (VALUES always correct, only key order
differs). A per-instance fix would need `$shape`-style per-instance ordering =
exactly the high blast radius this approach avoids; rare in practice, so left as
the documented deterministic choice. The inline `Object.keys({...spread...})`
direct-argument form still traps ("illegal cast") — a SEPARATE pre-existing
`Object.keys` inline-spread-argument lowering bug (reproduced on main with the
src change stashed), NOT an ordering issue; bind to a variable first. Carve
separately if needed.

All three original acceptance-criteria repros continue to match Node; R3b
enumeration order now matches too. #2009 closed.
