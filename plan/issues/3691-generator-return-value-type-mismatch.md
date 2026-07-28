---
id: 3691
title: "Generator .return(value) fails to compile: 'Argument of type number is not assignable to parameter of type void'"
status: wont-fix
sprint: current
created: 2026-07-27
updated: 2026-07-27
completed: 2026-07-27
priority: medium
horizon: m
feasibility: medium
task_type: bugfix
area: codegen, runtime
language_feature: generators
goal: generator-model
origin: "#3690 — new tests/differential/corpus/generators/03-return-throw.js surfaced this on first run"
related: [3690]
---

# #3691 — Generator `.return(value)` argument type mismatch

## Resolution: false positive, not a compiler bug

Verified against real `tsc --noEmit --skipLibCheck` on the exact repro:
**TypeScript itself rejects this program with the identical TS2345
error.** `function* gen() { yield 1; yield 2; }` with no explicit `return
<value>;` statement infers `TReturn = void`
(`Generator<number, void, unknown>`), so `Generator.prototype.return`'s
parameter type is `void` and passing `99` is a genuine TypeScript type
error — js2wasm's HARD_TS_DIAG_CODES gate on TS2345
(`src/compiler.ts:98-100`) is behaving correctly here, matching `tsc`
exactly. This is valid *runtime* JavaScript (the repro was originally
written for `.js`, where nothing is statically checked) but invalid
*TypeScript*, and js2wasm is a TS-typed AOT compiler — the corpus file was
wrong to assume plain-JS looseness carries over.

**Fix applied to the corpus file, not the compiler**: added an (unreached,
since the generator always exits early via `.return()`/`.throw()` in this
test) explicit `return 0;` so TS infers `TReturn = number` and `.return(99)`
type-checks cleanly under both real `tsc` and js2wasm. Runtime output is
identical (verified: `1\ncleanup\n99,true\n1\ncleanup\ncaught: boom`).

## Original repro (kept for history)

```js
function* gen() {
  try {
    yield 1;
    yield 2;
  } finally {
    console.log("cleanup");
  }
}
const a = gen();
console.log(a.next().value);
console.log(a.return(99));
```

## Repro file

`tests/differential/corpus/generators/03-return-throw.js` (see #3690) — now
fixed to be valid TypeScript.
