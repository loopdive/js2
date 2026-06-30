---
id: 2869
title: "Destructuring with a member-expression assignment target ([x.y]=vals, {k:x.y}=src) — funcIdx-repoint of detached body buffer (~53 fails)"
status: in-progress
assignee: ttraenkler/senior-dev-promise
created: 2026-06-30
updated: 2026-06-30
parent: 2669
priority: high
feasibility: hard
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 2015
language_feature: destructuring
goal: spec-completeness
architect_spec: done
sprint: current
related: [2669, 2664, 2659, 2567, 1109, 1461, 2191, 2193]
---

# #2869 — member-expression assignment-target destructuring (funcIdx-repoint of the detached destructure buffer)

## Edition / impact

- **Edition:** ES2015 (DestructuringAssignmentTarget may be a PropertyReference — §13.15.5.x AssignmentElement).
- **Fail count:** ~53. Split: assignment-expression **25**, for-of **26**, for-await **4**.
  (The object-pattern externref subset, +3, already passes; the array path emits
  malformed Wasm.) Child of the #2669 destructuring umbrella.
- **Symptom shape:** `var x = {}; [x.y] = [4]; assert.sameValue(x.y, 4)` — the
  write to `x.y` is dropped (array path) or mis-targeted (member-set dispatch
  off-by-one → `need 3 got 2` invalid Wasm / runtime recursion on a plain `{}`).

## Sample tests

```js
// test/language/expressions/assignment/dstr/array-elem-put-prop-ref.js
var x = {};
var vals = [4];
result = [x.y] = vals;
assert.sameValue(x.y, 4);
assert.sameValue(result, vals);
```

The `-no-get` / `-user-err` variants assert the **value is read exactly once**
and that a throwing setter on the base propagates (setter side effects).

---

## Implementation Plan

### Root cause (two coupled defects)

