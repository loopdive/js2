// #4558 — the linear-IR ratchet went red because 0f7f4039c (counted-push
// preallocation) wired `emitVecSetLength` into every backend emitter but
// never admitted `vec.set_length` in the linear/porffor legality allow-lists
// (`linearInstrError` / `porfforInstrError` in src/ir/backend/legality.ts).
// Every function using the preallocated-push lowering then demoted at
// `illegal:instr-vec.set_length` despite the emitter supporting it.
//
// Permanent repro: the canonical empty-array counted-push loop must stay
// IR-compiled on the linear overlay (not rejected at backend legality), and
// the overlay artifact must agree with the direct path and plain JS.
import { afterEach, describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { getLastLinearIrReport } from "../src/ir/backend/linear-integration.js";
import { verifyIrBackendLegality, type IrBackendKind } from "../src/ir/backend/legality.js";
import type { IrFunction } from "../src/ir/nodes.js";

const FLAG = "JS2WASM_LINEAR_IR";
const savedFlag = process.env[FLAG];
afterEach(() => {
  if (savedFlag === undefined) delete process.env[FLAG];
  else process.env[FLAG] = savedFlag;
});

// The exact shape that regressed (bench_array in the playground corpus).
const SRC = `export function countedPush(): number {
  const arr: number[] = [];
  for (let i = 0; i < 10000; i++) arr.push(i);
  let total = 0;
  for (let i = 0; i < arr.length; i++) total = total + arr[i];
  return total;
}
export function test(): number { return countedPush(); }`;

const JS_EXPECTED = (() => {
  let total = 0;
  for (let i = 0; i < 10000; i++) total += i;
  return total;
})();

async function compileLinear(flag: "1" | "0"): Promise<Uint8Array> {
  process.env[FLAG] = flag;
  const r = await compile(SRC, { fileName: "issue-4558.ts", target: "linear" });
  expect(r.success, r.success ? "" : r.errors.map((e) => e.message).join("; ")).toBe(true);
  if (!r.success) throw new Error("unreachable");
  return r.binary;
}

async function run(binary: Uint8Array): Promise<unknown> {
  const { instance } = await WebAssembly.instantiate(binary as BufferSource, {});
  return (instance.exports as { test: () => unknown }).test();
}

describe("#4558 vec.set_length backend legality", () => {
  it("the counted-push shape stays IR-compiled on the linear overlay (no illegal:instr-vec.set_length)", async () => {
    const binary = await compileLinear("1");
    const report = getLastLinearIrReport();
    expect(report).toBeTruthy();
    const setLengthRejects = (report?.rejected ?? []).filter((r) => r.reason.includes("vec.set_length"));
    expect(setLengthRejects).toEqual([]);
    expect(report?.compiled ?? []).toContain("countedPush");
    expect(await run(binary)).toBe(JS_EXPECTED);
  });

  it("overlay and direct-path values agree", async () => {
    const direct = await compileLinear("0");
    expect(await run(direct)).toBe(JS_EXPECTED);
  });

  it("vec.set_length is legal in the linear AND porffor instruction profiles", () => {
    // Minimal function containing only the instruction under test; the
    // legality walk reads instr.kind (and embedded types, absent here).
    const func = {
      name: "probe",
      params: [],
      resultTypes: [],
      blocks: [{ id: 0, blockArgTypes: [], instrs: [{ kind: "vec.set_length", vec: 0, length: 1 }] }],
      exported: false,
      valueCount: 2,
    } as unknown as IrFunction;
    for (const backend of ["linear", "porffor"] as IrBackendKind[]) {
      const errors = verifyIrBackendLegality(func, backend);
      expect(
        errors.filter((e) => e.instr === "vec.set_length"),
        `${backend} must admit vec.set_length (emitVecSetLength exists in its emitter)`,
      ).toEqual([]);
    }
  });
});
