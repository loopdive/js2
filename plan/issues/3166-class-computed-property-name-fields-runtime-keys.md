---
id: 3166
title: "Class fields/accessors with RUNTIME computed property names are silently dropped ([f()] = 1 → read returns 0) — ~150 cpn tests"
status: ready
sprint: current
created: 2026-07-12
updated: 2026-07-12
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: classes, computed-property-names
goal: standalone-mode
related: [2515, 1472, 2042]
loc-budget-allow:
  - src/codegen/expressions/calls.ts
origin: "2026-07-12 architect standalone audit: 192 cpn-* failures (120 class-field, 30 class-accessor, 14 obj-lit variants); class-field root cause verified live."
---

# #3166 — runtime computed property names on class fields/accessors

## Problem

**Verified live** (2026-07-12, upstream/main @ adc65cfc65, standalone):

```ts
function f(): number { return 1; }
class C { [f()] = 1; }
const c: any = new C();
c[f()]   // → 0   (expected 1)
```

Object-literal computed names work (`{ [1 * 1]: 1 }` reads back 1); the class
form silently drops the field.

Failing population: 150 `cpn-class-*` tests (fields + accessors) across
`language/expressions/class` and `language/statements/class`, plus 14
`cpn-obj-lit-*` residuals (the obj-lit tests fail on secondary asserts like
`o[String(1 * 1)]` — verify per-test; do not assume the same root cause).

## Root cause (confirmed in source)

`resolveClassMemberName` (src/codegen/class-bodies.ts:523) resolves computed
names via `resolveComputedKeyExpression` (src/codegen/literals.ts:1783), which
only handles **compile-time constants** (literals, const-folding, well-known
Symbols, enum members). A runtime expression (`[f()]`, `[x && 1]`) returns
`undefined`, and the field-collection loop then does:

```ts
// class-bodies.ts:748
const fieldName = resolveClassMemberName(ctx, member.name);
if (fieldName === undefined) continue; // dynamic computed name — skip
```

— the member vanishes: no struct field, no init emission, no error. Reads
return the missing-property default (0). Same pattern at :1007 (methods),
:1129/:1136/:1176 (accessors/props).

## Implementation Plan (architect)

### Strategy

Per ClassDefinitionEvaluation (§15.7.14) the key expression is evaluated
ONCE, at class-evaluation time, with ToPropertyKey. Since the key is not
known at compile time, the field cannot be a struct field — it must go
through the **dynamic/open-object property table** on the instance (the
#2515 open-object machinery / the dynamic-shape property path used for
`obj[k] = v` writes on class instances).

### Changes

**1. Collection (class-bodies.ts, field loop at :745):** for a
`PropertyDeclaration` whose `resolveClassMemberName` is `undefined` AND whose
name is a `ComputedPropertyName`, do NOT `continue` silently. Record it in a
new `dynamicComputedFields: { member: ts.PropertyDeclaration }[]` list on the
class info (and equivalently for get/set accessors at :1129+). Leave methods
out of scope (bail-with-diagnostic as today) — the failing corpus is fields +
accessors.

**2. Class-evaluation-time key capture:** emit evaluation of each computed
key expression at the point where the class definition is evaluated (for a
class statement: where static members are initialized), apply
ToPropertyKey → string (reuse the ToString/ToPrimitive helper the object
literal computed-key RUNTIME path uses — find it via the obj-lit lowering in
literals.ts around the `resolveComputedKeyExpression` call-site fallback),
and store it in a module-level global (`__cpn_key_<class>_<i>`, externref or
native-string ref depending on lane).

