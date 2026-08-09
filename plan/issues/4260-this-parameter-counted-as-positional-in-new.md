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

## THE HAZARD IS AT FIX TIME — read this before touching the emit path

Contributed by `fable-743-fixpoint` (#4250 lane), who ran the check against the
#743/#4250 inference surfaces. **There are no mis-attached facts today**, and
the reason is the trap:

> Both inference lanes use the SAME this-inclusive positional mapping as the
> buggy runtime `new` binding. The satellite maps `argExprs[i] →
> fn.parameters[i]` (this-param included); the legacy call-site scan and the
> consumer's `fn.parameters.indexOf(decl)` are this-inclusive the same way; and
> the runtime ALSO binds arguments positionally counting the this-slot.
> **Three agreeing off-by-ones = facts attach to exactly the parameter slots
> the runtime actually fills.**

Probe (`function C(this: any, v: any)`, sites `new C(1,"s")` / `new C(2,"t")`):
satellite `C(dynamic, dynamic)`, slot `x` stays externref, runtime `x = "t"` —
the bug reproduced, with the fact-attachment still self-consistent.

**So whoever fixes the runtime `new` path MUST fix the inference lanes in the
same change** — `param-return-inference.ts`'s call-site arg↔index mapping, and
the satellite's `runFixpoint`/`buildScope`/`paramInfo` in
`src/ir/fnctor-method-edges.ts` plus `fnctor-receiver-provenance.ts`. Otherwise
the current benign three-way agreement becomes a one-slot-stale
**disagreement** — a fact attached to the wrong parameter, which is worse than
no fact, in exactly the code the fix was meant to help.

A fixing PR that touches only the emit path **will be green everywhere**, because
the fixtures that would catch it do not exist yet.

### Refinement: there are TWO indexing conventions, and they already disagree

Verified against the TypeScript API on 2026-08-09 — the "three agreeing
off-by-ones" argument holds for **AST-based** indexing only:

```
node.parameters      for  function C(this: any, v: any, w: any)
                     ->  [this, v, w]     indexOf(v) = 1   THIS-INCLUSIVE
checker signature    ->  [v, w]           indexOf(v) = 0   THIS-EXCLUSIVE
                         (length 2 vs the node's 3)
```

So a consumer reading `signature.parameters` is **already** one slot off from
the runtime binding, today, independent of any fix. Whether that bites depends
on which convention each site uses — `inferFnctorFieldTypeFromCtorParam` and
`dtsSeedForParam` both index `fn.parameters` (AST, consistent), but this must be
checked site by site rather than assumed uniform.

The practical consequence for the fix: **do not "skip index 0 everywhere".**
Half the sites never counted the this-parameter to begin with, and shifting
those breaks what currently works. Each site has to be classified as
AST-indexed or signature-indexed first.

### Classification inventory

**Signature-indexed (this-EXCLUSIVE) — must NOT be shifted:**

- `resolveGenericCallSiteTypes` (`param-return-inference.ts:27`) — calls
  `getResolvedSignature(node)` and builds the entire wasm param list from
  `sig.getParameters()`. Located by `fable-743-fixpoint`, who flagged it for
  the inventory without a repro.

  **Probed 2026-08-09 — reachable, and it already fails today:**

  | source | result |
  | --- | --- |
  | `function f<T>(this: any, v: T): T` → `f(7)` | **compile error** — *"stack-balance invariant (entry): 'f' references local 1, but only 1 params + 0 locals are declared"* |
  | `function f<T>(this: any, a: T, b: T): T` → `f(1,2)` | **compile error** — same, references local 2 with 2 params |
  | `class K { m<T>(this: K, v: T): T }` → `k.m(5)` | **runtime trap** — `RuntimeError: dereferencing a null pointer` |
  | `function f<T>(v: T): T` → `f(7)` (control) | `7` ✓ |

  Exactly the predicted mismatch: the body compiles this-INCLUSIVE (references
  local 1 = `v`) while the inferred signature declares the this-EXCLUSIVE
  count. The stack-balance invariant catches the function case.

  **Mitigating, and it changes the priority**: these fail **loudly** — a
  compile error and a trap, not a silent wrong answer — so they are a strictly
  better class than the `new`-binding bug at the top of this issue. Narrow
  population: a TS this-parameter on a generic callee.

**AST-indexed (this-INCLUSIVE) — must be shifted with the emit path:**

- the satellite's `runFixpoint` / `buildScope` / `paramInfo`
  (`src/ir/fnctor-method-edges.ts`), `fnctor-receiver-provenance.ts`'s
  `paramInfo`, `inferParamTypeFromCallSites`' call-site scan, the consumer's
  `fn.parameters.indexOf(decl)`, and the `.d.ts` seeds — verified as a
  consistent set by the #4250 lane.

The two opposite treatments live **in one file, about fifty lines apart**:
`resolveGenericCallSiteTypes` must not move, `inferParamTypeFromCallSites`
must. That is the concrete shape of the trap.

## Acceptance criteria

- [ ] Every row of the table above answers the JS value.
- [ ] A this-parameter is skipped consistently on the `new` path — arity checks,
      argument binding, and any ctor-param inference keyed on parameter INDEX.
- [ ] **The emit path and BOTH inference lanes change together, in one PR** —
      `param-return-inference.ts`'s call-site arg↔index mapping, and the
      satellite's `runFixpoint`/`buildScope`/`paramInfo`
      (`src/ir/fnctor-method-edges.ts`, `fnctor-receiver-provenance.ts`). Today
      three off-by-ones agree and facts land correctly; fixing only the emit
      path converts that into a one-slot-stale disagreement, which is worse than
      the bug being fixed. **A PR that fixes only emit will be green** — the
      fixtures that would catch it do not exist yet, so write them.
- [ ] Each affected site is classified **AST-indexed** (`node.parameters`,
      this-INCLUSIVE) vs **signature-indexed** (`checker` signature,
      this-EXCLUSIVE) before being changed. These already disagree by one; a
      blanket "skip index 0" breaks the sites that never counted it.
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
