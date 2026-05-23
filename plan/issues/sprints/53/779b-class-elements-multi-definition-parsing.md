---
id: 779b
title: "class/elements same-line / semicolon multi-definition parsing"
status: done
sprint: 53
created: 2026-05-21
updated: 2026-05-21
priority: high
feasibility: medium
reasoning_effort: medium
goal: property-model
parent: 779
es_edition: ES2022
language_feature: class-elements-parsing
task_type: bug
test262_fail: 290
---

# #779b — class/elements same-line / semicolon multi-definition parsing

## Problem

~290 test262 fails under `language/{statements,expressions}/class/elements`
trace to a single class-body parsing/emission bug: consecutive class members
declared on the same line or separated by `;` are silently dropped or
re-ordered. The failure surface is `verifyProperty(C.prototype, "m", { ... })`
returning `undefined` because the second method is missing from the prototype.
The five name-prefix groups all point at the same root cause:

| Group | Count |
|-------|-------|
| `after-same-line` | 90 |
| `multiple-stacked-definitions` | 79 |
| `multiple-definitions-rs` | 54 |
| `new-sc-line` | 46 |
| `wrapped-in-sc` | 22 |

Expected: every textual class member emits its own `[[DefineOwnProperty]]`
step on the class or its prototype. Actual: subsequent members on the same
line / after a `;` are not emitted.

## ECMAScript spec reference

- §15.7.10 ClassDefinitionEvaluation — Step 27 iterates `ClassElementList`
  in source order and calls ClassDefinitionEvaluation on each element.
- §15.7.11 ClassElementEvaluation — each element calls
  `DefineMethod` / `MethodDefinitionEvaluation` independently.

The spec is explicit that empty class-elements (`;`) are no-ops and do not
affect the surrounding members. The grammar treats `ClassBody : ClassElementList`
where `ClassElementList` is left-recursive over the production
`ClassElement` and `ClassElement : ;`.

## Files to change

- `src/codegen/index.ts` — class-body emission walk. Inspect the loop that
  iterates `ClassDeclaration.members` / `ClassExpression.members`. Suspect:
  (a) early-exit / break on encountering an `EmptyStatement`-like `;`
  element; (b) coalescing two members that share a source line into a single
  emit slot; (c) iteration that uses `node.body[i]` indexing but advances by
  more than one when a same-line pair is seen.
- Verify against TypeScript's AST — `ts.SyntaxKind.SemicolonClassElement`
  should round-trip through the iteration without skipping the next sibling.

## Acceptance criteria

- [ ] `verifyProperty(C.prototype, "m", { enumerable: false, configurable: true })` passes for class methods defined on the same line as another method.
- [ ] All 5 name-prefix groups (`after-same-line`, `multiple-stacked-definitions`, `multiple-definitions-rs`, `new-sc-line`, `wrapped-in-sc`) collapse: net test262 pass increase ≥ +230 (target ~290).
- [ ] Both `language/statements/class/elements/**` and `language/expressions/class/elements/**` improve symmetrically.
- [ ] No regression in single-member class tests or existing decorator / static-block tests.

## Investigation findings (2026-05-21, dev-779b)

The original problem statement above is **incorrect**. Members are NOT being
silently dropped or reordered. Direct probes confirm:

```ts
class C { *m() { return 42; } a; b = 42; c = fn; }
const c = new C();
typeof C.prototype.m === "function"  // → true
c.b === 42                           // → true
c.a === undefined                    // → true (field present, default value)
```

So all 3 elements (generator method + 2 fields) emit correctly. The class-body
loop in `src/codegen/class-bodies.ts` iterates `decl.members` once, handles
`SemicolonClassElement` via the standard TS AST (which excludes them from
`decl.members` already — TS lexes `;` as a no-op `SemicolonClassElement` node
that the existing `for (const member of decl.members)` walks past harmlessly).

The actual root cause of all 5 name-prefix groups is **instance method lookup
does not walk the prototype chain**. The failing assert in every group is:

```js
assert.sameValue(c.m, C.prototype.m);   // assert #3, fails with c.m === undefined
```

- `C.prototype.m` returns a bridge `Function` via `_prototypeMethodBridges`
  (runtime.ts:1220, gated by `__register_prototype`).
- `c.m` returns `undefined`: the instance Proxy's `get` trap (runtime.ts:1386)
  walks struct fields + sidecar + `__sget_*` exports only; methods aren't there.
- The Proxy's `getPrototypeOf` returns `Object.prototype` (runtime.ts:1500),
  so JS native lookup does not fall through to the registered class prototype.

This is exactly the case the existing comment at runtime.ts:1218 calls out
as deferred to **#1364b**:

> JS-side method invocation through this bridge (`C.prototype.m.call(c)`)
> needs richer dispatch deferred to a follow-up.

### Recommended fix path

1. **Codegen** — emit a `__register_instance_prototype(struct, proto)` call
   in the class constructor that maps each struct ref to its class prototype.
2. **Runtime** — `_wrapForHost`'s `getPrototypeOf` trap returns the registered
   class prototype (instead of `Object.prototype`), so V8 walks the chain
   on `c.m` and finds `C.prototype.m` via the bridge.
3. **Runtime** — bridges need to actually invoke the corresponding wasm
   method (currently they throw — see `classMethodBridge` at runtime.ts:1230)
   so subsequent calls like `c.m()` after the identity check still work.

Estimated scope: ~50-100 LOC across `src/codegen/class-bodies.ts` and
`src/runtime.ts`. Touches host-import surface, descriptor invariants, and
ownKeys enumeration — needs architect spec because changing `getPrototypeOf`
will affect `Object.getPrototypeOf(c)`, `instanceof`, `hasOwnProperty`,
and `for...in` semantics for every class instance.

**Status**: bumped back from dev to architect — not a parsing bug.
