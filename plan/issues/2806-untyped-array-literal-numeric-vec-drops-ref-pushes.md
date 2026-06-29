---
id: 2806
title: "[SENIOR-DEV ONLY] untyped `[]` array literal lowers to a NUMERIC (f64) vec — ref pushes coerce to 0 (drops AST node refs)"
status: done
assignee: ttraenkler/senior-dev
completed: 2026-06-28
sprint: current
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
created: 2026-06-28
task_type: bugfix
area: codegen
language_feature: value-representation
goal: acorn-dogfood
related: [2801, 2794, 2784]
depends_on: []
blocks: [2801]
architect_spec: candidate
---

# #2806 — untyped `[]` lowers to a numeric vec, dropping reference-typed pushes

**Carved out of #2801 (layer 2 of 2).** Distinct substrate class from the host
vec→array *marshaling* fix that landed for #2801 layer-1. This is the **real
blocker** for correct compiled-acorn call arguments — and it is **general**, not
acorn-specific: it equally breaks `ArrayExpression.elements` and surfaces in
`CallExpression.optional` reading `0` instead of `false`.

## Symptom

After the #2801 layer-1 host-marshaling fix (`_wrapVecForHost`), compiled-acorn
`parse("foo(bar, baz)").arguments` is a **real JS array of length 2**, but its
elements are `[0, 0]` — numeric zeros — instead of the two `Identifier` nodes.

## Decisive root-cause probe

Instrumenting the host read (`DBG2801` in `_wrapVecForHost.elemAt`,
`src/runtime.ts`):

```
[DBG elem] i=0 rawTypeof=number rawIsWasm=false raw=0 mutSup=1 vecLen=2
```

So `__vec_get(argsVec, i)` returns a **`number 0`** (`rawIsWasm=false`), with
`__vec_mut_supported=1`, `__vec_len=2`. The `arguments` vec is a genuine,
growable vec whose **backing-array element kind is numeric (f64)**. When acorn
pushes AST node references into it, each ref is coerced to f64 `0`; `__vec_get`
faithfully reads back `0`. `call.optional` reading `0` (not `false`) is the same
class of raw-scalar representation leak.

`__vec_get` (`src/codegen/index.ts` ~4726-4900) is innocent: it does a
`ref.test` chain over registered vec types and reads the matched backing array.
The args vec genuinely **is** a numeric vec, so the read is correct for the
(wrong) representation.

## Origin — empty-array element-kind resolution

`compileArrayLiteral` empty-array path, `src/codegen/literals.ts` ~3087-3162:

```ts
let emptyElemKind = "externref";
const ctxType = ctx.checker.getContextualType(expr) ?? ctx.checker.getTypeAtLocation(expr);
if (ctxType) {
  const sym = (ctxType as ts.TypeReference).symbol ?? ctxType.symbol;
  if (sym?.name === "Array") {
    const typeArgs = ctx.checker.getTypeArguments(ctxType as ts.TypeReference);
    if (typeArgs[0]) {
      const elemWasmType = resolveWasmType(ctx, typeArgs[0]);
      emptyElemKind = elemWasmType.kind === "ref" || elemWasmType.kind === "ref_null"
        ? `ref_${(elemWasmType as { typeIdx: number }).typeIdx}`
        : elemWasmType.kind;
    }
  }
}
const vecTypeIdx = getOrRegisterVecType(ctx, emptyElemKind);
```

acorn is **plain JS** (compiled with `skipSemanticDiagnostics: true`, no type
annotations). For acorn's `arguments`/`elements` `[]` literals the contextual /
`getTypeAtLocation` element type resolves to a **numeric** wasm kind, so the vec
is created with an f64 backing array — and every subsequent reference push is
coerced to f64.

## The `body`-vs-`arguments` representation split (the tell)

`Program.body` reaches the host as a **host-backed JS array** (externref,
`isWasm=false`) of node proxies and works, while `CallExpression.arguments` /
`ArrayExpression.elements` are **f64 vecs** that drop their node refs. Same
"untyped `[]` + `.push(node)`" source pattern, different representation — so the
element-kind decision is **inference-context dependent** (evolving-array flow
analysis / contextual type), not uniform. Pinning *why* the two diverge is the
first investigation step.

