---
id: 6840
title: "standalone: a node:fs readFileSync/writeFileSync call inside a dependency (node_modules) refuses the whole compile — throw at the call site instead (jest)"
status: done
sprint: current
created: 2026-10-05
updated: 2026-10-05
completed: 2026-10-05
priority: high
horizon: s
feasibility: easy
reasoning_effort: high
task_type: bug
area: compiler
language_feature: host-imports
goal: standalone
requested_by: ttraenkler/wave9-jest
related: [1491, 6735, 6659, 6664, 6675, 6691, 2961]
# 2026-10-05: +7 lines — the six-line throw lowering at the head of the #1491
# branch. The predicate and message live in node-fs-binding-identity.ts; the
# emission stays in call-identifier.ts because moving it there pulled that module
# into the codegen value-import SCC (#6797 ratchet, 697 → 698).
loc-budget-allow:
  - src/codegen/expressions/call-identifier.ts
func-budget-allow:
  - src/codegen/expressions/call-identifier.ts::compileBoundIdentifierCall
files:
  - src/codegen/node-fs-binding-identity.ts
  - src/codegen/expressions/call-identifier.ts
  - tests/issue-6840-standalone-node-fs-library-call.test.ts
---

# #6840 — standalone: dependency `node:fs` calls refuse the whole compile

## What you will see

Measured 2026-10-05 on upstream/main `b6324ee6d1`:

```
npx tsx scripts/generate-npm-compat-report.mjs --only jest --no-write --perf-only --lane standalone-dynamic
standaloneDynamic: compile-error — "'node:fs' call to 'readFileSync' requires the
--allow-fs flag (or { allowFs: true } in CompileOptions) for non-WASI targets
(#1491). Refusing to emit the host import to prevent accidental capability leakage."
```

jest's dependency closure (284 packages) has ten files that bind
`readFileSync`/`writeFileSync` with a named `node:fs` import or a
`const { readFileSync } = require("fs")` destructure — e.g. `yargs`,
`yargs-parser`, `y18n`, `v8-to-istanbul`, `get-package-type`,
`package-json-from-dist`, `update-browserslist-db`, `unrs-resolver`. Every one
of them hits the #1491 gate and the whole graph fails to compile, although the
sample op (`typeof jest.run`) reads no file.

## Why the #1491 rule does not apply as written

#1491 gates the **JS-host** `__node_fs_readFileSync`/`__node_fs_writeFileSync`
host imports behind `--allow-fs` because emitting them would hand a third-party
package the host's filesystem ("prevents accidental capability leakage when
compiling third-party code", #1491 Implementation plan step 5). Its acceptance
criterion "Without `--allow-fs`: compile-time error" is about not silently
binding — or silently dropping — that host import.

