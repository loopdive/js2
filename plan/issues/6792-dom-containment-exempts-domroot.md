---
id: 6792
title: "runtime: DOM containment exempts `domRoot` itself from the mutation checks — `root.after(x)`, `root.remove()`, `root.insertAdjacentHTML(\"beforebegin\")` escape the container; `src/runtime-containment.ts` is a dead duplicate"
status: ready
sprint: Backlog
created: 2026-09-30
updated: 2026-09-30
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
