---
id: 4036
title: "dead-elim's double-remap WeakSet is scoped per body, so an Instr object aliased across two functions is remapped twice"
status: ready
sprint: current
created: 2026-08-02
updated: 2026-08-02
priority: high
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: bug
area: codegen
language_feature: compiler-internals
goal: correctness
related: [1302, 2564, 4034, 2043]
origin: "2026-08-02 — hit while landing #4034; a latent aliasing bug that only fires once a type actually dies"
---

# #4036 — the #1302 double-remap guard has a hole across function bodies

## Problem

`remapFuncIdxInBody` and `remapTypeIdxInBody` (`src/codegen/dead-elimination.ts:150`
and `:162`) mutate instructions in place and guard against chained double-remap
with a `WeakSet` — but the set is allocated **inside each function**, and the
caller invokes them **once per function body**
(`for (const func of mod.functions)`, ~`:424`). So the guard only holds within
one body. An `Instr` object reachable from **two** bodies is remapped once per
body: `7 → 6 → 5` under a compaction map.

#1302's own comment states the intent — "guarding the remap itself against
re-visiting an object fixes the whole class at the sink, so an aliased template
is remapped exactly once regardless of how many times the walker reaches it" —
and the per-body scope silently narrows that to "…within one body".

## How it surfaced

`emitStrWsSpanHelpers` (`src/codegen/native-strings-ws.ts`) built one `prologue`
array and spread it into both `__str_ws_start` and `__str_ws_end`. Spread copies
the array but **aliases the `Instr` objects**, including two `struct.get`s
carrying `typeIdx: strTypeIdx`. With a live compaction map, `$NativeString`
7→6→5 landed on `$AnyString` (1 field) and emit refused:

```
Codegen error: struct field index out of range — 2 (valid: [0, 1))
  at function '__str_ws_start' (struct.get on type 5)
```

Latent on main because nothing was making a type die on that path. #4034's
export gating did, and `tests/issue-3164.test.ts` (guard-suite) went red.

Fixed **at the producer** in #4034's PR — the prologue is now a factory, so each
body gets fresh objects. That unblocks the branch but leaves the sink hole open
for every other producer.

## Fix direction

Hoist both WeakSets out of the per-body calls so they span the whole
`eliminateDeadImports` pass — one `seen` set per remap map, threaded through the
loop. Each instruction object is then remapped exactly once no matter how many
bodies reach it, which is the invariant #1302 intended and the only one that is
sound for a mutate-in-place remapper.

Note the same reasoning applies to the `blockType`/ValType guard added by #2564
(same function, same scope).

## Risks

- The pass also remaps globals, exports, imports and element segments; only the
  body walkers need the widened scope. Do not widen anything keyed on position.
- A producer that shares an object across bodies is still fragile for other
  reasons (a later in-place edit hits both). The sink fix makes the pass sound;
  it does not make sharing good practice.
- Byte-identity: on modules with no cross-body aliasing the output must be
  unchanged. Verify with `scripts/prove-emit-identity.mjs` before/after.

## Acceptance criteria

- A regression test with one `Instr` object deliberately aliased across two
  function bodies plus a compaction map: the operand resolves to the same final
  index in both, and emit succeeds.
- Reverting the #4034-era producer fix in `native-strings-ws.ts` and keeping
  only the sink fix still compiles `tests/issue-3164.test.ts` clean (proves the
  sink fix subsumes the producer workaround).
- No byte-identity change on an unaffected corpus.

## Dupe check

- **#1302** — introduced the guard, per-body scope. This is the hole in it, not
  a re-report: the original repro (a throw-template spliced twice into ONE body)
  is genuinely fixed. Not a dupe.
- **#2564** — extended the same guard to shared `blockType` objects, again
  within a body. Same scope limitation. Not a dupe.
- **#2043** — the late-import index-shift class the error message cites. Related
  symptom, different mechanism (that one is stale captures across shifts; this
  is one object remapped twice). Not a dupe.
