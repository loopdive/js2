---
id: 3711
title: "yield* delegation to an inner generator traps with 'illegal cast'"
status: blocked
sprint: current
blocked_on: 1687
created: 2026-07-27
updated: 2026-07-27
priority: high
horizon: m
feasibility: medium
task_type: bugfix
area: codegen, runtime
language_feature: generators
goal: generator-model
origin: "#3690 — new tests/differential/corpus/generators/05-yield-star.js surfaced this on first run"
related: [3690]
---

# #3711 — `yield*` delegation traps with "illegal cast"

## Repro

```js
function* inner() {
  yield "a";
  yield "b";
  return "inner-done";
}
function* outer() {
  const result = yield* inner();
  yield "c:" + result;
}
console.log([...outer()].join(","));
```

## Symptom

- V8: `a,b,c:inner-done`
- js2wasm: compiles, but throws a runtime `illegal cast` trap when the
  program runs — no output at all (the whole program errors before the
  first `console.log`).

Both `inner` and `outer` are plain generator functions individually
exercised (see #3690's `01-basics.js`), so the gap is specific to
`yield*` delegating from one generator to another (the recursive
`flatten` case in the same corpus file, which delegates to itself, was
never reached because the harness stops at the first error — worth
re-checking once this is fixed).

## Repro file

`tests/differential/corpus/generators/05-yield-star.js` (see #3690).

## Root cause (investigated 2026-07-27) — same family as #1687/#3710

Same eager-buffer-vs-lazy-state-machine gap as #3710 (see that issue for
the full trace): `yield*` delegation is explicitly listed as **not
modeled** by the native lazy generator lowering
(`src/codegen/generators-native.ts` header: *"yield*, break/continue
targeting a yield-loop, switch/labeled statements with yields, and
try/catch with yields are not modeled"*) and the runtime's
`__gen_yield_star` eager-buffer helper (`src/runtime.ts`) drains the inner
iterable eagerly into the outer buffer. Unlike #3710 (silently wrong
values), this repro **traps** ("illegal cast") rather than degrading
gracefully — worth flagging to whoever picks up native `yield*` support
(#1687/Phase 3) as a harder failure mode than a value mismatch: something
in the delegation path is casting a value to the wrong Wasm type rather
than just producing an incorrect-but-valid one.

**Not fixed here** — same architecturally-significant, multi-phase
compiler-lowering scope as #3710. Keeping open as a minimal repro +
differential-corpus regression pin.
