---
id: 4176
title: "Standalone: named keys on builtin prototypes (Object/Function/Array/String/… .prototype.x) invisible through the chain — per-brand proto-property store"
status: done
assignee: ttraenkler/W4-proto-followups
completed: 2026-08-06
sprint: current
created: 2026-08-06
updated: 2026-08-06
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen
language_feature: prototype chain, builtin prototypes
goal: standalone-gap
related: [4172, 4160, 4008, 2660, 802]
loc-budget-allow:
  # the #4176 keep-arm + isBuiltinProtoWriteTarget predicate: top-level
  # `<Builtin>.prototype.<name> = …` statements were DROPPED by the module-init
  # root-identifier check (measured: absent from __module_init); the keep must
  # live in the same collection ladder as the #1719/#2660/#3468 keeps
  - src/codegen/declarations.ts
  # __extern_has non-$Object arm + fillDynamicForinVecArms vec arm: both miss
  # tails gain the receiver-aware companion consult; the arms are baked inside
  # the registration/fill bodies they extend (cannot be extracted without
  # splitting an Instr[] mid-body)
  - src/codegen/object-runtime.ts
  # clause-A one-hop widening (nested object-literal argument of Object.* /
  # Reflect.*) belongs inside classifyUse's ladder — same rationale as #4172's
  # grant: extracting one rung would split the single classification ladder
  - src/codegen/fnctor-escape-gate.ts
  # isCarrierBackedDescriptor gate + rationale comment on the #2372 reify path
  # — the decision must sit exactly where the reify/passthrough fork is
  - src/codegen/object-ops.ts
  # protoNamedDirty flag + companion-table ctx fields with their contract docs
  - src/codegen/context/types.ts
func-budget-allow:
  # the keep-arm lives inside collectDeclarations' module-init statement
  # selection loop (nested closure over stmt/expr) — same position as the
  # #1719/#2660/#3468/#2671 keeps it mirrors
  - src/codegen/declarations.ts::collectDeclarations
  # one field init line (protoNamedDirty) in the context literal
  - src/codegen/context/create-context.ts::createCodegenContext
  # the __extern_has non-$Object arm restructure (bag-hit → 1, then the
  # receiver-aware companion consult, then 0) is baked inside the
  # registration-time body ensureObjectRuntime builds — the arm cannot move
  # out without splitting the __extern_has Instr[] mid-registration
  - src/codegen/object-runtime.ts::ensureObjectRuntime
---

# Standalone: named keys on builtin prototypes invisible through the chain

## Problem

W2 (#4172, PR #4145) made the `[[Prototype]]` chain live for user fnctors
(+95 on the 219-file ES5 lever `.tmp/levers/W2-prototype-chain.txt`). The
residue (124 files) decomposed NOT as W2 estimated (15 override / 14 accessor
/ 12 named-key / 8 TypeError / ~75 builtin-proto tail) but as **one dominant
mechanism (~62 files)**: a NAMED key written onto a BUILTIN prototype —

```js
Function.prototype.value = "Function";   // or Array/String/Number/Boolean/
var funObj = function () {};             // Date/RegExp/Error/Object.prototype
Object.defineProperty(obj, "property", funObj);  // §8.10.5 reads `value`
// standalone: obj.property === undefined  (write landed NOWHERE)
```

plus the `Object.create({}, {prop: descObj})` nested-descriptor shape (~15
files) that W2's clause A missed (direct arguments only).

## Root causes found (measured, 2026-08-06 — each was probed before fixing)

1. **Top-level `<Builtin>.prototype.<name> = …` statements compiled to
   NOTHING.** The module-init collection (declarations.ts) drops top-level
   assignments with no module-global root identifier; `Object` is a builtin,
   so the whole statement was elided (measured: absent from `__module_init`
   WAT). Fixed with a flag-gated keep-arm mirroring the #1719/#2660/#3468
   keeps.
2. **The #4160 proto-index store was integer-only and two-brand-only.**
   Generalized to a per-brand companion table (`(array (mut externref))`,
   one `$Object` slot per `BUILTIN_BRAND_TABLE` entry), named keys admitted
   (the integer gate protected nothing — a refused key was a silent no-op),
   write arms accept every builtin brand, and read consults became
   RECEIVER-aware (`__protoidx_brand_off`: vec ⇒ Array, closure ⇒ Function,
   `__StandaloneRegExp`/`__Date`/`$Error_struct` ⇒ their brands,
   `$NativeProto` ⇒ its own brand, boxed-primitive wrapper `$Object`s ⇒
   String/Number/Boolean via the `[[PrimitiveValue]]` slot's box type,
   default ⇒ Object). New consult sites: `__closure_prop_get` /
   `__vec_prop_get` miss tails, `__extern_has` non-`$Object` bag-miss, the
   `__extern_has` finalize vec arm's named-key miss, and the `$Object`
   terminal-walk misses (now `_r` variants).
3. **The #2372 descriptor-struct reify severed carriers.** A vec/Date/RegExp
   descriptor argument was reified field-by-field into a fresh `$Object`,
   losing both carrier-bag own expandos and inherited companion keys. Such
   carriers are now passed through as externref — `__obj_define_from_desc`'s
   `__desc_has_own`/`__extern_get` reads resolve them directly.
4. **Clause A (#4172) missed property values nested in object-literal
   arguments** of builtin `Object.*`/`Reflect.*` calls (`Object.create({},
   {prop: descObj})`). Widened one hop, builtin namespaces only.
5. **Pre-scan**: new `protoNamedDirty` flag (array-holes.ts), deliberately
   separate from `protoIndexDirty` so the polyfill idiom
   (`String.prototype.foo = …`) reserves the store WITHOUT disabling the HOF
   hole visit-skip / typed element lanes. The brand table moved to
   dependency-free `builtin-brands.ts` (importing native-proto from the
   pre-scan closed an ESM cycle — TDZ crash in collections-brand.ts).

## Measured (2026-08-06, CI-aligned shimmed instrument — L2 handoff §2/§3)

| 219-file lever list (`--target standalone`) | pass |
| --- | ---: |
| base = origin/main + #4145 (W2) merged | **95** |
| this branch | **171** |

**+76, 0 regressions on the list.** Instrument responsiveness verified by
base-file swap of declarations.ts (probes pA1/pA3 revert to red). Subsystem
unit tests: 158/158 (4160/2660×4/3468/3537/4055/3251×3/802×2 families).
Ratchets: oracle +0, coercion-sites net −1, loc/func growth granted above.

Residue (46 fail + 2 CE): builtin-proto DIFFERENT mechanisms (toString tags,
`String.hasOwnProperty('prototype')`, `Number.prototype` primitive value,
filter borrow lengths, `__get_builtin` CEs, dynamic-code) — see the handoff
in `plan/agent-context/W4-proto-followups.md`.

## Deliberately left out

- `in`-operator static fold on statically-typed vec/Date receivers still
  answers false for inherited named keys (reads are what the tests assert;
  the erased-receiver `in` path has a separate pre-existing fold).
- `Math.value` / `JSON.value` namespace own-props (builtin-namespace storage,
  L1's row 3 — different mechanism).
- Error-subclass 3-level chain middle hop (TypeError.prototype →
  Error.prototype); no test in the lever exercises it.
- for-in enumeration of inherited companion keys.
