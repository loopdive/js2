---
id: 1697
title: "static method `this.X = v` write not routed to staticProps global — public + private (asymmetric with read path)"
status: done
created: 2026-05-28
updated: 2026-05-28
completed: 2026-05-28
priority: medium
feasibility: easy
reasoning_effort: low
task_type: bugfix
area: codegen
language_feature: classes, private-methods, static
goal: spec-completeness
sprint: Backlog
test262_fail: 12
related: [1680, 1681, 1683-brand, 1693]
---
# #1697 — `this.X = v` in static method body silently drops write

## Problem

Inside a `static` method body, an assignment of the form
`this.publicField = v` or `this.#privateField = v` **does not write
through to the static-prop backing global**. The read path
(property-access.ts:1427-1453) already handles `ThisKeyword` in a static
context by resolving the enclosing class and reading
`ctx.staticProps.get(...)`. The symmetric write arm in
`src/codegen/expressions/assignment.ts` is missing — only the
`Identifier + ClassSet` arm at L2010 handles `C.X = v` writes, not the
`ThisKeyword + isStaticContext` shape.

## Confirmed root cause

Probe results (`.tmp/probes-1697/probe-1697g.mjs`):

| Shape | Result | Path taken |
|---|---|---|
| `C.publicField = v` from static method | ✅ 42 | identifier-classSet arm L2010 |
| `C.#privField = v` from static method | ✅ 42 | identifier-classSet arm L2010 |
| `this.publicField = v` from static method | ❌ 5 | falls through to generic struct write |
| `this.#privField = v` from static method | ❌ 5 | same generic fallthrough |

The reads work because property-access.ts:1427 has a
`ThisKeyword && (localMap.get("this") === undefined || isStaticContext)`
arm that resolves the enclosing class. The write side has no analogous
arm — the LHS expression is `ThisKeyword` and the generic struct-write
fallthrough either drops the value (when `this` is `null`/undefined) or
emits a no-op cast.

## Acceptance criteria

1. `class C { static #x: number = 0; static doIt() { this.#x = 42; return this.#x; } }`
   → `C.doIt()` returns `42`.
2. Same with public static field (`static x = 0`).
3. Same with `this.#x = v` inside a static method calling another static private method.
4. Test262 cluster:
   - `language/expressions/class/elements/after-same-line-method-static-private-methods-with-fields.js`
   - `language/expressions/class/elements/regular-definitions-static-private-methods-with-fields.js`
   - `language/expressions/class/elements/same-line-gen-static-private-methods-with-fields.js`
   - plus ~10 sibling templates from the same generator
5. `tests/issue-1697.test.ts` covering the probe shapes.

## Investigation findings

The team-lead's prompt sketched the candidate as ~12 private-method
fails. Ran the cluster
`language/expressions/class/elements/.*private-method.*` against
`.test262-cache/test262-current.jsonl` (2026-05-28 baseline). Actual
size: **50 fails**, decomposing into:

| Sub-cluster | Count | Root cause |
|---|---|---|
| `this.#X = v` / `this.X = v` static-method write missing | ~12-15 | **THIS ISSUE (#1697)** |
| `verifyProperty` descriptor-attribute mismatch | ~8 | #1629 (descriptor model) |
| `Reflect.has called on non-object` in async-priv | ~5 | #1665 (generator/async-gen gap) |
| yield-spread / yield-promise in gen-priv | ~10 | #1665 (generator gap) |
| Brand check on subclass receiver `D.f()` | ~4 | #1683-brand (done investigation) |
| `extern.convert_any[0]` wasm validation | ~3 | #1693 (funcref dispatch) |
| Nested-class private-method `extends` scoping | ~3 | separate (low priority) |
| `Symbol value to number` yield-star | ~2 | #1665 |
| `call is not a function` codegen | ~1 | separate (look at #1693) |

Only the first sub-cluster is a clean localized fix. The rest already
have owners or need separate carving.

## Implementation plan

Mirror the read path's `ThisKeyword + isStaticContext` arm in
`src/codegen/expressions/assignment.ts`, just before the existing
identifier-classSet arm at L2010. Resolve the enclosing class via
`fctx.enclosingClassName` first, then fall back to the underscore-prefix
scan against `ctx.classSet` (the exact dance from
property-access.ts:1435-1445). When matched, lookup
`ctx.staticProps.get(\`\${enclosing}_\${propName}\`)` and emit
`local.tee + global.set + local.get` exactly like the identifier-classSet
arm.

For private names, prefix the propName with `__priv_` (matching how
identifier-classSet arm at L2012 already does it).

Should be ~20 LOC and a single function-internal change. No
cross-cutting impact: gated on `expr.expression.kind === ThisKeyword`
**and** `(localMap.get("this") === undefined || isStaticContext)` — which
is exactly the read-path gate, provably never fires on instance method
bodies.

## Files to modify

- `src/codegen/expressions/assignment.ts` — add `this`-arm mirroring L2010
- `tests/issue-1697.test.ts` — new

## Probe (saved in `.tmp/probes-1697/`)

`probe-1697g.mjs` reproduces the four shapes above (`C.publicField`,
`C.#privField`, `this.publicField`, `this.#privField`).
