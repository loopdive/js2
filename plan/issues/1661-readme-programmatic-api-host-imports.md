---
id: 1661
title: "README programmatic-API example fails: instantiate(binary, {}) but default mode requires host imports"
status: done
created: 2026-05-25
updated: 2026-05-25
completed: 2026-05-25
priority: high
feasibility: easy
reasoning_effort: low
task_type: docs
area: docs
language_feature: n/a
sprint: 55
github_issue: 601
filed_by: guest271314
related: [1471, 1472, 1473, 1474, 1530]
---

## Problem

Reported by **guest271314** in GitHub issue **#601**. The README's programmatic
API section shows:

```js
import { compile } from "js2wasm";
const result = compile(`export function add(a: number, b: number): number { return a + b; }`);
if (result.success) {
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  console.log(instance.exports.add(2, 3));
}
```

**Actual failure**:

```
TypeError: WebAssembly.instantiate(): Import #0 "string_constants": module is not an object or function
```

…and likewise the `env` module expects `__throw_reference_error`,
`__extern_length`, `__extern_get`, `__unbox_number`, `__box_number`,
`__array_from_iter`. So `instantiate(binary, {})` cannot work for default-mode
output.

**Likely cause**: the example uses **default JS-host compile mode**, which emits
the `string_constants` module + `env.*` runtime imports. Instantiating with an
empty imports object `{}` therefore fails. The README neither discloses the
required imports nor shows the standalone / no-host option.

## Fix direction

(Let the implementing dev pick, but recommend (a).)

- **(a) preferred** — change the example to compile in **standalone / no-JS-host
  mode** (the `--target wasi` / `standalone` path from #1471–#1474, where the
  module instantiates with `{}` because it has no `env` / `string_constants`
  imports) and verify the snippet runs end-to-end.
- **(b)** — document how to supply the runtime host imports the compiler emits
  (and where they come from).

Given the project's standalone-first direction, **(a)** is preferred — the
README should show a snippet that genuinely runs under `instantiate(binary, {})`.

## Acceptance criteria

- The README programmatic-API snippet, copy-pasted, runs successfully (exports
  callable) under Node with no missing-import error.
- The default-vs-standalone import requirement is documented.
- Verified by **actually running** the snippet.

## Theme link

Same root as guest's **#389** / `readStdin` finding — docs imply standalone
behavior the default mode doesn't deliver.
