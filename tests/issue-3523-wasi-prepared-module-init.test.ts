// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#3523 R4 gap 3) Behavior pin for the WASI module-init shapes the prepared
 * exact-lexical selector admits.
 *
 * WASI is the last cell in the 12-cell R4 census still emitting a direct
 * (legacy) module-init body, and the mechanism that makes its `__module_init`
 * safe is `applyModuleInitGuard` — a POST-EMISSION splice that mints the
 * `__init_done` global, prepends an idempotence prologue to `__module_init`,
 * and prepends `call __module_init` to every other export. Gap 3 relocates
 * that splice into invocation-policy-driven prepared emission.
 *
 * The relocation has to be measured against a behavior pin rather than
 * self-certify, and the test probe found NO such pin for any shape the
 * selector admits: `issue-1789` uses an object-literal `valueOf` population,
 * `issue-1411` a plain-literal assignment and `issue-4376` an Unsupported
 * shape — all three stay on the legacy lane. This file pins the observable
 * contract for the ADMITTED grammar (initialized top-level lexical
 * declarations, optionally followed by exact scalar self-assignments):
 *
 *   α — a direct export call with no `_start` sees initialized state;
 *   β — `_start()` then an export initializes exactly once;
 *   γ — two distinct exports initialize exactly once between them.
 *
 * These must hold identically before and after the mechanism moves.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/** Shape (b) of the R4 census: one initialized top-level lexical binding. */
const SHAPE_B = `let v = 7;
export function test(): number { return v; }`;

/** Shape (c): a lexical declaration plus an exact scalar self-assignment. */
const SHAPE_C = `let total = 0;
total = total + 1;
export function test(): number { return total; }`;

/** Shape (c) with two distinct exported readers of the same init state. */
const SHAPE_C_TWO_EXPORTS = `let total = 0;
total = total + 1;
export function readA(): number { return total; }
export function readB(): number { return total; }`;

async function instantiateWasi(src: string): Promise<{
  exports: Record<string, unknown>;
  exportNames: readonly string[];
}> {
  const r = await compile(src, { fileName: "test.ts", target: "wasi" });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  // Empty import object — a genuine standalone instantiation, exactly as the
  // test262 standalone harness does it.
  const { instance } = await WebAssembly.instantiate(r.binary!, {});
  const exports = instance.exports as Record<string, unknown>;
  return { exports, exportNames: Object.keys(exports) };
}

describe("#3523 gap 3 — WASI module init for the prepared-admitted grammar", () => {
  it("α shape (b): a direct export call without _start sees the initialized binding", async () => {
    const { exports } = await instantiateWasi(SHAPE_B);
    expect((exports.test as () => number)()).toBe(7);
  });

  it("α shape (c): a direct export call without _start sees the assigned value", async () => {
    const { exports } = await instantiateWasi(SHAPE_C);
    expect((exports.test as () => number)()).toBe(1);
  });

  it("β shape (c): _start() then an export initializes exactly once", async () => {
    const { exports } = await instantiateWasi(SHAPE_C);
    expect(typeof exports._start).toBe("function");
    (exports._start as () => void)();
    // A second init would run `total = total + 1` again and read 2.
    expect((exports.test as () => number)()).toBe(1);
  });

  it("β shape (c): repeated _start() calls still initialize exactly once", async () => {
    const { exports } = await instantiateWasi(SHAPE_C);
    (exports._start as () => void)();
    (exports._start as () => void)();
    expect((exports.test as () => number)()).toBe(1);
  });

  it("γ shape (c): two distinct exports initialize exactly once between them", async () => {
    const { exports } = await instantiateWasi(SHAPE_C_TWO_EXPORTS);
    expect((exports.readA as () => number)()).toBe(1);
    expect((exports.readB as () => number)()).toBe(1);
    // And in the other order, on a fresh instance.
    const second = await instantiateWasi(SHAPE_C_TWO_EXPORTS);
    expect((second.exports.readB as () => number)()).toBe(1);
    expect((second.exports.readA as () => number)()).toBe(1);
  });

  it("publishes `_start` and never a `__module_init` export alias", async () => {
    for (const src of [SHAPE_B, SHAPE_C, SHAPE_C_TWO_EXPORTS]) {
      const { exportNames } = await instantiateWasi(src);
      expect(exportNames).toContain("_start");
      expect(exportNames).not.toContain("__module_init");
    }
  });

  it("wires no wasm start section — `_start` is the sole WASI startup adapter", async () => {
    const r = await compile(SHAPE_C, { fileName: "test.ts", target: "wasi" });
    expect(r.success).toBe(true);
    // Section id 8 is the wasm `start` section. Scan the top-level section
    // sequence rather than the raw bytes so a coincidental 0x08 in a payload
    // cannot make this pin vacuous.
    expect(topLevelSectionIds(r.binary!)).not.toContain(8);
  });
});

/** Top-level wasm section ids, in module order. */
function topLevelSectionIds(binary: Uint8Array): number[] {
  const ids: number[] = [];
  let offset = 8; // magic + version
  while (offset < binary.length) {
    const id = binary[offset]!;
    offset += 1;
    let size = 0;
    let shift = 0;
    for (;;) {
      const byte = binary[offset]!;
      offset += 1;
      size |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7;
    }
    ids.push(id);
    offset += size;
  }
  return ids;
}