## Fix direction (needs an architect representation-policy decision)

An empty / untyped `[]` that subsequently receives **reference-typed** pushes
must lower to an **externref/any-element vec** (boxed refs preserved), never an
f64 vec. Candidate policies (DESIGN DECISION — architect-spec):

1. **Default-to-any**: an untyped/`any[]`/`never[]` empty literal whose element
   kind can't be proven numeric lowers to externref, not f64. Simple, but may
   widen genuinely-numeric untyped arrays (perf/repr cost) — measure.
2. **Flow-analyze pushes**: inspect the `.push(...)` / index-write sites feeding
   the array binding; if any pushes a ref/`any`, choose externref. More precise,
   more complex, must handle the evolving-array binding across the function.

Either way: validate the `body`-style host-array path is unaffected, and run the
**full `merge_group` + standalone-floor** (broad blast radius — touches every
untyped/evolving array literal). Watch for regressions in numeric-array-heavy
test262 buckets.

## Acceptance

- An empty/untyped `[]` that receives reference-typed pushes round-trips those
  references (host reads them back as the pushed objects, not `0`).
- Compiled-acorn `parse("foo(bar, baz)").arguments` structurally equals
  node-acorn (two `Identifier` nodes) via the dogfood differential oracle —
  closing **#2801**. Spot-check `f(1, 2+3)`, `f()`, `g(a)(b)`, `[1, 2]`.
- `CallExpression.optional` reads `false` not `0` (same representation class).
- Full `merge_group` + standalone-floor green; no numeric-array regressions.

## Banked probes / method

- `.tmp/callargs3.mjs` — parse + diffAst vs node-acorn oracle for arguments.
- `.tmp/elemdbg.mjs` + `DBG2801` instrumentation in `_wrapVecForHost.elemAt` —
  the decisive `__vec_get → number 0` classification.
- Acorn compiles in ~40s (longer under load); reuse ONE compile per probe.
- Depends on the #2801 layer-1 fix (`_wrapVecForHost`) being present so the
  array surfaces at all — branch fresh from `origin/main` after that lands, or
  cherry-pick it.

## Build-on

- **Blocks #2801** (its acceptance can't be met until node arrays preserve refs).
- Sibling representation work: #2784 (vec-identity), #2794 (vec read-methods).

---

## Implementation Plan (architect arch-arrayrep — CANDIDATE, superseded by Step-0; see below)

**Reframing (architect):** empty `[]` already defaults to `externref`
(`literals.ts:3126`). The generic evolving-local array is already ref-safe. The
bug is a NUMERIC OVERRIDE: when the contextual/location type resolves to
`Array<number>`, `emptyElemKind` becomes f64/i32, the vec is f64-backed, and
pushed AST-node refs coerce to `f64 0`. The fix must make actual ref writes WIN
over the inferred-numeric kind — not merely default to externref.

Policy as specified:
- **(B) push-flow override** at the empty-`[]` site (~`literals.ts:3140`): after
  `emptyElemKind` is computed, if it is primitive numeric (`f64`/`i32`), scan the
  containing function for writes to this array's binding via a
  `classifyArrayWriteElemKind(ctx, expr) → "ref"|"numeric"|"mixed"|"unknown"`
  helper (reuse the forward-walk infra at `detectCountedPushLoopSize` ~2782 /
  `detectCountedFillLoopBound` ~2867). If any write stores a reference, or
  numeric+ref mixed → override `emptyElemKind = "externref"`. All-numeric /
  no-writes → keep numeric (preserve `var a=[]; a.push(1)` fast path).
- **(A′) bounded allowJs fallback** in `resolveWasmType`'s Array branch
  (`index.ts` ~11610): only if the numeric comes from the binding/field/return
  `Array<number>`, and only under `ctx.allowJs`/`skipSemanticDiagnostics` with a
  WIDENED/inferred `number` element — prefer `externref`. Gated strictly so
  annotated TS `number[]` stays f64. (B) and (A′) must pick the SAME kind for a
  given binding or `struct.new` mismatches the local/field type → validation
  failure.

## Step-0 findings (instrument-verified — SUPERSEDE the plan above)

