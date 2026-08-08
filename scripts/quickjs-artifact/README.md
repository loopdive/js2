# QuickJS WASI artifact (#4236 slice 1)

Builds `libquickjs.wasm` — a **standalone wasm32-wasip1 reactor module** that
exposes QuickJS to a *peer wasm module* over one shared linear memory, with **no
JS host and no emscripten glue**.

This is the artifact the #4236 spike could not produce. The spike proved the
one-heap identity claim using `quickjs-emscripten`, whose module imports
`env.emscripten_*` — unusable on the WASI lane, which is the entire premise of
the issue. This build imports **only** five `wasi_snapshot_preview1` functions.

```bash
bash scripts/quickjs-artifact/build.sh            # -> .tmp/quickjs-artifact/
node scripts/quickjs-artifact/probe/probe.mjs     # R2/R3/R4 acceptance probes
```

`.github/workflows/quickjs-wasi-artifact.yml` runs the same script in CI
(`workflow_dispatch` only until slice 2 has a consumer).

## Files

| file | role |
| --- | --- |
| `qjs_shim.c` | the wrapper ABI js2wasm codegen targets. Read its header comment first — it is the ABI contract. |
| `build.sh` | pinned, reproducible build: wasi-libc sysroot → quickjs core → shim → link → ABI extraction. |
| `extract-abi.mjs` | reads QuickJS's tag/encoding constants **out of the built module** into `qjs-abi.json`. |
| `wasi-stub.mjs` | the five WASI imports, for Node-side probes and CI checks. |
| `probe/peer.c` | stand-in for js2wasm-compiled code: a separate module that imports the artifact's memory + wrappers. |
| `probe/probe.mjs` | R2 (eval round-trip), R3 (object identity + tag extraction), R4 (sizes + timings). |

## The four things this build establishes

1. **No wasi-sdk install is needed.** wasi-libc builds with stock clang 18;
   only the wasm32 `compiler-rt` builtins must be fetched (Ubuntu ships none),
   from a pinned wasi-sdk release.
2. **QuickJS core is WASI-clean.** `dtoa.c libregexp.c libunicode.c quickjs.c`
   compile for `wasm32-wasip1` with zero patches and zero warnings. No setjmp:
   QuickJS returns `JS_EXCEPTION` sentinels, so no Asyncify and no `libsetjmp`.
3. **The peer module can share the heap safely** — but only under discipline.
   `probe/peer.c` links to **zero data segments and zero shadow-stack traffic**
   (verified: no `DATA` section, no `global.get`/`global.set`), so the only
   bytes it touches are ones it got from the artifact's `malloc`. An active
   data segment or a spilling shadow stack would write at a link-time offset
   straight through QuickJS's static data.
4. **QuickJS's internal encodings stay out of the compiler.** They are exported
   by the artifact and extracted at build time into `qjs-abi.json`.

## Pins

| | |
| --- | --- |
| quickjs-ng | `954dc53628e36891f93c359aa60895c2ae3dac6b` (v0.16.1) |
| wasi-libc | `8d8348ec24253d0638a693b8af82445c13d92d32` |
| builtins | wasi-sdk-34-rc.1 `libclang_rt-34.0-rc.1.tar.gz` |

Override with `QUICKJS_NG_REF` / `WASI_LIBC_REF` / `BUILTINS_URL`; `OPT=-Oz`
trades ~23% speed for ~385 KB.
