---
id: 7291
title: "IR string-builder loop is 6–10× slower than legacy's #1210/#1580 buffer (`$text$buf`/`$text$mat`)"
status: done
sprint: current
created: 2026-11-06
updated: 2026-11-07
completed: 2026-11-07
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
related: [1210, 1580, 1761, 3740, 3744, 3518, 7277]
assignee: "ttraenkler/c-r7"
loc-budget-allow:
  # 2026-11-07 (#7291 step 2). The lowering, verifier rule and slot-role
  # predicate live in their own modules; these are the remaining seams.
  # nodes.ts: the role field, and collectTerminatorUses folded in from the
  # identical copies in verify.ts and lower-generic.ts. integration.ts: the
  # native resolver hook, which needs the codegen helper registry.
  - src/ir/core/nodes.ts
  - src/ir/integration.ts
  - src/ir/from-ast.ts
  - src/ir/lower-generic.ts
  # 2026-11-07 (#7291 review nit 2): +6, `nativeStringBuilderTypes`, the one
  # source of the builder type indices for legacy and the IR resolver; it sits
  # beside `ensureNativeStringHelpers`, which integration.ts already imports.
  - src/codegen/native-strings.ts
func-budget-allow:
  # 2026-11-07 (#7291 step 2): one-line hooks to src/ir/lowering/string-builder.ts.
  - src/ir/lower-generic.ts::lowerIrFunctionBody
  - src/ir/lower-generic.ts::emitInstrTree
  - src/ir/integration.ts::makeResolver
import-cycles-allow:
  - ir->backend: 26 # 2026-11-07 (#7291): +1 edge over base 25 — ir/backend/wasmgc-emitter.ts (destined for backend-wasmgc) calls the shared builder sequences in backend/wasmgc/lowering/wasm-string-builder.ts
  - codegen->ir: 305 # 2026-11-07 (#7291 step 3): +2 edges over base 303 — legacy codegen/string-builder.ts imports the shared presize analysis (ir/analysis/string-builder-presize.ts) and the shared isFunctionScopeBoundary (ir/analysis/ast-scope.ts, replacing its private copy; review N1); #7157 grants the same pair, so whichever merges second re-states its grant as base+its own delta
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

Target: a claimed builder loop is lowered to the same scalarised buffer
legacy uses, with no allocation per append. No new IR ops (design review
2026-11-07: new `string.builder_*` ops would touch 15+ files and every
backend, ~700–900 LOC).

**IR today** (`run(n: number)`, standalone):
- `text` is a slot (`$slot_text`, `ref null $AnyString`).
- Each `text += e` is `slot.read` → `string.concat{owned-append}` →
  `slot.write` (from-ast.ts compound-assignment string arm; licensed by
  `collectOwnedStringAppendSymbols`).
- `alphabet.charAt(a)` is `string.char_at`.
- The read loop snapshots the slot once through `__str_flatten`.

### Step 1 — shared emitters (done, `ebbdafbb`)
`src/backend/wasmgc/lowering/wasm-string-builder.ts`.

