---
id: 1971
title: "re-validate object-literal/property cluster: 6 reproducible-on-main behaviors whose covering issues are marked done (#140/#1239/#492/#1112/#1837/#1136)"
status: done
sprint: 61
created: 2026-06-10
updated: 2026-06-12
completed: 2026-06-12
priority: high
feasibility: medium
reasoning_effort: high
task_type: investigation
area: codegen
language_feature: object-literals
goal: property-model
related: [140, 1239, 492, 1112, 1837, 1136, 1821, 1994, 2017, 2032, 2126, 2127, 2128, 2129, 2130, 2131, 2132]
origin: "2026-06-10 deep-audit sweep (objects + eval-order agents): verified on main; flagged as residuals/regressions of done issues rather than unknown bugs"
---

# #1971 — done-status issues whose behaviors still reproduce

## Problem

The 2026-06-10 audit verified the following on current main. Each falls inside
the scope of an issue marked `done`, so they are residuals or regressions —
this issue is the triage container to re-validate, then either reopen-as-new
(per renumbering policy) or split into scoped bugfix issues:

1. **Dynamic computed keys silently dropped** (incl. losing the key
   expression's side effects) — scope of #140/#1837.
2. **Spread of accessor-bearing object literals drops the property** (getter
   never fires, value NaN) — scope of #492/#1112.
3. **Object-literal setters not invoked on assignment**; object-literal
   accessors on module-level consts trap (`o.x += 3` → null deref) — scope of
   #1239.
4. **Duplicate keys: first-wins instead of last-wins** — basic object-literal
   semantics.
5. **`delete o.a` leaves `"a" in o === true`** with literal objects;
   dynamic-key delete is a silent no-op — #1821 fixed only the literal-key
   sidecar.
6. **JS-host enumeration order ignores the integer-keys-ascending rule**.

Compile-error cluster verified alongside (second-tier, loud):
`arr.flat()/flatMap()` on `number[][]` → "No default value" (regression vs
#1136-done); `reduceRight` on string arrays → "Illegal argument";
`Object.entries(o)[0]` element access → "No default value";
`Map.forEach((v,k)=>...)` → invalid module (struct vs externref arg mismatch).

Also from the eval-order audit: **non-optional method call on null class
receiver is an uncatchable wasm trap** instead of catchable TypeError —
residual of #785 (done).

## Acceptance criteria

- Each of the 6+5 behaviors re-verified with a minimal probe
- For each: either a scoped new issue (with `renumbered_from`-style provenance
  note pointing at the original) or a documented wont-fix rationale
- The done-status originals annotated with the residual finding

## Triage results (2026-06-12, PO re-validation vs main `c19a2e9c1`)

Each probe compiled with `compile()` and run via `compileAndInstantiate()`
(JS-host mode, default options); wasm vs node compared. Repros in
`.tmp/triage.mts` / `.tmp/triage2.mts` on branch `po-1971-triage`.

| # | Behavior (as filed) | Verdict | Probe result | Disposition |
|---|---------------------|---------|--------------|-------------|
| 1 | Dynamic computed keys dropped + key side-effects lost (#140/#1837) | **STILL-BROKEN** | static-resolvable key works (`{[k]:42}.dyn==42`); **truly-runtime key drops the property** (`{[ks[1]]:5}` → read `NaN`); **key-expr side effect never runs** (`{[key()]:1}` → `calls==0`) | **NEW #2126** (construction side; #2032 covers only the destructuring *read* side) |
| 2 | Spread of accessor-bearing literal drops property, getter never fires (#492/#1112) | **STILL-BROKEN** | `{...{get a(){return 7}}}.a` → wasm `null`, node `7`. Data-prop spread is fine (`{...{a:7}}.a==7`) — accessor-only | **NEW #2127** |
| 3 | Object-literal setters not invoked; accessor on module const traps (#1239) | **PARTIAL** | 3a setter on literal: `{set v(x){captured=x}}; o.v=9` → `captured==0` (**STILL-BROKEN**). 3b getter/setter on module-level const with `o.x+=3` → `13` (**FIXED**, no longer traps) | 3a → **NEW #2128**; 3b fixed. Getter-only *write* trap already tracked by #2017 |
| 4 | Duplicate keys: first-wins instead of last-wins | **STILL-BROKEN** | `{a:1,a:2}.a` → wasm `1`, node `2`; `{a:1,b:9,a:3}.a` → wasm `1` | **NEW #2129** |
| 5 | `delete o.a` leaves `"a" in o`; dynamic-key delete no-op; rest `in` (#1821) | **STILL-BROKEN** | `delete o.a; "a" in o` → wasm `true`; **worse: `o.a` still reads `1` after delete** (no-op on the struct, not just `in`). Dynamic-key `delete o[k]` and `{e,...rest}; "e" in rest` both → wasm `true`. `in` resolved at compile time against the source struct shape (`src/codegen/binary-ops.ts:486-583`) | **NEW #2130** (false-positive mirror of #1991's false-negative) |
| 6 | JS-host enumeration ignores integer-keys-ascending | **STILL-BROKEN** | `{b:1,"2":2,a:3,"1":4}` → `Object.keys` wasm `"b,2,a,1"`, node `"1,2,b,a"` | **NEW #2131** (#1837 fixed standalone hash-bucket order; JS-host path still emits insertion order, never reorders integer keys) |
| CE1 | `arr.flat()/flatMap()` on `number[][]` → "No default value" (#1136) | **FIXED** | `[[1,2],[3,4]].flat()[2]==3`; `[1,2,3].flatMap(x=>[x,x*2])[3]==4` — both match node | — |
| CE2 | `reduceRight` on string arrays → "Illegal argument" | **STILL-BROKEN** | `["a","b","c"].reduceRight(...)` → "illegal cast"; also plain `reduce` on string[] traps | **already covered by open #1994** |
| CE3 | `Object.entries(o)[0]` element access → "No default value" | **FIXED** | `Object.entries({x:1,y:2})[0][0]=="x"` matches node | — |
| CE4 | `Map.forEach((v,k)=>...)` → invalid module | **FIXED** | `m.forEach((v,k)=>sum+=v)` → `3` matches node | — |
| EO | Non-optional method call on null class receiver → uncatchable wasm trap instead of catchable TypeError (#785) | **STILL-BROKEN** | `const c:C\|null=null; try{(c as any).m()}catch{return 99}` → wasm `RuntimeError: dereferencing a null pointer` (uncatchable), node `99` | **NEW #2132** |

### Summary

- **FIXED since filing (3+1):** CE1 (flat/flatMap), CE3 (Object.entries elem),
  CE4 (Map.forEach), plus item 3b (accessor on module const, compound assign).
- **Already covered by open issues (1):** CE2 → #1994.
- **STILL-BROKEN, new scoped issues filed (7):** #2126 (computed-key
  construction), #2127 (spread accessor), #2128 (object-literal setter),
  #2129 (duplicate-key last-wins), #2130 (delete/`in` against static struct),
  #2131 (JS-host integer-key enum order), #2132 (null-receiver method call
  uncatchable).
- Close this container **done** once #2126–#2132 are filed; all 11 behaviors
  are now individually tracked or fixed.

## Why one issue

These need per-item git-archaeology (did the fix regress, or never cover this
shape?) before they're dev-dispatchable; that triage is one sitting of work.

## Dupe check

Each item grepped during the audit; all covering issues are `done`, none have
open follow-ups.

## Addendum (2026-06-11 iterators-agent sweep)

Additional trigger for the static-`in` family (item 5): object-rest
destructuring — `const { e, ...rest } = { e: 3, f: 4 }; "e" in rest` →
wasm `true`, node `false`. Rest *contents* are correct (`rest.e` →
undefined, `Object.keys(rest)` → `["f"]`); `in` is resolved at compile
time against the source object's struct shape
(`src/codegen/binary-ops.ts:484-560`), so any runtime-shaped object
(rest objects, post-delete objects) answers wrong. See also #1991
(prototype-chain misses, the false-negative mirror of this
false-positive).