A host-free `--target standalone` module has no host to leak: it imports
nothing, so it cannot reach a filesystem whatever the flag says. The rule's
purpose is vacuous there, and its effect is the opposite of the standalone
contract (#6659/#6664/#6675/#6691): one unreached capability mention in a
dependency makes the entire program uncompilable. Worse, `--allow-fs` does not
help in standalone — it emits the `env.__node_fs_readFileSync` host import,
which standalone must not carry (#2961 leak scan).

So neither lane-harness configuration (passing `allowFs: true` to the
npm-compat standalone lane would just trade the compile error for a leaked
host import and misdescribe the lane) nor weakening #1491 is right.

## Decision

Scoped, standalone-only throwing lowering:

- **Where:** host-free standalone only (`ctx.standalone && !ctx.wasi &&
  targetProfile.environment === "none"`), and only for a call whose source
  file is a dependency — a path segment `node_modules`. The JS-host lane, WASI
  and the linked/JS-environment standalone regimes are untouched.
- **What:** evaluate the arguments (ECMAScript evaluates the ArgumentList
  before the callee runs), then throw a catchable `Error`:
  `node:fs.<name> is not available in a standalone module: there is no
  filesystem (#6840)` — the shape Node's own permission model uses
  (`ERR_ACCESS_DENIED` is a plain `Error` thrown at the call, not a load
  failure), and the same shape #1491 says it mirrors (Deno permission errors
  are thrown at the call).
- **User code keeps #1491 unchanged:** a `readFileSync` in the program's own
  source still fails the compile with the #1491 message. Only dependency code
  — which the user did not write and whose fs path the sample may never reach —
  is compiled to the documented throw.

## Implementation Plan

1. `src/codegen/node-fs-binding-identity.ts` — add
   `isStandaloneDependencyNodeFsCall(ctx, expr)` (host-free standalone gate +
   `node_modules` path segment of `expr.getSourceFile().fileName`) and
   `emitStandaloneNodeFsUnavailable(ctx, fctx, expr, fnName)` (compile+drop
   every argument, `buildThrowJsErrorInstrs(ctx, "Error", msg, { flush })`,
   return `VOID_RESULT` for `writeFileSync`, externref otherwise — the stack
   is polymorphic after `throw`).
2. `src/codegen/expressions/call-identifier.ts` — at the top of the #1491
   branch, before the `!ctx.allowFs` error, dispatch to the helper when the
   predicate holds.
3. Regression test `tests/issue-6840-standalone-node-fs-library-call.test.ts`:
   a `node_modules/dep` package (ESM named import + CJS destructure) compiled
   from a project entry under `--target standalone` → zero imports, the module
   instantiates host-free, an unrelated export runs, and the reached call
   throws a catchable `Error` after evaluating its arguments. Controls: the
   same call in the entry file still fails the compile with the #1491 message
   (fails on parent too — anti-vacuity), and the JS-host compile of the
   dependency fixture is byte-identical (the change is standalone-gated).
4. Measure jest `standalone-dynamic` before/after; record the next blocker.

   As shipped: `node-fs-binding-identity.ts` exports
   `standaloneDependencyNodeFsThrowMessage` (predicate + message, no new value
   imports); call-identifier.ts emits `compileDiscardedArgument` per argument
   (spread arguments are iterated, as the ArgumentList requires) and the
   `Error` throw. A package-linker provider build (#5247,
   `ctx.exportsConsumedByWasm`) also counts as dependency code — it compiles
   one dependency package with package-relative file keys, so its paths carry
   no `node_modules` segment.

## Resolution

- `tests/issue-6840-standalone-node-fs-library-call.test.ts` (3 cases):
  parent **1 failed / 2 passed**, fix **3 / 3**. The two cases passing both
  ways are the controls: the program's own `readFileSync` keeps the #1491
  compile error (anti-vacuity), and the JS-host target keeps it for dependency
  code too.
- jest `standalone-dynamic` (same checkout, parent vs fix, measured
  2026-10-05 on a heavily loaded shared box):

  | | parent | fix |
  | --- | --- | --- |
  | status | `compile-error` — #1491 `--allow-fs` refusal (`readFileSync`) | `compile-error` — "`'__get_builtin'` (dynamic-shape object/property operation) is not yet supported in --target standalone (#1472 Phase B)" |

  The next blocker is a `__get_builtin` dynamic property operation somewhere
  in jest's graph (#1472 Phase B umbrella); not identified further here.
  #6735 no longer applies as a compile blocker: its own 2026-09-29 re-measure
  records that #3494 removed the `import()` refusal, and the fixed lane does not
  report it.
- JS-host and WASI output byte-identical: sha256 of a `target: "gc"` +
  `allowFs: true` compile and a `target: "gc"` compile of a dependency-fs
  fixture match parent vs fix; the WASI compile reports the same #1772 error
  both ways. The change is gated on `ctx.standalone && !ctx.wasi &&
  environment === "none"` without a realm-global link.
- test262: no `test/` or `harness/` file references `readFileSync` or
  `writeFileSync`, and the changed branch requires a binding recorded in
  `ctx.wasiNodeFsFuncs` (only populated from `fs`/`node:fs` imports), so
  standalone test262 output is unchanged by construction.
- Existing fs suites green: `issue-1491`, `issue-1772-no-provider-gate`,
  `issue-2647`, `issue-2631-node-fs-fd-shim` (21/21).

## Residuals

- In standalone, other `node:fs` uses (`import * as fs`, `existsSync`, …)
  still lower through the `env.__node_fs` module-object import, which the
  #2961 scan reports as a leak (warning). Not reached by jest's current first
  diagnostic; a graph that gets past `__get_builtin` may surface it.
- Standalone user code with `allowFs: true` still emits the
  `env.__node_fs_*` host import (a #2961 leak) instead of a clear "no
  filesystem provider in standalone" error — unchanged here.