### Step 2 — slot role + WasmGC scalar replacement
1. **IR fact.** `IrSlotDef` (core/nodes.ts) gains
   `stringBuilder?: { presize?: { capacitySlot, unitsPerIter } }`.
   `IrFunctionBuilder.declareSlot` accepts it. This is the same
   producer-declares-role pattern as `concatMode` and `i32Storage` (#3741).
2. **from-ast** marks the slot in `bindLocalName` when:
   - its symbol is in `cx.ownedStringAppendSymbols`, and
   - the function is neither async nor a generator.

   Captured variables are ref cells, so they never qualify.
3. **Verifier** (runtime/verify.ts, beside the slot checks). A builder slot's
   writes are either the initial `string.const ""`, or a single-use
   `string.concat{owned-append}` whose `lhs` is a single-use `slot.read` of
   the same slot. A builder slot in a function with an `asyncPlan` is refused.
4. **Resolver hook** in backend/lower-contracts.ts:
   `resolveStringBuilderLowering?()` → `{ types, flatten, nextCap }`.
   - integration.ts answers it only when the frozen owned-append concat
     provider is the native arm.
   - Linear, bytecode, porffor and the host-string lane keep today's path
     byte-for-byte.
5. **Lowering**, a new `src/ir/lowering/string-builder.ts` beside
   `string-operations.ts`, delegated to from lower-generic's slot-local
   allocation and its `slot.read`/`slot.write` arms:
   - a builder slot gets `buf/len/cap/mat` locals;
   - the init write → init (or presized alloc + reset);
   - a concat write → append (rhs only);
   - other reads → the cached read;
   - `string.len` of a single-use builder `slot.read` → `len`.
   - **Code-unit fast path**, for a single-use rhs:
     - a 1-unit `string.const` → `i32.const`;
     - `string.char_at` → a bounds-checked `array.get_u` on the receiver's
       flat data. The bounds check is needed because `charAt` out of range is
       `""`. Legacy omits it; the IR must not.
6. **Inliner.** Nothing to do: `canInline` rejects every loop-bearing callee,
   so a builder slot never reaches `appendCalleeSlots` (review, 2026-11-07).

### Step 3 — presize (#1761)
- Move the checker-only part of legacy's `computePresizeInfo` into
  `src/ir/analysis/string-builder-presize.ts`, shared by legacy and IR.
- from-ast writes the clamped capacity into a sibling i32 slot.
- Keep the grow guard on the IR path: `n = 2.5` with `i < n` runs 3
  iterations, while the truncated bound gives 2. Measure the guard's cost.

### Acceptance
- **Performance:** IR `run(n: number)` is equal to or faster than legacy on
  wasi, standalone and gc (ms per step in the table below).
- **Byte identity:**
  - legacy byte-identical;
  - the linear/bytecode/porffor backends byte-identical;
  - typed corpus A/B.
- **Conformance and routing:**
  - ledger A/B;
  - standalone test262 A/B incl. `built-ins/String` and template-literal
    files;
  - `tests/issue-1580.test.ts` extended to assert the IR route's builder
    locals.
- **Adversarial probes:**
  - `charAt` out of range or with a NaN index;
  - a non-string rhs;
  - an exception thrown mid-append;
  - `break`/`continue`;
  - a closure capture (refused);
  - async/generator (refused);
  - a surrogate pair split by `charAt`.
- **Quality:**
  - every instruction sequence comes from `backend/wasmgc/lowering/wasm-string-builder.ts`;
  - the role check lives in one verifier arm;
  - fresh-context adversarial review recorded in the PR body.

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
| 2 | `run(n)` (legacy) | 2.0 | 2.0 | 2.1 |
| 2 | `run(n: number)` (IR) | 4.4 | 3.6–3.9 | 3.7–3.9 |
| 3 | `run(n)` (legacy) | 2.0–2.1 | 2.1–2.2 | 2.1 |
| 3 | `run(n: number)` (IR) | 1.6–1.8 | 1.6–2.2 | 1.7 |

**Step 1** (shared emitters, `src/backend/wasmgc/lowering/wasm-string-builder.ts`). Legacy
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

**Step 2** (slot role + WasmGC scalar replacement), measured 2026-11-07:

- **Route:** IR `run(n: number)` now keeps `text` as buffer locals, with no
  `__str_concat_owned` or `__str_charAt` call in the loop.
- **Speed:** 2.5–3× faster than step 1, and about 1.8× slower than legacy.
  The remaining gap is legacy's presized buffer, which removes the growth
  check (step 3), plus a per-append `__str_flatten` of the constant
  `charAt` receiver.
- **Byte identity:**
  - typed corpus 264/264;
  - the 27 changed builder-fixture compiles are all modules with an
    IR-claimed builder function. Besides that function, the only changes are
    helpers that became dead (stubbed `unreachable` by the existing pass) or
    live, and inliner counter names (`__inl3` → `__inl2`) shifting because
    one fewer call is inlined.
- **Not marked:** linear, bytecode and porffor never see the hook. A
  counted append (#3518) keeps its single `string.repeat`.
- **Tests:**
  - new `tests/issue-7291-ir-string-builder-locals.test.ts`: 18/18 on
    standalone and gc. Cases: the #1580 shape; `charAt` out of range and at
    NaN; a split surrogate pair; multi-unit appends across growth;
    `break`/`continue`; a throwing append; a closure read; a generator; a
    number append, which the IR refuses on its own.
  - `tests/issue-3744-*` now asserts the buffer locals instead of
    `__str_concat_owned`.
- **Cleanup:** `collectTerminatorUses` is folded into `core/nodes.ts` from
  identical copies in `verify.ts` and `lower-generic.ts`.

**Step 2 review** (PR #7156, fresh-context review, 2026-11-07): approved with
nits.
- **Standalone test262 A/B**, 202 files (every 8th `built-ins/String` file
  plus 50 `template-literal` files): 190 pass / 10 fail / 2 CE on base
  `dc52abf7` and on head, with the same 12 non-pass files.
- **Nits folded in:**
  - one scratch type (`Pick<StringBuilderScratch, …>`) and one helpers type;
  - the type-index literal now comes from `nativeStringBuilderTypes`
    (`codegen/native-strings.ts`), used by legacy and by the IR resolver;
  - the `StringBuilderInfo` alias is gone;
  - the unreachable inliner role copy is reverted.
- **Deferred:**
  - scratch locals are allocated eagerly per builder slot (7 extra);
  - the lowering trusts the verifier's `""` / single-use contract, so a
    mismatch throws (fails closed).
- **Moved:** the shared sequences now live in
  `src/backend/wasmgc/lowering/wasm-string-builder.ts`, the canonical WasmGC
  lowering home. That satisfies the compiler-boundaries inventory and removes
  the codegen→ir import edge; the remaining +1 is `ir->backend`.
- **Pre-existing legacy builder bugs** found by the review: filed as #7300.

**Status:** stays `in-progress`. Step 3 (presize, #1761) is the next PR,
stacked on #7156. Acceptance "IR ≥ legacy" is not met yet: 3.4–4.0 ms vs
2.1 ms.

**Step 3** (PR stacked on #7156, 2026-11-07). Commits:

1. A legacy fix (#7300 item 4): presize by `ceil(bound)`.
2. The shared presize analysis moves to
   `src/ir/analysis/string-builder-presize.ts`.
3. A legacy fix (#7300 item 5): a bound written by a closure, or by any
   assignment operator, is not presized.
4. IR presize: a sibling `$bound` slot; no growth check.
5. The `charAt` receiver is tested with `ref.test` instead of calling
   flatten on every append.

Clean machine, median ms, build phase only, n = 2M:

| appends | legacy wasi / standalone / gc | IR wasi / standalone / gc |
| --- | --- | --- |
| `charAt` ×2 + `";"` | 13.9 / 13.8 / 14.4 | 9.0 / 8.9 / 9.4 |
| literals only | 6.3 / 7.1 / 6.3 | 8.7 / 6.9 / 8.9 |

- **Acceptance** "IR ≤ legacy on #1580 `run(n: number)`": **met** on all three
  lanes (table above).
- **Literal-only build loops:** still 1–2.6 ms slower than legacy at 2M on
  wasi/gc. This was not traced further; it is a follow-up candidate.
- **Standalone test262 A/B,** the same 202 files: 190 pass / 10 fail / 2 CE,
  with the same 12 non-pass files as base `dc52abf7`.
- **Equivalence gate:** no new regressions; 2 baseline failures now pass.
- **Not taken (review nit, #7156):** moving the slot/scratch shapes into
  `ir/backend/string-contract.ts`. The clean `backend-wasmgc` module would
  then import an unmigrated (mixed) one, which the compiler-boundaries gate
  rejects.

**Known gaps (presize analysis), from the #7168 reviews:**

- **`arguments[i] = …` aliasing:** a sloppy-mode parameter bound written through
  `arguments` is not modelled. The presize is refused there, because any
  `arguments` reference refuses, but the value itself is wrong (3, node 5).
  This is pre-existing and independent of the presize.
- **Script-mode `.js` file, top-level `var` bound:** the variable is a
  `globalThis` property, so `globalThis.n = 5` (or `this.n`, `window.n`) writes
  it without naming the binding. The write search does not see that. Untested
  and not blocking: the compiled inputs are modules in every measured case.
