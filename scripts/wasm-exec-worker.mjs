/**
 * Wasm execution worker — instantiates and runs a compiled Wasm test in an
 * isolated worker thread. The parent can terminate this worker if the Wasm
 * call hangs (infinite loop), which is impossible with setTimeout since
 * synchronous Wasm blocks the event loop.
 *
 * Protocol:
 *   Parent posts: { binary: Uint8Array, imports: ImportDescriptor[], stringPool: string[], isRuntimeNegative: boolean,
 *                   expectedErrorType?: string }
 *   Worker posts: { ok: true, ret: number } | { ok: true, runtimeNegativePass: true }
 *                 | { ok: false, error: string, isException: boolean }
 *                 | { ok: false, error: string, noTestExport: true }
 *                 | { ok: false, error: string, instantiateError: true }
 */
import { parentPort } from "node:worker_threads";
import { readFileSync } from "node:fs";
import { buildImports } from "./runtime-bundle.mjs";
// (#6779) test262 rows keep the explicit `hostEval` dynamic-code policy.
import { TEST262_DYNAMIC_CODE_POLICY } from "./test262-import-object.mjs";
// (#7459) The one reader and the one runtime-negative rule every test262 lane uses.
import { readThrownValue } from "./lib/wasm-exn-render.mjs";
import { runtimeNegativeThrowAccepted } from "./test262-runtime-verdict.mjs";

// Suppress unhandled Promise rejections — Promise tests create async
// operations that reject after the test function returns. Without this,
// the rejection propagates and crashes the parent's IPC channel.
process.on("unhandledRejection", () => {});

parentPort.on("message", async (msg) => {
  const { id, imports, stringPool, isRuntimeNegative, expectedErrorType } = msg;
  // Read binary from disk (cachePath) or use inline binary — avoids
  // copying large Uint8Arrays through the fork's heap on cache hits.
  let binary = msg.cachePath ? readFileSync(msg.cachePath) : msg.binary;
  const reply = (data) => parentPort.postMessage({ id, ...data });
  // A throw passes a runtime-negative test only when it is of the expected kind; otherwise it is the failure.
  const replyThrown = (err, thrownBy, extra = {}) => {
    const thrown = readThrownValue(err, { instance: thrownBy });
    if (isRuntimeNegative && runtimeNegativeThrowAccepted(err, thrown, { expectedErrorType, prepared: false })) {
      reply({ ok: true, runtimeNegativePass: true });
      return;
    }
    reply({ ok: false, error: thrown.text, isException: true, ...extra });
  };

  let instance;
  try {
    // Build the import object
    const importObj = buildImports(imports, undefined, stringPool, { dynamicCode: TEST262_DYNAMIC_CODE_POLICY });

    // Instantiate the Wasm module
    try {
      const result = await WebAssembly.instantiate(binary, importObj);
      instance = result.instance;
    } catch (err) {
      if (err instanceof WebAssembly.CompileError || err instanceof WebAssembly.LinkError) {
        reply({
          ok: false,
          error: err.message ?? String(err),
          instantiateError: true,
        });
        return;
      }
      replyThrown(err, undefined, { instantiateError: true });
      return;
    }

    // Wire the branded instance for callback and host-bridge support.
    importObj.setInstance?.(instance);

    // (#3049 C1) Deferred top-level init: the fork worker compiles with
    // `deferTopLevelInit: true`, so the module's top-level code did NOT run
    // during instantiate — run the exported `__module_init` now that
    // `setInstance` has wired the runtime (`__sget_*` / `__vec_*` exports),
    // mirroring the #2796 diff-test host lane. Classification mirrors the
    // pre-defer behavior where the same throw surfaced from the `(start)`
    // section inside `WebAssembly.instantiate`: a runtime-negative test's
    // top-level throw is the expected error (pass); any other top-level
    // throw is an honest runtime exception (fail), NOT a malformed-wasm
    // compile_error.
    const moduleInit = instance.exports.__module_init;
    if (typeof moduleInit === "function") {
      try {
        moduleInit();
      } catch (initErr) {
        replyThrown(initErr, instance);
        return;
      }
    }

    const testFn = instance.exports.test;
    if (typeof testFn !== "function") {
      reply({ ok: false, error: "no test export", noTestExport: true });
      return;
    }

    // Run the test — this is the synchronous call that may hang
    try {
      let ret = testFn();

      // (#3227 S4) Async post-drain verdict re-read — parity with
      // scripts/test262-worker.mjs. An async-flagged test's sync 1/-262 is
      // read before its host-microtask continuations run; drain two
      // setImmediate rounds and re-read via the wrapper's __result() export.
      const resultFn = instance.exports.__result;
      if (!isRuntimeNegative && typeof resultFn === "function" && (ret === 1 || ret === -262)) {
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));
        try {
          ret = resultFn();
        } catch {
          // re-read trapped — keep the sync verdict
        }
      }

      if (isRuntimeNegative) {
        // Expected a runtime error but test succeeded
        reply({ ok: true, ret, runtimeNegativeNoThrow: true });
      } else {
        reply({ ok: true, ret });
      }
    } catch (execErr) {
      replyThrown(execErr, instance);
    }
  } catch (outerErr) {
    // #1221: A WebAssembly.Exception escaping the inner tries (e.g. thrown
    // from `restoreBuiltins` walking a poisoned Symbol.iterator, or a
    // microtask resumed at an `await` boundary) is a runtime throw — not a
    // compile/link failure. Read it like any other throw so the harness
    // records a useful runtime fail instead of compile_error
    // (instantiateError:true) with text "[object WebAssembly.Exception]".
    // The inner instantiate catch was fixed in #1155 — this closes the
    // outer-catch leak that was missed. It is never a runtime-negative pass.
    if (outerErr instanceof WebAssembly.Exception) {
      reply({ ok: false, error: readThrownValue(outerErr, { instance }).text, isException: true });
    } else {
      reply({
        ok: false,
        error: outerErr.message ?? String(outerErr),
        instantiateError: true,
      });
    }
  } finally {
    // Drop references to Wasm module so GC can collect compiled code
    instance = null;
    binary = null;
  }
});