**3. Constructor field-init:** in the constructor prelude where instance
fields are initialized, after the static-key fields, emit for each dynamic
computed field: read the captured key global, evaluate the initializer, and
install via the SAME dynamic property write helper `c[key] = value` lowers to
on a class instance (grep the any-receiver member-write path in
property-access.ts — the helper #2515 routes open-object writes through).
Ordering: fields initialize in source order — interleave with static-key
fields per member index, not appended at the end (tests assert ordering).

**4. Accessors:** register the getter/setter functions as today (they compile
fine — only the NAME is dynamic), but attach them to the instance/prototype
under the runtime key via the dynamic accessor-installation path used by
`Object.defineProperty` with get/set (see #2042's descriptor machinery in
object-ops.ts). If that path only supports static keys, slice accessors out
to a follow-up and land fields first (120 of the 150).

### Edge cases

- Key evaluates to a number (`[1 + 1]`) → ToPropertyKey canonicalization
  ("2"); reuse the numeric-key canonicalization the dynamic write path
  already performs (verify `c[2]` and `c["2"]` both read it).
- Key expression with side effects — must evaluate exactly once, at class
  eval, NOT per construction (test262 asserts call counts).
- Duplicate key with a static field (`class C { x = 1; ["x"] = 2 }` — note
  `"x"` is compile-time-resolvable, but `[f()]` colliding with `x` at runtime
  is possible): dynamic write wins (later member overwrites); the dynamic
  write helper must shadow the struct field read — if the dynamic-read path
  checks the property table BEFORE struct fields this is free; verify.
- Static members (`static [f()] = 1`): same mechanism against the class
  object/constructor carrier; slice out if the class-object representation
  lacks a property table.

### Validation

- Live repro above → 1.
- Scoped: `runTest262File` on
  `language/expressions/class/cpn-class-expr-fields-*.js` sample (both lanes).
- Equivalence test for host-lane parity.
- CI: expect ~120–150 flips in the cpn family; standalone floor green.

### Classification

**fable-executable-now** for fields (steps 1–3; the dynamic-write helper
exists). Accessors (step 4) may need the #2042 descriptor path — if it
resists, slice it to a follow-up rather than stalling the field win.

## Re-grounding (2026-07-12, sendev-3164 — READ BEFORE IMPLEMENTING)

Probed against post-#3164 main before implementing. **Two of the plan's
premises are wrong; the scope is heterogeneous:**

1. **The "dynamic property write helper on class instances" does NOT work in
   standalone** — the plan's step 3 depends on it. Probes:
   `class C {}; c[f()] = 7; c[f()]` → 0, and `class C { x = 5 }; c["y"] = 7;
   c.x + c["y"]` → NaN. Closed class-instance structs have no property table;
   out-of-shape writes are silently dropped. The only side-table precedent is
   the Error-subclass `$Error_struct.$props` field (#2101a,
   assignment.ts `emitExternrefBackedOwnFieldWrite`). Generalizing that (a
   `$props` overflow field on classes with dynamic members + read/write path
   threading) is substrate work, not a `continue` removal.
2. **Constant-foldable cpn tests already pass** (`[1+1]`, string/numeric
   literals — `cpn-class-expr-fields-computed-property-name-from-additive-*`
   PASS on main). The 150-fail population concentrates in:
   - `fields-methods-*` variants (~26 of 31 fields-methods files fail): a
     class with BOTH a computed field and a computed METHOD; even the
     STATIC-key ones fail at assert #3 (returned 4) — the failing assert is
     the later dynamic access (`c[String(1+1)]` string-key read of a
     numeric-named member, or the method invocation through a computed key),
     NOT the field collection.
   - genuinely-runtime keys (function-expression / arrow / assignment /
     coalesce / yield / await keys) — these DO hit the :748 `continue`, but
     fixing them requires the missing dynamic-write substrate above.
3. Suggested slicing (verify counts per slice before starting):
   - **S1 (no new substrate):** dynamic READ canonicalization on closed class
     structs — `c[String(1+1)]` / `c[2]` must both find struct field "2"
     (numeric-key ToPropertyKey canonicalization in the any-receiver read),
     plus computed-key METHOD invocation dispatch. Likely flips the
     static-key `fields-methods` bucket (assert #3 class).
   - **S2 (substrate):** generalized `$props` overflow table for classes with
     runtime-computed members (fields first, accessors after), keyed at
     class-eval time per §15.7.14 (evaluate-once ordering).
   - Static members (`C[1+1]`) need the class-object carrier to answer
     computed reads — verify which bucket asserts them (assert #2/#4 in the
     same files).

Claim released pending re-slice; the probes live in this branch's history
(`.tmp/probe-3166*.mts` shapes are reproduced inline above).

## S1 landed (2026-07-12, agent-a52eb84a — PR against loopdive/js2)

**Scope of this PR: S1 only** (read-side canonicalisation + computed-key method
dispatch on CLOSED class structs; no new substrate). S2 ($props overflow table
for genuinely-runtime-key MEMBERS) remains OPEN under this issue.

### Root cause (S1)
For a computed-name class FIELD (`[1+1] = () => 2`), TypeScript does not track a
member named `"2"`, so the element-access callee `c[1+1]` carries no call
signature — `compileCallableElementAccessCall` bailed — and it is not a
prototype method (no `ClassName_2` in `funcMap`), so the method-dispatch paths
missed it too. The struct-field READ already canonicalises the key
(numeric `c[1+1]` / string `c[String(1+1)]`) to field `"2"` and returns the
closure; only the INVOCATION was dropped, falling to the `ref.null.extern`
fallback (call returned the missing-property default `0`).

### Fix
`src/codegen/expressions/calls.ts`: at the two element-access-call fallback
sites (resolved-key-no-method and unresolved-key), when the receiver is a
user-class instance (and, for the static-key site, the resolved key names a
struct field), route the read + call through the existing ref.test-guarded
dynamic `call_ref` machinery (`tryEmitInlineDynamicCall`) that an `any`-typed
identifier call already uses. Two small `elemAccessReceiverIsUserClass` /
`classInstanceHasField` gates keep primitive/array/host receivers on their
existing lowering; a non-closure field value hits the safe default arm.

### Measured impact
`cpn-class-*fields*` standalone: **34 → 64 pass (+30)**, zero in-family
regressions; gc/host lane matches (64/124). The const-foldable + read-canonical
+ instance method-call asserts of the `fields`/`fields-methods` buckets now pass
(incl. the full 4-assert additive-add shape once static reads type-resolve).

### Remaining (S2 — separate slice, still failing)
The ~60 remaining `cpn-class-*fields*` fails are the genuinely-runtime-key
variants (`from-arrow-function`, `from-assignment-expression`,
`from-function-declaration`, `from-await`/`yield`, …) where the member is
DROPPED at collection time (`resolveClassMemberName` → `undefined` → `continue`)
because a closed class struct has no property table. These need the `$props`
overflow substrate (evaluate-once key capture at class-eval time per §15.7.14 +
read/write threading), as scoped in the Re-grounding section above. Static
members (`C[key]`) additionally need the class-object carrier to answer computed
reads.

### Tests
`tests/issue-3166.test.ts` — 6 standalone cases (numeric/string computed-key
invocation, arg passing, named-field no-regression, value-field read control,
full instance-assert shape). All green.
