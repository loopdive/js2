---
id: 4377
title: "MISCOMPILE: compileMulti does not resolve canonical file: URL imports to virtual filesystem paths"
status: done
created: 2026-08-12
updated: 2026-08-12
priority: high
feasibility: medium
reasoning_effort: high
task_type: bug
area: checker, modules
language_feature: esm, file URLs
goal: deno-runtime
related: [1298, 2930, 4001, 4126, 4376]
origin: "Deno.cwd() typed-host bridge in the v8x/js2wasm prototype"
files:
  - src/checker/multi-file-paths.ts
  - src/checker/language-service.ts
  - tests/issue-4377-multifile-exported-object-shorthand-callable.test.ts
---
# #4377 — compileMulti does not resolve canonical file URLs

## Defect

The natural AOT Deno wrapper shape silently returns the default value and never
calls its host operation:

```ts
// deno.ts
declare function op_cwd_length(): number;
function cwd(): number { return op_cwd_length(); }
export const Deno = { cwd };

// main.ts
import { Deno } from "file:///tmp/deno.ts";
export function probe(): number { return Deno.cwd(); }
```

The `compileMulti()` source map uses `/tmp/deno.ts` as its key, matching the
canonical filesystem identity supplied by v8x. The emitted module instantiated
and exported `probe`, but `probe()` returned `0` and the imported host function
was called zero times.

The same graph with a relative import worked. So did direct calls and static
class calls in the file-URL graph, because their flat-name/static dispatch
fallbacks accidentally masked the unresolved TypeScript module binding. The
exported object was a useful canary, not the root cause.

This is a compiler ABI defect, not a v8x or Wasmtime issue. The Deno prototype
must not retain the class workaround.

## Acceptance

- [x] A local `const api = { fn }; api.fn()` control remains correct.
- [x] A relative named import of `export const api = { fn }` invokes the callable field.
- [x] The cross-module host-extern form invokes its typed import and returns its
      value (anti-vacuity call count required).
- [x] Canonical `file:///...` imports resolve to the matching virtual filesystem
      path, including native-string-returning callable object fields.
- [x] Restore the v8x Deno adapter to an exported object with `Deno.cwd()`.
- [x] Focused tests and the v8x embedded runtime proof pass.

## Investigation notes

`normalizeMultiFileName()` treated `file:///tmp/deno.ts` as the unrelated bare
name `file:/tmp/deno.ts`, while the virtual source map normalized
`/tmp/deno.ts` to `tmp/deno.ts`. `resolveMultiFileModule()` consequently
returned no module record and codegen saw an unresolved import binding.

The fix canonicalizes local `file:` URLs before virtual path normalization and
gives the one-shot and incremental dependency walkers the same custom
resolver. It also handles URL-encoded path characters without aliasing URLs
that carry query strings or fragments. No Deno-specific codegen case or
callable representation change was needed.
