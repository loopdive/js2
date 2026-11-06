---
id: 7291
title: "IR string-builder loop is 6–10× slower than legacy's #1210/#1580 buffer (`$text$buf`/`$text$mat`)"
status: in-progress
sprint: current
created: 2026-11-06
updated: 2026-11-06
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
related: [1210, 1580, 1761, 3740, 3744, 3518, 7277]
assignee: "ttraenkler/c-r7"
---

# IR string-builder loop is 6–10× slower than legacy's buffer

## Problem

`let s = ""; for (…) s += <expr>` is claimed by the IR, which appends through
`__str_concat_owned` (#3740/#3744). Legacy rewrites the same loop
(`src/codegen/string-builder.ts`, #1210/#1761/#1580) into a scalarised
buffer. #1580's string-hash benchmark (`tests/issue-1580.test.ts`), WASI,
`run(200000)`, steady state, main `dc52abf7`:

| source | route | ms |
| --- | --- | --- |
| `run(n)` (untyped) | legacy (`param-type-not-resolvable`) | 2.9 |
| `run(n: number)` | IR | 17.0–18.2 |
| `run(n: number)`, `JS2WASM_IR_STRING_BUILDER=0` | legacy (`string-builder-candidate`) | 2.0–2.4 |
| literal appends (`s += "a"`), IR | IR | 10.4 |
| literal appends, `JS2WASM_IR_STRING_BUILDER=0` | legacy | 1.3 |

#7277 makes the IR claim the untyped `run(n)` too, which turns
`tests/issue-1580.test.ts` red (`$text$mat` gone). #7143 waits for this
issue.

## Where the time goes (WAT, measured)

Legacy, per append: no allocation.
- The builder lives in locals: `$text$buf` (i16 array), `$text$len`,
  `$text$cap`, and `$text$mat` (the read cache).
- The buffer is presized from the loop bound (#1761: `n * 3`).
- `alphabet.charAt(a)` lowers to one `array.get_u` + `array.set`.
- A read materialises one `$NativeString` and caches it in `$text$mat`.

IR, per append:
- `call $__str_charAt` allocates a one-unit string;
- `call $__str_concat_owned` flattens both operands, grows in place (doubling)
  and allocates a fresh `$NativeString` wrapper every time.

The read side is already fine: one `__str_flatten` before the read loop, then
an inline `array.get_u`. The gap is entirely in the build loop: one or two
allocations and two calls per append. That holds even when the appended value
is a literal (10.4 vs 1.3 ms).

## Implementation Plan

Target: the IR lowers the #1210 builder shape to the same scalarised buffer
legacy uses, so a claimed builder loop performs no allocation per append.

1. **Module.** A builder dialect next to the existing owned-append support.
   - The shape license stays in `src/ir/string-builder-shape.ts`, which already
     detects `let s = ""` + append-only loop.
   - from-ast lowers the licensed variable to builder slots `buf/len/cap/mat`
     instead of a `string` local.
   - Each `s += e` becomes a `string.builder_append` op.
   - Each read of `s` becomes `string.builder_read` (materialise-once into
     `mat`, cleared by an append).
2. **Reuse, no duplication.**
   - The append lowering calls the legacy helpers that already emit these
     instruction sequences, i.e. buffer growth (`__str_buf_next_cap`), the
     single-code-unit `charAt` arm and the presize bound, by extracting them
     from `src/codegen/string-builder.ts` into a shared emitter. It does not
     re-implement them.
   - `__str_concat_owned` remains for appends the builder cannot see (it is
     the fallback the license already covers).
3. **Order of work.**
   1. Extract the legacy emitters (byte-identical legacy output, proven by the
      typed corpus on gc/standalone/wasi).
   2. Add the IR ops and lowering.
   3. Switch the license to the builder lowering.
4. **Acceptance.**
   - IR `run(n: number)` is equal to or faster than legacy on wasi, standalone
     and gc (ms stated per lane).
   - Legacy byte-identical for unclaimed functions.
   - Typed corpus A/B.
   - Ledger A/B.
   - Standalone test262 A/B incl. `built-ins/String` + template-literal files.
   - `tests/issue-1580.test.ts` extended to assert the IR route's builder
     locals as well as legacy's.
   - Adversarial probes: a read inside the loop, an append of a non-string,
     `s` captured by a closure (license must refuse), a `break`/`continue`
     mid-loop, an exception thrown by an appended expression.
   - **Quality:** no second copy of the buffer-growth / `charAt` emitters; the
     new ops sit beside `string.concat` in the same shape.
   - Fresh-context adversarial quality review recorded in the PR body.

### Rejected interim

Re-defaulting `JS2WASM_IR_STRING_BUILDER` to `0` (defer every builder loop to
legacy) restores the numbers at once (table above). It would reverse
#3740/#3744 and take units off the IR, which runs against the IR-replaces-legacy
direction. It is not taken unless the lead asks for a stopgap.

## Progress

`run(200000)`, median of 7 after warm-up, `dc52abf7` base. Untyped `run(n)`
is legacy; typed `run(n: number)` is IR.

| step | source | wasi | standalone | gc |
| --- | --- | --- | --- | --- |
| base | `run(n)` (legacy) | 2.0–2.9 | 2.0 | 2.0 |
| base | `run(n: number)` (IR) | 12.1 | 11.5 | 8.9 |
| 1 | `run(n)` (legacy) | 2.0 | 2.0 | 2.0 |
| 1 | `run(n: number)` (IR) | 10.6 | 9.8 | 10.1 |

**Step 1** (shared emitters, `src/codegen/string-builder-emit.ts`). Legacy
output is byte-identical:
- typed corpus 264/264 (gc/standalone/wasi);
- 234 compiles of the builder fixtures extracted from the #1004/#1210/#1580/
  #1744/#1746/#1761/#1919/#2641/#3744 tests (each on gc/standalone/wasi as
  `.ts` and `.js`);
- those nine test files: 76/78 pass. The two failures (#1004 host-assisted
  option, #3744 untyped benchmark route) fail identically on `dc52abf7`.

The step also:
- removes the duplicated growth block between the string and code-unit
  appends;
- drops `compileStringBuilderAppend`'s unused `rhsAnyStrType` parameter;
- gives `fctx.stringBuilders` the shared `StringBuilderSlots` type.
