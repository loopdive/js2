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
| `patches/script-plan-v1.patch` / `.json` / `.mjs` | private Script producer patch, exact source pre/postimages and deterministic application/provenance step. |
| `probe/script-plan-contract.mjs` | frozen 42 native cases, separate seven allocation failures and artifact mismatch contracts. |
| `probe/script-plan.mjs` | dedicated native producer acceptance receipts; never activates the production adapter. |
| `probe/script-plan-test-hooks.c` | identified allocation-test build only; observes private producer resources and runtime cleanup backstop. |
| `probe/script-plan-canaries.mjs` | isolated matched version0/version1 adapter compatibility receipts; all11 maintained readings per artifact, no native rebuild or cache publication. |

## The four things this build establishes

1. **No wasi-sdk install is needed.** wasi-libc builds with stock clang 18;
   only the wasm32 `compiler-rt` builtins must be fetched (Ubuntu ships none),
   from a pinned wasi-sdk release.
2. **QuickJS core is WASI-clean.** `dtoa.c libregexp.c libunicode.c quickjs.c`
   compile for `wasm32-wasip1`. The maintained build now applies the bounded
   private Script-plan v1 patch to the exact pinned `quickjs.c`/`quickjs.h`
   sources. No setjmp:
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

`WASI_LIBC_REF` / `BUILTINS_URL` remain configurable. A different
`QUICKJS_NG_REF` requires a reviewed matching patch manifest; the current
manifest rejects any different pin or edited source. `OPT=-Oz`
trades ~23% speed for ~385 KB.

## Private inactive Script-plan capability v1

This producer compiles a global Script once, captures the parser's decoded root
declarations before lowering, and owns the exact compiled program and atom
references. It preserves raw source order, duplicates, lexical kind and explicit
Annex B extra-var origin. It does not apply a caller declaration ledger,
descriptor preflight, Annex B contextual admission or callback synchronization.
Existing adapter externs, generated source and Script routing are unchanged.

The nine new all-i32 exports are `qjs_script_plan_version`, `compile(ctx,source,
byteLen)`, `count(ctx,id)`, `strict(ctx,id)`, `kind(ctx,id,index)`,
`origin(ctx,id,index)`, `name(ctx,id,index)`, `eval(ctx,id)` and `free(ctx,id)`,
with the `qjs_script_plan_` prefix on every name. Version is exactly1.
Kinds are0 var,1 hoisted function/generator,2 mutable lexical,3 immutable lexical;
origin is0 ordinary or1 Annex B extra var. `count`/`strict`/`kind`/`origin`
return-1 with a pending exception on invalid ID/context/index; count0 means a
successful empty list. Compile returns0 with the original pending syntax/OOM
exception on failure. Plan IDs are monotonic and never value-handle pointers.

`name`/`eval` return owned value or exception handles. Reserve their result cell
before creating a string or entering the body; allocation failure returns0 with
pending OOM and leaves the plan READY. Release returned values through existing
`qjs_free_value`; release plans through `qjs_script_plan_free` only. Evaluation
borrows the plan ID and consumes its internally owned compiled value once:
READY→RUNNING→CONSUMED, including body throws. Readers work in READY/CONSUMED.
Foreign, stale, running or twice-evaluated plans fail explicitly.

Private plan cleanup runs immediately before existing context/runtime teardown.
Normal callers free all contexts before their runtime, as required by QuickJS.
The dedicated test build separately invokes the nonempty private runtime cleanup
hook while its owning contexts remain live; it then tears them down normally.
No context lifetime, general value refcount, allocator or membrane behavior is
changed.

`qjs_abi_version` remains1. Extracted ABI metadata adds
`capabilities.scriptPlan.version` and actual export signatures. The private
verifier compares the binary's exports, signatures and version with its ABI,
binary/ABI digests and exact patch/shim/build source provenance. Required version0
accepts valid old artifacts; only this producer fixture requires version1.
No capability activates an adapter consumer. Patch/manifest/recipe bytes enter
the artifact cache key. Build staging must be exclusive and pristine: wrong pin,
edited preimage, partial patch and second application fail before compilation.
Create a fresh own `WORK` directory for each build; never reset a donor.

After a reviewed native build, the finite fixture is run explicitly:

```bash
node scripts/quickjs-artifact/probe/script-plan.mjs --shipped OWN_ARTIFACT_DIR OWN_RECEIPT.json
# Separate build with own WORK/OUT_DIR and JS2WASM_SCRIPT_PLAN_TEST_BUILD=1:
node scripts/quickjs-artifact/probe/script-plan.mjs --faults OWN_TEST_ARTIFACT_DIR OWN_TEST_RECEIPT.json
```

The first receipt has42 shipped native rows; the second has seven allocation
failure/recovery rows, a separately named nonempty normal-context cleanup
diagnostic (two READY plus one CONSUMED plan), and a private runtime cleanup
backstop. These two diagnostics do not change the seven-row denominator. Test-only
fault exports, resource counters and the fixture's release observer are compiled
out of the shipped artifact and rejected by production acquisition. Metadata
tests use explicitly synthetic Wasm mocks and prove gates/source generation
only. Real old/new artifact adapter canaries, the eventual43 diagnostic cases
and17 compiled controls remain independent obligations; producer success earns
no Script conformance or original-gain credit.