**(A) The write is dropped for a non-static-struct member target.**
`emitAssignToTarget` (`src/codegen/expressions/assignment.ts:2150`) handles a
`PropertyAccessExpression` target *only* when `target.expression` resolves to a
registered struct **and** `target.name` is a static field of it
(`src/codegen/expressions/assignment.ts:2164–2182`). Every miss early-`return`s
and **silently drops the write** — lines `2165` (`!typeName`), `2169`
(`structTypeIdx===undefined || !fields`), `2173` (`fieldIdx===-1`). A plain
`{}` receiver (the test's `var x = {}`) hits the `fieldIdx===-1`/`!typeName`
miss, so `x.y` is never written. `plain x.y = 4` already works via
`tryEmitPinnedStructMemberSet` (`assignment.ts:2745`) →
`emitAlternateStructSetDispatch` → the #2664 `__set_member_<name>` dispatcher,
whose terminal else-arm is the `__extern_set_strict` sidecar (native `$Object`
store standalone / host set in JS mode). The destructure target path simply
never routes there.

**(B) Routing the dynamic case through the dispatcher hits the late-import
funcIdx-repoint hazard, because the dispatch `call` lands in a DETACHED body
buffer the shift walker never visits.**
`compileArrayDestructuringAssignment` swaps `fctx.body` to a fresh detached
buffer for the element loop:

- `assignment.ts:1591` `savedBodyADA = fctx.body`
- `assignment.ts:1592` `arrDestructInstrsADA: Instr[] = []`
- `assignment.ts:1593` `fctx.body = arrDestructInstrsADA`  ← detached window opens
- … element loop (calls `emitAssignToTarget` at `1781`/`1786`) …
- `assignment.ts:1912` `fctx.body = savedBodyADA`  ← restore
- `assignment.ts:1914` `buildDestructureNullThrow(...)` ← runs while buffer is still detached + unspliced
- `assignment.ts:1921`/`1924` splice `arrDestructInstrsADA` back in

`shiftLateImportIndices` (`src/codegen/expressions/late-imports.ts:144`) walks a
fixed set of bodies: `ctx.mod.functions[*].body`, `fctx.body` + `fctx.savedBodies`,
`ctx.currentFunc.body` + saved, `ctx.funcStack[*]` + saved,
`ctx.parentBodiesStack[*]`, `ctx.liveBodies[*]`, `ctx.pendingInitBody`
(`late-imports.ts:177–222`). **The detached `arrDestructInstrsADA` is in NONE of
these** — it lives only in a JS local. So any late import added while the buffer
is not the active `fctx.body` shifts every defined-function index (in `funcMap`
and in the walked bodies) **but leaves the buffer's already-emitted
`call <dispIdx>` stale-low.**

`emitAlternateStructSetDispatch` (`src/codegen/property-access.ts:1431`) →
`reserveMemberSetDispatch` (`src/codegen/member-set-dispatch.ts:75`) settles its
*own* import batch (`flushLateImportShifts` at `member-set-dispatch.ts:107`)
before reserving the dispatcher funcIdx, so the `call` is **correct at emit
time**. It goes stale only when a **subsequent** late import shifts it:

- **(b1) in-loop nested temp buffer.** A later element with a default
  (`[a = d, x.y] = …`) swaps `fctx.body` to a temporary `[]`
  (`assignment.ts:1832`) and calls `ensureLateImport("__extern_is_undefined")`
  + `flushLateImportShifts` at `assignment.ts:1839–1840`. That flush walks the
  temp `[]` and `savedBodies`/`currentFunc` — but **not** the detached
  `arrDestructInstrsADA`. The dispatcher's defined-func slot moves up; the
  buffer's `call` does not.
- **(b2) the splice-gap.** `buildDestructureNullThrow` (`assignment.ts:1914`)
  can pull a late import; that flush runs with `fctx.body === savedBodyADA`
  while `arrDestructInstrsADA` is still **unspliced** → missed.

This is exactly dstr5's WAT finding: the dispatch is `call 11` while
`__set_member_y` actually lives at idx `12` — stale-low by one. The
`need 3 got 2` invalid Wasm and the runtime recursion on plain `{}` are
downstream symptoms of the `call` landing on the **wrong neighbor function**
(different signature → stack imbalance; or a self/loop call).

This is the documented late-import funcIdx-shift / finalize-repoint class
(memories `reference_1461_*`, `reference_2191_*`, `reference_2193_*`) and the
**same** detached-default-buffer hazard already solved for the *param*
destructure sibling in `src/codegen/destructuring-params.ts:595–641` (#2567 /
#1109): register the detached buffer with `ctx.liveBodies` for the compile
window, delete it after reattach.

### Why dstr5's "pre-ensure imports before the body-swap" did NOT settle it

Pre-ensuring `__extern_set_strict` + the union helpers *before* line `1593`
removes **one** import from the in-loop window, but cannot remove **all** of
them, so the buffer stays structurally unwalkable:

1. The dispatcher funcIdx itself is **reserved per-property at the write site
   inside the loop** (`reserveMemberSetDispatch`), not hoistable — the
   `__set_member_<name>` defined function is appended to `ctx.mod.functions`
   mid-loop.
2. A **heterogeneous** pattern still triggers *other* late imports mid-loop /
   in the splice-gap regardless of pre-ensuring: `__extern_is_undefined`
   (`1839`), `__extern_get` / `__box_number` / `__extern_slice` on mixed
   element kinds, and `buildDestructureNullThrow` (`1914`).

Each of those shifts the dispatcher's defined-func index up while the detached
buffer's `call` is invisible to the walker. **No amount of pre-ensuring makes
the detached array reachable by `shiftLateImportIndices`** — the only robust fix
is to make the buffer reachable for the whole detached window. (A correct
*ordering* alone does not exist here because the dispatcher reservation is
intrinsically per-site and in-loop.)

### Recommended fix — Direction (1): register the detached buffer with the repoint pass

Adopt the proven #2567/#1109 pattern. `shiftLateImportIndices` already walks
`ctx.liveBodies` (`late-imports.ts:217–219`) and dedups by array identity via
its `shifted: Set<Instr[]>` (`late-imports.ts:155–158`), so a registered
detached buffer is shifted in lockstep with every in-window flush, and the
post-splice double-walk is guarded.

**Direction (2) (name-keyed placeholder `call`-by-name resolved at finalize) is
NOT recommended here.** That tool is for bodies detached **across the finalize
boundary** (reserve-then-fill dispatcher bodies). This buffer is reattached
during the **same** compile pass, within a bounded window, so it needs no new
`Instr` variant, no encoder change, and no finalize pass — Direction (1) is
strictly lighter and matches the sibling param-destructure precedent. Use
Direction (1).

#### Change 1 — route a dynamic member target through the dispatcher

**File: `src/codegen/expressions/assignment.ts`** — function `emitAssignToTarget`
(line 2150). In the `ts.isPropertyAccessExpression(target)` branch
(`2157–2182`), keep the static-struct-field fast path, but replace each early
`return` at a **field/struct miss** (`2165`, `2169`, `2173`) with a fall-through
to a new dynamic block that mirrors `tryEmitPinnedStructMemberSet`
(`assignment.ts:2745–2797`). The value is **already** in `valueLocal` (do NOT
recompile the value AST):

```ts
// (after the static-field path declines: !typeName / no struct / fieldIdx === -1)
if (ts.isPrivateIdentifier(target.name)) return;            // # private — out of scope, drop
const propName = target.name.text;
// receiver → externref local
const recvRes = compileExpression(ctx, fctx, target.expression);
if (recvRes && recvRes.kind !== "externref") coerceType(ctx, fctx, recvRes, { kind: "externref" });
else if (!recvRes) fctx.body.push({ op: "ref.null.extern" } as Instr);
const objLocal = allocLocal(fctx, `__dstr_set_obj_${fctx.locals.length}`, { kind: "externref" });
fctx.body.push({ op: "local.set", index: objLocal });
// value (already computed) → externref local
fctx.body.push({ op: "local.get", index: valueLocal });
if (valueType.kind !== "externref") coerceType(ctx, fctx, valueType, { kind: "externref" });
const valLocal = allocLocal(fctx, `__dstr_set_val_${fctx.locals.length}`, { kind: "externref" });
fctx.body.push({ op: "local.set", index: valLocal });
// #2664 deferred member-set dispatcher; terminal else-arm = __extern_set_strict
emitAlternateStructSetDispatch(ctx, fctx, objLocal, valLocal, propName, /*strict*/ true);
return;
```

`emitAlternateStructSetDispatch` is already imported (`assignment.ts:38`). It
calls `reserveMemberSetDispatch(ctx, propName, true, fctx)` which **flushes the
`__extern_set_strict` + union-import batch before reserving the dispatcher
funcIdx** (so `dispIdx` is final at emit time). The dispatcher tests every
mutable struct candidate that owns `propName` at finalize
(`fillMemberSetDispatch`, `member-set-dispatch.ts:136`) and falls through to
`__extern_set_strict(recv, "<name>", val)` for a plain `{}` / accessor / host
externref — strict so a getter-only accessor throws per §[[Set]].

> **Reserved-name carve-out.** `length` / `constructor` / `__proto__` /
> `prototype` / `name` must NOT use the named dispatcher (mirror
> `tryEmitPinnedStructMemberSet:2753–2761`). For `[obj.length] = v` etc., emit a
> **bare `__extern_set_strict(recv, "<name>", val)`** terminal instead of the
> dispatcher (ensure it via `ensureLateImport` + `flushLateImportShifts(fctx)`
> in-window). These names are outside the 53-test scope; the bare-sidecar
> fallback keeps them correct rather than dropped.

> **ElementAccess with a dynamic key** (`[x[k]] = v`) stays on the existing
> vec/struct path (`assignment.ts:2183–2229`); a fully-dynamic computed-key
> write needs `__extern_set(recv, key, val)` (not the *named* dispatcher) and is
> a follow-on, not part of this cluster (the 53 are all property-name targets).

#### Change 2 — keep the detached buffers reachable by the shift walker

Apply the #2567 `ctx.liveBodies` registration to **every** destructure-assignment
detached buffer that can now reach a member-set dispatch (all three call
`emitAssignToTarget`). Pattern: `add` at the swap, `delete` after reattach,
**before** `return` (so the rest of the enclosing function — which keeps
compiling and may add more late imports — does not double-walk the now-`fctx.body`-reachable
elements; the `shifted` Set only dedups by array identity, and the
non-nullable spread-splice shares element objects with `fctx.body`).

- **`compileArrayDestructuringAssignment`** (`assignment.ts:1498`):
  `ctx.liveBodies.add(arrDestructInstrsADA)` immediately after `1593`;
  `ctx.liveBodies.delete(arrDestructInstrsADA)` after the splice (after `1922`
  in the nullable branch and after `1924` in the else branch), before the
  trailing `local.get tmpLocal` / `return resultType` at `1928–1929`. This
  covers both (b1) the in-loop `__extern_is_undefined` flush at `1839–1840` and
  (b2) the `buildDestructureNullThrow` splice-gap flush at `1914`.
- **`compileDestructuringAssignment`** (object, `assignment.ts:729`): same around
  `destructInstrsDA` — `add` after `1015`, `delete` after the splice that
  follows `1349`/`1351`. It calls `emitAssignToTarget` at `1296`.
- **`emitObjectDestructureFromLocal`** (`assignment.ts:2234`): same around
  `odflInstrs` — `add` after `2269`, `delete` after the splice at `2368`/`2371`.
  It calls `emitAssignToTarget` at `2351`.

(`emitArrayDestructureFromLocal` at `2376` should get the same treatment if it
swaps to a detached buffer and can reach a member target — verify and mirror.)

> Double-shift guard: in the **nullable** branch the buffer becomes a nested
> `else:` arm (distinct array identity, no element-sharing) — the `shifted` Set
> dedups it cleanly even pre-delete. The **non-nullable** branch spread-copies
> elements into `fctx.body` (`push(...buf)`), so the SAME `Instr` objects are
> reachable via two arrays; deleting the buffer from `liveBodies` right after
> the splice (no flush occurs in that gap) prevents the #1109 double-shift on
> any later flush.

#### Change 3 — route member targets in the for-of / for-await assignment path

**File: `src/codegen/statements/loops.ts`** — function
`compileForOfAssignDestructuring` (line 1990). This path emits per-iteration
directly into the **live** loop `fctx.body` (no long-lived detached buffer), so
the funcIdx hazard of Change 2 does **not** apply here — the dispatcher reserve
flush walks the live `fctx.body` correctly. The fix is purely to stop dropping
member targets:

- Tuple branch: `if (!ts.isIdentifier(targetEl)) continue;` at **~`loops.ts:2287`**.
- Vec branch: `if (!ts.isIdentifier(targetEl)) continue;` at **~`loops.ts:2403`**.
- Object branch: identifier-only target resolution at **~`loops.ts:2027–2055`**
  and **~`loops.ts:2081–2137`**.

Replace each `continue`/identifier-gate with: when `targetEl` (resp.
`prop.initializer`) is a `PropertyAccessExpression`, extract the field value
into a temp local of `fieldType` (the existing `local.get elemLocal` +
`struct.get`/`emitBoundsCheckedArrayGet` already on these branches), then call
the **same** member-set helper as Change 1. Export `emitAssignToTarget` from
`assignment.ts` (or factor a thin `emitDynamicMemberSet(ctx, fctx, target,
valLocal, valType)` and call it from both files) so loops.ts reuses one
implementation:

```ts
// tuple/vec branch, replacing the identifier-only gate:
if (ts.isPropertyAccessExpression(targetEl)) {
  const tmpV = allocLocal(fctx, `__forof_memtgt_${fctx.locals.length}`, fieldType);
  fctx.body.push({ op: "local.get", index: elemLocal });
  /* tuple: */ fctx.body.push({ op: "struct.get", typeIdx: innerVecTypeIdx, fieldIdx: i });
  /* vec:   struct.get fieldIdx 1 + i32.const i + emitBoundsCheckedArrayGet(...) */
  fctx.body.push({ op: "local.set", index: tmpV });
  emitAssignToTarget(ctx, fctx, targetEl, tmpV, fieldType);
  continue;
}
```

- **for-await** (`stmt.awaitModifier`) shares
  `compileForOfAssignDestructuring`, so it is fixed **transitively** — the
  per-element member write is identical to for-of. The existing
  `!stmt.awaitModifier` carve-outs only gate **call-valued defaults**
  (`loops.ts:1519`), which do not affect a bare member target.
- The for-of **externref** elem path
  (`compileForOfAssignDestructuringExternref`, dispatched at `loops.ts:2150`)
  should get the same member-target routing for `[x.y]` over a host/dynamic
  source — mirror it there too.

### Wasm IR pattern (the dynamic member set, post-fix)

```wasm
;; [x.y] = [4]  with x : plain {}
;; element 0 already extracted into $val (externref / boxed 4)
local.get $x_extern          ;; receiver as externref
local.set $obj
local.get $val
local.set $valext
local.get $obj
local.get $valext
call $__set_member_y         ;; <-- funcIdx STAYS correct under later late-import shifts
                             ;;     because arrDestructInstrsADA is now in ctx.liveBodies
;; __set_member_y(recv, val):
;;   any.convert_extern recv -> $any
;;   if ref.test $StructWithY: cast; coerce val->fieldT; struct.set
;;   ... (every mutable candidate, enumerated at finalize)
;;   else: __extern_set_strict(recv, "y", val)   ;; plain {} / accessor / host
```

### Edge cases

- **Plain `{}` receiver** (the headline test): no struct candidate matches →
  dispatcher falls to `__extern_set_strict`, native `$Object` store standalone /
  host set in JS mode. The earlier "runtime recursion on `{}`" was a **symptom
  of the off-by-one** (`call` hit the wrong neighbor) — it disappears once the
  buffer is registered with `liveBodies`. Verify `x.y === 4` and no recursion on
  `array-elem-put-prop-ref.js`.
- **Multiple member targets** `[x.y, a.b] = …`: each reserves its own
  `__set_member_<name>` (distinct defined functions appended at the end — they
  do not shift import indices). The first reserve pulls `__extern_set_strict` +
  union helpers (a real shift); the buffer registration makes the first
  already-emitted `call` survive it.
- **Setter side effects / `-user-err`**: strict dispatcher → getter-only or
  throwing setter on the base propagates at `[[Set]]` time (the dispatch call),
  after the value is read once. Matches `*-user-err` / `*-no-get` assertions.
- **`-no-get`**: the value is materialized into `valLocal` exactly once before
  the dispatch; the base is not read as a getter (it is the assignment *target*
  reference). No spurious `[[Get]]`.
- **for-of vs for-await vs assignment-expr**: assignment-expr → Change 1+2
  (detached buffer); for-of/for-await → Change 3 (live loop body, no buffer
  hazard). All three share the member-set helper.
- **Evaluation order** (base-ref vs iterator step): the destructure driver
  pre-computes the value (`valueLocal`) then this code evaluates the base
  (`x`). For the 53 in-scope tests the base is a side-effect-free `var x = {}`,
  so order is immaterial. Strict base-eval-before-value ordering (the `*-init-*`
  / getter-on-base interleave tests) is a separate #2669 sub-cluster — flag, do
  not block.
- **Reserved names / private**: `[obj.length]=` → bare `__extern_set_strict`
  fallback; `[obj.#y]=` → out of scope (drop). Both outside the 53.
- **Null/undefined source**: unchanged — the existing array-pattern GetIterator
  guard (`emitExternrefAssignDestructureGuard` / `buildDestructureNullThrow`)
  still throws TypeError for `[x.y] = null`.

### Scoped repro

```bash
# build, then compile + run the headline case
cat > .tmp/m.ts <<'EOF'
const x: any = {};
const vals = [4];
const result = ([x.y] = vals);
console.log(x.y);            // expect 4
console.log(result === vals); // expect true
EOF
node dist/cli.js .tmp/m.ts -o .tmp/m.wasm   # must NOT emit "need 3 got 2"
# wat sanity: the `call` into the destructure block targets __set_member_y, not idx-1
wasm-tools print .tmp/m.wasm | grep -n "set_member_y\|call " | head
```

Confirm: no validation error, `x.y` prints `4`, no stack-imbalance, no recursion.

### Test262 paths unblocked (representative; ~53 total)

Assignment-expression (`test/language/expressions/assignment/dstr/`):
- `array-elem-put-prop-ref.js`, `array-elem-put-prop-ref-no-get.js`,
  `array-elem-put-prop-ref-user-err.js`
- `array-elem-put-obj-literal-prop-ref.js`,
  `array-elem-put-obj-literal-prop-ref-init.js`,
  `array-elem-put-obj-literal-prop-ref-init-active.js`
- `array-elem-nested-memberexpr-optchain-prop-ref-init.js`
- `array-rest-put-prop-ref.js`, `array-rest-put-prop-ref-no-get.js`,
  `array-rest-put-prop-ref-user-err.js`,
  `array-rest-put-prop-ref-user-err-iter-close-skip.js`
- `obj-prop-put-prop-ref.js`, `obj-prop-put-prop-ref-no-get.js`,
  `obj-prop-put-prop-ref-user-err.js`,
  `obj-prop-elem-target-memberexpr-optchain-prop-ref-init.js`,
  `obj-prop-elem-target-obj-literal-prop-ref{,-init,-init-active}.js`

for-of (`test/language/statements/for-of/dstr/`) and for-await
(`test/language/statements/for-await-of/`): the mirrored
`*-put-prop-ref*` / `*-prop-ref-*` set (≈12 + ≈14 respectively; the bare
member-target subset of those is the ~26 + ~4 in scope).

### Coordination / overlap flag

The parallel session is active on the value-rep **substrate / `$Object`** read
path, `calls.ts`, and closures (#2826 / #2818). This issue is the member-**SET**
dispatch (`emitAlternateStructSetDispatch` / `__set_member_<name>` /
`__extern_set_strict`) **plus** the detached-body-splice in
`expressions/assignment.ts` + the for-of routing in `statements/loops.ts` —
**adjacent but disjoint files**. The one true shared surface is
`reserveMemberSetDispatch` / `fillMemberSetDispatch` (`member-set-dispatch.ts`)
and the `$Object` terminal in `__extern_set_strict`: if the parallel work
changes the `$Object` store ABI or the union-import set, re-merge `origin/main`
and re-verify the dispatcher fill. No expected conflict in `assignment.ts` /
`loops.ts`. Recommend landing after, or merging up from, the substrate PRs to
inherit any `__extern_set_strict` changes.
