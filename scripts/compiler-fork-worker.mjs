/**
 * Compiler fork worker — runs as a child process (not worker thread).
 * Uses process.send/process.on('message') for IPC.
 * Writes compiled .wasm + .json directly to disk (no binary over IPC).
 *
 * Launched by CompilerPool via child_process.fork().
 * --expose-gc and --max-old-space-size=512 are passed via execArgv.
 */
import { writeFileSync } from "node:fs";
import { compile, createIncrementalCompiler } from "./compiler-bundle.mjs";
import { isPoisonCompileError } from "./test262-poison-error.mjs";

let compileCount = 0;
const GC_INTERVAL = 25;
// With #973 fix (no oldProgram reuse), there's no type leakage between
// compilations. Recreate interval is now purely for memory management.
const RECREATE_INTERVAL = 500;

// #1808: emit-layer failures ("Binary emit error: …" and allocation-class
// RangeErrors such as "offset is out of bounds" / "Array buffer allocation
// failed" / "Maximum call stack size exceeded") can leave the long-lived
// incremental compiler or the V8 heap in a degraded state. Without an immediate
// recreate, one poisoned worker keeps producing the same emit-error RESULT for
// every subsequent file until its scheduled RECREATE_INTERVAL recycle — which is
// the exact signature of the #1808 cluster: ~290 identical "Binary emit error:
// offset is out of bounds" failures bunched into a single ~30s window on one
// worker, all of which compile cleanly on a fresh run. Force an early recreate
// whenever such an error is observed so the bad state cannot cascade across the
// remainder of the batch.
let forceRecreate = false;

let incrementalCompiler = null;
function createFreshCompiler() {
  try {
    incrementalCompiler = createIncrementalCompiler({
      fileName: "test.ts",
      sourceMap: true,
      sourceMapUrl: "test.wasm.map",
      emitWat: false,
      skipSemanticDiagnostics: true,
      // (#3049 C1) Defer top-level init in the host test262 lane: export
      // `__module_init` instead of wiring the wasm `(start)` section, so
      // top-level code runs AFTER `setExports` has wired the runtime
      // (`__sget_*` / `__vec_*` exports). The executor
      // (scripts/wasm-exec-worker.mjs) calls the exported `__module_init()`
      // right after `setExports` — the #2796 diff-test model. This fork
      // worker is host-lane only (it never receives a `target`).
      deferTopLevelInit: true,
    });
  } catch (e) {
    incrementalCompiler = null;
  }
}
createFreshCompiler();

process.on("message", async (msg) => {
  const start = performance.now();
  try {
    try {
      const compileFn = incrementalCompiler ? incrementalCompiler.compile : compile;
      // (#2119) honour the script/module strictness signal from the dispatcher
      // so the synthetic `export function test()` wrapper does not unmap sloppy
      // `arguments`. Undefined ⇒ default true (module input is strict).
      const inferModuleStrictArguments = msg.inferModuleStrictArguments;
      const result = incrementalCompiler
        ? await compileFn(msg.source, {
            sourceMapUrl: msg.sourceMapUrl || "test.wasm.map",
            inferModuleStrictArguments,
          })
        : await compile(msg.source, {
            fileName: "test.ts",
            sourceMap: true,
            sourceMapUrl: msg.sourceMapUrl || "test.wasm.map",
            emitWat: false,
            skipSemanticDiagnostics: true,
            inferModuleStrictArguments,
            // (#3049 C1) See createFreshCompiler — host lane defers top-level
            // init; wasm-exec-worker calls __module_init() after setExports.
            deferTopLevelInit: true,
          });
      const compileMs = performance.now() - start;

      if (!result.success || result.errors.some(e => e.severity === "error")) {
        const errMsg = result.errors
          .filter(e => e.severity === "error")
          .map(e => `L${e.line}:${e.column} ${e.message}`)
          .join("; ");
        const errorCodes = result.errors
          .filter(e => e.severity === "error" && e.code)
          .map(e => e.code);

        // #1808: an emit-class error result means the compiler/heap may be in a
        // degraded state — schedule an immediate recreate so it cannot poison
        // the rest of this worker's batch.
        if (isPoisonCompileError(errMsg)) forceRecreate = true;

        // Write error to disk if cachePath provided
        if (msg.wasmPath && msg.metaPath) {
          writeFileSync(msg.wasmPath, new Uint8Array(0));
          writeFileSync(msg.metaPath, JSON.stringify({
            ok: false,
            timeout: false,
            error: errMsg || "unknown",
            errorCodes,
            compileMs,
          }));
        }

        process.send({ id: msg.id, ok: false, error: errMsg || "unknown", errorCodes, compileMs });
        return;
      }

      // Write binary + metadata directly to disk (no base64 over IPC)
      if (msg.wasmPath && msg.metaPath) {
        writeFileSync(msg.wasmPath, result.binary);
        writeFileSync(msg.metaPath, JSON.stringify({
          ok: true,
          stringPool: result.stringPool,
          imports: result.imports,
          sourceMap: result.sourceMap || null,
          compileMs,
        }));
        process.send({
          id: msg.id,
          ok: true,
          compileMs,
          writtenToDisk: true,
        });
      } else {
        // Fallback: send binary over IPC (for callers that don't provide paths)
        process.send({
          id: msg.id,
          ok: true,
          binary: Buffer.from(result.binary).toString("base64"),
          stringPool: result.stringPool,
          imports: result.imports,
          sourceMap: result.sourceMap || null,
          compileMs,
        });
      }
    } catch (err) {
      const errStr = err && err.message ? err.message : String(err);
      // #1808: a thrown emit/allocation-class error likely corrupted shared
      // state — recreate before the next file.
      if (isPoisonCompileError(errStr)) forceRecreate = true;
      process.send({
        id: msg.id,
        ok: false,
        error: errStr,
        compileMs: performance.now() - start,
      });
    }
  } finally {
    // #1084: advance the counter on every message regardless of success,
    // error-result, or thrown exception. The prior early-return after
    // error-result bypassed this, starving RECREATE on error-dense chunks.
    compileCount++;
    // #1808: recreate eagerly on the scheduled interval OR as soon as an
    // emit-class poison error was seen, so a single bad worker state cannot
    // cascade into hundreds of false "Binary emit error" results.
    if (compileCount % RECREATE_INTERVAL === 0 || forceRecreate) {
      try {
        incrementalCompiler?.dispose?.();
      } catch (_e) {
        // dispose() may fail if the service is already in a bad state;
        // fall through to hard replacement.
      }
      incrementalCompiler = null;
      const heapMB = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
      const why = forceRecreate ? "poison-error" : "interval";
      console.error(`[fork-worker] RECREATE (${why}) at compile ${compileCount}, heap=${heapMB}MB`);
      forceRecreate = false;
      if (typeof globalThis.gc === "function") globalThis.gc();
      createFreshCompiler();
    } else if (compileCount % GC_INTERVAL === 0 && typeof globalThis.gc === "function") {
      globalThis.gc();
    }
  }
});

process.send({ type: "ready", pid: process.pid });
