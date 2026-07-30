// Dogfood probe WORKER (#2674) — compiles + runs a compiled-acorn entry point in
// an ISOLATED worker thread so the parent can terminate it when the in-Wasm call
// hangs. A synchronous Wasm infinite loop blocks the event loop, so a same-thread
// setTimeout watchdog can NEVER fire (the reason the #2664 / 9th-wall hang could
// not be bounded or signature-sampled before).
//
// Host-call signature via SharedArrayBuffer: every host import is wrapped to
// increment a per-import counter in a SAB. The import closures run DURING the
// in-Wasm loop (each loop iteration that calls a host import bumps a counter), so
// even though the worker's own JS timers are STARVED by the synchronous call, the
// PARENT thread reads the live SAB counts and — on a hang — terminates the worker
// and reports the top counters. That signature (which import is hammered, e.g.
// `__extern_get("type")` vs `__extern_set`) localizes the wall, bounded, the same
// way the #2656/#2664 host-call-count probes did.
//
// Protocol (workerData):
//   { source, fileName, call, args, sab }  — sab = SharedArrayBuffer (Int32Array)
// Worker posts:
//   { kind: "keys", keys: string[] }       — SAB slot i ↔ keys[i] (host import name)
//   { kind: "compiled", ms }
//   { kind: "done", ms, result }
//   { kind: "error", phase, message }
// The parent (probe-driver.mjs) spawns this worker with the tsx loader flags in
// execArgv, so static .ts imports resolve.
import { parentPort, workerData } from "node:worker_threads";
import { compile } from "../../src/index.ts";
import { wrapExports } from "../../src/runtime.ts";

process.on("unhandledRejection", () => {});

async function main() {
  const { source, fileName, call, args, sab } = workerData;
  const counts = new Int32Array(sab);
  const t0 = Date.now();
  const r = await compile(source, { fileName: fileName ?? "probe.mjs" });
  if (!r.success) {
    parentPort.postMessage({
      kind: "error",
      phase: "compile",
      message: (r.errors ?? [])
        .map((e) => e.message)
        .slice(0, 5)
        .join(" | "),
    });
    return;
  }
  parentPort.postMessage({ kind: "compiled", ms: Date.now() - t0 });

  // Wrap every host import with a SAB-backed counter BEFORE instantiation.
  const io = r.importObject ?? {};
  const keys = [];
  for (const ns of Object.keys(io)) {
    const mod = io[ns];
    if (!mod || typeof mod !== "object") continue;
    for (const fn of Object.keys(mod)) {
      const orig = mod[fn];
      if (typeof orig !== "function") continue;
      const slot = keys.length;
      if (slot >= counts.length) continue; // SAB full — skip extras
      keys.push(`${ns}.${fn}`);
      mod[fn] = function instrumented(...a) {
        Atomics.add(counts, slot, 1);
        return orig.apply(this, a);
      };
    }
  }
  parentPort.postMessage({ kind: "keys", keys });

  let instance;
  try {
    ({ instance } = await WebAssembly.instantiate(r.binary, io));
    io.__setInstance?.(instance);
  } catch (e) {
    parentPort.postMessage({ kind: "error", phase: "instantiate", message: String(e?.message ?? e) });
    return;
  }
  const exp = wrapExports(instance, { signatures: r.exportSignatures });

  const callName = call ?? "parse";
  const fn = exp[callName];
  if (typeof fn !== "function") {
    parentPort.postMessage({ kind: "error", phase: "run", message: `export '${callName}' is not callable` });
    return;
  }
  const tCall = Date.now();
  const result = fn(...(args ?? [])); // BLOCKS here on a hang; parent terminates us.
  const summary =
    result && typeof result === "object"
      ? { type: result.type, bodyLen: Array.isArray(result.body) ? result.body.length : undefined }
      : result;
  parentPort.postMessage({ kind: "done", ms: Date.now() - tCall, result: summary });
}

main().catch((e) => {
  parentPort.postMessage({ kind: "error", phase: "run", message: String(e?.message ?? e), stack: e?.stack });
});
