---
id: 3337
title: "wasi: materialize process.argv through args_get instead of a silent empty vector"
status: ready
created: 2026-07-17
updated: 2026-07-17
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen, runtime, wasi
language_feature: process-argv
goal: standalone-mode
sprint: current
horizon: m
es_edition: n/a
complexity: M
related: [1035, 1482, 1490, 1532, 1801, 3340]
origin: "2026-07-17 current-origin/main PO audit, corrected by second-pass probe: process.argv validates but returns an empty import-free vector"
fable_role: spec
model: opus
assignee:
---

# #3337 - WASI `process.argv` must materialize through `args_get`

## Problem

`process.argv` under `--target wasi` reports compile success and emits valid
WebAssembly, but the module has no argv imports and silently exposes an empty
vector. A direct runtime probe returns `argc() === 0` even when the host has
arguments. The current `it.fails` test and its invalid-binary comment are stale:
the assertion now passes, so Vitest fails only because an expected failure
unexpectedly passed.

The fix should implement a real WASI argv path, not reuse the Node host-import
path and not narrow the behavior to a JS polyfill-only shortcut.

## Evidence on current `origin/main`

- `tests/real-world-wasi.test.ts:39-58` still marks `"reads process.argv as a
valid WASI module"` as `it.fails` and describes an `__str_flatten`
  invalid-binary failure. On current main, focused execution reports
  `Expect test to fail`: both `result.success` and `WebAssembly.validate` are
  now `true`.

  ```ts
  declare const process: { argv: string[] };
  export function argc(): number {
    return process.argv.length;
  }
  ```

- A current-main runtime probe of that exact source reports no module imports,
  instantiates with `buildWasiPolyfill()`, and returns `argc() === 0`. It does
  not import `wasi_snapshot_preview1.args_sizes_get` or `args_get`.
- #1801 recorded the then-observed native-string failure as out of scope at
  `plan/issues/1801-wasi-process-exit-invalid-binary.md:121-129`. The failure
  mode has changed, but the deferred argv semantics remain unimplemented.
- The implemented `process.argv` runtime path is explicitly non-WASI:
  `src/codegen/property-access-dispatch.ts:1524-1549` gates the Node
  `__get_process_argv` import on `!ctx.wasi`.
- `tests/wasi.test.ts:22-27` still lists `args_get` / `args_sizes_get` and
  `process.argv` support as out of scope.
- #1490 is done for Node host mode, not WASI: its problem statement and plan
  are Node runtime access at
  `plan/issues/1490-nodejs-process-argv-env-runtime.md:18-24` and
  `plan/issues/1490-nodejs-process-argv-env-runtime.md:72-83`.
- #1035's follow-up list points `process.argv` / `process.env` to #1044 at
  `plan/issues/1035-wasi-hello-world-compile-console.md:232-240`, but #1044 is
  not the WASI argv implementation; the pointer is stale.
- #1532 mentions `process.argv[2] -> args_get` as one case in a tests-only WASI
  syscall suite at `plan/issues/1532-wasi-syscall-unit-test-suite.md:26-33`,
  but its acceptance is "PR is tests-only" at
  `plan/issues/1532-wasi-syscall-unit-test-suite.md:69-77`. It cannot fix this
  compiler/runtime behavior.
- `src/runtime/wasi-polyfill.ts:24-35` exposes fd, env, clock, and memory
  helpers but no `args_sizes_get` / `args_get` shims or `{ args }` option.
- `src/codegen/wasi.ts:498-525` shows the current `process.env` precedent:
  WASI imports are registered for the protocol, with a separate JS-polyfill
  fast path. There is no analogous argv registration.

## Impact

