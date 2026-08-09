---
id: 2620
title: "Standalone `class X extends Set/Map` — synthetic accessor late-import index-shift (-1 global) + host-import leak"
status: ready
sprint: current
created: 2026-06-22
completed: 2026-06-22
assignee: sendev-flatten
priority: medium
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: collections
language_feature: Set, class
goal: standalone-mode
parent: 2162
depends_on: 2043
follow_up: 2622
# (#3102) +5 lines in an existing god-file: a 1-line predicate fix plus a
# 6-line pointer comment. The long-form analysis deliberately lives in this
# issue file ("the gc/host lane was NOT fine") rather than in the god-file —
# the comment was trimmed from 20 lines to 6 for exactly this reason. Extracting
# a module for a single boolean would not reduce the god-file meaningfully.
loc-budget-allow:
  - src/codegen/expressions/call-receiver-method.ts
# Same +5 lines seen by the per-function gate (#3400). Splitting
# `compileReceiverMethodCall` is worthwhile but is its own refactor — doing it
# inside a silent-wrong-answer bugfix would bury the fix in a large diff.
func-budget-allow:
  - src/codegen/expressions/call-receiver-method.ts::compileReceiverMethodCall
---

# #2620 — Standalone subclass-of-native-collection compile errors (split from #2606 Bug B)

Split out of #2606 (Bug A — null/undefined element coercion — landed; this is the
deeper, higher-risk Bug B the spec flagged as routable to the index-shift owner).

## Symptom

```
L2:1 Binary emit error: Codegen error: global index out of range — -1
(valid: [0, 10)) at function 'MySet_size'. This is the late-import index-shift
class (#2043): a captured index went stale across a deferred
flushLateImportShifts/addUnionImports/addStringImports shift…
```
from
```js
class MySet extends Set {
  size(...rest) { return super.size(...rest); }
  has(...rest)  { return super.has(...rest); }
  keys(...rest) { return super.keys(...rest); }
}
const s1 = new MySet([1, 2]);
s1.isSubsetOf(new Set([2, 3]));
```

`test/built-ins/Set/prototype/{union,intersection,difference,symmetricDifference,
isSubsetOf,isSupersetOf,isDisjointFrom}/subclass-receiver-methods.js` (~7 rows).

## What was confirmed (2026-06-22 — dev-collections)

This is **two intertwined defects**, both substrate-deep:

1. **Host-import leak.** Even a *bare* `class MySet extends Set {}` in standalone
   mode leaks `env::Set_new` / `env::Set_add` / `env::Set_has` host imports
   (`WebAssembly.instantiate(): Import #0 "env" …`). The subclass-of-native-
   collection construction path does NOT route through the WasmGC-native Set
   runtime — it falls to the externClass host path. A standalone subclass needs
   a native `extends $Map`-backed instance.
2. **`-1` global index** in the synthetic `<Class>_<method>` accessor body. Only
   the exact `size(...rest) { return super.size(...rest); }` + `has` + `keys`
   combination triggers it (a `-1` global.get/set baked by a late-import shift
   that the synthetic-accessor table is not shifted in lockstep with). This is
   the #2043 family — `addUnionImports`/`flushLateImportShifts` reorders the
   import/global table after the synthetic accessor's index was captured.

## Direction (for the index-shift / value-rep owner)

- Route `extends Set`/`extends Map`/`extends WeakMap`/`extends WeakSet` to a
  native `$Map`-backed instance in standalone (no `env::Set_*` host imports), the
  way #2162 made the base collections native.
- Apply the #2162 `mapHelpers`-shift lockstep discipline to the subclass-accessor
  index table: add it to every `addUnionImports`/`shiftLateImportIndices` site, or
  defer its registration until AFTER the collection runtime + box helpers are
  registered. Re-resolve by name after the last shift.
