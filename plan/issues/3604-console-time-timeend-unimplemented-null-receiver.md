---
id: 3604
title: "console.time/timeEnd unimplemented — and the fallback compiles a null console receiver that throws at runtime instead of erroring at compile time"
status: ready
sprint: current
created: 2026-07-25
updated: 2026-07-25
priority: medium
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: bug
area: codegen
language_feature: console
goal: platform
es_edition: ES2015
related: [937]
---

# #3604 — `console.time` / `console.timeEnd` unimplemented, with an inconsistent + unsafe fallback

Two defects, one small. The missing feature is the lesser half; the
**inconsistent failure mode** is the part worth fixing.

## Problem 1 — the methods are not implemented

`IR_CONSOLE_METHODS` in `src/ir/from-ast.ts:4547` is:

```ts
const IR_CONSOLE_METHODS: ReadonlySet<string> = new Set(["log", "warn", "error", "info", "debug"]);
```

`time` / `timeEnd` (and `timeLog`) are absent. #937 added `info`/`debug` but not
the timing family. These are standard Console API methods and are the idiomatic
way JS benchmarks self-report — any benchmark script pulled in from the wild
uses them.

## Problem 2 — the failure mode depends on where the call appears (the real bug)

**At module scope** → hard compile error, which is fine and honest:

```
error: Codegen error: IR path failed for <module-init>:
  ir/from-ast: console.time not in IR console slice (<module-init>) [IR-FALLBACK]
```

**Inside a function / IIFE** → **compiles successfully**, and the `console`
receiver is emitted as a constant `ref.null extern`:

```wat
ref.null extern        ;; <- console
local.set 25
...
global.get 22          ;; "time"
call 7                 ;; __extern_method_call(null, "time", [...])
```

At runtime this throws from the host glue:

```
TypeError: Cannot read properties of null (reading 'time')
    at __extern_method_call (src/runtime.ts:10240)
```

So the same unsupported call is a compile error in one position and a runtime
null-dereference in another. Worse, **no host `deps.console` can rescue it** —
the null is baked into the module as a constant, so the documented
`buildImports(manifest, { console })` override (`src/runtime.ts:7338`) has no
effect. A user supplying a perfectly good `console` still gets the TypeError.

## Why it matters

- A benchmark or script that calls `console.time` inside a function compiles
  clean and then dies at runtime with a message that points at the *host glue*,
  not at the unsupported feature — actively misleading during triage.
- `ref.null extern` for an unresolved global is a general hazard: it converts
  "unsupported" into "null receiver", which surfaces as an unrelated TypeError
  at an arbitrary later point.

## Acceptance criteria

- [ ] `console.time` / `console.timeEnd` / `console.timeLog` implemented, or
      explicitly declined.
- [ ] **Either way**, an unsupported/unresolved `console` method fails the
      **same way regardless of call position** — a compile error, not a
      constant-null receiver that throws at runtime. This half is required even
      if the methods stay unimplemented.
- [ ] If implemented: label-keyed timers, `timeEnd` prints elapsed ms, unknown
      label warns (per Console spec), and standalone mode has a Wasm-native
      monotonic clock path or the methods are compile-rejected there rather than
      host-import-only (per the dual-mode rule in CLAUDE.md).
- [ ] Test asserting the in-function case does not produce a null-receiver
      TypeError.

## Repro

```bash
# (a) module scope -> hard error
printf 'console.time("t");\nconsole.timeEnd("t");\n' > /tmp/a.ts
npx tsx src/cli.ts /tmp/a.ts -o /tmp/o          # error: not in IR console slice

# (b) inside a function -> compiles, then throws at runtime
printf '(() => { console.time("t"); console.timeEnd("t"); })();\n' > /tmp/b.ts
npx tsx src/cli.ts /tmp/b.ts -o /tmp/o          # compiles clean
# instantiate the module -> TypeError: Cannot read properties of null (reading 'time')
# grep /tmp/o/b.wat for `ref.null extern` before the "time" string global
```

## Provenance

Found 2026-07-25 while benchmarking
<https://github.com/CanadaHonk/porffor/issues/262#issuecomment-5072076826>
with js2 — the benchmark times itself with `console.time('engine')` inside an
IIFE, so it hit case (b) exactly. Working around it required stripping both
calls and timing externally. Porffor (latest main) runs the same script's
`console.time` path without issue.