WASI CLI programs cannot inspect their arguments, and the failure is silent:
valid-looking programs compile, instantiate, and observe the wrong argc rather
than receiving an unsupported-feature diagnostic. That can misconfigure real
command-line programs without any compilation or runtime signal. The stale
expected-failure sentinel also pollutes the root issue-test baseline (#3340).

## Root cause / unknowns

The exact current lowering route is unknown. It no longer reaches the old
invalid native-string path; instead, it produces an import-free value whose
length is zero. The implementation must trace where `process.argv` is replaced
or defaulted before adding `args_sizes_get` / `args_get` materialization.

Open semantic choices for the implementer:

- Whether guest `process.argv` should expose WASI argv verbatim, including
  argv0, or emulate Node's `process.argv` shape. The issue should document the
  chosen contract and keep tests consistent with it.
- Whether the first slice supports only `.length` and indexed reads, or full
  array iteration. If only a subset is shipped, unsupported operations must
  fail loudly instead of silently returning incomplete data.

## Proposed approach

1. Add a WASI `process.argv` detector beside the existing `process.env` scan in
   `src/codegen/wasi.ts`, registering `args_sizes_get` and `args_get` only when
   argv is referenced.
2. Materialize argv into the existing standalone string/array representation
   using WASI linear-memory buffers, with bounds-checked allocation and a clear
   contract for argv0.
3. Extend `buildWasiPolyfill()` with deterministic test args, for example
   `{ args?: string[] }`, and implement memory-writing `args_sizes_get` /
   `args_get` shims.
4. Keep the Node host import path in `property-access-dispatch.ts` gated to
   non-WASI mode. WASI modules should import only `wasi_snapshot_preview1`
   functions for argv unless a documented test-only polyfill import is needed.
5. Replace the stale `it.fails` sentinel with executable import, validity, and
   runtime coverage.

## Non-goals

- Reworking Node host-mode `process.argv` (#1490).
- Implementing all Node `process` APIs in WASI mode.
- Solving unrelated native-string invalid-binary buckets.
- Implementing WASI component-model `wasi:cli/environment`; this issue targets
  preview1 `args_sizes_get` / `args_get`.

## Dependencies / related issues

- Related: #1482 (`process.env`/`environ_get`) is the closest implementation
  precedent.
- Related: #1801 fixed `process.exit` invalid-binary behavior and documented
  argv as separate work.
- Related: #1490 covers Node host mode and must not be regressed.
- Related: #1532 should use this issue's implementation as the prerequisite for
  its argv syscall-suite case; it is not an implementation owner.
- Related: #3340 owns expected-failure/baseline hygiene, not argv semantics.
- No open issue other than this one owns WASI argv support.

## Why this is not already covered

#1801 explicitly deferred argv work. #1490 is Node-host-only, #1482 is env-only,
#1532 is tests-only, #3340 is gate hygiene only, and #1035's old follow-up
pointer is stale. Searches for `args_get`, `args_sizes_get`, and `process.argv`
on current `origin/main` find no implementation owner that supplies host argv
to the guest.

## Acceptance criteria

- [ ] The stale `tests/real-world-wasi.test.ts` `it.fails` sentinel and
      invalid-binary comment are replaced with a passing runtime contract test.
- [ ] `process.argv.length` under `{ target: "wasi" }` returns the documented
      argc value with a deterministic test argv source.
- [ ] At least one indexed read test, for example `process.argv[1].length` or a
      string equality check, validates that argv strings are materialized
      correctly.
- [ ] The emitted WASI module validates with `WebAssembly.validate(binary) ===
true` and instantiates with `buildWasiPolyfill({ args: [...] })`.
- [ ] The module's argv imports come from `wasi_snapshot_preview1`
      `args_sizes_get` / `args_get`, with no `env.__get_process_argv` host
      import in WASI mode.
- [ ] Existing Node host-mode tests for #1490 still pass.

## Validation plan

- Run the focused WASI argv tests added for this issue.
- Run `pnpm test tests/real-world-wasi.test.ts tests/wasi.test.ts tests/issue-1490.test.ts`.
- Run a WAT/import inspection asserting only expected WASI argv imports are
  introduced when argv is referenced.
- Run the standard issue-specific test gate if the implementation adds
  `tests/issue-3337.test.ts`.

## Implementation Plan

Author: Fable architect (spec-only). Implementer: Opus. All line numbers are
against `origin/main` at spec time (2026-07-17); re-grep before editing.

### Root cause

`process.argv` under `--target wasi` reaches
`tryProcessHostMemberRead` in
`src/codegen/property-access-dispatch.ts:1528-1553`, but that whole Node
host-import branch is gated `if (!ctx.wasi && …)`. In WASI mode the gate is
false, so the branch is skipped and the access falls through to
`PA_FALLTHROUGH`. Downstream generic lowering resolves `process` to a
ref-null/empty value and `.argv` to an empty `string[]` vec, so `.length`
reads a zero-length vec — no import, no diagnostic. There is **no** WASI argv
materialization anywhere on main (`args_get` / `args_sizes_get` appear only in
out-of-scope test lists), so the value is structurally empty.

### Chosen contract (resolves the issue's open questions)

- **argv shape = WASI verbatim.** Guest `process.argv[0]` is the WASI program
  name (argv0), `process.argv[1..]` are the user arguments, exactly as the host
  passes them through `args_get`. We do **not** synthesize Node's
  `[execPath, scriptPath, …]` shape — that would require inventing an
  execPath/scriptPath the WASI host never provided. Document this in a comment
  and in the test names. (A future issue may add a Node-emulation shim; out of
  scope here.)
- **First slice = full array materialization, not a `.length`-only shortcut.**
  We materialize the complete `string[]` vec once, so `.length`, `argv[i]`,
  iteration, `for…of`, `.join`, etc. all work through the existing vec lowering
  with no special-casing. This is simpler and less surprising than a subset that
  must "fail loudly" on unsupported ops.
- **argv is materialized once and cached** in a module global. WASI argv is
  immutable for the process lifetime; re-running `args_get` on every reference
  would re-bump the linear arena (which never resets — see
  `linear-type-reservations.ts:36`) and leak pages.

### Memory layout for `args_get` materialization

Linear-memory map already in use (do not disturb):

| Region           | Const                                | Page |
| ---------------- | ------------------------------------ | ---- |
| page-0 reserved  | —                                    | 0    |
| stdin buffer     | `WASI_STDIN_BUF_START` = 64 KiB      | 1    |
| fd_write scratch | `WASI_WRITE_SCRATCH_START` = 128 KiB | 2    |
| guard            | —                                    | 3    |
| u8 arena (bump)  | `LINEAR_U8_ARENA_START` = 256 KiB    | 4+   |

`args_get(argv_ptrs, argv_buf)` writes into linear memory: a table of `argc`
i32 pointers at `argv_ptrs`, and the NUL-terminated UTF-8 argument strings at
`argv_buf`. `args_sizes_get(argc_ptr, buf_size_ptr)` writes the two sizes.

**Allocation strategy:** bump-allocate the transient buffers from the page-4 u8
arena via the existing arena allocator (the `__lin_u8_arena_ptr` global +
page-grow idiom in `linear-type-reservations.ts:29-36`; reuse
`emitU8ArenaAlloc`/equivalent — grep `linearU8ArenaGlobalIdx`). Layout within
one allocation of `align8(8 + argc*4 + buf_size)` bytes:

- `+0`: `argc` out-param (i32) for `args_sizes_get`
- `+4`: `buf_size` out-param (i32) for `args_sizes_get`
- `+8`: `argv_ptrs` table (`argc * 4` bytes) for `args_get`
- `+8 + argc*4`: `argv_buf` (`buf_size` bytes) for `args_get`

Because `argc`/`buf_size` are only known after `args_sizes_get`, do it in two
allocations: (1) alloc 8 bytes, call `args_sizes_get`, read `argc`+`buf_size`;
(2) alloc `align8(argc*4 + buf_size)` for the pointer table + string buffer,
call `args_get`. Guard both syscalls' errno return: on non-zero errno, produce
an empty vec (argc treated as 0) rather than trapping — a defensive fallback,
not the happy path.

### String encoding under nativeStrings

`--target wasi` auto-enables `nativeStrings` (WasmGC i16 arrays, see CLAUDE.md).
The argv bytes land in linear memory as **UTF-8**; each argument must become a
`$NativeString` (FlatString) — a `struct (len i32) (off i32) (data (ref
$__str_data)))` where `$__str_data` is the i16 code-unit array (see
`native-strings.ts:71` `struct.new $NativeString(len, off, data)` and the
3-field reads at `native-strings.ts:1463-1470`).

**Reuse the existing UTF-8 → UTF-16 decoder.** `native-strings-core.ts:390-600`
already decodes a `$__str_data_u8` (WasmGC i8 array, `ctx.utf8StrDataTypeIdx`)
into a `$NativeString`, handling 1/2/3/4-byte sequences and surrogate pairs.
The one impedance mismatch: that decoder reads from a **WasmGC byte array**, but
`args_get` writes to **linear memory**. Two options for the implementer,
preferred first:

1. **Copy-then-decode (lowest risk):** for each argument, copy its
   `[ptr, ptr+len)` bytes from linear memory into a fresh
   `array.new_default $__str_data_u8(len)` (loop `array.set` / `i32.load8_u`),
   then call the existing decode helper. `len` = C-string length: scan to the
   NUL at `argv_buf`, or compute `argv_ptrs[i+1] - argv_ptrs[i] - 1` for
   `i < argc-1` and scan-to-NUL for the last. Factor the existing decoder's core
   into a callable helper if it is currently inlined only into the
   `Utf8String`-field path.
2. **New linear-memory decoder variant:** clone the decode loop to read
   `i32.load8_u` from a linear base pointer instead of `array.get_u`. Avoids the
   copy but duplicates ~150 lines; only do this if profiling shows the copy
   matters (it will not for typical argv).

### Changes

**File: `src/codegen/wasi.ts`**

1. Detection (near the `needsEnviron` flag block, declared ~line 180; set in
   the `visit()` walker ~line 321 alongside the `process.env` detector):
   add `let needsArgv = false;` and, in `visit`, detect a `process.argv`
   reference — a `PropertyAccessExpression` whose `.expression` is the
   identifier `process` (not shadowed) and `.name.text === "argv"`. Mirror the
   `process.env` shape check at 324-334. Cover both bare `process.argv` and
   member/element forms (`process.argv.length`, `process.argv[i]`) — detecting
   the inner `process.argv` PropertyAccess covers all three because it is a
   subtree of each.

2. Import registration (add a block mirroring the `needsEnviron` block at
   `wasi.ts:498-526`, and register BEFORE any defined helpers to respect the
   late-import funcidx-shift discipline — CLAUDE.md "addUnionImports"):

   ```
   if (needsArgv) {
     // args_sizes_get(argc_ptr: i32, buf_size_ptr: i32) -> errno (i32)
     const argsSizesType = addFuncType(ctx, [{kind:"i32"},{kind:"i32"}], [{kind:"i32"}], "$wasi_args_sizes_get");
     addImport(ctx, "wasi_snapshot_preview1", "args_sizes_get", { kind:"func", typeIdx: argsSizesType });
     ctx.wasiArgsSizesGetIdx = ctx.funcMap.get("args_sizes_get")!;
     // args_get(argv_ptrs: i32, argv_buf: i32) -> errno (i32)
     const argsGetType = addFuncType(ctx, [{kind:"i32"},{kind:"i32"}], [{kind:"i32"}], "$wasi_args_get");
     addImport(ctx, "wasi_snapshot_preview1", "args_get", { kind:"func", typeIdx: argsGetType });
     ctx.wasiArgsGetIdx = ctx.funcMap.get("args_get")!;
   }
   ```

   Note: unlike `process.env` (which additionally registers an `env.__wasi_env_get_str`
   host shortcut), argv registers **ONLY** the two `wasi_snapshot_preview1`
   imports — the acceptance criteria forbid an `env.*` host import for argv.

3. Materialization helper `emitWasiArgvMaterialize(ctx)` (new defined function,
   e.g. `__wasi_argv_vec`, returning `(ref $NativeStringVec)`), plus a cache
   global `ctx.wasiArgvGlobalIdx` (`(mut (ref null $NativeStringVec))`,
   init `ref.null`). Body:
   - if global non-null → return it (`ref.as_non_null`);
   - alloc 8-byte scratch; `call $args_sizes_get`; branch on errno (non-zero →
     argc=0);
   - read `argc`, `buf_size`; alloc `align8(argc*4 + buf_size)`;
     `call $args_get`; branch on errno;
   - `array.new_default` the vec backing array of `argc` `(ref null
$NativeString)` elements (fetch the string-elem vec type — see the vec
     layout note below);
   - loop `i` in `[0, argc)`: load `argv_ptrs[i]`, compute cstr length, decode
     to `$NativeString` (per the encoding section), `array.set`;
   - `struct.new $NativeStringVec(argc, dataArray)`; store into the global;
     return it.
     Register the helper name in `ctx.funcMap` and register the vec type so its
     type index is stable (see `ensureNativeStrVec`/`nstrVec*` usage in
     `native-strings.ts`).

Add the new `ctx` fields (`wasiArgsSizesGetIdx`, `wasiArgsGetIdx`,
`wasiArgvGlobalIdx`, and any helper funcIdx) to the `CodegenContext` type
(same place `wasiEnvGetStrIdx` / `wasiEnvironGetIdx` are declared — grep
`wasiEnvGetStrIdx`), initialized to `-1` / `undefined`.

**File: `src/codegen/property-access-dispatch.ts`**

4. Add a WASI argv short-circuit **before** the `!ctx.wasi` Node branch
   (i.e. insert right before line 1528, mirroring the `process.env` WASI
   short-circuit at `property-access-dispatch.ts:1022-1046`). Guard:
   `ctx.wasi && ts.isIdentifier(expr.expression) && expr.expression.text ===
"process" && propName === "argv"` and NOT shadowed (reuse the `isShadowed`
   check at 1534). Emit `call $__wasi_argv_vec` (the materialize helper) and
   return the vec's ValType (`{ kind: "ref", typeIdx: nativeStrVecTypeIdx }`).
   From there, `.length` and indexed reads lower through the existing vec
   member/element paths with no further change. Ensure the helper +
   imports are registered lazily here too (call
   `emitWasiArgvMaterialize(ctx)` / the ensure-fn) so a `process.argv` that the
   `visit()` scan somehow missed still wires up — but the scan in step 1 is the
   primary trigger.

Vec layout reference: a `string[]` vec is
`struct (field 0: len i32) (field 1: data (ref (array (ref $NativeString))))`
— confirmed by `vec-access-exports.ts:184` (`fieldIdx:0` = len) and `:404`
(`fieldIdx:1` = data array); `getArrTypeIdxFromVec` maps vec→backing-array
type. Produce the SAME vec type the compiler already uses for `string[]` so
`.length`/indexing/iteration reuse existing lowering.

**File: `src/runtime/wasi-polyfill.ts`**

5. Extend the options bag to `{ env?: …; args?: string[] }` and add two shims
   mirroring `environ_sizes_get` / `environ_get` (`wasi-polyfill.ts:215-249`):
   ```
   args_sizes_get(argcPtr, bufSizePtr): number  // write argsSource.length + total UTF-8 bytes (KEY\0 style, +1 NUL each)
   args_get(argvPtrsPtr, argvBufPtr): number     // write i32 ptr table + NUL-terminated UTF-8 args
   ```
   Source: `argsSource = options?.args ?? []` (do NOT default to Node's
   `process.argv` — tests must be deterministic; an explicit `{ args: [...] }`
   is the contract). Add `args_sizes_get`/`args_get` to the returned object's
   type signature (lines 24-36). No `env`-namespace addition for argv.

### Wasm IR sketch (materialize helper, abridged)

```wasm
;; cached?
global.get $__wasi_argv_cache        ;; (ref null $NStrVec)
ref.is_null
i32.eqz
if (result (ref $NStrVec))
  global.get $__wasi_argv_cache
  ref.as_non_null
else
  ;; scratch8 = arena_alloc(8)
  ;; args_sizes_get(scratch8, scratch8+4) ; errno check -> argc=0 on failure
  ;; argc = i32.load scratch8 ; bufSize = i32.load (scratch8+4)
  ;; buf  = arena_alloc(align8(argc*4 + bufSize))
  ;; args_get(buf, buf + argc*4)   ; ptr table then string bytes ; errno check
  ;; data = array.new_default $NStrArr (argc)
  ;; loop i in [0,argc): ptr = i32.load (buf + i*4)
  ;;   len = cstrlen(ptr) ; copy [ptr,ptr+len) -> u8arr ; decode -> $NativeString
  ;;   array.set $NStrArr data i <str>
  ;; vec = struct.new $NStrVec (argc, data)
  ;; global.set $__wasi_argv_cache vec
  ;; vec
end
```

### Edge cases

- **argc == 0** (host passed no args, or errno failure): materialize a
  zero-length vec — `.length` is `0`, no trap. `array.new_default` with count 0
  is valid.
- **Empty-string argument** (`""`): `len == 0`, decode loop body runs 0
  iterations, produces an empty `$NativeString`. Verify the C-string length
  computation does not underflow (a `""` arg is a single NUL byte).
- **Non-ASCII / multibyte args** (UTF-8): the decoder must handle 2/3/4-byte
  sequences and astral code points (surrogate pairs) — the existing
  `native-strings-core.ts` decoder already does; that is why we reuse it rather
  than a naive byte→char copy.
- **`args_sizes_get` / `args_get` errno != 0**: treat as argc=0 (empty vec),
  never trap. Real hosts return 0; the guard is belt-and-suspenders.
- **`process` shadowed by a local** (`const process = …`): the WASI branch must
  be skipped (reuse `isShadowed`), falling through to the ordinary member read.
- **Repeated `process.argv` references**: must return the SAME cached vec (one
  `args_get` call per module run), not re-materialize — otherwise the arena
  leaks pages and identity comparisons differ.
- **argv referenced but never `.length`/indexed** (bare `process.argv` passed to
  a function): still materializes the full vec — correct, since the callee may
  index it.
- **Late-import funcidx shift**: registering `args_sizes_get`/`args_get` after
  defined helpers would corrupt `__str_*` indices. Register in the early WASI
  import pass (step 2), same discipline as `environ_*` / `random_get`.

### Test files to add / update

- **`tests/real-world-wasi.test.ts:46-58`** — remove the `it.fails` and the
  stale KNOWN-BUG comment (39-45). Replace with a passing test: compile
  `return process.argv.length`, assert `result.success`,
  `WebAssembly.validate(binary) === true`, and that the WAT contains
  `args_get` + `args_sizes_get` and does NOT contain `__get_process_argv`.
- **`tests/issue-3337.test.ts`** (new) — runtime contract:
  - `argc()` returns the documented value with
    `buildWasiPolyfill({ args: ["prog", "a", "b"] })` → `3`.
  - indexed read: `process.argv[1]` materialized correctly (e.g. compile a fn
    returning `process.argv[1].length` → `1` for arg `"a"`; or a string-equality
    check).
  - a non-ASCII arg (e.g. `"café"`) round-trips to the right `.length`
    (accounts for UTF-16 code-unit count).
  - import inspection: emitted module imports ONLY
    `wasi_snapshot_preview1.args_sizes_get` / `.args_get` for argv, and has NO
    `env.__get_process_argv`.
- **`tests/wasi.test.ts:22-27`** — drop `args_get`/`args_sizes_get`/`process.argv`
  from the "out of scope" list.
- Confirm **`tests/issue-1490.test.ts`** (Node host mode) still passes — the
  `!ctx.wasi` Node branch is untouched.

### Risks / conflicts

- Touches `src/codegen/wasi.ts` and `src/codegen/property-access-dispatch.ts`.
  Any concurrent WASI work (timers/#2632, stdin reactor) also edits `wasi.ts`
  import-registration region — coordinate to avoid a `[CONFLICT]` on the import
  block. The property-access edit is localized to the `process.*` region.
- Do NOT regress the `process.env` WASI path (`property-access-dispatch.ts:1030`)
  — argv is an additive sibling branch, not a replacement.
- Keep the change WasmGC-backend-only; the linear backend (`src/codegen-linear/`)
  is out of scope for this slice.
