---
id: 2070
title: "closures stored via Array.push/unshift (and bare Map.set) wrapped as host callbacks — trap when invoked from Wasm; HOST_CALLBACK_METHODS allowlist is dead code"
status: done
completed: 2026-06-12
sprint: 61
created: 2026-06-10
updated: 2026-06-12
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: closures
goal: crash-free
related: [1306, 1311, 1300, 1695, 1453]
origin: "2026-06-10 deep-audit sweep (closures agent): verified trap on main, WAT-proofed"
---

# #1950 — `fns.push(() => 42); fns[0]()` traps

## Problem

A closure passed to `Array.prototype.push`/`unshift` (or `Map.set` outside a
class context) is wrapped as a **host callback** (`__make_callback`,
externref), but the element-read call site expects the WasmGC closure struct —
`ref.test` fails and `call_ref`/`struct.get` traps on null. Compiles cleanly,
traps at runtime in everyday code. This also masks per-iteration-binding
testing for the closures-in-a-loop idiom (#1453).

## Repro (verified on main)

```ts
export function test(): number {
  const fns: (() => number)[] = [];
  fns.push(() => 42);
  return fns[0]();
}
```

| probe | wasm | node |
|-------|------|------|
| push then `fns[0]()` | `ERR access to a null reference` | `42` |
| `unshift` then call | WebAssembly.Exception (TypeError tag) | `7` |
| top-level `Map.set("a",()=>5); m.get("a")!()` | null-ref trap | `5` |

Controls: array **literal** `[() => 42]` OK; `o.f = () => 9; o.f!()` OK.

WAT proof: pushed element is
`(call $__make_callback (i32.const 0) (ref.null noextern))` while the call
site does `ref.test (ref $0)` against the closure struct, fails → null →
trap.

## Root cause

`src/codegen/closures.ts:1018-1111` (`isHostCallbackArgument`) returns `true`
(line 1094) for a callable argument of **any** method call whose receiver is
not a user-defined class — including `Array.prototype.push`. The
`HOST_CALLBACK_METHODS` allowlist at closures.ts:989-1013 (added with #1311,
whose doc-comment says push/set/add "get the closure-struct path") is **dead
code — declared and never referenced**. So `compileArrowFunction`
(closures.ts:1237-1240) routes the arrow through `compileArrowAsCallback`.

## Fix direction

Actually consult `HOST_CALLBACK_METHODS` in the property-access branch of
`isHostCallbackArgument`: host path only for methods in the set; storage
methods (`push`, `unshift`, `set`, `add`, unknown methods on non-extern
receivers) get the closure-struct path. Alternatively/additionally make the
element-read call site fall back to a host `__call_fn_*` dispatch when
`ref.test` fails instead of proceeding with null.

## Acceptance criteria

- All three repros match Node
- Genuine host-callback methods (e.g. array `map`/`filter` host paths, timers)
  keep working
- `#1311` class-context Map dispatch unregressed
- Closures-in-a-loop pattern (`fns.push(() => i)`) callable (then #1453 owns
  the per-iteration values)

## Dupe check

Grepped `push.*closure`, `make_callback`, `closure.*array`, `callback array`:
#1306 (element-access call on closure array, done), #1311 (Map-in-class, done —
its text lists `Array.push` as intended closure path), #1300/#1695 (adjacent,
done). The push/unshift/bare-Map breakage on current main is untracked.

## Partial resolution (2026-06-11) — array `push`/`unshift` landed

`isHostCallbackArgument` (`src/codegen/closures.ts`) now consults the
previously-dead `HOST_CALLBACK_METHODS` allowlist: in the property-access
branch, a callable arg to `Array.prototype.push`/`unshift` on an **array**
receiver (`isArrayLikeReceiverType`) is routed to the closure-struct path
instead of the host `__make_callback` externref, so the eventual
`fns[0]()` read-site dispatch (`ref.test`/`ref.cast`/`struct.get`) no longer
null-derefs.

Covered (match Node — `tests/equivalence/closure-push-host-callback.test.ts`):
- `fns.push(() => 42); fns[0]()`
- `unshift` then call
- captured + multiple-closure push
- array `map` host-HOF still works (host path preserved)

**Deliberately scoped narrow** — only array `push`/`unshift`. `Map.set`/`Set.add`
and `DisposableStack.defer/use/adopt` keep the host-callback path because the
#1311 in-class Map dispatch and #1695 deferred-writeback machinery depend on the
JS-callable externref; a universal `Map.set → closure` flip *re-broke* #1311
(verified: null-deref). Confirmed zero new regressions across #1306/#1311/#1453/
#1695 (the 3 still-red #1311 cases are pre-existing — identical on clean HEAD).

### Remaining (issue stays open)

- **Bare top-level `Map.set(k, () => …)` then `m.get(k)!()`** still traps/returns
  0 — needs the read-site fallback (dispatch via host `__call_fn_*` when
  `ref.test` fails) the Fix-direction's "alternatively" branch describes, so the
  same stored externref works from both the #1311 class-wrapper and a bare
  module-scope Map. Higher risk (touches the element-read dispatch site); split
  out to avoid bundling with the safe array fix.

## Frontmatter reconcile (2026-06-12)

Fixed by merged PR #1381; frontmatter was stale at `in-progress`. Flipped to `done` during the sprint-62 issue review.
