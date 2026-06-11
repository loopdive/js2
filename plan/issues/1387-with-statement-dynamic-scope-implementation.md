---
id: 1387
title: "feat: implement `with` statement — architect exploration of dynamic-scope compilation strategies"
status: done
created: 2026-05-08
updated: 2026-06-11
priority: high
feasibility: medium  # Tier 1 (IR-proven static routing) is medium and dispatchable; Tier 2 (dynamic fallback) is hard and overlaps the object-representation ceiling — slice & ship Tier 1 first.
reasoning_effort: max
task_type: feature
area: codegen, ir
language_feature: with
goal: spec-completeness
sprint: 61
owner: Hooke
claimed_by: codex-developer
claimed_at: 2026-06-07T10:09:57.864Z
pr: 1272
completed: 2026-06-08
---
# #1387 — `with` statement: architect exploration

## Background

`with` is currently in the test262 skip list and emits `CE: Unsupported statement: WithStatement`
(294 tests). The statement has been avoided because it creates dynamic scope — any bare identifier
inside a `with(obj){}` block may refer to a property of `obj`, defeating static type analysis and
WasmGC typed struct emission.

However, the user has asked for an architect exploration: **how can we implement `with` nonetheless?**
If a fully static path is not possible, an IR-dependent or externref-fallback path may be acceptable.

## Evidence: real standalone test262 run 2026-06-01

Artifacts:
`benchmarks/results/test262-standalone-report-20260601-213702.json` and
`benchmarks/results/test262-standalone-results-20260601-213702.jsonl`.

Standalone result: 4,368 / 43,106 passing (10.1%) versus the canonical JS-host
baseline of 30,480 / 43,106 (70.7%). `WithStatement` unsupported appears in
294 non-exclusive standalone failures, matching this issue's static
prove-or-demote plan and the older #671 umbrella count.

## Evidence: refreshed standalone test262 artifact 2026-06-02

Source: `loopdive/js2wasm-baselines` commit
`b4684d8f97a462c6414716aea46f31b67f48b959`,
`test262-standalone-current.jsonl`; js2 baseline
`ac88301967d70be11c9abb456051ff4afcd3a9d7`.

The ordered root-cause classifier assigns **62** rows primarily to #1387:
59 `compile_error` rows and 3 runtime/assertion rows. Unlike the June 1
non-exclusive evidence, the latest artifact does not have a large direct
`Unsupported statement: WithStatement` diagnostic cluster; many `with`-path
tests now hit earlier standalone blockers first, especially #1472 dynamic
object/property dispatch and #1665/#681 iterator protocol refusal. The 62-row
primary bucket is therefore the currently visible `with` owner, not the full
latent pass-rate impact of implementing the Tier-1/Tier-2 design below.

## What `with` does (spec §14.11)

```js
with (expression) statement
```

1. Evaluate `expression` → get object `obj`.
2. Push `obj` onto the lexical environment chain.
3. Execute `statement` with identifier resolution checking `obj`'s properties first.
4. Pop `obj` from the chain.

Key invariant: any read/write of an identifier `x` inside the body must first check
`Object.prototype.hasOwnProperty.call(obj, x)` (or `x in obj`) before falling through to the
outer scope. This means identifier access is **not statically resolvable** inside a `with` body.

## Why this is hard for a WasmGC compiler

Normal compilation assigns each local variable to a typed Wasm local (`local.get $x`). Inside a
`with` body, `x` might be `obj.x` or the local `x` depending on runtime state. A static compiler
must either:

- Compile the entire `with` body in a "slow mode" where every identifier read/write goes through
  a dynamic dispatch, OR
- Refuse to handle the case statically and fall back to an interpreter path.

## Approach: prove-or-demote (project lead's direction, 2026-05-31)

> "With our IR-based static analysis we should prove the actual shape and, if not
> possible, fall back to a more dynamic representation."

`with` is **not a special case** — it is one more instance of the compiler's general
**prove-or-demote** pattern: static types lower to typed locals; what we cannot prove
demotes to the dynamic (`externref`) representation. The lexical/property ambiguity of a
`with` body is exactly the shape-uncertainty the IR's static analysis exists to resolve.

The decision is driven by a single IR fact: **can we prove `obj` has a *closed shape*** —
a statically-known, complete key set + prototype + `@@unscopables` filter that cannot change
between the `with` head and the references in its body? If yes, every bare-identifier
reference is resolved at compile time to either a property access or the lexical binding
(Tier 1, zero runtime cost). If no, the body demotes to the dynamic-object representation,
reusing the existing `__extern_has`/`__extern_get`/`__extern_set` machinery (Tier 2).

