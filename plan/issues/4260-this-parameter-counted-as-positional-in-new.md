---
id: 4260
title: "A TypeScript `this` parameter is counted as positional under `new`, shifting every constructor argument"
status: ready
created: 2026-08-09
priority: high
horizon: m
feasibility: medium
area: codegen
goal: core-semantics
related: [3617, 4258, 4253]
---

## Summary

`function C(this: any, v: any) { this.x = v; }` compiled standalone, then
`new C(1)`, leaves `x` **undefined** instead of `1`. Every argument is shifted
by one, because the TypeScript **this-parameter** — a type annotation that is
erased at emit and is *not* a runtime parameter — is being treated as
positional on the `new` path.

Silent wrong answer: no diagnostic, no trap, just the wrong value.

## Evidence

Measured on `upstream/main` @ `6a16f225c`, `target: "standalone"`:

| source | expected | got |
| --- | ---: | ---: |
| `function C(this: any, v: any){this.x=v}` → `new C(1).x` | `1` | **NaN** |
| `function C(v: any){this.x=v}` → `new C(1).x` (no this-param) | `1` | `1` ✓ |
| `function C(this: any, v, w){this.x=v;this.y=w}` → `x*10+y` | `12` | **NaN** |
| `function C(this: any, v, w){…}` → read `.y` alone | `2` | **NaN** |
| `function C(this: any, m: any){this.m=m}` → `new C("hi").m === "hi"` | `1` | **0** |
| `function C(this: any){this.x=1}` → `new C().x` (no value param) | `1` | `1` ✓ |

The pattern is exactly an off-by-one in the argument list: with no value
parameter there is nothing to shift and the result is correct; with one or two,
everything lands one slot late and the last parameter reads `undefined`.

## Why it is scoped, not wholesale

The codebase already knows this-parameters must be skipped, and filters them in
at least five places:

- `src/codegen/object-ops.ts:1736`
- `src/codegen/closure-receiver-install.ts:136`
- `src/codegen/expressions/calls.ts:1962` and `:5088`
- `src/codegen/named-this-call.ts:305`
- `src/ir/module-bindings.ts:1623`

So this is a **missing filter on one path** (constructor invocation / fnctor
field derivation), not an unimplemented concept. That should make the fix small;
what needs care is finding every arity-consuming site on that path rather than
patching the first one.

## Why nobody noticed

`tests/issue-3617.test.ts` uses this exact idiom in its own harness
(`function DummyError(this: any, message: any) { this.message = message; }`)
and passes — because every assertion in it is about **identity and
enumerability**, never about the field's VALUE. `this.message = message`
creates the `message` field either way; it just holds `undefined`. A suite can
exercise a broken shape continuously and stay green if it never looks at the
one thing that is wrong.

That is the same shape as #4253's other exhibits: the defect was reachable, it
was even *exercised*, and nothing asked the question that would have failed.

## Acceptance criteria

- [ ] Every row of the table above answers the JS value.
- [ ] A this-parameter is skipped consistently on the `new` path — arity checks,
      argument binding, and any ctor-param inference keyed on parameter INDEX
      (`param-return-inference.ts` indexes `fn.parameters` directly; confirm it
      agrees, since #743/#4250 consume those indices).
- [ ] A pin that reads the VALUE, not just the field's existence — the gap that
      let #3617 stay green over a broken fixture.
- [ ] Check the same shape for a plain call (`C.call(obj, 1)`) and for a method
      with a this-parameter, not only `new`.

## Notes

- Found while probing whether #4250's slot lever could compound #4258. It
  cannot — but the probe fixture used the `this: any` idiom, and the anomalous
  result led here. Recording the provenance because the finding was incidental
  to a negative result, which is where these tend to hide.
- Interaction to check when fixing: `param-return-inference.ts` and the #743
  satellite both key facts by `fn.parameters.indexOf(...)`. If the runtime
  binding skips the this-parameter but the inference does not, the two disagree
  about which parameter is which — a fact attached to the wrong slot is worse
  than no fact.
