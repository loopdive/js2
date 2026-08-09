---
id: 3715
title: "TS 'evolving array type' inference unimplemented — an empty-array-initialized variable/property/field permanently types as never[], hard-fails any later element-typed usage"
status: ready
sprint: current
created: 2026-07-27
updated: 2026-07-27
priority: high
horizon: l
feasibility: hard
task_type: bugfix
area: checker
language_feature: type-inference
goal: core-semantics
origin: "tests/dogfood/marked-harness.mjs — new marked dogfood harness, first run"
related: [3716]
---

# #3715 — Evolving array type inference unimplemented (`never[]` sticks forever)

## Repro (minimal, verified against real `tsc` — zero errors there)

```ts
export function test(): string {
  let items = [];
  for (let i = 0; i < 3; i++) {
    items.push({ type: "list_item", raw: "x" });
  }
  return items[0].raw;
}
```

js2wasm:

```
Argument of type '{ type: string; raw: string; }' is not assignable to parameter of type 'never'.
Property 'raw' does not exist on type 'never'.
```

Real `tsc --noEmit` (same source, `--target es2022 --lib es2022 --skipLibCheck`):
no errors. TypeScript's ["evolving array types"](https://github.com/microsoft/TypeScript/pull/12572)
feature infers `items`'s element type from the union of every value ever
pushed to it within reachable control flow, defaulting to `never[]` only
until the first push — js2wasm's checker/oracle appears to permanently keep
the initial `never[]` inference and never widens it.

## Scope — checker-level, not codegen; affects every binding shape tried

Bisected across three declaration shapes, all fail identically (same error
pair, same line pattern):

| shape | fails? |
| --- | --- |
| bare local `let items = [];` then `.push()` in a loop | **yes** |
| object-literal property `let r = { items: [] }; r.items.push(...)` | **yes** |
| class field `items = [];` then `r.items.push(...)` | **yes** |

Since even the simplest bare-local-variable case fails, this is not a
narrow object/class-field gap — the checker/oracle (`src/checker/oracle.ts`,
`src/checker/type-mapper.ts`) has no evolving-array-type support at all.
Grepped for `never[]`/`EvolvingArray`/related terms — nothing found, so
this looks like an unimplemented feature, not a regression.

**Distinct from #2806** (`untyped [] array literal lowers to a NUMERIC (f64)
vec — ref pushes coerce to 0`, done 2026-06-28): that issue is a **runtime
value-representation** bug (an empty array's backing vec picks the wrong
element kind, silently corrupting values that DO compile). This issue is a
**static type-checking** gap one layer up — the checker rejects the program
outright with a hard compile error before codegen is ever reached. Likely
worth coordinating fixes (an evolving-array type, once inferred, needs
`resolveWasmType` to pick the right vec element kind too — the two issues
may end up sharing a code path), but they are not the same bug.

## Discovered via

`tests/dogfood/marked-harness.mjs` (new — a second pinned-tarball
differential dogfood package alongside acorn, compiling
`marked@18.0.2`'s bundled `lib/marked.esm.js`). marked's tokenizer state
object (`Lexer`'s `tokens`/`items`-style accumulator fields) is initialized
as bare `[]` and populated via `.push()` deeper in the same
class/function — the exact evolving-array-type pattern above, at real-code
scale (12 distinct `never`-cascade error sites collapsing to 46
`ts-property-noise` + 12 `ts-not-assignable` diagnostics across 64 total).
**marked fails to compile at all as a result** (`compile()` returns
`success: false`, 0 binary bytes — nothing to even attempt validating or
running). See `tests/dogfood/report/marked-surface.json` (gitignored,
regenerate via `pnpm run dogfood:marked`) for the full diagnostic dump.

## Acceptance criteria

- [ ] The minimal repro above compiles successfully and `test()` returns
      `"x"`.
- [ ] All three bisected shapes (bare local, object property, class field)
      compile.
- [ ] Re-run `pnpm run dogfood:marked` — `compile.success` becomes `true`
      (does not require the FULL package to validate/run correctly yet,
      just to get past the type-checking phase — that's this issue's bar;
      #3716 tracks what's found once compilation succeeds).