The old "evaluate approaches A–E" framing and its hybrid A+B slow-path plan are **superseded**
by this two-tier design. (A's purely-syntactic free-identifier walk is folded into Tier 2 as
the demotion path; B's "no overlap" fast path is generalised and made *sound* by Tier 1's
closedness requirement — see §1 on why closedness, not "has at least these keys", is the
load-bearing fact.)

The old approach table is retained at the bottom for provenance (§9), but is **not** the plan.

---

## Tier 1 — IR-proven static routing (primary path, the common case)

When the IR can prove `obj` has a **closed shape**, we resolve every free-identifier reference in
the body entirely at compile time. No runtime probe, no slow mode, no externref boxing — the
`with` evaporates and the body is plain typed codegen.

### 1. The decision: HasBinding, and why *closedness* is load-bearing

For each free identifier `x` referenced in the body, the spec (§9.1.1.2.1 `HasBinding` for an
Object Environment Record, used by §14.11 `WithStatement`) requires:

```
HasBinding(objEnvRec, x)  ≡  HasProperty(obj, x)        (§7.3.12 — own + full prototype chain)
                             AND NOT IsTruthy(unscopables[x])   (when obj[@@unscopables] is set)
```

- If `HasBinding` is **true** → rewrite the reference to a property access: read `obj.x`,
  write `obj.x = …`, `typeof obj.x`, `delete obj.x`.
- If `HasBinding` is **false** → leave the reference as the lexical binding `x` (the outer
  local/global), exactly as if no `with` were present.

**The load-bearing requirement is CLOSEDNESS, not "has at least these keys."** To route `x` to
the *lexical* binding we must prove `HasProperty(obj, x)` is **false** — i.e. that `x` is
**absent** from `obj` *and its entire prototype chain*. A type that merely guarantees the
presence of some keys is insufficient: tsc structural types are **open** (excess properties are
permitted; a value typed `{a: number}` may carry an `x` at runtime). Proving absence requires a
**complete, sealed** key-set — every key `obj` can possibly answer to, with nothing addable.

> Concretely: `with({a, b}) { x }` can only route `x` to the lexical binding if we know the
> object's key set is *exactly* `{a, b}` (plus `Object.prototype`'s keys, which the
> `@@unscopables` step and own-vs-inherited handling cover) and that nothing mutates it before
> the reference. tsc's `{a:number,b:number}` does not give us that — provenance does.

### 2. Where closedness comes from — *provenance*, tracked on the IR value

Closedness is a **provenance fact carried on the IR value**, computed by the IR's static
analysis — **not** read off tsc's structural type (which is open and excess-property-permitting).
A value qualifies for Tier 1 when its provenance is one of:

1. **Object literal** — `with({a, b}) {…}`. The literal's complete key set is syntactically
   visible. Lowered today by `lowerObjectLiteral` → `object.new` with an `IrObjectShape`
   (`src/ir/from-ast.ts:1670`); that shape's `fields` list **is** the closed key set.
2. **`Object.freeze` / sealed objects** — the key set is frozen post-construction. The legacy
   codegen already tracks this in `ctx.frozenVars` / `ctx.sealedVars`
   (`src/codegen/context/types.ts:865-866`); the IR equivalent is a `frozen`/`sealed`
   provenance bit on the value.
3. **Well-known builtins with fixed shape** — `Math`, `JSON`. Their key sets are constants
   known to the compiler. (`with(Math){ sin(x) }` → `Math.sin(x)`.)
4. **Compiler-constructed objects whose entire lifecycle is statically visible** — an
   `object.new` value that (a) never escapes the function, (b) is never the target of a
   dynamic key add (`obj[k]=…`), `delete obj[k]`, or `Object.defineProperty`, and (c) never
   has its prototype reassigned, between its construction and the `with` references.

Provenance is necessary but not sufficient on its own: it must be paired with a
**no-mutation-across-body** proof (§3) so the closed shape that held at the `with` head still
holds at each reference.

### 3. The IR closed-shape fact (the new analysis this issue introduces)

Add a per-value **closed-shape fact** to the IR's shape/type map, computed by a new analysis pass
under `src/ir/analysis/` (sibling to `escape.ts` / `ownership.ts`), consumed at the `with`
lowering site in `src/ir/lower.ts`. The fact:

