---
id: 2543
renumbered_from: 2519
title: "CLI run-hint recommends `-W all-proposals=y`, which enables stack-switching and makes wasmtime exit at module load"
status: done
created: 2026-06-19
completed: 2026-06-19
priority: high
feasibility: easy
reasoning_effort: low
task_type: bug
area: cli
language_feature: none
goal: usability
sprint: 64
---

# #2543 — Wasmtime run hint enables stack-switching, which exits at module load

References external report: loopdive/js2#389 ("the host exits in the browser").

## Problem

After every compile the CLI prints a run hint (`src/cli.ts`, added by #1590):

```
To run: wasmtime -W all-proposals=y <wasm>
```

`-W all-proposals=y` enables the **stack-switching** proposal, which wasmtime
44/45 does **not** support in its compiler configuration. wasmtime therefore
fails at **module load** with:

```
Error: the wasm_stack_switching feature is not supported on this compiler configuration
```

and exits(1) immediately — before running anything, regardless of module
content (js2wasm output contains zero stack-switching opcodes).

When the compiled module is used as a Chrome Native Messaging host (with this
exact wasmtime command as the launcher shebang), Chrome starts it, wasmtime
exits instantly, and the host dies on connect — which the external tester saw
as "the host exits in the browser" (loopdive/js2#389).

The shipped example launcher `examples/native-messaging/nm_js2wasm.sh` already
uses the correct targeted flags and warns against `all-proposals=y`, so the CLI
hint contradicts the project's own example.

## Reproduction (wasmtime 44.0.0)

| Command | Result |
| --- | --- |
| `wasmtime -W all-proposals=y nm_js2wasm.wasm < frame.bin` | exit 1, `wasm_stack_switching ... not supported`, no output |
| `wasmtime -W gc=y,function-references=y,tail-call=y,exceptions=y nm_js2wasm.wasm < frame.bin` | exit 0, correctly echoes the framed message (`07 00 00 00 [1,2,3]`) |

## Fix

Recommend the minimal working proposal set
`gc=y,function-references=y,tail-call=y,exceptions=y` (reference-types is on by
default in wasmtime) everywhere the run hint appears, and never recommend
`all-proposals=y`:

1. `src/cli.ts` — the live post-compile hint now emits the 4-flag set, with a
   comment explaining the stack-switching exit.
2. `tests/issue-1590-cli-run-hint.test.ts` — assertions updated to the new flag
   string; added a guard that the hint never contains `all-proposals=y`.
3. `README.md` — the "running standalone output" section recommends the targeted
   flags and explicitly warns against `all-proposals=y` (removed the prior "if
   `all-proposals=y` is what you reach for, it is always safe" claim, which was
   the wrong advice).
4. `docs/standalone-io.md` — all five `wasmtime -W all-proposals=y` example
   commands updated to the targeted set (keeping `--dir .`, `2>err.txt`,
   `echo input |` parts intact), plus a note explaining the stack-switching exit.
5. `examples/native-messaging/nm_js2wasm.sh` — left unchanged (already correct).

Rationale for the 4 flags: matches the proven example launcher; covers
js2wasm's GC / funcref / tail-call / exception output and externref. Verified
working on wasmtime 44.

## Acceptance

- `src/cli.ts` no longer emits `all-proposals=y`; emits the 4-flag set.
- `tests/issue-1590-cli-run-hint.test.ts` passes against the new hint.
- `README.md` + `docs/standalone-io.md` no longer recommend `all-proposals=y`
  for the run command.
