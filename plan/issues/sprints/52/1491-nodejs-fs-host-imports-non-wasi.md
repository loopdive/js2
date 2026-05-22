---
id: 1491
sprint: 52
title: "nodejs: fs.readFileSync/writeFileSync as JS-host imports (non-WASI)"
status: done
created: 2026-05-20
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: feature
area: runtime
language_feature: host-imports
goal: nodejs-support
related: [1035, 1044]
---

# #1491 — `fs.readFileSync` / `writeFileSync` as JS host imports (non-WASI)

## Problem

Synchronous file I/O is only available via the **WASI compile path** today.
`src/codegen/expressions/calls.ts:5153` rewrites `writeFileSync(path, data)`
into the WASI helper `__wasi_write_file_sync` (#1035), and the corresponding
import is registered in `src/codegen/index.ts:3126` (`path_open` + `fd_close`).

Outside WASI target the path falls through to "Node builtin module" stubs
(#1044): `import { readFileSync } from "fs"` becomes `declare const
readFileSync: any`, and calls produce extern fallbacks that **trap at run
time** because no host import is bound.

This forces users targeting Node to either:
- Drop down to WASI mode (loses WasmGC host string interop, callback support,
  etc.), or
- Hand-write a JS wrapper that calls `fs.readFileSync` before invoking Wasm
  exports.

Neither is acceptable for a "compiled Node CLI" workflow.

## Use case

Compile a Node tool that processes a file:

```ts
import { readFileSync, writeFileSync } from "node:fs";

function main(): void {
  const input = readFileSync(process.argv[2], "utf-8");
  const upper = input.toUpperCase();
  writeFileSync(process.argv[3], upper);
}
main();
```

```sh
$ js2wasm tool.ts -o tool.wasm        # default JS-host target
$ node run.mjs tool.wasm input.txt out.txt
```

This is the canonical "compile to Wasm, run on Node" workflow that #1032
(axios-to-Wasm) implicitly assumes.

## Implementation plan

1. **`src/runtime.ts`** — wire host bindings inside `resolveImport` (the
   `node_builtin` case at ≈line 1850–1880 already resolves classes; extend it
   to bind named functions for `fs`):

   ```ts
   case "node_builtin": {
     if (intent.moduleName === "fs") {
       const fs = _getNodeRequire()?.("fs");
       return { readFileSync: fs.readFileSync, writeFileSync: fs.writeFileSync,
                existsSync: fs.existsSync, mkdirSync: fs.mkdirSync,
                statSync: fs.statSync, readdirSync: fs.readdirSync };
     }
     // existing class-resolution path...
   }
   ```

   For function-shaped imports (not constructors), introduce a new
   `node_builtin_fn { moduleName; name }` `ImportIntent` so the manifest
   knows the call shape.

2. **`src/import-resolver.ts`** — `preprocessImports` already recognises
   `fs` as a builtin; emit `declare function readFileSync(path: string,
   encoding?: string): string` / `Uint8Array` etc., instead of `any`. The
   compiler then routes calls through the host import.

3. **`src/codegen/expressions/calls.ts`** — split the WASI-only branch
   (≈line 5153) into a generic "node_builtin_fn" dispatch:
   - WASI target → existing `__wasi_write_file_sync` helper.
   - JS host target → bind to `(externref, externref) -> externref` host
     import resolved by `node_builtin_fn { moduleName: "fs", name:
     "writeFileSync" }`.

4. **String <-> Buffer marshaling**: `readFileSync(path, "utf-8")` returns a
   JS string — straight externref pass-through. `readFileSync(path)` returns
   a `Buffer`. Initial scope: only support `utf-8` (string) calls. Buffer
   return path is deferred to a follow-up (see future Buffer interop issue).

5. **Sandboxing**: gate behind `--allow-fs` CLI flag (default off), mirroring
   Deno/WASI's permission model. The compiler emits the import only if the
   flag is set; otherwise emit a compile-time error pointing the user to
   `--allow-fs`. This prevents accidental capability leakage when compiling
   third-party code.

## Acceptance criteria

```ts
import { readFileSync, writeFileSync } from "node:fs";
const data = readFileSync("./fixtures/hello.txt", "utf-8");
writeFileSync("./out/upper.txt", data.toUpperCase());
console.log(`wrote ${data.length} chars`);
```

Compiled with `js2wasm --allow-fs file.ts -o file.wasm` and run via the
generated `run.mjs`:
- Reads `hello.txt`, writes `upper.txt` with the upper-cased content.
- Without `--allow-fs`: compile-time error (do not silently fall through).

Equivalence test: round-trip a known fixture through readFileSync/writeFileSync
and verify the output matches.

## Files to modify

- `src/index.ts` — add `node_builtin_fn` `ImportIntent` variant.
- `src/runtime.ts` (≈line 1850 `node_builtin` case) — bind fs functions when
  asked.
- `src/import-resolver.ts` — refine `fs` declare-shim emission to typed
  signatures.
- `src/codegen/expressions/calls.ts` (≈line 5153) — split WASI vs. host
  dispatch.
- `src/cli.ts` — add `--allow-fs` flag.
- `src/codegen/index.ts` — propagate `allowFs` through `CompileOptions`.
- `tests/equivalence.test.ts` — new "fs host imports" block.

## Suspended Work

- **PR**: https://github.com/loopdive/js2/pull/399
- **Branch**: `issue-1491-nodejs-fs`
- **Worktree**: `/workspace/.claude/worktrees/issue-1491-nodejs-fs/`
- **HEAD SHA**: `19793b8555c1b698b9a747c7edd97b2bde1fd195`
- **State**: ci-wait
- **Done**:
  - `node_builtin_fn` `ImportIntent` variant in `src/index.ts`
  - Runtime resolver in `src/runtime.ts` binds `require(moduleName)[name]`
  - Classify `__node_fs_*` in `src/compiler/import-manifest.ts`
  - Non-WASI call-site dispatch in `src/codegen/expressions/calls.ts` (uses `ensureLateImport` so export indices stay aligned)
  - `--allow-fs` CLI flag + `CompileOptions.allowFs` threaded through `CodegenContext`
  - `wasiNodeFsFuncs` populated for both WASI and non-WASI compiles
  - `tests/issue-1491.test.ts` — 5/5 passing locally
- **Resume**: when ci-status JSON arrives at `/workspace/.claude/ci-status/pr-399.json` with matching SHA, run `/dev-self-merge 399`.