```ts
// src/ir/analysis/closed-shape.ts (NEW) — inference-only, like escape.ts/ownership.ts:
//   writes to a reserved AllocSiteRegistry namespace, never mutates the IR.
interface ClosedShapeFact {
  readonly closed: boolean;          // false ⇒ Tier 2 demote (TOP of the lattice)
  readonly keys: ReadonlySet<string>;// complete own-key set (only meaningful when closed)
  readonly proto: ProtoShape;        // "object-prototype" | "null" | "known-builtin:<name>" | "unknown"
  readonly unscopables:              // @@unscopables resolution
    | { kind: "none" }               //   obj[@@unscopables] provably absent
    | { kind: "static"; blocked: ReadonlySet<string> } // statically-known blocked keys
    | { kind: "dynamic" };           //   present but not statically resolvable ⇒ forces Tier 2
}
```

Three sub-analyses feed it (all already have IR scaffolding to build on):

- **(a) Key-set + prototype derivation.** From the value's provenance (§2):
  - `object.new` → `IrObjectShape.fields` gives `keys`; prototype is `Object.prototype`
    (`proto: "object-prototype"`). `IrObjectShape` already exists
    (`src/ir/nodes.ts:100`, canonical sorted field list) — the analysis reads it directly.
  - frozen/sealed value → keys from the construction site + frozen bit.
  - `Math`/`JSON` builtin → constant key tables in the compiler.
  - The **prototype shape** matters because `HasProperty` walks the chain: for an object-literal
    object, `obj.toString`/`obj.valueOf`/`obj.hasOwnProperty` etc. resolve **true** via
    `Object.prototype` — they must route to a property access (or be `@@unscopables`-blocked),
    not the lexical binding. The analysis must therefore fold the **fixed `Object.prototype`
    key set** into `HasProperty` for the common object-literal case.

- **(b) Immutability / no-mutation-across-body check.** A dataflow walk from the `with` head over
  the body that **invalidates** (sets `closed = false`) on any operation that could add/remove a
  key or change the proto of `obj`:
  - dynamic key write `obj[k] = …` with non-constant `k`, `delete obj[k]`,
    `Object.defineProperty(obj, …)`, `Object.assign(obj, …)`, `obj.__proto__ = …` /
    `Object.setPrototypeOf(obj, …)`,
  - `obj` (or an alias) passed to an **opaque call** that could mutate it.

  This is precisely what the existing **escape / ownership analysis already computes**
  (`src/ir/analysis/escape.ts` + `ownership.ts`, #747/#1587). An `object.new` classified
  `local` (`EscapeClass = "local"`, "never escapes; lifetime bounded by the function") with no
  key-mutating instruction in its access set is the canonical Tier-1 candidate. We **reuse**
  the escape classification as the no-mutation gate; we do **not** invent a parallel pass.
  > **Prerequisite (call this out, do not assume):** the escape pass classifies *allocation
  > escape* but does **not yet** track *property/proto mutation* as an access tag in the access
  > lattice. The closed-shape analysis needs a "key-set-mutating access" tag added to the access
  > lattice in `src/ir/analysis/lattice.ts` (powerset-of-access-ops, join = union). If that tag
  > does not exist, **adding it is a Tier-1 prerequisite** — see §6.

- **(c) `@@unscopables` resolution.** For object literals and builtins, `obj[@@unscopables]` is
  provably absent (`{ kind: "none" }`) → no blocking. If a literal explicitly sets
  `[Symbol.unscopables]: {…}` with a static initializer, resolve `blocked` at compile time
  (`{ kind: "static", blocked }`). A **dynamic** `@@unscopables` (computed/opaque) forces
  `{ kind: "dynamic" }` → demote to Tier 2.

### 4. Tier-1 lowering (how the fact is consumed at the `with` site)

In the AST→IR lowerer (`src/ir/from-ast.ts`) add a `WithStatement` case (it is currently absent →
the node demotes to legacy, which CEs). It:

1. Lowers `stmt.expression` to a value `objV`, queries `ClosedShapeFact` for `objV`.
2. If `closed === true`: enter Tier-1 mode. Collect the body's free identifiers (an identifier
   whose binding resolves *outside* the body's own lexical scope — `var`/`function`-hoisted names
   and inner `let`/`const` are **bound**, never free, so they are never rewritten; see edge cases).
   For each free identifier `x`, compute `HasBinding` from the fact:
   - `present = keys.has(x) || protoHasKey(proto, x)`, then apply the `@@unscopables` filter.
   - If `HasBinding(x)` → emit the reference as a **member access on `objV`**: read →
     `object.get objV "x"` (or `class.get`/builtin getter); write → `object.set objV "x" rhs`;
     `typeof`/`delete` → the member-access form. These are existing IR instrs — no new lowering.
   - Else → emit the reference as the **lexical binding** unchanged.
