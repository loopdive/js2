---
id: 802
title: "- Dynamic prototype support (Object.setPrototypeOf, Object.create with dynamic proto)"
status: ready
model: opus
fable_role: spec
created: 2026-03-26
updated: 2026-07-18
priority: low
feasibility: hard
reasoning_effort: high
goal: property-model
sprint: current
# (#3102) Intended god-file growth for the #802 dynamic-proto wiring across all
# slices. Slice B+C (landed): the conditional $__proto__ field append
# (class-bodies), the typed getPrototypeOf field-read arm (call-builtin-static),
# the scanForDynamicProto + fillDynamicProtoHelpers invocations (index), the
# context fields (types), the INITIAL_CAP export (object-runtime). Slice A: the
# object-literal → $Object promotion gate (literals) + the representation-lockstep
# variable-local slot-typers (statements/variables + index). All are integration
# points INSIDE existing functions; the bulk of the new logic lives in the NEW
# src/codegen/dynamic-proto.ts (not a god-file).
loc-budget-allow:
  - src/codegen/expressions/call-builtin-static.ts
  - src/codegen/class-bodies.ts
  - src/codegen/index.ts
  - src/codegen/context/types.ts
  - src/codegen/object-runtime.ts
  - src/codegen/literals.ts
  - src/codegen/statements/variables.ts
---
# #802 -- Dynamic prototype support (Object.setPrototypeOf, Object.create with dynamic proto)

## ECMAScript spec reference

