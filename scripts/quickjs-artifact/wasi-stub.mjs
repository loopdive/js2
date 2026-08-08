/**
 * Minimal wasi_snapshot_preview1 stub for the QuickJS boxed-tier artifact
 * (#4236). The artifact imports exactly five WASI functions and nothing else —
 * no `env.*`, no emscripten glue — so this is the entire host surface it needs.
 *
 * In a real standalone deployment these come from the WASI runtime
 * (wasmtime/wasmer/WAMR); this module exists so Node-side probes and CI checks
 * can instantiate the artifact without one.
 */
const ESUCCESS = 0;
const EBADF = 8;

export function makeWasiStub(getMemory) {
  const u8 = () => new Uint8Array(getMemory().buffer);
  const dv = () => new DataView(getMemory().buffer);
  const chunks = { 1: [], 2: [] }; // stdout / stderr text captured for probes

  return {
    wasi_snapshot_preview1: {
      clock_time_get(_id, _precision, outPtr) {
        dv().setBigUint64(outPtr, BigInt(Math.round(Date.now() * 1e6)), true);
        return ESUCCESS;
      },
      fd_write(fd, iovs, iovsLen, nwrittenPtr) {
        const view = dv();
        const mem = u8();
        let total = 0;
        const parts = [];
        for (let i = 0; i < iovsLen; i++) {
          const base = view.getUint32(iovs + i * 8, true);
          const len = view.getUint32(iovs + i * 8 + 4, true);
          parts.push(mem.subarray(base, base + len));
          total += len;
        }
        if (chunks[fd]) for (const p of parts) chunks[fd].push(new TextDecoder().decode(p));
        view.setUint32(nwrittenPtr, total, true);
        return ESUCCESS;
      },
      fd_close(fd) {
        return fd > 2 ? EBADF : ESUCCESS;
      },
      fd_seek(_fd, _offset, _whence, newOffsetPtr) {
        dv().setBigUint64(newOffsetPtr, 0n, true);
        return ESUCCESS;
      },
      fd_fdstat_get(_fd, statPtr) {
        const mem = u8();
        mem.fill(0, statPtr, statPtr + 24);
        mem[statPtr] = 2; // filetype = character device
        return ESUCCESS;
      },
    },
    // probe helpers, not part of the wasm import object
    _captured: chunks,
  };
}

/** Instantiate the artifact with the stub and run its reactor `_initialize`. */
export async function instantiateArtifact(bytes) {
  let instance;
  const stub = makeWasiStub(() => instance.exports.memory);
  const { wasi_snapshot_preview1 } = stub;
  const result = await WebAssembly.instantiate(bytes, { wasi_snapshot_preview1 });
  instance = result.instance ?? result;
  instance.exports._initialize?.();
  return { instance, captured: stub._captured };
}
