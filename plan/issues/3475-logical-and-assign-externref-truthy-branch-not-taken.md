---
id: 3475
title: "defineProperty-added (externref/dynamic-shape) property: ALL writes silently dropped — general write-persistence bug (NOT a logical-assignment branch bug)"
status: ready
sprint: current
created: 2026-07-20
updated: 2026-07-21
priority: high
horizon: m
feasibility: hard
reasoning_effort: high
task_type: bug
area: codegen
language_feature: property-write, defineProperty, dynamic-property
es_edition: es2021
goal: es5
related: [3430]
origin: "Discovered 2026-07-20 while implementing #3430 (strict compound/logical assignment [[Set]]-failure-throws fix). Isolated as a pre-existing, unrelated bug — NOT caused by the #3430 fix (reproduces identically with #3430's diff removed)."
---

# #3475 — writes to a `Object.defineProperty`-added property are silently dropped

> **RE-SCOPED 2026-07-21 (dev-b, verify-first). This section SUPERSEDES the
> original diagnosis (`&&=` truthy-branch not taken), preserved below under
> "## Original (mis-diagnosed) report" for history.** The original title/root-
> cause were wrong: the bug is **not** specific to `&&=` and **not** a
> then/else branch-swap in `operator-assignment.ts`. See the measured controls.

## Real bug (measured, current main d3d2454, host + standalone lanes)