- [§10.1.14 OrdinarySetPrototypeOf](https://tc39.es/ecma262/#sec-ordinarysetprototypeof) — steps 5-8: cycle check, then set \[\[Prototype\]\]
- [§20.1.2.21 Object.setPrototypeOf](https://tc39.es/ecma262/#sec-object.setprototypeof) — calls OrdinarySetPrototypeOf
- [§20.1.2.2 Object.create](https://tc39.es/ecma262/#sec-object.create) — creates object with specified prototype

## Problem

`Object.setPrototypeOf(obj, proto)` and `Object.create(dynamicProto)` change an object's prototype at runtime. These can't be resolved at compile time.

## Approach (original issue note — superseded by the Implementation Plan below)

Only when the compiler detects these patterns in the source:
1. Add a `$__proto__` externref field to affected struct types (not all structs)
2. `Object.setPrototypeOf(obj, proto)` → `struct.set $__proto__`
3. `Object.create(proto)` → allocate struct with `$__proto__` set
4. Property access on affected objects falls back to proto chain walk at runtime

For static inheritance (class extends), the compiler resolves the chain at compile time — no `__proto__` field needed (#799a revised approach).

## Previous attempt
#799a added `__proto__` to ALL structs unconditionally — caused −2,788 regression by breaking struct.new argument counts. Reverted to conditional-only.

---

## Implementation Plan

> **Author:** architect (Fable spec lane), 2026-07-17. **Implementer:** Opus.
> Spec-first: this section is the contract. Follow the slice order; each slice is
> independently landable and, on its own, zero-regression.

### 0. State of the world (read this before touching anything)

Most of the "dynamic prototype" machine **already exists**. Do not rebuild it.
Grep-verified anchors as of `origin/main` c47a26f9a:

1. **`$Object` (dynamic open-object hash-map runtime)** — `src/codegen/object-runtime.ts:23-28`.
   Its struct layout **already carries a mutable `$proto` at field 0**:
   ```
   (type $Object (struct
     (field $proto      (mut (ref null $Object)))   ;; field 0
     (field $props      (mut (ref $PropMap)))
     (field $count      (mut i32))
     (field $tombstones (mut i32))
     (field $flags      (mut i32))))
   ```
   Native helpers **already registered** in `OBJECT_RUNTIME_HELPER_NAMES`
   (`object-runtime.ts:6354-6364`): `__getPrototypeOf`, `__object_create`,
   `__isPrototypeOf`, `__object_setPrototypeOf`. `__object_setPrototypeOf`
   performs the §10.1.2.1 OrdinarySetPrototypeOf extensibility + cycle checks
   and writes `$proto`. **Any `$Object`-backed value already has full,
   correct, standalone dynamic-prototype semantics.**

2. **`Object.setPrototypeOf` dispatch** — `src/codegen/expressions/call-builtin-static.ts:1549-1632`.
   - **standalone arm** (`ctx.standalone`, lines 1563-1595): coerces `obj` to
     externref, `compileProtoArg` normalizes an inline-literal proto to a
     native `$Object`, then calls `__object_setPrototypeOf`.
   - **gc/host arm** (lines 1597-1631): calls the host import
     `__host_set_struct_proto`, which records the link in the `_wasmStructProto`
     JS `WeakMap` sidecar (`src/runtime.ts:11963-11993`).

3. **`o.__proto__ = v` assignment** — `src/codegen/expressions/assignment.ts:3195-3226`
   routes to the SAME two helpers (`__object_setPrototypeOf` / `__host_set_struct_proto`).

4. **`Reflect.setPrototypeOf`** — `src/codegen/expressions/call-namespace-static.ts:640-716`
   (native) and `:817-858` (host `__reflect_setPrototypeOf`). Same backing links.

5. **`Object.getPrototypeOf`** — `call-builtin-static.ts:1634+`. **`Object.create`** — native
   `__object_create` builds a fresh `$Object` with the requested `$proto`, so
   `Object.create(dynamicProto)` **already works** (it returns a `$Object`,
   which carries proto natively). Verify with a smoke test; treat as DONE unless
   the test disagrees.

6. **Class instance struct build** — `src/codegen/class-bodies.ts:711-831`. The
   hidden `__tag` is `unshift`ed at field 0 (`:793`); an empty root also gets a
   trailing `__shape_brand` i32 **appended last** (`:820-822`) to break an
   iso-recursive canonical merge with `$AnyString`. Note the precedent:
   **appending a field LAST leaves every existing positional `fieldIdx`
   unchanged**, and the constructor field-init loop
   (`class-bodies.ts:1638-1670`) **iterates the field list and defaults every
   field** (externref → `ref.null.extern`, `:1657`), so an appended field costs
   nothing at the `struct.new` site inside the generated ctor. There is a
   deliberate stub at `:1675` — `// __proto__ initialization: deferred to #802`.

**So the actual remaining gap is narrow and specific:**

> A **closed-shape struct-backed object** (a `class` instance, or a
> closed-shape object literal lowered to a bespoke WasmGC struct) that is the
> **receiver** of `Object.setPrototypeOf` / `o.__proto__ =` / `Reflect.setPrototypeOf`,
> **in `--target standalone`**, silently loses the link: `__object_setPrototypeOf`
> does `ref.test $Object` on the receiver, the class/closed-literal struct is
> not a `$Object`, the test fails, and the proto is dropped. Inherited reads
> then return `undefined`/`0`.
>
> In **gc/host mode this already works** via the `_wasmStructProto` WeakMap
> sidecar (an opaque struct can be a WeakMap key). So **the struct-layout change
> in this issue is STANDALONE-ONLY.** That halves the risk surface and is the
> single most important scoping decision in this plan — do not touch struct
> layout for gc/host.

### 1. Representation decision (the core call)

Two receiver kinds, two strategies — pick per-node, never globally:

**(A) Closed-shape object-literal receivers → promote to `$Object`, no layout change.**
A plain object literal `{...}` that the prescan proves is a proto-mutation
receiver is allocated as a **`$Object` hash-map** instead of a bespoke closed
struct. `$Object` already has field-0 `$proto` and full native/host proto
support, so this needs **zero struct-layout change** and inherits the entire
existing read/walk/getPrototypeOf machine for free. This is the low-risk bulk
of the test262 win (most `Object.setPrototypeOf` conformance tests use plain
objects as the receiver).

**(B) Class-instance receivers → conditional appended `$__proto__` field, standalone-only.**
A `class` instance cannot be promoted to `$Object` (it has typed fields,
methods, an instanceof `__tag`, identity). For **only those class names the
prescan proves are proto receivers**, append **one** field:

```
(field $__proto__ (mut externref))    ;; appended LAST, after __shape_brand
```

- **externref, not `(ref null $Object)`** — the proto value is arbitrary
  (`null`, another `$Object`, another class instance, a builtin prototype). Store
  it uniformly as externref (the same currency the whole object model already
  uses); the read walk (Slice C) classifies it with `any.convert_extern` +
  `ref.test`. This mirrors what the host sidecar stores (`_wasmStructProto` holds
  any JS value).
- **Appended LAST** — after `__tag` (field 0), all real fields, and any
  `__shape_brand`. This is the #799a-avoidance invariant (see §3).
- **mutable** — `struct.set` writes it at runtime.
- **Inheritance:** a subclass struct is a WasmGC subtype of its parent struct;
  the parent's fields come first positionally. Only append `$__proto__` to a
  class if the prescan marks **that exact class name**. If a marked class has a
  marked-or-unmarked subclass, the subtype relation still holds because the
  field is appended after the shared prefix on the ROOT that introduces it —
  **but** to keep positions monotonic across the hierarchy, only introduce
  `$__proto__` on a **root** class (no `parentStructTypeIdx`) and let subclasses
  inherit it; if a non-root class is marked, promote the mark up to its root
  (mark the whole hierarchy). Document this in the prescan (§2).

**Dual-mode summary:**
| Receiver | gc/host | standalone |
|---|---|---|
| `$Object` / plain-any object | works (native/sidecar) | works (native) |
| object literal (Slice A promotes) | works | works (now a `$Object`) |
| class instance (Slice B) | works (WeakMap sidecar) | **new:** `$__proto__` struct field |

No new host imports (dual-mode principle satisfied: standalone gets a native
field, gc/host keeps its sidecar).

### 2. Slice B/C gating — the `scanForDynamicProto` prescan (new file)

Create `src/codegen/dynamic-proto.ts`, mirroring `src/codegen/new-target.ts`
(`scanForNewTarget`, `:34-44`). Export:

```ts
export function scanForDynamicProto(ctx: CodegenContext, root: ts.Node): void
```

Add to `CodegenContext` (`src/codegen/context/types.ts`, initialise in
`src/codegen/context/create-context.ts` next to `usesNewTarget`, `:102`):
- `usesDynamicProto: boolean` — any proto-mutation site at all.
- `dynamicProtoClasses: Set<string>` — class **names** whose instances are proto
  receivers (drives Slice B field append). Store ROOT class names (promote a
  subclass mark to its hierarchy root — see §1).
- `dynamicProtoLiteralNodes: WeakSet<ts.Node>` — object-literal AST nodes that
  are proto receivers (drives Slice A `$Object` promotion).

Invoke it in `src/codegen/index.ts` right beside the existing pre-scans
`scanForNewTarget(ctx, ...)` / `scanForArrayHoles(ctx, ...)` — **both** call
sites (`index.ts:2453` and `:4639`; there are two module-gen entry paths).

**Detection walk** (conservative over-approximation — see §5 for the
never-silently-wrong rule):
1. `Object.setPrototypeOf(X, _)`, `Reflect.setPrototypeOf(X, _)`,
   `Object.create(_)` is NOT a receiver (it MAKES an object — Slice A/§0.5).
2. `X.__proto__ = _` (`BinaryExpression`, `=`, LHS is a
   `PropertyAccessExpression` named `__proto__`).
3. Resolve `X` to a class or a literal:
   - Use **`ctx.oracle`** (`src/checker/oracle.ts`) — NOT the raw TS checker
     (oracle-ratchet gate, see CLAUDE.md). Resolve `X`'s static type → symbol →
     declaration. If it is a `ClassDeclaration`, add the (root) class name to
     `dynamicProtoClasses`.
   - If `X` is a direct object-literal expression, or a `const`/`let` binding
     whose initializer is an object literal in the same scope, add that literal
     node to `dynamicProtoLiteralNodes`.
4. Set `usesDynamicProto = true` on any hit.

Gate ALL Slice-B/C machinery on `ctx.usesDynamicProto` / membership in the sets,
exactly as `usesNewTarget` gates the new-target machine — so a module that never
mutates a prototype is **byte-for-byte unchanged**.

### 3. #799a post-mortem — why it regressed −2,788, and how this plan avoids it

**Root cause of #799a:** it added `__proto__` to **ALL** structs
**unconditionally**. A WasmGC `struct.new $T` consumes exactly one stack operand
per declared field, in order. The compiler has **many** `struct.new` sites that
push a **hard-coded, positional** list of field values — object-literal
lowering, lazy prototype-singleton / class-object inits, and per-class
allocation helpers. Adding a field to every struct made every one of those
sites push N operands into an (N+1)-field `struct.new`: a validation error /
wrong-field write at scale → −2,788.

**How this plan is structurally immune:**
1. **Conditional, prescan-gated (§2):** only class names actually proven to be
   proto receivers get the field. A typical module marks **zero** classes, so
   zero structs change shape. #799a's blast radius was "every struct"; ours is
   "the handful the program actually setPrototypeOf's."
2. **Appended LAST (§1):** every existing positional `fieldIdx` is unchanged, so
   no `struct.get`/`struct.set` index shifts (same trick `__shape_brand` uses,
   `class-bodies.ts:820`).
3. **Constructor uses the iterate-and-default loop, not hard-coded operands:**
   the generated ctor at `class-bodies.ts:1638-1670` **iterates `fields`** and
   emits a typed default per field (externref → `ref.null.extern`). An appended
   field is defaulted automatically; the `struct.new` operand count stays
   correct **by construction**. This is the exact site of the `:1675`
   "deferred to #802" stub.
4. **Standalone-only (§0):** gc/host `struct.new` sites are not touched at all.
5. **Mandatory audit (do this before Slice B lands):** grep every `struct.new`
   that targets a class struct and confirm it flows through the iterate-list
   path, not a hard-coded operand list:
   ```
   grep -rn 'op: "struct.new"' src/codegen/ | grep -i class
   ```
   For any site that hard-codes operands for a class that CAN be marked, make it
   push a trailing `ref.null.extern` when `ctx.dynamicProtoClasses.has(name)`, or
   (preferred) reroute it through the shared iterate-and-default field-init
   helper. The two known lazy-init sites to check explicitly: the prototype
   singleton global init and the class-object init referenced in the
   `__shape_brand` comment (`class-bodies.ts:816-817`).

### 4. Slice decomposition (land in this order; each is green on its own)

**Slice A — object-literal proto receivers → `$Object` promotion. (LOW risk, biggest bulk.)**
- Prescan populates `dynamicProtoLiteralNodes` (§2).
- At object-literal lowering, if the node ∈ `dynamicProtoLiteralNodes`, allocate
  a `$Object` (`__new_plain_object` + `__extern_set` per property) instead of a
  bespoke closed struct. Everything downstream (setPrototypeOf, reads,
  getPrototypeOf, for-in) already handles `$Object`. **No struct-layout change.**
- Ship + measure. This alone should move the `Object.setPrototypeOf` /
  `Object.prototype.__proto__` test262 buckets in standalone.

> **Slice A — LANDED (PR #3318).** New `src/codegen/dynamic-proto.ts`
> (`scanForDynamicProto`) detects object-literal receivers of
> `Object.setPrototypeOf` / `Reflect.setPrototypeOf` / `o.__proto__ =` (unwrapping
> `(o as any)`, resolving a `const/let/var` binding to its object-literal
> initializer by lexical-scope walk; `Object.create` excluded). Marked receivers
> lower to the open `$Object` via `compileObjectLiteralAsExternref` — zero
> struct-layout change. Representation lockstep: the let/const pre-hoist
> slot-typer + `compileVariableStatement` + the `var`-hoist path consult the same
> `ctx.dynamicProtoLiteralNodes` set, so the receiver's local is `externref` and
> reads route through `__extern_get` (a WAT probe during dev showed a missing
> pre-hoist slot-type override was casting the promoted `$Object` back to the
> inferred struct and nulling the receiver). **Standalone-only** (spec §0: the
> dropped-link gap is standalone-specific; gc/host stays byte-for-byte unchanged).
> Tests: `tests/issue-802-slice-a.test.ts` (14, all pass — 10 standalone incl.
> inherited field/method reads, shadowing, null proto, `setPrototypeOf` return,
> direct-literal & `__proto__=` & `Reflect` receivers; 4 gc/host regression
> guards). `dynamicProtoClasses` is added but left unpopulated for Slice B.
> **Slices B/C/D remain outstanding**; issue stays `status: ready`.

**Slice B — class-instance proto receivers → conditional `$__proto__` field. (HIGHER risk, gated.)**
- Prescan populates `dynamicProtoClasses` (§2), promoting marks to roots.
- `class-bodies.ts` ~ `:820`: when `ctx.dynamicProtoClasses.has(className)` AND
  this is the root that introduces it, `fields.push({ name: "__proto__", type: { kind: "externref" }, mutable: true })`
  (reuse the existing `INTERNAL_FIELD_NAMES` set at `:1407` which already lists
  `__proto__`, so enumeration/`Object.keys` skips it).
- `class-bodies.ts:1675`: replace the deferred-stub comment with the init — the
  iterate-and-default loop already covers it, so likely **no code needed** here
  beyond removing the comment; verify the field lands as `ref.null.extern`.
- **setPrototypeOf write path**, `call-builtin-static.ts:1563-1595` standalone
  arm: after `__object_setPrototypeOf`'s `ref.test $Object` fails for a class
  instance, add a **struct arm**: if the receiver's static type resolves (via
  `ctx.oracle`) to a marked class, emit
  `local.get $recv; <proto externref>; struct.set $Class $__proto__` (with the
  §10.1.2.1 cycle + extensibility guard — factor a shared
  `__set_struct_proto_checked` native helper alongside `__object_setPrototypeOf`
  in `object-runtime-prototype.ts:138+`, or inline the guard). Return the
  receiver (setPrototypeOf returns `obj`).
- Mirror the same struct arm in `assignment.ts:3195-3226` (`o.__proto__ = v`)
  and `call-namespace-static.ts:640-716` (`Reflect.setPrototypeOf`, returns the
  i32 boolean).

**Slice C — standalone read-path proto walk for `$__proto__`-bearing structs. (Completes Slice B.)**
- A typed `o.x` read on a class instance emits `struct.get`. When `x` is NOT a
  declared field of the class but the class is marked (`dynamicProtoClasses`),
  the read must walk `$__proto__`. Anchor: the dynamic member-read path
  `src/codegen/dyn-read.ts` (its `__extern_get` reader already walks own+proto
  for `$Object`, `:181`, `:462`) and the closed-shape read dispatch
  `src/codegen/member-get-dispatch.ts`.
- Emit: read the struct's `$__proto__` externref; if non-null, `any.convert_extern`
  + classify (`ref.test $Object` → `__extern_get` on it; `ref.test $Class` →
  recurse the struct walk; else null) and return the found value, else
  `undefined`. Factor this as a native helper `__struct_proto_get(recv, key)`
  next to the object-runtime prototype helpers so both the read path and
  `Object.getPrototypeOf` reuse it.
- **`Object.getPrototypeOf(classInstance)`** (`call-builtin-static.ts:1634+`)
  standalone: return the struct's `$__proto__` externref (or the compile-time
  class prototype singleton `__proto_${className}` when `$__proto__` is null —
  i.e. the instance's proto was never dynamically reset).

**Slice D — parity + edge hardening (optional tail; only if buckets warrant).**
- `Object.create(dynamicProto)` confirm (should already pass via `__object_create`).
- `isPrototypeOf` / `instanceof` interaction with a dynamically-reset class-instance proto.
- Cross-realm / builtin-prototype edge cases (§6).

Slices A and B/C are independent: A ships without touching struct layout; B/C
ship without touching literal lowering. C depends on B (same field). D depends
on B/C.

### 5. The "never silently wrong" rule (dual-mode discipline)

If the prescan sees a proto mutation on a receiver whose static type the oracle
**cannot** resolve to either a class or a literal (e.g. an `any`-typed
parameter), do **not** silently drop the proto:
- If the receiver is already `$Object`/`any`-backed → it works natively, no action.
- If the receiver could be a closed struct the prescan failed to mark →
  emit an **IR/codegen fallback** (the existing warn-channel demotion, see
  `STRICT_IR_REASONS` discussion in CLAUDE.md) rather than a silent wrong
  answer. Better a conservative promotion-to-`$Object` of the ambiguous literal,
  or a compile-time diagnostic, than a dropped link.

### 6. Edge cases (must all be covered by tests)

- **`null` prototype:** `Object.setPrototypeOf(o, null)` / `Object.create(null)`.
  Standalone: `$__proto__` = `ref.null.extern`; read walk stops → `undefined`.
  `$Object` path already handles null (`__object_setPrototypeOf` accepts null).
- **Cycle:** `setPrototypeOf(a, b); setPrototypeOf(b, a)` — §10.1.2.1 step 8 must
  refuse (no-op), NOT infinite-loop the read walk. `__object_setPrototypeOf`
  already does the cycle check; the struct arm's `__set_struct_proto_checked`
  MUST replicate it, and the read walk (Slice C) MUST carry a visited-guard /
  depth cap (mirror `_wasmStructProto` walk's `guard++ < 100`, `runtime.ts:11979`).
- **Non-object, non-null proto** (number/string/bool): §10.1.2.1 is a silent
  no-op (do not throw). Match the host stub (`runtime.ts:11972-11975`).
- **Primitive / undefined receiver:** `Object.setPrototypeOf(undefined, p)` →
  TypeError; `Reflect.setPrototypeOf` on a non-object → TypeError. Preserve the
  existing arg guards (`emitNonObjectArgGuard`, `call-namespace-static.ts:669`).
- **`__proto__` object-literal syntax vs `setPrototypeOf`:** `{ __proto__: p }`
  in an object literal **sets the prototype** (§B.3.1) and is DISTINCT from a
  string-keyed `"__proto__"` and from later `o.__proto__ = p` assignment. The
  `with-scope.ts:783` guard already flags `__proto__` in object literals as a
  legacy prototype mutation — Slice A's `$Object` promotion is the natural home
  for `{ __proto__: p, ... }`. Do NOT create an own enumerable `"__proto__"`
  data property for the identifier form.
- **Builtins / cross-realm:** setting a class instance's proto to a builtin
  prototype (e.g. `Array.prototype`) — store the builtin's externref value; the
  read walk classifies it via `__extern_get`. Cross-realm is out of scope
  (single-realm compiler); note it as won't-fix if a test requires two realms.
- **gc/host regression guard:** confirm Slice B/C are `if (ctx.standalone)`-gated
  and gc/host still routes to `__host_set_struct_proto`; no gc/host `struct.new`
  site changes.

### 7. Test plan

- **New equivalence tests** (`tests/issue-802-*.test.ts`) run in BOTH modes
  (gc/host and standalone): plain-object setPrototypeOf + inherited read; class
  instance setPrototypeOf + inherited method/field read; `o.__proto__ = p`;
  `Object.create(dynamicProto)`; `Object.create(null)`; cycle no-op;
  non-object-proto no-op; `Object.getPrototypeOf` round-trip; `{ __proto__: p }`
  literal form; `Reflect.setPrototypeOf` boolean result.
- **test262 targets** (expect movement in standalone, no gc/host regression):
  `built-ins/Object/setPrototypeOf/*`, `built-ins/Object/create/*` (dynamic
  proto), `built-ins/Object/getPrototypeOf/*`,
  `built-ins/Object/prototype/__proto__/*`, `built-ins/Reflect/setPrototypeOf/*`.
- **Regression gate:** per-slice CI (`.claude/ci-status/pr-<N>.json`) — require
  `net_per_test > 0`, no bucket > 50, ratio < 10%. Slice B is the one to watch;
  the struct-layout audit (§3.5) is the pre-flight for it.

### 8. Regression risks & rollback

- **Highest risk:** a `struct.new $Class` site that hard-codes operands for a
  markable class (the #799a failure mode). Mitigated by §3.5 audit + prescan
  gating + append-last. If CI shows a `struct.new` arity failure, that audit
  missed a site.
- **Rollback:** each slice is a separate PR. Slice A is trivially revertible
  (literal-promotion is opt-in per node). Slice B/C revert by reverting the
  field append + read-walk + dispatch arms; because everything is gated on
  `ctx.dynamicProtoClasses` membership, reverting the prescan population alone
  (make it always-empty) disables Slice B/C wholesale with zero layout change —
  a one-line kill switch. Keep that kill-switch shape deliberately.

### 9. Files to touch (summary)

- **NEW** `src/codegen/dynamic-proto.ts` — `scanForDynamicProto` prescan (mirror `new-target.ts`).
- `src/codegen/context/types.ts` + `context/create-context.ts` — `usesDynamicProto`, `dynamicProtoClasses`, `dynamicProtoLiteralNodes`.
- `src/codegen/index.ts` (~`:2453`, ~`:4639`) — invoke the prescan.
- `src/codegen/class-bodies.ts` (~`:820` append field, `:1675` init stub) — Slice B.
- object-literal lowering (Slice A `$Object` promotion — find the literal→struct site; entry checks live around `assignment.ts:538+` and the object-literal expression compiler).
- `src/codegen/expressions/call-builtin-static.ts` (`:1563-1595`, `:1634+`) — setPrototypeOf/getPrototypeOf struct arms.
- `src/codegen/expressions/assignment.ts` (`:3195-3226`) — `o.__proto__ =` struct arm.
- `src/codegen/expressions/call-namespace-static.ts` (`:640-716`) — Reflect struct arm.
- `src/codegen/dyn-read.ts` + `src/codegen/member-get-dispatch.ts` — Slice C read walk.
- `src/codegen/object-runtime-prototype.ts` (`:138+`) — shared `__set_struct_proto_checked` / `__struct_proto_get` native helpers.

---

## Implementation status (2026-07-18, fable-dev-2)

**Slices B + C landed** (standalone class-instance dynamic prototype). PR branch
`issue-802-impl-bc`.

### What shipped
- **New `src/codegen/dynamic-proto.ts`**: `scanForDynamicProto` prescan (marks
  hierarchy-ROOT class names + object-literal nodes that are proto receivers;
  promotes a marked subclass to its declared root; unwraps `as`/paren/`!` casts;
  handles the `const c: any = new C()` initializer case) and
  `fillDynamicProtoHelpers` finalize fill. The fill mints four DEFINED natives —
  `__struct_proto_set` (§10.1.2.1 with cycle refusal + null sentinel),
  `__struct_proto_get` (inherited read, mutually recursive with `__extern_get`
  for mixed struct/`$Object` chains), `__struct_proto_read`
  (`Object.getPrototypeOf` per-class, most-derived-first, falls back to the
  compile-time proto singleton when never set), `__dynproto_norm` (sentinel →
  null) — and PREPENDS a marked-root `ref.test` dispatch arm into
  `__object_setPrototypeOf` / `__getPrototypeOf` / `__extern_get`.
- **`class-bodies.ts`**: appends the conditional `(field $__proto__ (mut
  externref))` LAST, standalone-only, gated on `ctx.dynamicProtoClasses`. The
  `#799a` −2,788 regression is avoided structurally: prescan-gated (a typical
  module marks zero classes) + append-last (no positional `fieldIdx` shift) +
  every class-struct `struct.new` site iterates the field list and defaults the
  externref field automatically (audited: both ctor alloc loops, the lazy
  proto/class-object singleton inits, the fnctor ctor, the object-literal path).
- **`call-builtin-static.ts`**: typed `Object.getPrototypeOf(instance)` reads
  the field inline (non-null struct receiver) or routes a nullable receiver
  through the generic `__getPrototypeOf` marked arm.
- **Context**: `usesDynamicProto`, `dynamicProtoClasses`,
  `dynamicProtoLiteralNodes`, `dynProtoSentinelGlobalIdx`.
- **Kill switch**: `JS2WASM_NO_DYNPROTO=1` disables the prescan marks, disabling
  all of Slice B/C wholesale (§8 rollback shape preserved).
- **Test**: `tests/issue-802-dynamic-proto-class.test.ts` (17 cases: inherited
  read, null sentinel, singleton identity, set-proto identity, cycle refusal,
  multi-level struct chains, `__proto__` setter, Reflect, subclass root
  promotion, two hierarchies, own-field shadow, `Object.keys` no-leak,
  regression guards).

### Deferred to follow-ups (out of THIS PR's scope)
- **Slice A** (object-literal → `$Object` promotion): owned by opus-802a.
  `dynamicProtoLiteralNodes` is POPULATED by the prescan here but not yet
  CONSUMED — Slice A wires it. No behavior change from populating it.
- **Slice D** (`isPrototypeOf` / `instanceof` with a dynamically-reset
  class-instance proto; `__extern_has` marked arm; non-object-proto exactness).

### Known-pre-existing failures (NOT caused by this PR — verified via the
`JS2WASM_NO_DYNPROTO=1` kill-switch A/B; both are plain-`$Object` paths this PR
never touches, and have no classes):
- `tests/issue-2747.test.ts` "walks a multi-level `__proto__` chain" — the
  two-level `proto.__proto__ = grand` for-in walk on plain objects drops the
  grandparent key.
- `tests/issue-2009.test.ts` R3b "named-source spreads (variables)" — object
  spread insertion-order.

`status: in-progress` (not `done`) because the #802 epic also has Slices A + D;
this PR completes the class-instance backbone (B + C).
