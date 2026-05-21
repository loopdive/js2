---
title: "IR fallback bucket analysis — sprint 53 (2026-05-21)"
status: analysis
owner: arch-ir
date: 2026-05-21
---

# IR fallback bucket analysis — 2026-05-21

Deep analysis of `pnpm run check:ir-fallbacks` output to identify root causes
behind the remaining unintended buckets and propose targeted sub-issues to
retire them.

## Current state vs. baseline

Baseline (`scripts/ir-fallback-baseline.json`, generated 2026-05-08):

| Bucket                       | Baseline | Current | Δ |
|------------------------------|---------:|--------:|--:|
| `body-shape-rejected`        |       22 |      22 | 0 |
| `call-graph-closure`         |        6 |       6 | 0 |
| `param-type-not-resolvable`  |        1 |       1 | 0 |

No drift — but no progress either. The `external-call` bucket (#1371) is at
zero. The 29-fallback total is concentrated in 9 files under
`playground/examples/`.

### Per-file breakdown

```
playground/examples/benchmarks.ts                body-shape × 4
playground/examples/benchmarks/array.ts          body-shape × 2
playground/examples/benchmarks/dom.ts            body-shape × 2
playground/examples/benchmarks/fib.ts            body-shape × 1
playground/examples/benchmarks/helpers.ts        body-shape × 1, param-type × 1, closure × 1
playground/examples/benchmarks/loop.ts           body-shape × 1
playground/examples/benchmarks/string.ts         body-shape × 1
playground/examples/benchmarks/style.ts          body-shape × 2
playground/examples/dom/calendar.ts              body-shape × 6, closure × 3
playground/examples/js/builtins.ts               body-shape × 2, closure × 2
```

## Root cause analysis

### `body-shape-rejected` (22 — the dominant bucket)

`body-shape-rejected` is a coarse bucket: `whyNotIrClaimable` (src/ir/select.ts:574)
returns it whenever `isPhase1StatementList` returns `false`, regardless of
which sub-shape inside the body actually failed. By spot-reading every rejected
function we can attribute every occurrence to one of three concrete sub-causes:

#### Sub-cause A — host-global property access (≈ 15 of 22)

The hot pattern across every `main` and every DOM helper:

```ts
function el(tag: string, css: string): HTMLElement {
  const e = document.createElement(tag);   // ← rejected
  e.style.cssText = css;
  return e;
}
```

`isPhase1Expr` (src/ir/select.ts:1649) recurses into the receiver of a property
access:

```ts
if (ts.isPropertyAccessExpression(expr)) {
  if (!ts.isIdentifier(expr.name)) return false;
  return isPhase1Expr(expr.expression, scope, localClasses);
}
```

The receiver `document` is an `Identifier`, so `isPhase1Expr` falls into the
identifier branch (line 1515):

```ts
if (ts.isIdentifier(expr)) {
  return scope.has(expr.text);
}
```

`document` is never in scope (it's a host global, not a param/local), so the
property-access chain `document.body` / `document.createElement(...)` /
`performance.now()` / `console.log(...)` always returns `false`.

The Math-unary path (line 1557) is the prior art — it whitelists `Math.<unary>`
as a receiver-exempt shape. We need the same treatment for the small set of
host globals that appear in the playground corpus: `document`, `performance`,
`console`, `window`, `JSON`, `Math.<binary>` (e.g. `Math.pow`, `Math.log2`,
`Math.sin`).

#### Sub-cause B — array literal expressions (≈ 4 of 22)

`fdow` (calendar.ts:40):

```ts
const t = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4];   // ← rejected initializer
```

`bench_array` (array.ts:3) and the `dayNames` literal in calendar.ts/main:

```ts
const arr: number[] = [];                          // ← rejected (empty)
const dayNames = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];
```

`isPhase1Expr` does not list `ArrayLiteralExpression` — there is a comment at
src/ir/select.ts:1674-1677:

> Slice 12 (#1169o) — array literals not yet selector-accepted in expression
> position. `f([1, 2, 3])` keeps falling back to legacy because the call-graph
> closure drops the caller. A follow-up slice that adds a `vec.new_fixed` IR
> instr can flip this on.

So the IR shape is known (`vec.new_fixed`), but neither the IR node nor the
selector wiring is in. The corresponding IR builder/lowering site is
`src/ir/from-ast.ts` — we'd need a `vec.new_fixed(elemType, [e1, e2, …])`
instruction and a selector branch in `isPhase1Expr`.

#### Sub-cause C — arrow function as a call argument (≈ 3 of 22)

`main` in calendar.ts and benchmarks/* repeatedly does:

```ts
prev.addEventListener("click", () => {
  if (curMonth === 0) { curMonth = 11; curYear = curYear - 1; }
  else { curMonth = curMonth - 1; }
  selStart = -1;
  selEnd = -1;
  updFoot();
  renderCal();
});
```

`isPhase1Expr` only accepts arrow / function-expression literals via the
`const`-bound initializer path in `isPhase1VarDecl` (src/ir/select.ts:1223),
NOT as a direct argument expression in a `CallExpression`. The call-position
arrow falls through to the final `return false` at src/ir/select.ts:1693.

This is a real IR gap: the closure-literal lowering exists (Slice 3 / #1169c)
but only when the closure is *named* via a `const`. Lifting it into expression
position needs the lowerer to fabricate an anonymous closure name.

### `call-graph-closure` (6 — fully derivative)

Every closure-closure rejection traces to a body-shape-rejected caller or
callee — no fundamental IR gap:

| File | Rejected func | Root cause |
|------|---------------|------------|
| helpers.ts | `bcrd` | callee `el` rejected by sub-cause A (`document.createElement`) |
| calendar.ts | `mname`, `dimOf`, `priceOf` | callers `renderCal`, `updFoot`, `onDay`, `main` all rejected by A/B/C |
| builtins.ts | `crd`, `rw` | callers `main` rejected by A/B/C |

Fixing sub-causes A/B/C eliminates the `call-graph-closure` bucket entirely.

### `param-type-not-resolvable` (1 — single occurrence)

`addBenchCard` (helpers.ts:27):

```ts
export function addBenchCard(
  wrap: HTMLElement,
  title: string,
  desc: string,
  fn: () => number,            // ← rejected
): void {
```

`resolveParamType` (src/ir/select.ts:612) accepts `NumberKeyword`,
`BooleanKeyword`, `StringKeyword`, `AnyKeyword`, `TypeLiteralNode`,
`TypeReferenceNode`, `ArrayTypeNode`. `FunctionTypeNode` (`() => number`)
falls through to `return null`.

To accept this we need a closure type at param position — the IR has a
closure-ref ABI already in use for Slice 3 nested funcs / arrow-init binds.
The selector just doesn't recognise the type node.

## Proposed sub-issues

Implementation specs follow the architect template — one issue per
concrete fix.

### Issue: `ir-host-global-receivers` — accept `document` / `performance` / `console` / `window` as Phase-1 receivers

**Root cause**: `isPhase1Expr` rejects property access on host globals because
the receiver fails the in-scope check. Mirror the Math whitelist pattern.

**Files**

- `src/ir/select.ts`
  - `isPhase1Expr` PropertyAccess branch (line 1649): before recursing into
    `expr.expression`, accept the receiver if it is an `Identifier` whose
    text is in a new `IR_HOST_GLOBAL_WHITELIST` (`document`, `performance`,
    `console`, `window`, `JSON`).
  - `buildLocalCallGraph` PropertyAccessExpression branch (line 1917):
    when the receiver is a whitelisted host global, do NOT mark as external
    AND do NOT walk into the receiver. Mirror the Math-unary special case
    (line 1932-1939).
  - Add `IR_HOST_GLOBAL_WHITELIST` set near `IR_MATH_UNARY_WHITELIST`
    (line 117).
- `src/ir/from-ast.ts`
  - Wire lowering of `<host-global>.<method>(...)` to a host import call
    (existing `compileExternCall` / `getHostMethod` infrastructure; the
    legacy path already routes DOM calls via the same imports).

**Edge cases**

- `Math.<binary>` (e.g. `Math.pow`, `Math.atan2`) — out of this issue's
  scope; needs a separate `IR_MATH_BINARY_WHITELIST` since lowering must
  emit a host import. Tracked separately.
- `document.body` returns `HTMLElement`; the selector accepts the chain
  shape but the lowerer must coerce the result to an `externref` / object
  IR type. The existing class-instance return path covers this.
- `console.log(...)` returns `void`. Must be accepted only in
  `ExpressionStatement` (drop-result) or in a `void`-returning function's
  tail.

**Estimated bucket reduction**: 15 body-shape rejections + retroactively
unblocks 6 call-graph-closure rejections via the closure walk → ~21.

---

### Issue: `ir-vec-new-fixed` — accept array-literal initializers

**Root cause**: `ArrayLiteralExpression` is rejected in `isPhase1Expr` because
the IR lacks a `vec.new_fixed` instr. The deferral is documented at
src/ir/select.ts:1674-1677 and references this issue.

**Files**

- `src/ir/nodes.ts`
  - Add `vec.new_fixed` `IrInstr` variant with `elemType: IrType` and
    `elements: IrInstr[]`.
- `src/ir/from-ast.ts`
  - In the expression dispatch (look for the `isElementAccessExpression`
    arm — array-literal sits next to it conceptually): lower
    `ArrayLiteralExpression` by lowering each element and wrapping in
    `vec.new_fixed`.
  - Reject nested `SpreadElement` and `OmittedExpression` — defer those.
- `src/ir/select.ts`
  - `isPhase1Expr` (line ~1693): add `ArrayLiteralExpression` branch that
    accepts when every element is itself Phase-1 and no element is a
    `SpreadElement`/`OmittedExpression`.
- `src/ir/lower.ts` (or wherever `IrInstr` → Wasm lowering lives)
  - Translate `vec.new_fixed` to the existing `vec.new + vec.push` sequence
    used by the legacy `compileArrayLiteral` path. (Look for the
    `__vec_*` runtime imports; the lowered sequence is `vec.new(len)`
    followed by `vec.set(i, val)` per element — no host import beyond the
    existing vec ones.)

**Edge cases**

- Empty `[]` — element type can't be inferred from contents; fall back to
  the TS-declared type annotation (`const arr: number[] = []` carries
  `f64` element type). When neither contents nor declared type pin it
  down, return `null` from the lowerer (clean fallback to legacy).
- Mixed element types — defer; selector requires all elements lower to
  the same `IrType`.
- Lateral aliasing into `for (let i = 0; i < arr.length; i++) arr[i]` —
  already supported by Slice 12 element access on vec receivers.

**Estimated bucket reduction**: 4 body-shape + retroactively unblocks more
call-graph-closure rejections (`fdow` → `dimOf`).

---

### Issue: `ir-arrow-arg-expression` — accept arrow functions as call arguments

**Root cause**: `isPhase1Expr` only accepts arrow / function-expression literals
via the `const`-bound initializer path. Direct use in an argument expression
falls through.

**Files**

- `src/ir/select.ts`
  - `isPhase1Expr` (line ~1693, before the final `return false`):
    add an `ArrowFunction | FunctionExpression` branch that delegates to
    `isPhase1ClosureLiteral` (line 1361). Pass the current scope through.
- `src/ir/from-ast.ts`
  - In the expression dispatch, lower the anonymous closure by:
    1. Synthesising a unique name (`<caller>$arrow<N>`) for the closure
       function record;
    2. Reusing the existing Slice-3 closure-lift path to emit the closure
       function;
    3. Producing a `ref.func`-style instr to push the closure value onto
       the operand stack.

**Edge cases**

- Closure captures outer params/locals — Slice 3 already supports this
  via ref-cell rewriting. Need to thread the existing capture-set builder
  into the new entry point.
- `this` capture inside an arrow — Slice 3 closures don't capture `this`
  (arrow's `this` is the enclosing function's `this`). For top-level
  function arguments (non-method context) there is no `this` to capture;
  for method arguments (`isMethod=true` outer) — defer to a follow-up.
- Type compatibility with the receiving param — if the callee's param is
  `FunctionTypeNode`, lowering must match the synthesised closure's
  signature. Bundled with `ir-func-param-type` below.

**Estimated bucket reduction**: 3 body-shape rejections in `main`-style
event-handler-heavy functions.

---

### Issue: `ir-func-param-type` — accept `FunctionTypeNode` as a param type

**Root cause**: `resolveParamType` (src/ir/select.ts:612) does not list
`FunctionTypeNode`. The IR has a closure ABI but the selector won't
admit a function-typed param.

**Files**

- `src/ir/select.ts`
  - `resolveParamType` (line 612): add a `ts.isFunctionTypeNode(p.type)`
    branch returning a new `ResolvedKind = "closure"`.
  - Extend `ResolvedKind` type (line 610) to include `"closure"`.
  - `resolveReturnType` (line 648): mirror the same branch.
- `src/codegen/index.ts` (or wherever `resolvePositionType` lives — see
  comment chain at select.ts:629-633)
  - Map `FunctionTypeNode` → IR closure ref type. The shape mirrors the
    closure record produced by the Slice-3 closure-literal lowerer.
- `src/ir/from-ast.ts`
  - When a function-typed param is invoked (`fn(...args)` where `fn` is
    a param), lower as a call through the closure-ref ABI (existing).

**Edge cases**

- Multi-arity function types — match the IR closure ABI's vararg model
  (uniform externref args, or fixed-arity specialisation per call site).
- Polymorphic / overloaded function types — out of scope, return null.
- Higher-order returns (`(x: number) => () => number`) — out of scope.

**Estimated bucket reduction**: 1 direct (`addBenchCard`) + retroactively
unblocks `bcrd` (call-graph-closure) once `el` is claimed by the
host-globals issue.

---

### Issue: `ir-body-shape-telemetry-refine` — granular body-shape rejection reasons

**Root cause**: `body-shape-rejected` is a single coarse bucket. There is
no signal in the telemetry indicating WHICH inner shape rejected, which
makes prioritising future slices guesswork. The selector currently
returns boolean from `isPhase1StatementList`, `isPhase1Expr`, etc.

**Files**

- `src/ir/select.ts`
  - Introduce a `WhyNotPhase1` sum-type:
    ```
    type WhyNotPhase1 =
      | "ok"
      | "host-global-receiver"
      | "array-literal"
      | "arrow-as-arg"
      | "destructuring-in-let"
      | "missing-init"
      | "unsupported-binop"
      | …;
    ```
  - Add `whyNotPhase1Expr(...)`, `whyNotPhase1StatementList(...)`, etc.
    that mirror their boolean counterparts but return the granular reason.
  - In `whyNotIrClaimable`, replace `if (!isPhase1StatementList(...))
    return "body-shape-rejected"` with the reason returned from
    `whyNotPhase1StatementList`.
- `scripts/check-ir-fallbacks.ts`
  - Add new buckets to the `UNINTENDED` set so each is gated
    independently.
- `scripts/ir-fallback-baseline.json`
  - Refresh after the change lands so each new bucket has a real count.

**Edge cases**

- Backwards compatibility: keep `body-shape-rejected` as a catch-all for
  any future shape rejection not yet sub-bucketed.
- Telemetry can fire multiple reasons (a body that has both an array
  literal and a host-global receiver). Convention: first-failure wins
  (depth-first early return).

**Estimated bucket reduction**: 0 direct (it's diagnostic, not a fix);
but enables data-driven prioritisation of the next slice.

## Recommended order

1. `ir-host-global-receivers` — biggest single bucket reduction (~21).
   Pure additive: doesn't change any IR ABI.
2. `ir-vec-new-fixed` — needs a new IR instr but the runtime ABI exists.
3. `ir-arrow-arg-expression` + `ir-func-param-type` — best landed
   together (one unlocks the other for `addBenchCard` + its callers).
4. `ir-body-shape-telemetry-refine` — quality-of-life; do once the above
   land so we can measure the next layer of the onion.

After all four: expected unintended bucket counts ≈ 0 (modulo a small
residue in the unlikely-corner-case body shapes).

## Risks / open questions

- Host-global whitelist drift: each new whitelisted host global is an
  implicit contract with the runtime imports. Coordinate with whoever
  owns `src/codegen/index.ts:registerBuiltinExternClasses` to ensure
  the IR-claimed surface stays a subset of the legacy-supported surface.
- `vec.new_fixed` element-type inference: an empty `[]` literal without
  a TS annotation has no element type. We must NOT silently default to
  externref — that would change array runtime representation for
  existing tests. Defer to legacy when type can't be pinned down.
- The playground corpus is small (10 files). The IR-fallback gate
  measures *that* corpus only. A real conformance check (test262)
  may surface additional sub-shapes once these are retired.
