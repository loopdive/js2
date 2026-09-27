---
id: 6693
title: "standalone: a class method called with FEWER arguments than it declares, through an untyped receiver, throws `called value is not a function` — marked's Parser (`this.parser.parseInline(e)`)"
status: done
completed: 2026-09-26
sprint: Backlog
created: 2026-09-26
updated: 2026-09-26
loc-budget-allow:
  # 2026-09-26 (#6693): +~10 lines in collectMethodEntries/buildEntryArm to
  # route the new standalone arity admission; the logic itself lives in
  # zero-arg-method-pad.ts.
  - src/codegen/closed-method-dispatch.ts
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: compiler
goal: standalone
related: [3507, 6672, 6677]
---

# #6693 — method call with fewer args than params, untyped receiver

## Problem

Found by [#6677](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6677-standalone-runtime-regexp-compiler-full-grammar),
which moved marked's npm-compat **standalone-dynamic** lane past
`TypeError: Unsupported dynamic regular expression pattern`. The lane now fails
at the checksum call with:

```
TypeError: called value is not a function
```

Narrowed on marked 18 compiled standalone: `Lexer.lex("a")` is correct (one
`paragraph` token whose inline tokens match Node), `new Parser().parseInline(tokens)`
is correct, but `renderer.paragraph(token)` throws. `Renderer.paragraph` is
`` paragraph({tokens:e}){return`<p>${this.parser.parseInline(e)}</p>\n`} `` and
`Parser.parseInline` is declared `parseInline(e, t = this.renderer)` — TWO
parameters, called with ONE argument through `this.parser`, a class field whose
static type is erased.

Minimal repro (untyped `.js`, `target: "standalone"`; Node answers `1`):

```js
var R = class { p; go(e) { return this.p.inl(e); } };
var P = class { r; constructor() { this.r = new R(); this.r.p = this; } inl(e, t) { return "n" + e.length; } };
export function test() { try { return new P().r.go([1, 2]) === "n2" ? 1 : 0; } catch (e) { return -1; } }
// standalone: -1 (TypeError: called value is not a function)
```

The same call with both arguments (`this.p.inl(e, 0)`) answers `1`, and so does
a one-parameter method. A free function receiving the object
(`function go(o, e) { return o.inl(e); }`) fails the same way, so the defect is
the arity match in the untyped method-call dispatch (`__call_m_<name>_<argc>`,
#3507), not the class field.

## Acceptance criteria

- The repro answers 1 under `--target standalone`, and a call with MORE
  arguments than parameters keeps working (extra arguments are evaluated and
  dropped, §10.2.1).
- marked's standalone-dynamic lane moves past `called value is not a function`.

## Implementation Plan

1. `collectMethodEntries` (src/codegen/closed-method-dispatch.ts): keep the
   existing admission test (argc covers every formal without a `?`/constant
   default, f64 expression defaults via the sentinel) byte-for-byte; when it
   rejects an entry, ask a new standalone-only helper instead of dropping it.
2. `standaloneDispatchArityPads` (src/codegen/zero-arg-method-pad.ts): JS call
   arity (§10.2.1). Over-application → admit with no pads (the arm pushes only
   the declared formals; the extra arguments were already evaluated at the call
   site). Under-application → one `undefined` stand-in per omitted formal,
   matching what the callee prologue tests (`emitParamDefaultCheckInline`):
   canonical `undefined` for `externref`, `ref.null` for a nullable ref, the f64
   absence sentinel for `f64`, `0` for an undefaulted `i32`. Declines (entry
   stays out, as before) for methods reading `arguments`, a rest formal that is
   omitted or over-applied, a non-nullable ref, and `i32`/`anyref` expression
   defaults (their prologue needs the caller's argc).
3. `buildEntryArm`: a stored pad wins over the legacy missing-arg synthesis.
4. JS-host / wasi: the helper returns `null` off standalone, so every other
   lane keeps its bytes.

## Resolution

Root cause: `__call_m_inl_1` had no arm for `inl(e, t)` (2 formals, `t`
unmarked or with a non-f64 expression default), so the call fell to the
open-`$Object` fallback `__extern_method_call`, which finds no callable `inl`
on a class struct and throws `called value is not a function`. Fixed as
planned above.

- Regression test `tests/issue-6693-standalone-dispatch-js-arity.test.ts`:
  5/5 fail on the parent tree (file-copy revert of both source files), 5/5
  pass with the fix. Covers the repro, marked's class-typed expression default,
  `undefined` reads (externref and f64 formals), over-application with
  side-effecting extras, and object-literal methods.
- marked npm-compat `standalone-dynamic` lane: before `runtime-error` at the
  checksum phase, `TypeError: called value is not a function`; after
  `measured`, checksum 75 = 75, 0 imports (ratio 0.0019 — the wasm samples
  grow monotonically across rounds, 856 → 6396 µs, a perf residual, not a
  correctness blocker).
- Scoped standalone test262 (945 files: `language/expressions/{call,super,object/method-definition}`,
  `language/statements/class/{definition,subclass,super}`, `language/arguments-object`,
  `language/rest-parameters`): parent 700 pass / 178 fail / 67 CE, fix 700 / 178 / 67 —
  identical non-pass sets, no losses.
- `tests/issue-2151-mixed-spread.test.ts` pinned `o.m(5, ...[])` against
  `m(a, b) { return a * 10 + b }` at 50 (`b` read as 0). With JS arity it is
  `50 + undefined` = NaN, which is Node's answer; the expectation now says so.
- JS-host control: marked dogfood 16/30 (unchanged).