- Fallback if the machinery stays entangled: make `extends Set`/`extends Map` a
  *clean* compile error (not invalid-Wasm) so it never poisons the binary — but
  prefer the real native fix (the rows expect the subclass to work).

## Not in scope here

The ~21 instanceof/sameValue-bool rows (#2605) and the ~7 null/undefined element
rows (#2606 Bug A) are already fixed and merged separately.

## Resolution (2026-06-22, sendev-flatten — clean-CE refusal, native subclass parked to #2622)

Lead-approved scope (path 1): land the SAFE, right-sized fix in the index-shift
lane now; park the native subclass (the only thing that would *pass* the rows) to
a substrate follow-up. Confirmed against current main both defects reproduce, and
that **passing** the 7 `Set/prototype/*/subclass-receiver-methods.js` rows
requires the full native subclass (the tests assert `union` reads `[[SetData]]`
directly — `sizeCount/hasCount/keysCount === 0` — plus native spread +
`instanceof Set`/`!instanceof MySet` discrimination). That is collection-runtime
substrate (#2162-scale), not an index-shift point-fix → split to **#2622**.

### Root cause (confirmed)

`Set`/`Map`/`WeakMap`/`WeakSet` are in `BUILTIN_PARENTS_HOST_CONSTRUCTIBLE`
(`builtin-tags.ts`), so `class X extends Set` takes the generic host-constructible
subclass path: `new X()`/`super()` lower to the HOST `__new_Set` import. Under
`nativeStrings` (standalone/wasi) there is no JS host:

- **Defect A (host-import leak):** even a bare `class MySet extends Set {}` leaks
  `env::__new_Set` → `WebAssembly.instantiate` fails ("module is not an object").
- **Defect B (#2043 index-shift):** the synthetic `<Class>_<method>` accessor
  (`MySet_size`/`MySet_has`) desyncs across the addUnionImports/
  flushLateImportShifts reorder → invalid Wasm (`-1` global / a stale call
  funcIdx — on current main it surfaces as `MySet_has: call[0] expected externref,
  found local.get (ref null N)`).

The base collections ARE native-served (#1103a/#2162) — base `new Set([...])` is
intercepted to a `$Map`-backed instance in `new-super.ts` — but that interception
matches only the literal `Set`/`Map`/… constructor name, never a subclass.

### Fix (this PR)

Refuse a standalone subclass of a native-collection builtin at compile time —
clean `Codegen error:` (success:false, empty binary), never invalid Wasm, never a
leaked host import (the #1888 dual-mode invariant: "uncertainty ⇒ fail loud").

- `src/codegen/builtin-tags.ts` — new `NATIVE_COLLECTION_BUILTINS` set +
  `isNativeCollectionBuiltin(name)`.
- `src/codegen/class-bodies.ts` — at the heritage-clause chokepoint, BEFORE the
  externref-backed marking, if `ctx.nativeStrings && parentStructTypeIdx ===
  undefined && isNativeCollectionBuiltin(parent)`: queue the refusal and `break`
  (so the host-leak / invalid-Wasm path is never entered). gc/host mode is
  untouched (the refusal is `nativeStrings`-gated) — the externClass host path
  still compiles the subclass there.

Both defects become a single clean CE. Zero test262 regression risk: the rows
already failed (A = instantiate-fail, B = invalid-Wasm), so a graceful CE is
strictly ≥ the prior state. Validated: `extends Error/TypeError/Uint8Array`
standalone (#2029) and gc/host `extends Set` are unaffected; #1455's 2 failures
(`extends WeakRef`, `TypeError instanceof` chain) are PRE-EXISTING on main,
A/B-confirmed, unrelated (those aren't collection builtins).

Test: `tests/issue-2620-extends-set-standalone-refusal.test.ts`.

### Follow-up

**#2622** — native `extends Set/Map/WeakMap/WeakSet` subclass (native
`$Map`-backed construction + `[[SetData]]`/`[[MapData]]` direct set-algebra +
native iteration + `instanceof` discrimination) → the real +7
subclass-receiver-methods rows. Value-rep / collection-runtime lane (#2162/#2580
M2).

## Reopened 2026-07-20 (stale false-done review)

Marked `done` but live test262 shows: class extends WeakSet still 'not yet supported in --target standalone'. Reopened as `ready`. See #3474 (done-status integrity).

## Correction 2026-07-31 — the gc/host lane was NOT fine

The resolution note above states that the standalone refusal leaves "gc/host
mode untouched — the externClass host path still compiles the subclass there".
It compiles there. It also **silently computed the wrong answer**, which is
strictly worse than the standalone refusal, because there is no diagnostic and
no trap — just valid Wasm returning a lie.

Measured on `--target gc` (default), each row paired with a plain-collection
control performing the identical operations (all controls passed, so this is
the subclass path, not the harness):

| operation on `class R extends Map {}`        | expected | measured |
| -------------------------------------------- | -------- | -------- |
| `m.set("k", 7)` then `m.get("k")`            | 7        | undefined |
| `m.set(a,1); m.set(b,2)` then `m.size`       | 2        | 0        |
| `m.set("a", 1)` then `m.has("a")`            | true     | false    |
| `class B extends Set {}`, `add` ×2 then size | 2        | 0        |

### Mechanism

`compileReceiverMethodCall` (`src/codegen/expressions/call-receiver-method.ts`)
coerced an externref receiver to the receiver class's struct **whenever such a
struct existed, regardless of what the callee expected**. A builtin-collection
subclass instance is a real host `Map`/`Set` from `__new_Map`/`__new_Set`, never
a `$R` struct, so `emitGuardedRefCast` always failed, produced null, and the
`ref_null` null-guard returned the default instead of emitting the call:

```wat
ref.test (ref $R)
(if (result externref)
  (then ref.null extern)          ;; receiver "wrong struct type" -> call DROPPED
  (else … call $Map_set_import))
```

The cast was pointless even on paper — the callee is a host import taking
`externref` self, so the following coercion converted the struct straight back
with `extern.convert_any`. It could only ever destroy the receiver.

**Fix:** gate that coercion on the callee's declared first-param type, so the
struct cast happens only when the method actually expects a struct. Genuine
struct-receiver calls — including own methods of externref-backed classes —
keep the guarded-cast path unchanged.

Test: `tests/issue-2620-gc-host-inherited-collection-methods.test.ts`.

### Still broken after this fix (pinned, not closed)

`this.<inherited>()` inside an OWN method is still dropped. That is a defect one
level up: `class-bodies.ts` hardcodes a STRUCT self param for instance methods
(both the collection site ~1141 and the body-compile site ~2213) while the
instance is an externref, so the caller's guard-cast passes NULL into every own
method. Pinned as an explicit rung in the test file above.

### Architectural note — this is the wrong representation

Fixing the host path is a correctness stopgap, not the destination:

- **Standalone gets nothing.** These subclasses are still refused there; the
  host `__new_Map` import is exactly what cannot be satisfied.
- **gc pays a JS boundary crossing per `set`/`get`/`has`.**
- **The subclass never reaches the native substrate for a one-line reason:**
  `new-super.ts:3033` gates the WasmGC-native interception on
  `expr.expression.text === "Map"` — a literal constructor-NAME match. `new R()`
  cannot match it. Routing "resolves to the Map/Set builtin, directly or through
  a subclass chain" into that path is the real fix (#2622), and it also makes
  the own-method self-type question above moot.
- **Even the native path is not narrowly typed.** `$MapEntry` is
  `{ key: anyref, value: anyref, next: i32, hash: i32 }` (`map-runtime.ts:100`),
  so a `Map<string, number>` boxes every value and goes through generic
  hash/eq. Specialising the entry struct when key/value types are statically
  known is a separate perf slice that benefits BASE collections too, and should
  not be folded into #2622 or it will never land.
