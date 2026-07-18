---
id: 1951
title: "Linker self-host blocked on linear-backend try/catch lowering (#1838)"
status: ready
created: 2026-06-11
updated: 2026-06-11
priority: medium
feasibility: hard
model: fable
task_type: feature
area: codegen-linear
goal: self-hosting-dogfood
sprint: Backlog
depends_on: [1838, 1712]
---
# #1951 — linker self-host blocked on linear-backend try/catch lowering

## Symptom
`tests/linker-self-host.test.ts` and `tests/linker-e2e.test.ts` compile the
linker source (`src/link/*.ts`) through the **linear backend**
(`{ target: "linear" }` / `generateLinearMultiModule`) and assert the result
compiles + validates + instantiates. Both suites fail on `origin/main` with:

```
Codegen error: try/catch is not yet supported by the linear/standalone backend —
emitting it would silently drop the catch handler (#1838).
```

## Root cause
`src/link/linker.ts` uses two legitimate `try/catch` error boundaries:
- `:73` — `try { parseObject(...) } catch` (malformed-wasm reporting)
- `:130` — `try { emitLinked(...) } catch` (link-error reporting)

PR #1178 (#1838, commit `3b57c3e45`) made the linear backend **fail loud** on
`try { ... } catch` — correctly: it previously inlined the try body and
**silently discarded the catch clause**, so the linker self-host test was only
ever "passing" by compiling a subtly-wrong binary (catch handlers dropped). When
#1838 removed that silent miscompilation it surfaced the real gap but did not
update the self-host tests, leaving them red on main.

This is **not** a localized bug — the linker genuinely needs `try/catch`, and the
linear backend genuinely cannot lower it yet. The self-host goal depends on the
not-yet-implemented Wasm-EH `try`/`catch` lowering that #1838 names as the planned
fix. (`src/emit/binary.ts` already supports EH `try`/`catch`/`throw` at the
emitter level; the gap is wiring it through `src/codegen-linear/index.ts`'s
`ts.isTryStatement` arm, which currently throws when `stmt.catchClause` is set.)

## Interim state (red-on-main hotfix)
The self-host **compile** assertions in `tests/linker-self-host.test.ts` and
`tests/linker-e2e.test.ts` are skipped with an explicit `#1951 / #1838` pointer
so main goes green-honest (the skip names the blocker; it does not paper over a
real compiler bug). #1838's own fail-loud coverage (`tests/issue-1838.test.ts`,
4 cases) stays green and authoritative.

## Fix options (this issue)
1. **Wasm-EH try/catch lowering in the linear backend** (preferred long-term):
   wire `src/codegen-linear/index.ts` `ts.isTryStatement` (catch arm) through the
   emitter's existing EH `try`/`catch`/`throw` support (`src/emit/binary.ts`),
   then un-skip the self-host suites. Substantial; this is the real unblock.
2. **Exception-free linker** (alternative): refactor `parseObject`/`emitLinked`
   and the reader's ~10 `throw` sites (`src/link/reader.ts`) into discriminated
   result returns so `linker.ts` needs no `try/catch`. Keeps the production
   (JS-host) linker behavior identical but is invasive across the decode loop.

## Acceptance criteria
- The linear backend compiles `src/link/index.ts` (with its `try/catch`) without
  a `#1838` codegen error, OR the linker is refactored exception-free.
- `tests/linker-self-host.test.ts` + `tests/linker-e2e.test.ts` un-skipped and green.
- No silent catch-handler drop (no regression of #1838's correctness guarantee).
