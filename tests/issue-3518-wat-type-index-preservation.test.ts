// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createEmptyModule } from "../src/ir/types.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import { emitBinary } from "../src/emit/binary.js";
import { emitWat } from "../src/emit/wat.js";

function fixture() {
  const module = createEmptyModule(),
    tx = new PhysicalModuleReservations(module);
  const earlier = tx.reserveFunction("ordinary:earlier", "earlier", {
    params: [{ kind: "f64" }],
    results: [{ kind: "f64" }],
  });
  const signature = { params: [], results: [{ kind: "i32" } as const] };
  const left = tx.reserveFunction("ordinary:left", "left", signature);
  const right = tx.reserveFunction("ordinary:right", "right", signature);
  tx.freezeReservations();
  tx.fillFunction(earlier, { locals: [], body: [{ op: "local.get", index: 0 }] });
  tx.fillFunction(left, { locals: [], body: [{ op: "i32.const", value: 17 }] });
  tx.fillFunction(right, { locals: [], body: [{ op: "i32.const", value: 41 }] });
  for (const [name, token] of Object.entries({ earlier, left, right }))
    tx.defineExport(`ordinary:export:${name}`, name, token);
  expect(tx.seal().completedFunctions).toBe(3);
  expect(module.types).toHaveLength(2);
  expect(earlier.object.typeIdx).toBe(0);
  expect(left.object.typeIdx).toBe(1);
  expect(right.object.typeIdx).toBe(1);
  return module;
}

function execute(binary: Uint8Array) {
  const compiled = new WebAssembly.Module(binary as BufferSource);
  expect(WebAssembly.Module.imports(compiled)).toEqual([]);
  const exports = new WebAssembly.Instance(compiled).exports as {
    earlier(value: number): number;
    left(): number;
    right(): number;
  };
  return [exports.earlier(12.75), exports.left(), exports.right()];
}

it("preserves numeric type slots when an earlier single-use signature precedes two shared-signature functions", () => {
  const module = fixture();
  // The original physical binary is the independently executed value control.
  const direct = execute(emitBinary(module));
  expect(direct).toEqual([12.75, 17, 41]);
  const wat = emitWat(module);
  const directory = mkdtempSync(join(tmpdir(), "ordinary-type-slots-wat-"));
  try {
    const input = join(directory, "ordinary.wat"),
      output = join(directory, "ordinary.wasm");
    writeFileSync(input, wat);
    const assembler = spawnSync("wat2wasm", [input, "-o", output], { encoding: "utf8" });
    // Missing or incompatible assemblers leave evidence unresolved; never skip.
    // Baseline declaration omission must fail real assembly, before text checks.
    expect(assembler.error, assembler.stderr).toBeUndefined();
    expect(assembler.status, assembler.stderr).toBe(0);
    const roundTrip = execute(readFileSync(output));
    expect(roundTrip).toEqual([12.75, 17, 41]);
    expect(roundTrip).toEqual(direct);
    expect(wat.split("\n").filter((line) => line.startsWith("  (type "))).toEqual([
      "  (type $type0 (func (param f64) (result f64)))",
      "  (type $type1 (func (result i32)))",
    ]);
    expect(wat).toContain("(func $earlier (param f64) (result f64)");
    expect(wat).toContain("(func $left (type 1)");
    expect(wat).toContain("(func $right (type 1)");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