**ALL writes to a property added via `Object.defineProperty` (i.e. a property
that routes through the externref / dynamic-shape fallback path, because
TypeScript can't resolve a static struct field for it) are silently dropped.**
The write is a no-op; a subsequent read returns the property's *initial
descriptor value*. This affects plain assignment, compound assignment, and
every logical-assignment operator equally. Only the **static object-literal
struct path (Path A)** — where the field IS statically known — persists writes.

### Measured control table

Property under test: `Object.defineProperty(obj, "prop", { value: 2, writable: true, enumerable: true, configurable: true })`, then the write in `test()`, then `return obj.prop`. Run on **both** the host/gc lane (linked via `buildImports`) and the standalone lane (empty imports); results are identical on both lanes.

| write in `test()`            | spec-expected | actual (host & standalone) | verdict   |
| ---------------------------- | ------------: | -------------------------: | --------- |
| `obj.prop = 99`              |            99 |                          2 | **WRONG** |
| `obj.prop += 40`             |            42 |                          2 | **WRONG** |
| `obj.prop &&= 99` (prop = 2, truthy → assign) | 99 |             2 | **WRONG** |
| `obj.prop ||= 99` (prop = 0, falsy → assign)  | 99 |             0 | **WRONG** |
| `obj.prop &&= 99` (prop = 0, falsy → keep)    |  0 |             0 | ok (no write expected) |
| `obj.prop ||= 99` (prop = 2, truthy → keep)   |  2 |             2 | ok (no write expected) |
| `obj.prop ??= 99` (prop = 2, non-null → keep) |  2 |             2 | ok (no write expected) |
| **control:** object-literal `const obj:any={prop:2}; obj.prop &&= 99` (Path A, static struct field) | 99 | 99 | ok (persists) |

So plain `=` already fails — the logical operators are not special. The
**reads** work (they return the descriptor value); the **writes** never reach
the storage the reads observe.

### Why the original report said "`||=` works"

The original probe tested `||=` on a **truthy** value (`prop = 2`), where the
spec correctly short-circuits and performs **no write** — so the property
trivially stayed `2` and looked correct. Testing `||=` on a **falsy** value
(`prop = 0`, where a write IS required) exposes the identical failure. The
"`||=`/`??=` work, only `&&=` is broken" conclusion is a **false negative** of
that truthy-value probe.

## Fix locus (RE-POINTED)

**NOT** `emitLogicalAssignmentPattern` / the `&&=` arm in
`src/codegen/expressions/operator-assignment.ts` (the original hypothesis).
Since plain `obj.prop = 99` also drops the write, the defect is in the
**`$Object` / defineProperty dynamic-property WRITE path** — most likely one of:

1. `Object.defineProperty` does not create a **writable slot** that the
   externref property-write path (`__extern_set` / the property-assignment
   externref fallback) actually targets — i.e. read and write resolve to
   different storage (read finds the descriptor value; write goes elsewhere or
   is dropped), **or**
2. the externref property-**write** emission for a `defineProperty`-added key is
   itself a no-op (the value is computed and discarded, or the `__extern_set`
   call is not emitted / not reached).

A dev must root-cause with the WAT of `obj.prop = 99` on the defineProperty
shape (one `emitWat: true` compile) and diff the write emission against the
working Path-A struct-field `struct.set`. The logical-assignment operators will
be fixed for free once the base write persists — they share this write path.

## Conformance breadth (why priority bumped low → medium)

This is a **silent data-loss class** bug, not a niche operator quirk: *any*
program that does `Object.defineProperty(o, k, { writable: true, … })` and then
writes `o.k` gets a dropped write with no error. test262 has a large
`Object/defineProperty` + `Reflect.defineProperty` surface plus many harness
patterns that define-then-write a writable data property, so the fix may move a
non-trivial number of `defineProperty`-write tests. (Final priority is a PO
call — flagged here from the reframing, not unilaterally set high.)

## Ownership — RECONCILE BEFORE BUILDING (do not steal the lock)

`scripts/claim-issue.mjs 3475` reports the issue **claimed by the shared slug
`ttraenkler/senior-dev` since `2026-07-19T22:48:50Z`**. That timestamp is UTC;
in this repo's `+0200` local time it is `2026-07-20 00:48` — the **same day**
this issue was filed, so it may be a **live sendev/codex claim**, not stale.
The grep-gate on `origin/main` is clean (no merged fix) and there is no open PR,
but ownership is **unresolved**. The tech lead must reconcile with the sendev/
codex lane before any dev starts implementation. Do **not** `--force` steal.

## Acceptance criteria (updated)

- Plain `obj.prop = 99`, `obj.prop += 40`, and `obj.prop &&= / ||= / ??= 99`
  on a `Object.defineProperty(…, { writable: true })` property all **persist**
  the write (read-back returns the written value) when a write is required —
  on both the host/gc and standalone lanes.
- Regression guard: static object-literal (Path A, struct-field) property
  writes and element-access (`arr[i] = v`) writes stay unchanged.
- Add a focused vitest regression test covering the control table above
  (plain `=`, `+=`, and all three logical-assign operators, truthy + falsy).

---

## Original (mis-diagnosed) report — SUPERSEDED, kept for history

> The section below is the ORIGINAL 2026-07-20 write-up. Its root-cause
> hypothesis (`&&=`-specific then/else swap in `operator-assignment.ts`) and its
> "`||=`/`??=` work" claim are DISPROVEN by the measured control table above.
> Retained only so the reasoning trail is not lost.

### Problem (original)

`obj.prop &&= rhs` on a property that falls through to the externref/host
sidecar path (`compilePropertyLogicalAssignmentExternref` in
`src/codegen/expressions/operator-assignment.ts`) never executes the
"truthy → assign RHS" branch, even when the current value IS truthy. The
property is left unchanged and no write is ever attempted (confirmed via a
compile-time trace on the write-back import selection — it correctly resolves
`__extern_set`/`__extern_set_strict`, but the runtime `if` never takes that
arm).

This is **isolated from #3430** — reproduces identically whether or not
#3430's strict-set fix is applied, so it is not a #3430 regression. `||=` and
`??=` on the exact same property shape work correctly (confirmed via a
side-by-side probe); only `&&=` is affected.
[[RE-SCOPE NOTE: false — the `||=` probe used a truthy value; on a falsy value
`||=` drops the write identically. See the control table above.]]

### Original repro

```ts
var obj = {};
Object.defineProperty(obj, "prop", { value: 2, writable: true, enumerable: true, configurable: true });
export function test(): number {
  obj.prop &&= 99;
  return obj.prop; // expected 99 (2 is truthy → assign) — actual: 2 (unchanged)
}
```

Contrast with the literal-object-property case, which works correctly (takes
Path A — the compiler's static struct-field `struct.set`, unaffected since it
never reaches the externref fallback at all):

```ts
export function test(): number {
  const obj: any = { prop: 2 };
  obj.prop &&= 99;
  return obj.prop; // 99 — correct
}
```

The defining characteristic that routes into the broken path: the property is
added via `Object.defineProperty` (or otherwise not statically known to
TypeScript on the object literal), so `resolveStructNameForExpr` /
`fields.findIndex` can't resolve a static struct field and
`compilePropertyLogicalAssignment` falls back to
`compilePropertyLogicalAssignmentExternref`.

### Original root-cause hypothesis (DISPROVEN — see re-scope)

`emitLogicalAssignmentPattern` in `src/codegen/expressions/operator-assignment.ts`
(~line 961, the `&&=`/else branch) is structurally symmetric with the
`||=` branch (~line 931) — same `emitGet`/`ensureI32Condition`/`if` shape,
just then/else swapped. The write-back's `setName` (`__extern_set` vs
`__extern_set_strict`) resolves correctly at COMPILE time (confirmed via
trace), so the bug is in the RUNTIME condition/branch-taking, not the write
selection.
[[RE-SCOPE NOTE: disproven — plain `obj.prop = 99` (which never touches
`emitLogicalAssignmentPattern`) also drops the write. The defect is in the
shared defineProperty/externref WRITE path, not the logical-assign branch.]]

### Original notes

Low priority / small horizon — a narrow, self-contained bug once root-caused,
but out of scope for #3430 (whose acceptance criteria is about
integrity-level TypeError throwing, not `&&=` branch-taking correctness).
[[RE-SCOPE NOTE: re-classified as feasibility:hard, horizon:m — a write-path
substrate fix, not a narrow branch fix.]]
