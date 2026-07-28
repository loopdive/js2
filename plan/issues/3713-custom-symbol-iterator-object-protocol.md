---
id: 3713
title: "Nested object-literal-method closure over an enclosing method's local reads the default value, not the captured one (surfaced via custom Symbol.iterator)"
status: ready
sprint: current
created: 2026-07-27
updated: 2026-07-27
priority: high
horizon: l
feasibility: hard
task_type: bugfix
area: codegen
language_feature: closures
goal: iterator-protocol
origin: "#3690 — new tests/differential/corpus/builtins/19-symbol-iterator.js surfaced this on first run"
related: [3690]
---

# #3713 — Nested object-literal-method closures over an enclosing method's local silently read the default value

## Original repro (via #3690)

```js
const range = {
  from: 1,
  to: 3,
  [Symbol.iterator]() {
    let current = this.from;
    const last = this.to;
    return {
      next() {
        return current <= last ? { value: current++, done: false } : { value: undefined, done: true };
      },
    };
  },
};
console.log([...range].join(","));   // V8: "1,2,3", js2wasm: ""
let total = 0;
for (const n of range) total += n;
console.log(total);                  // V8: 6, js2wasm: 0
```

## Investigation (2026-07-27) — narrowed far past the original "Symbol.iterator" framing

Started by tracing the actual runtime values crossing the `__iterator`
host-import boundary (`src/runtime.ts`) with instrumented imports. This
ruled out the original hypothesis ("`__iterator` receives an empty
placeholder instead of `range`"): `range` **does** cross correctly as an
opaque wrapped WasmGC struct (`[Object: null prototype] {}` is just how
Node's console renders that — `Object.keys`/`obj[Symbol.iterator]` return
nothing because plain JS reflection can't see into an opaque externref,
not because the struct itself is empty). Compiled exports like
`__call_@@iterator` (a purpose-built accessor for exactly this case) DO
correctly find and invoke the object literal's `[Symbol.iterator]()`
method on the real struct.

Manually driving the chain (`__call_@@iterator` → `__sget_next` →
`__call_fn_0` → `__sget_value`/`__sget_done`) narrowed the actual defect
to one field: `{value: current++, done: false}`'s `done` comes back
correct (`false`); `value` comes back `0` instead of `1`.

**This has nothing to do with `Symbol.iterator`, computed keys, or
iterators at all.** Isolated to a minimal repro with none of those:

```js
const range = {
  makeIter() {
    const current = 42;
    return {
      next() {
        return current;
      },
    };
  },
};
range.makeIter().next(); // V8: 42, js2wasm: 0
```

Systematically bisected which shape triggers it:

| shape | result |
| --- | --- |
| standalone function → nested object-literal method closes over outer `let` | **42 (works)** |
| object-literal method → nested ARROW function closes over outer `let` | **42 (works)** |
| object-literal method → nested object-literal method closes over outer `let`/`const` | **0 (broken)** |
| object-literal method, no nested closure at all | **42 (works, sanity check)** |

The trigger is specifically: **an object-literal method-shorthand
(`next() {...}`, not an arrow) nested inside the return value of ANOTHER
object-literal method, closing over the outer method's local.**

## Root cause, precisely — cross-invocation state leak in capture promotion

`src/codegen/literals.ts`'s `compileObjectLiteralForStruct` calls
`promoteAccessorCapturesToGlobals` (`src/codegen/closures.ts`) once per
object-literal method to promote any enclosing-scope locals the method's
body references into module globals (object-literal methods are compiled
as free-standing Wasm functions, not true closures, so a captured local
has to become a global the method function can read).

Direct instrumentation (`console.error` at entry/exit of the promotion
call, comparing `fctx.body.length` before/after) proved
`compileObjectLiteralForStruct` runs **twice** for the exact same object
literal in this repro shape. First run: `capturedGlobals.has("current")`
is `false`, so the promotion correctly emits `local.get 1; global.set 8`
(copying `current`'s actual runtime value into the new global) — `fctx.body.length`
grows 8 → 12. Second run: `capturedGlobals.has("current")` is
now **`true`** (leftover from the first run — `ctx.capturedGlobals` was
never reset between the two invocations), so the promotion loop's own
`if (ctx.capturedGlobals.has(name)) continue;` guard (correctly meant to
avoid double-registering the SAME global) skips re-emitting the
value-copy too — `fctx.body.length` stays at 8, **unchanged**. Whichever
compiled function actually ships is the one missing the copy instruction,
so the promoted global keeps its bare default init (`f64.const 0`) forever
— reads as `0`, matching the observed symptom exactly.

Traced the "why compiled twice" one level further: it is **not** the
struct's placeholder-method pre-registration pass (`src/codegen/index.ts`
~line 7159, "Pre-register placeholder functions for callable properties")
— that pass only stubs empty function bodies into `funcMap` for
forward-reference resolution; it never calls
`compileObjectLiteralForStruct` or touches `capturedGlobals`. The actual
second invocation site is still unidentified — `generateModule` only
calls into codegen once from `compiler.ts`, so the duplicate call must
originate somewhere inside a deeper codegen path (possibly the two-pass
front-end architecture — direct-AST vs IR, `docs/architecture/codegen-axes.md`
— re-attempting the same literal, or a legitimate "sibling literal /
per-literal-fork" re-entry per the `#1557` comments in the same file that
did NOT reset shared promotion state this time).

**Not fixed here.** This is architecturally significant, not a local
patch:
- The trigger site (why the object literal compiles twice) needs
  identifying before a fix can be scoped — reset-on-every-call would be
  wrong if OTHER call sites intentionally rely on `capturedGlobals`
  surviving across sibling-literal forks (the `#1557` per-literal-funcIdx
  mechanism in the same file suggests exactly that kind of intentional
  sharing exists elsewhere).
- A correct fix likely needs the promotion to distinguish "already
  promoted AND already copied for THIS specific compiled function" from
  "already promoted for a DIFFERENT invocation of the same literal" —
  more than a one-line change.
- Blast radius unknown: any object-literal method returning a nested
  object-literal method that closes over the outer method's state could
  be affected (not just iterators) — worth a broader test sweep once a
  fix is scoped, not something to guess-patch under time pressure.

## Acceptance criteria (for whoever picks this up)

- [ ] `range.makeIter().next()` (the minimal repro above) returns `42`.
- [ ] The original `Symbol.iterator` repro matches V8: `"1,2,3"` / `6`.
- [ ] `private-fields/05-brand-checks.js`... n/a (unrelated); re-run the
      #3690 differential corpus and confirm `builtins/19-symbol-iterator.js`
      now matches.
- [ ] Identify and document why `compileObjectLiteralForStruct` runs twice
      for this shape, and whether that's by design (then the fix is in
      state isolation) or a separate bug (then fix the double-compile
      itself).