3. The `with` itself produces **no runtime construct** — no scope object, no probe, no `externref`.
   The body is ordinary typed IR. A null/undefined `obj` is a compile-time error in the
   closed-shape case only when the closed value is statically `null`/`undefined` (rare); otherwise
   the spec's §14.11.2 `ToObject`/TypeError-on-null is handled by Tier 2 when the value is opaque.

Spec citation: the rewrite is a sound static realization of §14.11 step "let newEnv be
NewObjectEnvironment(obj, …)" + §9.1.1.1 `GetBindingValue` / §9.1.1.5 `SetMutableBinding` —
because the binding-resolution that those records perform dynamically is, under proven closedness,
**constant** across the body, so it is folded into codegen.

### Tier-1 feasibility: **medium, dispatchable**

Tier 1 ships the bulk of the ~294 skipped `with` tests — the `with(Math)`/`with(JSON)`/
`with({literal})`/`with(frozenConst)` forms that dominate the dedicated suite — at **zero**
runtime cost and with **no** dependency on the object-representation ceiling. It is the
recommended first slice. Its only real prerequisite is the access-lattice mutation tag (§6); the
key-set derivation and `@@unscopables` static resolution are new but self-contained, and the
no-mutation gate is a *consumer* of the existing escape pass, not a new whole-program analysis.

---

## Tier 2 — dynamic fallback (secondary path)

When the IR **cannot** prove a closed shape — an opaque/externref target (`with(JSON.parse(s))`,
`with(document)`), a body that mutates `obj`'s keys/proto, a dynamic `@@unscopables`, or any value
whose provenance is not in §2 — the body **demotes to the dynamic-object representation**. Each bare
identifier read/write routes at runtime through `HasBinding`/get/set on `obj`'s dynamic-property
machinery, falling through to the lexical binding on a miss.

### 5. Reuse the existing dynamic-property machinery — do not invent a parallel one

The runtime primitives already exist and are the **same** ones the dynamic-object /
object-representation work uses (#1719 CPR computed-property-read track, #1130 getter-observing
property reads, the `__defineProperty_*` / dynamic descriptor path):

- `__extern_has(obj, key) → i32` — `src/runtime.ts:4891`. This is **HasProperty** (§7.3.12), not
  yet **HasBinding** — it does *not* apply the `@@unscopables` filter. Tier 2 needs a thin
  `__with_has(obj, key)` wrapper that = `__extern_has` **AND NOT** truthy
  `obj[@@unscopables][key]` (spec §9.1.1.2.1 steps 3–5). This is the **only** new host import
  Tier 2 needs; everything else is reuse.
- `__extern_get(obj, key) → externref` — `src/runtime.ts:4726`. The read primitive.
- `__extern_set(obj, key, val)` — `src/runtime.ts:4738`. The write primitive.

Per-reference lowering (dynamic mode), for a free identifier `x`:

```
read x   →  if __with_has(obj, "x") then __extern_get(obj, "x") else <lexical x>
write x  →  if __with_has(obj, "x") then __extern_set(obj, "x", v) else <lexical x = v>
```

The "miss → lexical" fallthrough is emitted by lowering the original lexical reference inline in
the `else` arm. Nested `with(a) with(b){…}` expands to a compile-time-nested `if/else` chain,
innermost-first (each scope is a distinct value; no runtime scope-chain object is needed because
the nesting is lexically fixed).

### Standalone vs JS-host split (dual-mode, per CLAUDE.md)

- **JS-host mode** (`--target js`): host objects like `with(document)` need the host-import
  `in`/get/set — `__with_has`/`__extern_get`/`__extern_set` route through the JS proxy and see the
  real host property table. This is the primary Tier-2 path.
- **Standalone / WASI mode** (`--target wasi`, no JS host): there is no host to answer `in`/get/set
  against an opaque externref. For a **Wasm-constructed** dynamic object (the dynamic-object
  representation track), the Wasm-native dynamic property lookup serves the same role. For a
  genuinely **host** target (`with(document)`) in standalone mode there is no host — that sub-case
  stays a clean `CE` ("with on a host object requires --target js"). This is the rare residual,
  **not** the default: literals/builtins are Tier 1, and Wasm-constructed dynamic objects use the
  native lookup.

