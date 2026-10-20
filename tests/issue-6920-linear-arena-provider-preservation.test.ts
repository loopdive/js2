// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { addArrayRuntime, addRuntime } from "../src/codegen-linear/runtime.js";
import {
  buildLinearBumpAllocationBody,
  describeLinearBumpArena,
} from "../src/codegen-linear/runtime/arena/bump-allocation.js";
import {
  buildLinearArrayConstructorBody,
  describeLinearArrayConstructor,
} from "../src/codegen-linear/runtime/arrays/constructor.js";
import { emitBinary } from "../src/emit/binary.js";
import { createEmptyModule, type WasmModule } from "../src/ir/types.js";

const authority = JSON.parse(
  readFileSync(new URL("./fixtures/issue-6920-canonical-arena-providers.json", import.meta.url), "utf8"),
);
const sha = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function moduleFor(name: string): WasmModule {
  const mod = createEmptyModule();
  if (name === "seeded" || name === "linked") {
    mod.types.push({ kind: "func", params: [{ kind: "i32" }], results: [{ kind: "i32" }] });
    mod.imports.push({ module: "fixture", name: "allocator", desc: { kind: "func", typeIdx: 0 } });
    mod.globals.push({
      name: "existing",
      type: { kind: "i32" },
      mutable: true,
      init: [{ op: "i32.const", value: 17 }],
    });
  }
  if (name === "linked")
    mod.imports.push({ module: "fixture", name: "memory", desc: { kind: "memory", min: 1, max: 256 } });
  addRuntime(
    mod,
    name === "custom-floor"
      ? { heapStart: 4096 }
      : name === "linked"
        ? { linkedHeap: { mallocFuncIdx: 0, chunkBytes: 65536 } }
        : {},
  );
  addArrayRuntime(mod);
  return mod;
}

describe("canonical allocator/constructor producer preservation — runtime unit only", () => {
  it("retains an explicit complete four-case canonical authority", () => {
    expect(authority.provenance.head).toBe("529b092b6f80682538c1c2b7f7e136f5ca9d72c2");
    expect(authority.cases.map((row: { name: string }) => row.name)).toEqual([
      "default",
      "custom-floor",
      "seeded",
      "linked",
    ]);
  });
  for (const row of authority.cases)
    it(`preserves the complete historical ${row.name} module apart from the checked default allocator epoch`, () => {
      const mod = moduleFor(row.name);
      expect(mod.memories).toEqual(row.memories);
      expect(mod.globals).toEqual(row.globals);
      expect(mod.types).toEqual(row.types);
      expect(mod.functions.find((fn) => fn.name === "__arr_new")).toEqual(row.constructor);
      expect(mod.imports).toHaveLength(row.importCount);
      expect(mod.functions).toHaveLength(row.functionCount);
      expect(mod.exports).toEqual(row.exports);
      const malloc = mod.functions.find((fn) => fn.name === "__malloc")!;
      const historical = structuredClone(mod);
      if (row.name === "linked") {
        expect(malloc).toEqual(row.malloc);
      } else {
        expect(malloc.body).toEqual(
          buildLinearBumpAllocationBody(mod.globals.findIndex((g) => g.name === "__heap_ptr")),
        );
        expect(malloc.locals).toEqual(describeLinearBumpArena().allocatorLocals);
        expect(malloc.body).not.toEqual(row.malloc.body);
        expect(malloc.locals).not.toEqual(row.malloc.locals);
        const oldMalloc = historical.functions.find((fn) => fn.name === "__malloc")!;
        // The immutable old authority proves the entire remaining module,
        // not a silently regenerated golden for the intentional safety change.
        oldMalloc.body = structuredClone(row.malloc.body);
        oldMalloc.locals = structuredClone(row.malloc.locals);
      }
      expect(sha(JSON.stringify(historical))).toBe(row.moduleSha256);
      const oldBinary = new Uint8Array(emitBinary(historical));
      expect(oldBinary.length).toBe(row.binaryBytes);
      expect(sha(oldBinary)).toBe(row.binarySha256);
      expect(WebAssembly.validate(oldBinary)).toBe(true);
      const binary = new Uint8Array(emitBinary(mod));
      expect(WebAssembly.validate(binary)).toBe(true);
      if (row.name === "linked") expect(sha(binary)).toBe(row.binarySha256);
      else expect(sha(binary)).not.toBe(row.binarySha256);
    });
  it("binds actual shifted allocator/global coordinates and supplies fresh nested bodies/resources", () => {
    const mod = moduleFor("seeded");
    expect(buildLinearBumpAllocationBody(1)).toEqual(mod.functions.find((fn) => fn.name === "__malloc")!.body);
    expect(buildLinearArrayConstructorBody(1)).toEqual(mod.functions.find((fn) => fn.name === "__arr_new")!.body);
    const first = buildLinearBumpAllocationBody(1);
    const before = structuredClone(first);
    first[0].op = "unreachable";
    expect(buildLinearBumpAllocationBody(1)).toEqual(before);
    const descriptor = describeLinearBumpArena();
    descriptor.heapPointer.init[0].op = "unreachable";
    expect(describeLinearBumpArena().heapPointer.init).toEqual([{ op: "i32.const", value: 1024 }]);
    const arrayConstructor = describeLinearArrayConstructor();
    arrayConstructor.locals[0].name = "foreign";
    expect(describeLinearArrayConstructor().locals[0].name).toBe("$l0");
    expect(buildLinearArrayConstructorBody(2)).not.toEqual(buildLinearArrayConstructorBody(1));
    expect(buildLinearBumpAllocationBody(0)).not.toEqual(buildLinearBumpAllocationBody(1));
  });
  it("executes canonical allocation, alignment, growth and fresh array headers in real Wasm", async () => {
    const mod = moduleFor("default");
    for (const name of ["__malloc", "__arr_new"])
      mod.exports.push({ name, desc: { kind: "func", index: mod.functions.findIndex((fn) => fn.name === name) } });
    const { instance } = await WebAssembly.instantiate(new Uint8Array(emitBinary(mod)));
    const malloc = instance.exports.__malloc as (size: number) => number;
    const array = instance.exports.__arr_new as (capacity: number) => number;
    const memory = instance.exports.memory as WebAssembly.Memory;
    expect(malloc(1)).toBe(1024);
    const pointer = array(3);
    expect(pointer).toBe(1032);
    const view = new DataView(memory.buffer);
    expect(view.getUint32(pointer, true)).toBe(1);
    expect(view.getUint32(pointer + 8, true)).toBe(0);
    expect(view.getUint32(pointer + 12, true)).toBe(3);
    const next = malloc(70000);
    expect(next).toBe(1072);
    expect(memory.buffer.byteLength).toBe(131072);
    expect(new DataView(memory.buffer).getUint32(next, true)).toBe(0);
  });
});
