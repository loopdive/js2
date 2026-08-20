---
id: 4419
title: "compileFiles silently binds node:* imports to ref.null and reports success"
status: ready
sprint: current
created: 2026-08-14
updated: 2026-08-20
priority: high
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: bug
area: compiler
goal: correctness
related: [4567]
---

## Problem

`node:*` imports have a real host-import mechanism — `preprocessImports`
(`src/import-resolver.ts`) plus `registerNodeBuiltinImports`
(`src/codegen/extern-declarations.ts:1530-1570`) lower a Node builtin to an
`env.__node_<module>` handle (`() -> externref`), dispatching members through
`env.__extern_get` / `env.__extern_method_call_N`.

**`compileFiles` never invokes it.** `compileFilesSource` calls
`buildCodegenOptions(options, emitSourceMap)` with no `prep`
(`src/compiler.ts:1871`), so `nodeBuiltins` is `undefined` and
`registerNodeBuiltinImports` never runs. There is no error and no warning: the
import binding becomes `ref.null extern`, and the compile reports
**`success: true`**.

```wat
;; compileFiles(".../node-only.ts") → success: true, 288 bytes
(func $readIt (param externref) (result externref)
  ref.null extern        ;; <-- this is `fs`
  local.set 1
  … call 0               ;; __extern_method_call_2(null, "readFileSync", …)
```

`compileMultiSource` / `compileProject` do it correctly via
`collectGraphNodeBuiltinImports` and emit `env.__node_fs`. The mechanism
exists; the whole-program entry point does not use it.

22 files under `src/` import `node:*`, so this blocks any whole-program
self-compile from producing a runnable module even once codegen succeeds.

## Why it is high priority despite being small

Silent-wrong is the worst failure mode available. A caller gets a module that
validates, instantiates, and then traps or misbehaves at the first use of the
import — with nothing in the compile output suggesting anything was dropped.

## Fix

Thread the `prep` / `nodeBuiltins` through `compileFilesSource` the way
`compileMultiSource` already does. If there is a reason the whole-program path
cannot resolve them, it must **fail loudly** instead of emitting a null
binding.

Exercise the fix across named, default, and namespace ESM imports plus static
CommonJS `require`/destructuring. Compare every public compiler entry point:
single-source compile, `compileFiles`, `compileMultiSource`, and
`compileProject`. Each row must either emit the applicable provider import or
return a deliberate unsupported/unknown diagnostic; successful null/empty
binding is never an allowed third state.

## Acceptance criteria

- [ ] `compileFiles` on an entry importing `node:fs` emits `env.__node_fs`,
      matching `compileProject` on the same input.
- [ ] Named, default, namespace, static `require`, and destructured CommonJS
      forms produce the same non-null capability decision in every compiler
      entry point that accepts the form.
- [ ] A test asserts the import is present, not merely that the compile
      succeeded — the bug is invisible to a success check.
- [ ] If a builtin genuinely cannot be lowered on this path, the compile
      reports an error rather than binding `ref.null`.
- [ ] The matrix includes a supported positive control and an intentionally
      unavailable member proving that the failure path is observable.

## Provenance

Found by the self-hosting investigation (see #4417 for the sibling finding).
Repro harnesses in `.tmp/selfhost/`.