### Tier-2 feasibility: **hard, deferred — overlaps the object-representation ceiling**

Tier 2's correctness is bounded by how complete the dynamic-object representation is for
compiled values (the convergent #1719/#1130/#1320/#1732 ceiling: compiled WasmGC values are not
host JS objects). It should **follow the dynamic-representation track**, not block Tier 1. The
`@@unscopables`-aware `__with_has` wrapper and the per-reference if/else lowering are
straightforward; the hard part is the underlying dynamic representation, which is shared work.

---

## Recommended slicing

1. **Ship Tier 1 first** (`feasibility: medium`, dispatchable now): IR closed-shape fact +
   static routing. Covers `with(Math)`, `with(JSON)`, `with({literal})`, `with(Object.freeze(…))`
   — the bulk of the dedicated `with` suite — at zero runtime cost. Prerequisite: access-lattice
   mutation tag (§6).
2. **Tier 2 follows the dynamic-representation track** (`feasibility: hard`): demote opaque/
   mutated/dynamic-`@@unscopables` bodies through `__with_has` + `__extern_get`/`__extern_set`,
   reusing #1719/#1130 machinery. Add the `__with_has` `@@unscopables` wrapper here.
3. **Residual CE** only for the genuinely unsupportable sub-cases (host object in standalone
   mode; a closure that captures a `with`-scoped name across a function boundary — see edge cases).
   This must be the *rare residual*, not the default.

> **Strict mode is unchanged**: `with` in strict-mode/module/class code is already a parse-time
> early error (`src/compiler/validation.ts:667`, §14.11.1). Both tiers only ever see sloppy-mode
> bodies; keep that gate.

---

## 6. Prerequisites & risks (call out, do not assume)

- **IR access-lattice "key-set-mutating access" tag (Tier-1 prerequisite).** The escape/ownership
  analysis (`src/ir/analysis/{escape,ownership,lattice}.ts`) classifies *allocation escape* and
  records an **access set** (powerset lattice, `src/ir/analysis/lattice.ts`), but does not today
  have an access tag meaning "this op can add/remove a key or change the proto of the value." The
  no-mutation-across-body gate (§3b) needs that tag. **If it does not exist, adding it is a
  prerequisite for Tier 1** — it is a small, local extension of the existing access lattice
  (add a tag; mark `obj[k]=`, `delete`, `defineProperty`, `setPrototypeOf`, opaque-call as
  setting it; join = set union), not a new pass. Flag for the dev as the first sub-task.
- **No general escape analysis gap beyond the above.** The "lifetime statically visible / does not
  escape" half is already provided by `escape.ts` (`EscapeClass = "local"`). We are consumers, so
  there is no missing whole-program analysis — only the mutation-tag extension above.
- **`WithStatement` is absent from the IR lowerer today** — `src/ir/from-ast.ts` has no case, so
  the node currently demotes to legacy and CEs. Tier 1 adds the case; until then nothing routes
  through the new fact.
- **`@@unscopables` static resolution** is new but bounded: object literals and `Math`/`JSON`
  have no `@@unscopables` (`{ kind: "none" }`); only an explicit static
  `[Symbol.unscopables]: {…}` needs evaluation; anything dynamic forces Tier 2.
- **Provenance must come from the IR value, not tsc.** The single biggest correctness risk is
  using tsc's open structural type as if it were closed. The spec is explicit that this is
  unsound (excess properties). The analysis must derive `keys`/`proto` only from §2 provenance.

## 7. Edge cases & spec-correctness checklist

