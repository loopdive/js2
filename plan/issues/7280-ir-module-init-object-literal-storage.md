---
id: 7280
title: "IR module-init: script-var object literals (`var obj = {}`, `{0: …}`, `{length: …}`) as the open `$Object` carrier"
status: in-progress
sprint: current
created: 2026-11-07
updated: 2026-11-07
priority: high
horizon: l
feasibility: medium
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
related: [7276, 7288, 7128, 2949, 7252]
assignee: "ttraenkler/c-lead"
---

# #7280: script-var object literals in `<module-init>`

## Problem

The census behind #6583 counts these as sole blockers of the test262 `<module-init>` unit:

- `var obj = {}` (`objectlit-empty`): 29 files;
- `obj = {}` (`vardecl-module-storage-unrepresentable`): 15 files;
- `{0: …}`: 6 files;
- `{length: …}`: 5 files;
- `proto = {}`: 3 files;
- 66 two-unit files paired with `formatPropertyName`.

Stacked on #7288 (and through it on #7276, whose `Object.create` lowering builds the same open `$Object` carrier).

## Measurement (2026-11-07, head of the #7288 stack 0e558eaf)

**Stride-40 census** (wrapped, standalone, SHAPE_DIAG). Files whose only legacy unit is `<module-init>`, first refused on object-literal storage, by initializer:

| first refusal | files | legacy slot type |
| --- | ---: | --- |
| `vardecl-module-storage-unrepresentable`, `{…}` (non-empty: `{0: 11, 1: 12}`, `{length: …}`, `{a: 1}`) | 47 | a **closed struct**, `(mut (ref null N))`, e.g. `$__mod_obj (ref null 17)` |
| `objectlit-empty` (`{}`, any position) | 29 | `externref` (the open `$Object`) |
| `vardecl-module-storage-unrepresentable`, `= {}` | 23 | `externref` |

So legacy keeps the #7276-style open `$Object` only for the **empty** literal. A non-empty literal is a closed struct (the shape #2949 widens with expando writes), and its `__mod_` slot is typed as that struct. Lowering it like `Object.create` would mean writing an open `$Object` into a struct slot, which changes legacy's storage and its output.

**Next blocker once `{}` is admitted.** Scratch probe, reverted: `{}` accepted as a dynamic value in `<module-init>`, over the 52 `{}` files. Each file's next refusal:

| next refusal | files |
| --- | ---: |
| storage of the `{}` var itself (`vardecl-module-storage-unrepresentable «obj = {}»`) | 33 (25 for `{}`, 8 other vars) |
| `expr-ident-not-in-scope` (`Symbol` 7, `Object` 3, `Array` 1) | 11 |
| closure return types, `let` closures, `++` on a dynamic value, other | 7 |
| from-ast only (selector passed): `f1`-shape `var obj = {}; obj.x = 1;` | 1 |

The storage refusal for `{}` is decided in the resolver / codegen home, not by the literal. Probes:
- `var obj = {}; Object.defineProperty(obj, "length", …)`: storage refused;
- `[].map.call(obj, …)`: storage refused;
- `var o1 = {}; var f = function () { return o1; }`: legacy has no `__mod_o1` slot at all;
- `var obj = {}; obj.x = 1;`: storage fine; from-ast lacks a dynamic producer for `{}` (`proven dynamic binding 'obj' initializer has no supported carrier`).

**Expected zero-legacy delta, stated before coding:**
- the `{}` admission alone: **about 1 file at stride 40**. The other `{}` files stop at the defineProperty / array-borrow storage refusal or at unrelated arms;
- the non-empty literals: **0** without an IR closed-struct producer whose type is legacy's struct, plus a resolver "object-literal struct" home (the #7252 class-instance home is the analogue). That is a different design from #7276's.

## Proposed slices (for the lead's decision)

1. **S1 (small):** a dynamic producer for `{}` in `<module-init>` (`emitNewPlainObject` boxed onto the carrier, the #7128 / #7276 builder). Admitted only where the resolver already gives the slot a dynamic home. Expected +1 at stride 40.
2. **S2 (large):** a closed-struct home for non-empty literals: the IR's `object.new` emitted with legacy's struct type, plus a resolver home kind beside `class-instance`. This is the 47-file bucket, and its next blockers are unmeasured until the storage is representable.
3. **S3:** the storage refusals around `Object.defineProperty(obj, …)` / `[].m.call(obj, …)` (codegen home classification). Most `{}` files sit behind this.