The (B)+(A′) premise does **not** hold on current `main` (post-#2275). Instrumented
`emptyElemKind`, the push-site element kind, and the host read for the real acorn
compile + minimal repros:

1. **Empty `[]` is already externref everywhere.** All **71** empty-`[]` literals
   in acorn — including `parseExprList`'s `arguments` array (`acorn.mjs:3613`) —
   resolve `emptyElemKind=externref`. **Zero** are f64/i32. So (B) (which only
   fires when `emptyElemKind` is numeric) is a **no-op**, and (A′) does not apply
   (the element type is not inferred-`number`).

2. **The f64/`0` comes from the binding's inferred element type, not the
   literal.** `parseExprList`'s `elts.push(elt)` (`acorn.mjs:3630`) compiles with
   `elemKind=i32` because `elts` infers `undefined[]`
   (`resolveWasmType` Array branch: `elemTs=undefined elemFlags=32768`). Each
   pushed AST-node ref coerces to i32 `0`. `__vec_get` faithfully returns
   `number 0`.

3. **Root cause = the `var elt = (void 0)` idiom.** acorn's `parseExprList`:
   `var elt = (void 0); ... elt = this.parseMaybeAssign(...); elts.push(elt)`.
   The `void 0` EXPRESSION pins the binding to TS type `undefined` (unlike
   `var elt = undefined`, which TS treats as **evolving-any**). Minimal repro
   (`.tmp/repro-variants.mjs`) confirms the split decisively:
   `var e=(void 0); e=ref; return e` → **undefined/0** (BROKEN);
   `var e=undefined` / `=null` / `var e;` (no init) → **object** (all WORK).
   Only the `void 0` form breaks. This also explains the issue's `body`-vs-
   `arguments` split: `Program.body` pushes a directly-typed ref (works);
   `CallExpression.arguments` flows through the `var elt = void 0` intermediate
   (drops the ref).

4. The `undefined` declared type then drops the ref at **multiple** codegen
   sites that each consult it independently: the local slot type
   (`localTypeForDeclaration`), the array element-kind inference
   (`inferArrayVecType` — picks the first non-`any` push value type =
   `undefined` → i32 vec), and at least one more value-coercion boundary (the
   array element STILL reads `0` even after the slot + vec are forced to
   externref — the value is lost at the assignment/return/push-arg coercion,
   not yet fully isolated). `call.optional` reading `0` not `false` is the same
   class (a `boolean` local/field carrying `0`).

### Partial fixes landed on this branch (correct but INSUFFICIENT alone)

- `inferArrayVecType` (`statements/variables.ts`): a write whose value type is
  purely `undefined`/`void`/`null` no longer pins the array element kind to a
  numeric vec (treated like `any`). → the `arguments` vec is now externref.
- `localTypeForDeclaration` (`statements/variables.ts`): a variable whose
  declared type is purely `undefined`/`void` gets an externref slot (matching
  `never`, `null`). → the `var elt = (void 0)` local is now externref.

With both, the vec + the local are externref, yet the host still reads `0` —
so a third value-coercion site remains. The complete fix needs the
`var x = (void 0)` binding to be treated as **evolving-any / externref
uniformly** across declaration + assignment + reads + return + push-arg (i.e.
make `void 0`-init behave like `undefined`-init, which already works
end-to-end). That is a cross-cutting representation change, broader than the
empty-array (B)+(A′) scope.

### Recommendation (ESCALATED to tech lead)

The architect's (B)+(A′) plan does not address the real root cause and would be a
no-op. Recommend a re-spec targeting the `var x = (void 0)` idiom: recognise a
`void`-expression initializer at the variable declaration and route the binding
through the same evolving-any path that `var x = undefined` already uses, so all
downstream coercion sites see externref. Broad blast radius → full `merge_group`
+ standalone-floor; watch `built-ins/Array/**` + TypedArray buckets.

Repros banked in `.tmp/`: `repro-variants.mjs` (the decisive void-0 split),
`repro-voidinit.mjs` (array + scalar), `callargs3.mjs`/`elemdbg.mjs` (acorn).

---

## RESOLUTION (root cause corrected + fix landed)

**The title's "lowers to a NUMERIC (f64) vec" framing and the architect's
empty-`[]` numeric-override premise were both wrong.** The real root cause is the
`var x = (void 0)` idiom (acorn's `parseExprList`):

```js
var elt = (void 0);          // the `void 0` EXPRESSION pins TS type `undefined`
elt = this.parseMaybeAssign(...);  // a REFERENCE
elts.push(elt);
return elts;
```

Unlike `var x = undefined` / `var x = null` / `var x;` (which TS treats as
**evolving-any** → `any` → externref), the `void 0` expression pins the binding to
type `undefined`. `resolveWasmType(undefined)` is numeric (i32), so the `undefined`
type drops the reference at **three independent codegen sites**, each verified by
WAT disassembly:

1. **The local slot** — `var elt`'s slot typed i32 → `elt = <ref>` coerces to i32 `0`.
2. **The array element-kind** — `inferArrayVecType` picked the first non-`any`
   push-value type (`undefined`) → an i32-backed `elts` vec.
3. **The function return type** — TS infers `parseExprList`'s return type as
   `undefined[]`, so the returned vec type was an i32 vec while the local `elts`
   was an externref vec; `return elts` coerced every pushed ref to i32 `0`.

### Fix (one root rule, applied consistently)

A `void`-expression initializer (`var x = void <expr>`) or a purely
`undefined`/`void` type is treated as **externref** (the same slot `= undefined`
gets) everywhere a binding/array/return type is resolved:

- `varBindingNeedsExternrefForUndefined(decl, type)` helper (`src/codegen/index.ts`)
  — shared by the `var` hoister (`hoistVarDecl`) and the let/const declaration
  path (`localTypeForDeclaration`, `statements/variables.ts`) so the hoisted slot
  and the declaration agree (a `var` reuses its hoisted slot).
- `inferArrayVecType` (`statements/variables.ts`) — `undefined`/`void`/`null`
  push-value types no longer pin the array element kind to a numeric vec.
- `resolveWasmType` Array branch (`src/codegen/index.ts`) — a purely
  `undefined`/`void` array element resolves to an externref vec (fixes the
  function-return-type site so it matches the externref local).

### Milestone — ACHIEVED

`parse("foo(bar, baz)").arguments` → `[Identifier(bar), Identifier(baz)]`
end-to-end via the dogfood oracle (closes **#2801**'s arguments blocker). Spot
checks: `f(1, 2+3)` → `[Literal, BinaryExpression]`; `h([1,2], {x:3})` nested
`ArrayExpression.elements` carry their node refs; all-numeric arrays still use the
f64 vec (`range = [pos, 0]` etc. unaffected — only purely undefined/void elements
change).

### Out of scope / separate classes (do NOT block #2806)

- **`CallExpression.optional` reads `0` not `false`** — a `boolean`-field-boxing
  class, NOT the void-0 binding type (it did NOT fall out of this fix; confirmed
  separate). Tracked separately.
- **Scalar `return <void-0-typed-var>` returns `undefined`** — a `var e = (void 0);
  e = <ref>; return e` standalone function infers a `void` RETURN TYPE, so the
  function emits no result and drops the value at the return. This is the
  function-return-type analogue of the same root and does NOT affect acorn's
  arguments (`parseExprList` returns an array). Follow-up if it surfaces.
- **`sourceFile` extra-field** in the dogfood diff — a harness/options field
  difference, unrelated.

### Path confirmation (direct AST→Wasm, not IR)

acorn compiles via the **direct AST→Wasm path** (`src/codegen/`), not an IR
partial — proven empirically: the fix lives entirely in `src/codegen/` and it
fixes acorn's `arguments` end-to-end, which is only possible if `parseExprList`'s
var-declaration + array-local lowering runs through that path (an IR-handled
declaration would make these changes no-ops).

## IR-path follow-up (#1530)

This fix lives on the **direct/legacy front-end** (`src/codegen/`) — the one
#1530 is retiring — because acorn compiles there today. The **same representation
rule** must be reproduced on the IR path (`src/ir/`) when it adopts
var-declarations + array-locals for modules this dynamic: a `void`-expression
initializer (`var x = void <expr>`), and any purely `undefined`/`void` binding
type, must be treated as **evolving-any / externref** (exactly like
`var x = undefined`), so a later reference assignment / push / return is not
coerced to numeric `0`. Without this, the IR path will reintroduce the #2801
node-ref drop once it owns these node kinds.
