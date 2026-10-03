---
id: 6792
title: "runtime: DOM containment exempts `domRoot` itself from the mutation checks — `root.after(x)`, `root.remove()`, `root.insertAdjacentHTML(\"beforebegin\")` escape the container; `src/runtime-containment.ts` is a dead duplicate"
status: done
sprint: Backlog
created: 2026-09-30
updated: 2026-10-02
completed: 2026-10-02
assignee: "ttraenkler/claude-dev-6792"
branch: "claude/issue-6792-domroot-containment"
priority: medium
horizon: s
feasibility: easy
reasoning_effort: low
task_type: bug
area: runtime
language_feature: dom
goal: platform
related: [68]
requested_by: ttraenkler/claude-review
origin: "2026-09-30 codebase review (plan/agent-context/claude-codebase-review-2026-09-30.md) — H11"
---

# #6792 — the root is inside the fence, but its outward-facing methods are not

## Problem

With `domRoot` set (#68), compiled code is meant to be confined to that
subtree. `src/runtime.ts:19476`, `:19486`, `:19513`, `:19522` all gate on
`self !== domRoot && …`, so any mutation method invoked **on the root
itself** is unchecked. `mutationMethods` (`:19427-19434`) includes `remove`,
`after`, `before`, `replaceWith`, `insertAdjacentHTML` — each of which
mutates the root's **parent** or siblings:

```ts
root.insertAdjacentHTML("beforebegin", "<div>outside</div>");
root.after(document.createElement("script"));
root.remove();
```

Separately, `src/runtime-containment.ts` has no importers except
`scripts/compiler-boundaries.json` — a second copy of the same policy that
cannot be kept in sync.

## Correction

1. For `self === domRoot`, reject the outward-mutating subset: `remove`,
   `after`, `before`, `replaceWith`, `insertAdjacentHTML` /
   `insertAdjacentElement` / `insertAdjacentText` with `beforebegin` /
   `afterend`, and property writes to `outerHTML`. Inward mutations on the
   root (`append`, `innerHTML`, `insertAdjacentHTML("afterbegin"|"beforeend")`)
   stay allowed.
2. Delete `src/runtime-containment.ts` (and its boundaries-manifest entry) or
   make `runtime.ts` import it — one implementation.

## Acceptance

- jsdom test: with `domRoot` set, the three calls above throw the
  containment error and the parent's child list is unchanged; `root.append`
  still works.
- `check:compiler-boundaries` passes with the duplicate removed.

## Implementation Plan

1. `src/runtime.ts` `wrapWithContainment`: replace the `mutationMethods` set —
   whose branch was byte-for-byte the same check as the generic method
   branch, so it encoded nothing — with the outward-facing subset:
   `outwardMethods` (`remove`, `after`, `before`, `replaceWith`),
   `outwardSetters` (`outerHTML`, `outerText`) and the `beforebegin` /
   `afterend` position test for `insertAdjacent{Element,HTML,Text}`
   (ASCII case-insensitive, as the DOM parses it).
2. When `self === domRoot`, throw `DOM containment violation: … on the
   container root would mutate outside it` for that subset. The
   `insertAdjacent*` position is converted to a string once and the
   converted value is what the DOM receives, so an object whose `toString`
   answers differently on a second call cannot pass the check and then act
   outward. Every other member on the root, and every member on a contained
   node, keeps its existing behaviour.
3. Delete `src/runtime-containment.ts` (no importers in `src/`, `tests/`,
   `scripts/` or workflows; `typecheck` stays green without it) and its
   `scripts/compiler-boundaries.json` entry.

## Resolution

Probe `.tmp/probe-6792.mts`: compiled exports call each member on the root
(jsdom, `buildImports(..., { domRoot: root })`, JS-host lane).

| Call on `domRoot` | Before | After |
| --- | --- | --- |
| `after(el)` / `before(el)` | sibling inserted in parent | throws, parent unchanged |
| `remove()` | root detached from parent | throws, parent unchanged |
| `replaceWith(el)` | root replaced in parent | throws, parent unchanged |
| `insertAdjacentHTML("beforebegin" \| "afterend")` | sibling inserted | throws, parent unchanged |
| `insertAdjacentElement("beforebegin")`, `insertAdjacentText("afterend")` | sibling inserted | throws, parent unchanged |
| `outerHTML = …` | root replaced in parent | throws, parent unchanged |
| `append`, `innerHTML =`, `insertAdjacentHTML("beforeend")`, `child.remove()` | allowed | allowed (unchanged) |

Test: `tests/issue-6792-domroot-containment.test.ts` — 10 escaping rows
(the above plus `outerText =` and a mixed-case `"AfterEnd"` position) and one
positive row (inward mutators on the root, and `after` on a contained child).
11/11 pass.

Gates (all exit 0): check-loc-budget, check-func-budget (both also with
`LOC_GATE_BASE` = upstream tip after merging it), check-coercion-sites,
check:oracle-ratchet, check:dead-exports, typecheck, format:check,
check-compiler-boundaries `--mode inventory` (`inventoryValid: true`), the
18 quality-lane gates from the dev brief, check:ir-fallbacks. No budget
allowances needed — `src/runtime.ts` shrinks by 11 lines.

Pre-existing, not touched:

- `tests/dom-containment.test.ts` fails 4/19 on `origin/main` too (identical
  set before and after this change). Its `MockElement` has no `nodeType`, so
  `isNodeLike` ignores it and the outside-container checks never run against
  the mock.
- `tests/issue-4576-*` / `tests/issue-4577-*` fail 14/28 on `origin/main` too
  (IR census counts; the standalone `dom@1` capability path, not this
  wrapper).
- The `plan/agent-context/3518-three-arm-repair-artifacts/execution-manifest-*.json`
  snapshots list a digest for `src/runtime-containment.ts`. They are frozen
  whole-`src/` snapshots (their `src/runtime.ts` digest already differs from
  `main`), and no script, test or workflow re-verifies them, so they were left
  unedited.
- Out of scope, needs its own issue: only `extern_class` imports are
  wrapped. Measured with `.tmp/probe-6792-any.mts`:
  `function f(root: any, el: any) { root.after(el); }` compiles to the
  `__extern_method_call_1` builtin import, which `buildImports` does not wrap,
  so `root.after(el)` still inserts outside the container on this branch.
  Arguments are not containment-checked either (unmeasured: a contained
  node's `append(x)` with `x` taken from outside the container would move
  `x` out of its parent).
