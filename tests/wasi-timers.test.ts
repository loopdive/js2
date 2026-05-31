// #1484 — WASI timer diagnostic + poll_oneoff helper.
//
// Under `--target wasi`, setTimeout/setInterval/setImmediate/queueMicrotask
// must produce a compile-time diagnostic (not a silent runtime hang from a
// missing `env::setTimeout` import). The compiler also registers
// `wasi_snapshot_preview1::poll_oneoff` and emits a `__wasi_sleep_ms` helper
// (gated on timer references) so a follow-up issue can lower timer call
// sites to synchronous sleeps via the async scheduler. The poll_oneoff
// polyfill in runtime.ts is the JS-side counterpart used by vitest.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildWasiPolyfill } from "../src/runtime.js";

describe("WASI timers (#1484) — compile-time diagnostic", () => {
  it("rejects setTimeout under --target wasi with a clear diagnostic", async () => {
    const src = `setTimeout(() => { console.log("late"); }, 100);`;
    const result = await compile(src, { target: "wasi" });
    expect(result.success).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    const msg = result.errors.map((e) => e.message).join("\n");
    expect(msg).toMatch(/setTimeout/);
    expect(msg).toMatch(/wasi/i);
    // Must surface as a `Codegen error:` so compiler.ts short-circuits and
    // never emits an unresolvable `env::setTimeout` import.
    expect(msg).toMatch(/Codegen error:/);
  });

  it("rejects setInterval under --target wasi", async () => {
    const src = `setInterval(() => {}, 50);`;
    const result = await compile(src, { target: "wasi" });
    expect(result.success).toBe(false);
    const msg = result.errors.map((e) => e.message).join("\n");
    expect(msg).toMatch(/setInterval/);
  });

  it("rejects setImmediate under --target wasi", async () => {
    const src = `setImmediate(() => {});`;
    const result = await compile(src, { target: "wasi" });
    expect(result.success).toBe(false);
    const msg = result.errors.map((e) => e.message).join("\n");
    expect(msg).toMatch(/setImmediate/);
  });

  it("rejects queueMicrotask under --target wasi", async () => {
    const src = `queueMicrotask(() => {});`;
    const result = await compile(src, { target: "wasi" });
    expect(result.success).toBe(false);
    const msg = result.errors.map((e) => e.message).join("\n");
    expect(msg).toMatch(/queueMicrotask/);
  });

  it("does NOT reject when setTimeout appears as a member name (e.g. obj.setTimeout)", async () => {
    // Member-name positions must not false-positive (the rejection is for
    // bare-identifier global lookups only).
    const src = `
      class Scheduler { setTimeout(_fn: any, _ms: number): void {} }
      const s = new Scheduler();
      s.setTimeout(() => {}, 10);
    `;
    const result = await compile(src, { target: "wasi" });
    if (!result.success) {
      // If compile fails for other reasons (e.g. class support), at least
      // ensure the failure is NOT the WASI timer diagnostic.
      const msg = result.errors.map((e) => e.message).join("\n");
      expect(msg).not.toMatch(/'setTimeout' is not available under --target wasi/);
    } else {
      expect(result.success).toBe(true);
    }
  });

  it("does NOT reject setTimeout outside --target wasi", async () => {
    // In non-WASI mode, setTimeout falls through to the env-host import
    // path. We only assert the diagnostic does not fire — full lowering
    // behaviour is covered elsewhere.
    const src = `setTimeout(() => {}, 1);`;
    const result = await compile(src, {});
    if (!result.success) {
      const msg = result.errors.map((e) => e.message).join("\n");
      expect(msg).not.toMatch(/is not available under --target wasi/);
    }
  });
});

describe("WASI timers (#1484) — buildWasiPolyfill poll_oneoff", () => {
  it("provides poll_oneoff that writes nevents and returns 0", () => {
    const polyfill = buildWasiPolyfill();
    // Provide a small memory buffer so poll_oneoff has somewhere to write.
    const mem = new WebAssembly.Memory({ initial: 1 });
    polyfill.setMemory(mem);

    const view = new DataView(mem.buffer);
    const SUB_PTR = 64;
    const EVT_PTR = 112;
    const NEVENTS_PTR = 144;

    // Pre-fill nevents with a non-zero sentinel so we can confirm the shim wrote it.
    view.setUint32(NEVENTS_PTR, 0xdeadbeef, true);

    const errno = polyfill.poll_oneoff(SUB_PTR, EVT_PTR, 1, NEVENTS_PTR);
    expect(errno).toBe(0); // __WASI_ERRNO_SUCCESS

    const nevents = view.getUint32(NEVENTS_PTR, true);
    expect(nevents).toBe(1);
  });

  it("returns -1 when memory is not set", () => {
    const polyfill = buildWasiPolyfill();
    expect(polyfill.poll_oneoff(0, 0, 1, 0)).toBe(-1);
  });
});