| Case | Tier-1 handling | Tier-2 handling |
|---|---|---|
| `with` body declares `var foo` / `function foo(){}` | `foo` hoists to the function's variable env → it is a **bound** (not free) ident → never rewritten; `obj.foo` does **not** win (§9.1.1.2). (S12.10-0-1.) | Same — bound idents are never probed. |
| inner `let`/`const` in the body | block-scoped binding → bound, never rewritten. | Same. |
| `obj.toString`/inherited `Object.prototype` keys | `HasProperty` walks the prototype; proto key set is folded in → routes to `obj.toString` unless `@@unscopables`-blocked. Tier 1 **must** include `Object.prototype` keys, else it wrongly routes them lexical. | `__with_has` (= `in`) already walks the chain. |
| `obj` is `null`/`undefined` | If the closed value is statically null → compile error. | `with(null)` per §14.11.2 → TypeError at entry; `__with_has(null,…)` returns 0 but we must throw at the head — emit a null guard via `__throw_type_error`. |
| `obj` is a primitive (`with(2)`) | `ToObject(2)` shape is the Number wrapper — only Tier-1-eligible if we model the wrapper's keys; otherwise demote. | `Object(obj)` inside the host primitives covers it (12.10-2-1). |
| `delete x` through `with` | rewrite to `delete obj.x` when `HasBinding`, else lexical `delete`. | `__with_has` then `__extern_set`/delete shim, else lexical delete. |
| `typeof x` through `with` | rewrite to `typeof obj.x` when `HasBinding`, else lexical `typeof` (so `typeof undeclared` doesn't throw). | probe then `typeof __extern_get`, else lexical. |
| compound assign `x ^= 3` / reference stability (S11.13.2_A5.10_T3) | Tier 1 resolves the base once at compile time → naturally stable. | resolve the base once on read, store rhs in a temp, write back via the *same* `obj` ref — stable even if a getter deletes the prop mid-eval. Document this. |
| dynamic `obj[k]=…` / `delete` / proto reassign inside body | invalidates closedness → **demote whole body to Tier 2**. | native dynamic handling. |
| dynamic `@@unscopables` | forces Tier 2. | `__with_has` reads `obj[@@unscopables]` at runtime. |
| nested `with(a) with(b)` | per-scope HasBinding resolved innermost-first at compile time. | compile-time-nested if/else chain, innermost-first. |
| closure capturing a `with`-scoped name across a function boundary | The object env record IS on the lexical chain, so a nested closure *does* see it. Tier 1 only rewrites references **lexically inside** the body; a name captured by an inner function is not rewritten there → **incorrect**. v1 demotes such bodies to Tier 2, or emits a residual CE if Tier 2 can't model the captured scope. <5 test262 tests; track as follow-up. | Same caveat — the inner function would need the `obj` ref threaded as a capture. |
| `eval` inside `with` | already CE (eval) — no interaction. | unchanged. |
| `with` inside generator/async | straight-line if/else or static rewrite; no function boundary → fine. | fine. |

## 8. Test yield & regression gate

| Source | CE today (`Unsupported statement: WithStatement`) | Tier 1 | Tier 1+2 |
|---|---:|---:|---:|
| `language/statements/with/` (dedicated, ~174 noStrict + 7 strict negatives) | ~155 | most literal/builtin forms pass | nearly all |
| compound-assignment / increment / delete / typeof through `with` LHS | ~64 | partial (closed-shape LHS) | most |
| Proxy traps via `with` (`built-ins/Proxy/has/`) | ~9 | — (needs Proxy) | — |
| Other (embed `with` incidentally, CE for other reasons too) | ~50 | modest | modest |
| **Total** | **294 CE** | **target +120–160 net pass** | **target +200+ net pass** |

Regression gate (per slice):
1. `pnpm test -- tests/equivalence.test.ts` — green (no codegen regression).
2. Add hand-rolled equivalence tests: `with(Math){…}`, `with({a,b}){…}`, `with(Object.freeze(o)){…}`,
   nested `with`, `@@unscopables` block — assert against Node.js reference output.
3. Scoped `pnpm test:262 --include language/statements/with` — expect newly-passing, 0 newly-failing.
4. Full sharded test262 in CI — net pass ≥ +120 for Tier 1; no single bucket regression > 5.

## 9. Superseded approach table (provenance only — NOT the plan)

The original exploration evaluated five approaches; they are folded into the two tiers above and
retained here only for history.

| Approach | Disposition under the two-tier plan |
|---|---|
| **A — pure externref slow-path body** | Subsumed by **Tier 2**, but gated by closedness: A is only emitted when Tier 1 *cannot* prove a closed shape, and reuses `__extern_*` rather than a bespoke `__with_lookup` scope-chain. |
| **B — static analysis for non-overlapping names** | Generalised and made *sound* by **Tier 1**: B's "no overlap" intuition is replaced by the **closedness** requirement (prove *absence*, not just presence), driven by IR provenance rather than a syntactic name walk. |
| **C — desugar to `(function(scope){…}).call(obj)`** | Rejected (unchanged): renames the lookup problem, breaks `var` hoisting / `this` capture. |
| **D — flat rejection in standalone** | Retained as the **residual CE** only for host objects in standalone mode; literals/builtins/Wasm-objects do not need it. |
| **E — delegate body to JS host (`eval`-style)** | Rejected (unchanged): defeats WasmGC compilation. |

## Related

- `with` skip filter / runner: `tests/test262-runner.ts` (no `with` skip filter exists today —
  tests begin passing once the compiler stops emitting CE; verified at `shouldSkip`).
- Strict-mode early error (keep): `src/compiler/validation.ts:667` (§14.11.1).
- IR shape & analysis: `src/ir/nodes.ts:100` (`IrObjectShape`), `src/ir/analysis/escape.ts`,
  `src/ir/analysis/ownership.ts`, `src/ir/analysis/lattice.ts`, `src/ir/from-ast.ts:1670`
  (`lowerObjectLiteral`), `src/ir/lower.ts`.
- Frozen/sealed provenance (legacy): `src/codegen/context/types.ts:865-866`
  (`frozenVars` / `sealedVars`).
- Dynamic-property runtime (Tier 2 reuse): `src/runtime.ts:4726` (`__extern_get`), `:4738`
  (`__extern_set`), `:4891` (`__extern_has`).
- Object-representation ceiling (bounds Tier 2): #1719, #1130, #1320, #1732.
- Eval (similar dynamic-scope problem): `plan/issues/1262-eval-static-string-compile-time.md`.
- CLAUDE.md: "compile away, don't emulate" + dual-mode (JS host optional) — Tier 1 *compiles the
  `with` away*; Tier 2 is the principled dynamic fallback for the unprovable residual.

## Acceptance criteria for the architect spec

1. ✅ Reframed as prove-or-demote with two tiers (Tier 1 IR-proven static routing; Tier 2 dynamic
   fallback), driven by an IR closed-shape fact.
2. ✅ Defined the IR closed-shape fact (`ClosedShapeFact`: closed bit, key set, proto shape,
   `@@unscopables`), its three sub-analyses, the IR structures/passes it touches, and where it is
   computed and consumed.
3. ✅ Connected Tier 2 to the existing dynamic-property machinery (`__extern_has`/get/set,
   #1719/#1130) and noted the standalone-vs-JS-host split.
4. ✅ Re-graded feasibility (Tier 1 medium/dispatchable; Tier 2 hard/deferred) and recommended
   slicing.
5. ✅ Called out the IR prerequisite (access-lattice mutation tag) rather than assuming it.

## Implementation note — 2026-06-01 diagnostic slice

This slice deliberately takes the precise diagnostic branch rather than shipping an unsound
Tier-1 rewrite. The current IR path still has no `WithStatement` lowering node, no closed-shape
fact namespace, and no key-set/prototype mutation access tag distinct from generic value writes.
That means even `with ({ a: 1 }) { ... }` cannot yet be proven sound under ECMA-262 14.11.2:
`with` installs an Object Environment Record, whose HasBinding operation (9.1.1.2.1) depends on
HasProperty plus `@@unscopables`; HasProperty (7.3.11) includes inherited properties.

Implemented behavior:

- `src/codegen/statements.ts` now handles `WithStatement` explicitly instead of falling through
  to `Unsupported statement: WithStatement`.
- The diagnostic is anchored to the `with` source location, cites #1387, cites the relevant
  ECMA-262 sections, explains the target expression kind, and points the dynamic fallback to
  #1472 rather than inventing local dynamic object helpers.
- Sloppy-mode coverage lives in `tests/issue-1387-with-diagnostic.test.ts`; existing source
  location tests were updated to expect the #1387 diagnostic.

Validation:

- `node node_modules/vitest/dist/cli.js run tests/issue-1387-with-diagnostic.test.ts tests/error-reporting.test.ts`
  → 2 files passed, 10 tests passed.
- Accidental broad command `pnpm test -- tests/issue-1387-with-diagnostic.test.ts tests/error-reporting.test.ts`
  expanded through the package script and ran the wider suite, including `tests/test262-vitest.test.ts`;
  it is not a scoped #1387 signal and eventually failed/OOMed after unrelated existing failures and
  missing precompile-cache/network issues.

## Implementation note — 2026-06-03 Tier-1 literal slice

This slice ships the first static `with` lowering rather than only diagnosing every
`WithStatement`. The implementation is deliberately narrow and sound:

- `src/codegen/with-scope.ts` proves object-literal targets with simple own data
  properties, compiles the target once into a WasmGC struct local, and pushes a
  per-function `withScopes` stack.
- Bare identifier reads and simple assignments consult the stack innermost-first.
  Proven own-property bindings lower to direct `struct.get` / `struct.set`; names
  absent from the closed own-key set fall through to the lexical binding.
- Nested literal `with` scopes work for the static path. Literal targets that lack a
  TypeScript struct identity synthesize a closed anonymous struct from the literal
  fields so nested scopes do not fall back to plain externref.
- Body declarations are treated as lexical blockers, and inherited
  `Object.prototype` names such as `toString` are refused for now rather than
  unsoundly routed to the outer lexical scope.
- Opaque targets, spreads, accessors, methods, duplicate keys, `__proto__`, dynamic
  computed keys, static/dynamic `@@unscopables`, and closure-capturing bodies remain
  on the #1387/#1472 diagnostic path.

Focused coverage:

- `tests/issue-1387.test.ts` covers literal reads, simple writes, nested literal
  scopes, lexical shadowing, opaque-target diagnostics, and inherited-prototype
  refusal.
- `tests/issue-1387-with-diagnostic.test.ts` and `tests/error-reporting.test.ts`
  were updated so diagnostics now target the residual unsupported cases.

Validation:

- `pnpm exec tsc --noEmit` — passed.
- `node node_modules/vitest/dist/cli.js run tests/issue-1387.test.ts tests/issue-1387-with-diagnostic.test.ts tests/error-reporting.test.ts`
  — 3 files passed, 16 tests passed.
- `node node_modules/vitest/dist/cli.js run tests/equivalence.test.ts` — no such
  test file exists in this checkout; the repo has sharded files under
  `tests/equivalence/`.
- `pnpm test:262 --include language/statements/with` — failed before running tests:
  the current worktree's `test262/` directory does not contain `test262/test`, while
  `/workspace/test262/test` exists. No test262 conformance result was produced.

## Implementation note — 2026-06-07 Object.freeze/Object.seal provenance slice

This slice extends the Tier-1 static path to two more closed-shape provenance
forms called out in the architecture plan:

- `with (Object.freeze({ ... })) { ... }` now unwraps the direct builtin
  integrity call when the argument is a simple object literal, compiles the
  literal once, and routes bare identifier reads through the existing
  `withScopes` stack.
- Frozen literal fields are treated as read-only in the `with` binding view, so
  writes stay on the residual diagnostic path instead of silently mutating the
  compiled struct.
- `with (Object.seal({ ... })) { ... }` uses the same closed literal proof while
  keeping data fields writable, matching sealed data-property semantics for this
  narrow static slice.
- Calls are only unwrapped for direct single-argument `Object.freeze`/`Object.seal`
  heads where `Object` is not a local binding. Opaque targets, extra arguments,
  and dynamic/static `@@unscopables` remain deferred to the existing diagnostic
  path.

Focused coverage:

- `tests/issue-1387.test.ts` now covers frozen literal reads, sealed literal
  writes, and frozen-field assignment diagnostics.

Validation:

- `pnpm exec tsc --noEmit` — passed.
- `node node_modules/vitest/dist/cli.js run tests/issue-1387.test.ts tests/issue-1387-with-diagnostic.test.ts tests/error-reporting.test.ts`
  — 3 files passed, 19 tests passed.
- `TEST262_PATH_FILTER=language/statements/with pnpm test:262` — completed the
  scoped with-statement slice and left the broader conformance slice red: 20
  pass / 181 total (9 fail, 152 compile errors, 0 skip). The residual failures
  are the expected post-slice dynamic cases, including opaque `with` targets,
  proxy/env and `@@unscopables` binding checks, strict `Function` parse
  coverage, and abrupt-completion cases. Artifacts:
  `benchmarks/results/test262-report-20260607-072647.json` and
  `benchmarks/results/test262-results-20260607-072647.jsonl`.

## Publication note — 2026-06-07 PR auto-merge enabled

PR #1272 is open and ready for review against `main`. The branch was refreshed
with current `origin/main` by merge commit `8658a7bd5` before publication.

The first refreshed CI run passed the #1387 implementation checks through
typecheck/lint, equivalence shards, and the sharded test262 catastrophic and
standalone regression guards. That run then failed the external stale-baseline
guard in `Test262 Sharded / merge shard reports`: `js2wasm-baselines` pointed
at baseline main SHA
`ff02d201152dc8777d3e8151ed05dddd47d75ecf`, which the job reports as 114
commits behind current `origin/main` (threshold: 50). This blocks merge-queue
entry for #1272 independently of the `with` slice; see #1668 in the CI message.

After recording this, commit `564bc4bb7` was pushed and GitHub accepted
auto-merge for PR #1272 at 2026-06-07T10:18:18Z. The issue remains
`in-review`; the PR will merge if the new queued checks pass, or stay blocked
if the stale-baseline guard repeats.
