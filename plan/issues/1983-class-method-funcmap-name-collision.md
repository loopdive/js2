---
id: 1983
title: "synthetic class-method names collide with user functions: class A { m() {} } + function A_m() breaks both paths"
status: suspended
sprint: 61
created: 2026-06-10
updated: 2026-06-12
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: classes
goal: compilable
related: [1370]
origin: "2026-06-10 deep-audit sweep (IR agent, secondary observation): verified on main @ 0c753ea88, both paths"
---

# #1983 — `${ClassName}_${method}` funcMap keying is not collision-free

## Problem

A class method `A.m` is registered under the synthetic name `A_m`; a
user-defined top-level `function A_m()` collides with it. Legacy: runtime
null-ref trap; IR: module-wide CompileError (`argument type mismatch in
call`). Node: works (`12`).

```ts
class A { m(): number { return 10; } }
function A_m(): number { return 2; }
export function test(): number { return new A().m() + A_m(); }
```

## Root cause (area)

funcMap keys use the `${ClassName}_${method}` convention
(`src/codegen/class-bodies.ts`, #1370 keying) with no mangling/uniquing
against user identifiers.

## Fix direction

Use a non-collidable separator in synthetic names (e.g. `A#m` or a reserved
prefix that is not a valid TS identifier), or unique-ify on collision at
registration time. Audit other synthetic name factories (getters/setters,
statics, closure wrappers) for the same convention.

## Acceptance criteria

- Repro returns `12` on both paths
- Mangled names don't leak into exports/WIT
- Other `_`-joined synthetic name sites audited

## Dupe check

#1370 (class-method IR adoption — keying origin). No collision issue on file.

---

## Implementation Plan (senior-1, 2026-06-12)

Bug reproduced on main @ 274dd03f7: the repro compiles to an **invalid Wasm
binary** (both `new A().m()` and `A_m()` resolve to one overwritten funcMap
entry with mismatched signatures).

### Scope-narrowing finding

The `${name}_${member}` convention appears at ~40 sites, but the **collision is
confined to `ctx.funcMap`** — the only map a user `function A_m()` also writes to
(under its export name). The funcMap-keyed synthetic member names are: methods,
getters (`${name}_get_${prop}`), setters (`${name}_set_${prop}`), and the
constructor. Their **gating membership sets must flip with them**:
`classMethodSet` / `staticMethodSet` (store the method `fullName`). Other maps
using the same string convention key disjoint namespaces and must NOT flip:
`structAccessorClosure`, `staticProps`, `classAccessorSet` / `staticAccessorSet`
(they store `${name}_${prop}`, never a user function name) — flipping them in
isolation would break their own producer/consumer pairing.

### The helper

`src/codegen/class-member-key.ts` → `classMemberKey(name, member)` =
`` `${name}#${member}` `` (`#` is not a valid TS-identifier char ⇒ collision
impossible). Internal only — exported names still come from the user identifier,
so the separator never reaches exports/WIT.

### Execution

Route every funcMap method/getter/setter key construction AND its
`classMethodSet`/`staticMethodSet` membership check through `classMemberKey`.
Producer sites (class-bodies.ts, index.ts struct methods) and consumer sites
(calls.ts dispatch, closures.ts method-ref, property-access.ts, literals.ts
object-literal methods) must change together. Verify by the full class
equivalence suite + the #1983 repro → 12 on both legacy and IR paths; a missed
funcMap lookup manifests immediately as a method-dispatch trap/invalid-wasm.

### ⚠️ CRITICAL TRAP found mid-implementation (senior-1) — needs arch design

The funcMap key `${name}_${member}` is **OVERLOADED**: it keys BOTH user-class
members AND **extern/host-class** members on the SAME map with the SAME
convention:

- **Constructors:** `${className}_new` (user) vs `${info.importPrefix}_new`
  (extern — `Map_new`, `Array_new`, `RegExp_new`) at index.ts:10184/10271/10279,
  expressions/calls.ts:2159, expressions/new-super.ts (many). The extern ones are
  **real `env` host-import names** — flipping their separator breaks
  `WebAssembly.instantiate` (unsatisfiable import).
- **Methods:** `${structName}_${methodName}` (user) vs
  `${info.importPrefix}_${methodName}` (extern — `Array_push`, `Map_get`,
  `String_charAt`) at index.ts:10192/10312. Same map, same dispatch lookup
  (index.ts:3311 `funcMap.get(${structName}_${methodName})` does **not** know if
  `structName` is a user class or an extern class).

So a blind flip of method/getter/setter/ctor keys would **break extern-class
construction and method dispatch** (Array/Map/String/RegExp) — strictly worse
than the original collision.

**The fix MUST discriminate user-class keys (flip to `#`) from extern/host-class
keys (keep `_`, they are host-import names) at every one of the ~20 funcMap
sites.** `ctx.classSet.has(name)` identifies user classes, but the extern path
keys off `info.importPrefix` (not always in `classSet`), so the producer and
consumer sites need a consistent "is this a user class?" predicate threaded
through. That is an architect-level design (a `userClassMemberKey` that only
mangles when the receiver is a user class, vs leaving extern host-import names
untouched), not a mechanical separator swap.

### Resolved design (senior-1, satisfying the [ARCH input first] gate)

**The discriminator is `ctx.classSet.has(className)`.** Two facts make this clean
and consistent across producer + consumer:

1. **`importPrefix` *equals* the className for extern classes**
   (index.ts:10027 `importPrefix: className`). So a user class `Foo` and an
   extern class `Foo` produce the identical string `Foo_method` — but a name is
   *either* a user class *or* an extern class, never both. `ctx.classSet` holds
   **only user-class names** (class-bodies.ts:371 `classSet.add(className)`);
   extern classes are registered via `ctx.externClasses` / `importPrefix` and are
   **not** in `classSet`.
2. So `ctx.classSet.has(name) === true` ⇒ user class (mangle to `#`);
   `=== false` ⇒ extern/host class (leave `_`, it is a real `env` import name).

Every producer already registers only when the name is a user class, and every
consumer either already gates on `classSet.has` (calls.ts:3311/3315,
index.ts:720) or can cheaply add the check. Producer and consumer therefore
**always agree** on the separator because they consult the same `classSet`.

#### The helper (replaces the unconditional `classMemberKey`)

```ts
// src/codegen/class-member-key.ts
export const CLASS_MEMBER_SEP = "#";            // not a valid TS identifier char
export function userClassMemberKey(ctx: CodegenContext, className: string, member: string): string {
  // Mangle ONLY user-class members. Extern/host-class keys (Array_push, Map_new,
  // String_charAt, …) are real `env` import names and MUST stay `${name}_${member}`.
  return ctx.classSet.has(className)
    ? `${className}${CLASS_MEMBER_SEP}${member}`
    : `${className}_${member}`;
}
```

The `#` key is internal — exports/WIT names come from the user identifier
(index.ts export path), never the funcMap key, so the separator never leaks.

#### Sites to route (funcMap method/getter/setter only; NOT ctor — see below)

Producers (register user-class members): class-bodies.ts method `fullName`
(:658, :1559), getter (:762, :1828), setter (:801, :1916), child-class
`childFullName` (:857, :871); index.ts struct-method registration (:2212, :3311
context). Consumers (dispatch): calls.ts (:1771/:1802, :3315/:3316,
:6511/:6523, :10661/:10662), closures.ts (:1169), property-access.ts (:2093,
:3939), literals.ts object-literal methods (:1313, :1813). Each
`` `${className}_${methodName}` `` / `` `${className}_get_${prop}` `` /
`` `${className}_set_${prop}` `` becomes `userClassMemberKey(ctx, className,
methodName)` / `userClassMemberKey(ctx, className, "get_" + prop)` /
`userClassMemberKey(ctx, className, "set_" + prop)`. The
`classMethodSet`/`staticMethodSet` membership stores (class-bodies.ts:667/669)
and their `.has` checks must use the SAME helper so the gate and the funcMap key
agree.

**Constructor (`_new`) is OUT OF SCOPE for this fix** — the repro is a *method*
collision (`A_m`), and the ctor path has the densest extern-overload surface
(new-super.ts has ~6 `${name}_new` sites, several of which resolve extern Map/
Array/RegExp ctors by the same string). A `class A {}` + `function A_new()`
collision is a separate, rarer case; if wanted, file a follow-up and apply the
identical `userClassMemberKey(ctx, className, "new")` discriminator to the ctor
sites only after auditing each new-super.ts site for extern-vs-user.

#### Why NOT the collision-only-uniquify alternative

The "uniquify on detected collision + override map" idea avoids the 20-site edit
but adds a lookup indirection on the **class-method hot path** and a second
source of truth (`classMemberKeyOverride`) that every one of the same ~20
consumers would still have to consult — so it does not actually shrink the
consumer surface, only hides it behind a map. The discriminator helper is
simpler, has zero per-call overhead beyond a Set lookup the consumers largely
already do, and keeps one source of truth. **Chosen: the discriminator helper.**

#### Verification

Full class equivalence suite + extern-class suites (Array/Map/Set/String/RegExp
method dispatch — the regression surface) + the #1983 repro → 12 on both legacy
and IR paths. A missed user-class consumer fails as a method-dispatch
trap/invalid-wasm in the class suite; a wrongly-mangled extern key fails as an
unsatisfiable-import / wrong-dispatch in the extern suites — both caught locally.

---

## Suspended Work (senior-1, 2026-06-12 — sprint close, token budget)

**Worktree:** `/workspace/.claude/worktrees/issue-1983-name-collision`
**Branch:** `issue-1983-name-collision` (pushed; doc-only commit `a3e9fa55d` is on
PR #1425). The partial **implementation** below is UNCOMMITTED in the worktree —
commit it on resume.

### ⚠️ STATE: build is HALF-FLIPPED — do NOT test until consumers are done

The **producers** (registration) now write mangled `#` keys, but the
**consumers** (dispatch lookups) still read `_` keys. So user-class method/
getter/setter dispatch is currently BROKEN (registration `A#m`, lookup `A_m`).
This is expected mid-refactor — finish ALL consumers, THEN test. `tsc` passes;
runtime would fail until consumers match.

### DONE (helper + all class-bodies.ts producers)

- `src/codegen/class-member-key.ts` (NEW, uncommitted): `userClassMemberKey(ctx,
  className, member)` and `userClassMemberPrefix(ctx, className)` — mangle to `#`
  iff `ctx.classSet.has(className)`, else legacy `_` (extern/host keys untouched).
- `src/codegen/class-bodies.ts` (uncommitted): imported the helpers; flipped
  method `fullName` (collect ~658 + compile ~1560), getter/setter names (~763,
  ~802, ~1831, ~1919), child-class inherit `childFullName` (~858, ~872), and the
  inheritance walk's prefix match + suffix extraction (~846-848, now uses
  `userClassMemberPrefix`). Left as `_` (correct — disjoint maps): `accessorKey`
  (classAccessorSet, ~757/796/866), static-prop `fullName` (staticProps, ~947),
  the CONSTRUCTOR `${className}_new` (extern-overload — out of scope, see spec).

### TODO (consumers — NONE done yet; this is the risky remainder)

Flip every funcMap **lookup** of a user-class member key to
`userClassMemberKey(ctx, className, methodName)` (or `"get_"+p`/`"set_"+p`).
Exact sites (from `grep -n '${className}_${methodName}' ... ${structName}_...`):
- `src/codegen/expressions/calls.ts`: ~1771 (`fullName0`), ~1802 (`funcMap.get`),
  ~3315 (`funcMap.has` guard) + ~3316 (`fullName`), ~6511 (`funcMap.has`) +
  ~6523 (`funcMap.has`), ~10661 (`funcMap.has`) + ~10662 (`fullName`). NOTE the
  `funcMap.has(`${className}_${methodName}`)` disjuncts at 3315/6511/10661 are
  what currently *route* extern vs user — replace the string with
  `userClassMemberKey(...)` so the user-class branch checks the mangled key while
  extern names (classSet.has false) still produce `_` and match their imports.
- `src/codegen/closures.ts`: ~1169 (`fullName`).
- `src/codegen/property-access.ts`: ~2093 (`fullName`), ~3939 (`methodFullName`),
  ~3926 (`accessorKey` — verify whether funcMap or classAccessorSet; if the
  latter, leave `_`).
- `src/codegen/literals.ts`: ~1313, ~1813 (object-literal method `fullName` —
  these are STRUCT methods; `classSet.has(typeName)` may be false for anonymous
  object-literal struct types, in which case the helper leaves `_` and they keep
  working. VERIFY: object-literal method registration in literals.ts ~1447 uses
  the same `${typeName}_${field.name}` — producer and consumer must agree, so
  flip BOTH or NEITHER per whether `typeName` is in `classSet`).
- `src/codegen/index.ts`: ~2212/2330 (`${structName}_${methodSuffix}` register +
  lookup — STRUCT method trampolines; same classSet caveat as literals.ts),
  ~3311 (`methodFullName` lookup). VERIFY each `structName` is a user class.
- `src/codegen/context/types.ts:989/995`: the `__obj_meth_tramp_${className}_
  ${methodName}` cached-trampoline GLOBAL key (#1394) — this is a SEPARATE
  namespace (a global-name string, not funcMap), but its producer + consumer must
  still agree if a class method name could collide there. Lower priority; audit.

### Resume steps

1. `cd` into the worktree (above). `git status` — confirm the uncommitted
   class-member-key.ts + class-bodies.ts changes are present.
2. Flip the consumer sites above, one file at a time. For each
   `funcMap.has/get(`${name}_${member}`)`, substitute
   `userClassMemberKey(ctx, name, member)`. For object-literal/struct sites,
   first confirm `classSet.has(typeName)` (anonymous struct types are NOT in
   classSet → helper leaves `_` → no change needed, but the call site is still
   correct to route through the helper for consistency).
3. `npx tsc --noEmit -p tsconfig.json` (must stay green).
4. Repro: `class A { m(){return 10;} } function A_m(){return 2;} export function
   test(){ return new A().m() + A_m(); }` → must return 12, valid Wasm, both
   default and IR.
5. Run the full **class** equivalence suite + **extern-class** suites
   (Array/Map/Set/String/RegExp method dispatch — the regression surface). A
   missed user consumer → class-suite dispatch trap; a wrongly-mangled extern key
   → extern-suite unsatisfiable-import.
6. Add `tests/issue-1983-class-method-collision.test.ts` (repro + a
   `function A_get_x()` collision + an extern-class smoke e.g. `[1,2].push(3)`).
7. prettier-write the touched files; `pnpm run lint` / `format:check` /
   `check:ir-fallbacks` green; commit (squash the doc commit), set `status: done`,
   open/refresh the PR.

### Alternative if the consumer surface proves too tangled

The collision-only-uniquify fallback (in the spec above) stays available: revert
to legacy `_` everywhere, and instead at the SINGLE method-registration site,
when `funcMap.has(syntheticName)` is already true, mangle just that one entry and
store the override in a new `ctx.classMemberKeyOverride: Map<string,string>` that
a single shared `lookupClassMember(ctx, name, member)` wrapper consults. Higher
indirection, but confines the change and can't break extern dispatch.
