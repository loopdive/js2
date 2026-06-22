---
id: 2609
title: "WASI native __defineProperty_value bakes undefined funcIdx (host-free __object_is gate)"
status: done
sprint: Backlog
assignee: ttraenkler/agent-a0f3a95
completed: 2026-06-22
feasibility: hard
reasoning_effort: max
external_ref: loopdive/js2#389
---

<!-- Re-allocated from hand-picked ids #2588 then #2602, both of which collided
     with landed work on main (#2588 = standalone RegExp named groups, #2602 =
     for-of rest-element). Fresh id #2609 via claim-issue.mjs --allocate (#2531). -->

# #2609 — `--target wasi` hard emit error at `__defineProperty_value`

## Symptom

Compiling an esbuild-bundled Native Messaging host with `--target wasi --wit`
fails with a HARD error:

```
Binary emit error: Codegen error: function index out of range — undefined
(valid: [0, 164)) at function '__defineProperty_value'.
This is the late-import index-shift class (#2043): a captured index went stale
across a deferred flushLateImportShifts/addUnionImports/addStringImports shift,
or a map lookup failed and baked -1/undefined.
```

Reported by an external user (loopdive/js2#389).

## Reproduction

Original (esbuild bundle):
```
npx esbuild examples/native-messaging/nm_js2wasm.ts --bundle --format=esm --platform=node --outfile=.tmp/nm_bundled.js
npx tsx src/cli.ts .tmp/nm_bundled.js --wit --target wasi -o .tmp/
```

Minimal (no esbuild, no defineProperty) — `process.stdin.read(buf, offset)` into a
typed buffer + `process.stdout.write` is enough to pull in the native `$Object`
runtime and reach the unconditionally-registered `__defineProperty_value` block:
```ts
declare const process: { stdin: { read(b: Uint8Array, o?: number): number }, stdout: { write(c: Uint8Array): void } };
function readExact(buf: Uint8Array, n: number): boolean {
  let got = 0;
  while (got < n) { const r = process.stdin.read(buf, got); if (r <= 0) return false; got = got + r; }
  return true;
}
export function main(): void {
  const header = new Uint8Array(4);
  if (!readExact(header, 4)) return;
  process.stdout.write(header);
}
```
`npx tsx src/cli.ts min.ts --target wasi -o out/` → same crash.

## Root cause

`ensureObjectRuntime` (`src/codegen/object-runtime.ts`) registers the native
data-descriptor define helper `__defineProperty_value` **unconditionally** (it is
always pulled in when the object runtime is). Its #2042-S4
ValidateAndApplyPropertyDescriptor (§10.1.6.3) preflight bakes a direct
`call __object_is` for the SameValue value-change check (the
"Cannot assign to read only property" guard).

But `__object_is` was registered under `if (ctx.standalone)` only. **WASI is
host-free too** — `--target wasi` sets `ctx.wasi = true` but leaves
`ctx.standalone = false` (the canonical host-free predicate across codegen is
`ctx.standalone || ctx.wasi`; see `any-helpers.ts`, `array-methods.ts`,
`binary-ops.ts`). So under WASI:

- the `if (ctx.standalone)` `__object_is` block was **skipped** →
  `ctx.funcMap.get("__object_is")` returned `undefined`;
- the unconditional `__defineProperty_value` block still ran and baked an
  **undefined** funcIdx into its emitted `call` → the binary emitter's index
  guard fired "function index out of range — undefined at __defineProperty_value".

This is a dependency-gate mismatch, NOT a late-import index shift: an
unconditionally-registered native helper depended on a helper gated more
narrowly than itself. Introduced by #2042 S4 (commit `b03ac8ca7`), which added
both the `if (ctx.standalone)` `__object_is` registration and the S4 preflight's
`call __object_is` inside the always-on define helper.

## Fix

`src/codegen/object-runtime.ts` — change the `__object_is` registration gate from
`if (ctx.standalone)` to `if (ctx.standalone || ctx.wasi)`. WASI runs the native
`__defineProperty_value` body (no JS host), so it must also register the helper
that body calls. The host-only path (`!ctx.standalone && !ctx.wasi`) still owns
`__object_is` via its JS import, so host output stays byte-identical.

### Why not patch the call site instead?

Guarding the S4 `call __object_is` like `withKeyCoercion`
(`idx === undefined ? skip` ) would silently DROP the spec-correct
ValidateAndApplyPropertyDescriptor SameValue check in WASI, diverging WASI
`defineProperty` redefine semantics from standalone. Registering the dependency
(so WASI gets the same validation) is the correct, non-lossy fix.

### Out of scope (separate latent WASI gap)

`__to_property_key` (object-runtime.ts ~line 450) is also `if (ctx.standalone)`,
and `number_toString` / the array-like arms are gated on `ctx.standalone` at
~line 191. These only affect *numeric-key* `defineProperty` correctness under
WASI (an `illegal cast` runtime trap, not the funcIdx emit crash) and pulling
them in for WASI cascades through several more standalone-gated registrations.
Left untouched here to keep the crash fix minimal and low-risk; tracked
separately if numeric-key defineProperty under WASI is needed.

## Verification

- Minimal repro + original esbuild bundle (`nm_bundled.js`) both compile to a
  binary that passes `WebAssembly.validate` (27,159 bytes) — no more emit error.
- `--target standalone` defineProperty data descriptor still executes and returns
  `42` (S4 SameValue path intact).
- Host mode (`Object.defineProperty` stays a JS import) compiles + validates —
  unchanged.
- Regression tests: `tests/issue-2609-wasi-defineproperty-funcidx.test.ts` (4
  cases — framed stdin loop, esbuild-prelude-like bundle, standalone, host).
- No regressions in `define-property-patterns`, `issue-2042-s3-object-is`,
  `issue-1629-S6`, `issue-1127-samevalue`, `issue-2042-r2-topropkey-object`,
  `issue-1653-wasi-process-stdin-read`, `issue-1654-wasi-dataview-arraybuffer`,
  `issue-1618-1651-wasi-stdout` (52 tests pass).
