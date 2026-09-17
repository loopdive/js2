// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { createEmptyModule, type Instr, type TypeDef, type ValType, type WasmModule } from "../src/ir/types.js";
import { emitBinary, emitBinaryWithSourceMap } from "../src/emit/binary.js";
import { emitWat } from "../src/emit/wat.js";
import {
  extractRuntimeGroup,
  fingerprintRuntimeGroup,
  verifyRuntimeRecGroupBinary,
  RUNTIME_RECGROUP_ABI_VERSION,
} from "../src/emit/canonical-recgroup.js";

const i32: ValType = { kind: "i32" };
const ref = (typeIdx: number): ValType => ({ kind: "ref_null", typeIdx });
const empty = (name: string): TypeDef => ({ kind: "struct", name, fields: [] });
function fn(module: WasmModule, name: string, typeIdx: number, body: Instr[], locals: ValType[] = []) {
  const index = module.imports.filter((imp) => imp.desc.kind === "func").length + module.functions.length;
  module.functions.push({
    name,
    typeIdx,
    body,
    locals: locals.map((type, i) => ({ name: `local${i}`, type })),
    exported: true,
  });
  module.exports.push({ name, desc: { kind: "func", index } });
  return index;
}
function instantiate(module: WasmModule, imports: WebAssembly.Imports = {}) {
  const binary = emitBinary(module);
  expect(WebAssembly.validate(binary)).toBe(true);
  expect(emitBinaryWithSourceMap(module).binary).toEqual(binary);
  return new WebAssembly.Instance(new WebAssembly.Module(binary), imports);
}
function recursiveValueModule(): WasmModule {
  const module = createEmptyModule();
  module.types.push(
    {
      kind: "rec",
      types: [
        {
          kind: "struct",
          name: "Node",
          fields: [
            { name: "children", type: ref(1), mutable: true },
            { name: "value", type: i32, mutable: false },
          ],
        },
        { kind: "array", name: "Children", element: ref(0), mutable: true },
      ],
    },
    { kind: "func", params: [], results: [i32] },
  );
  fn(module, "main", 2, [
    { op: "ref.null", typeIdx: 1 },
    { op: "i32.const", value: 42, sourcePos: { file: "recursive.ts", line: 3, column: 7 } },
    { op: "struct.new", typeIdx: 0 },
    { op: "array.new_fixed", typeIdx: 1, length: 1 },
    { op: "i32.const", value: 0 },
    { op: "struct.new", typeIdx: 0 },
    { op: "struct.get", typeIdx: 0, fieldIdx: 0 },
    { op: "i32.const", value: 0 },
    { op: "array.get", typeIdx: 1 },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: 0, fieldIdx: 1 },
  ]);
  return module;
}

describe("explicit recursive type emission", () => {
  it("matches ordinary forward-group bytes without reseeding historical controls", () => {
    const explicit = recursiveValueModule();
    const flat = recursiveValueModule();
    const group = flat.types[0]!;
    if (group.kind !== "rec") throw new Error("missing recursive fixture group");
    flat.types = [...group.types, ...flat.types.slice(1)];
    expect(emitBinary(explicit)).toEqual(emitBinary(flat));
    expect((instantiate(flat).exports.main as () => number)()).toBe(42);
  });

  it("instantiates mutual struct/array references and reads the nested value 42", () => {
    const module = recursiveValueModule();
    expect((instantiate(module).exports.main as () => number)()).toBe(42);
    const { binary, sourceMapEntries } = emitBinaryWithSourceMap(module);
    expect(sourceMapEntries).toHaveLength(1);
    const entry = sourceMapEntries[0]!;
    expect(entry.sourcePos).toEqual({ file: "recursive.ts", line: 3, column: 7 });
    expect(entry.wasmOffset).toBeGreaterThan(8);
    expect(entry.wasmOffset).toBeLessThan(binary.length - 1);
    expect(Array.from(binary.slice(entry.wasmOffset, entry.wasmOffset + 2))).toEqual([0x41, 42]);
    const wat = emitWat(module);
    expect(wat).toContain("(rec\n    (type $Node");
    expect(wat).toContain("(ref null 1)");
    expect(wat.indexOf("(type $Node")).toBeLessThan(wat.indexOf("(type $Children"));
    expect(wat).toContain("(type $type2 (func (result i32)))");
    expect(wat).toContain("(func $main (type 2)");
  });

  for (const wrapper of [false, true]) {
    it(`constructs and casts parent-before-child subtypes, wrapper=${wrapper}`, () => {
      const module = createEmptyModule();
      const parent: TypeDef = {
        kind: "struct",
        name: "Parent",
        superTypeIdx: -1,
        fields: [{ name: "value", type: i32, mutable: false }],
      };
      const fields = [{ name: "value", type: i32, mutable: false }];
      const child: TypeDef = wrapper
        ? { kind: "sub", name: "Child", superType: 0, final: true, type: { kind: "struct", name: "Payload", fields } }
        : { kind: "struct", name: "Child", superTypeIdx: 0, final: true, fields };
      module.types.push({ kind: "rec", types: [parent, child] }, { kind: "func", params: [], results: [i32] });
      fn(
        module,
        "main",
        2,
        [
          { op: "i32.const", value: 42 },
          { op: "struct.new", typeIdx: 1 },
          { op: "local.set", index: 0 },
          { op: "local.get", index: 0 },
          { op: "ref.cast", typeIdx: 1 },
          { op: "struct.get", typeIdx: 1, fieldIdx: 0 },
        ],
        [ref(0)],
      );
      expect((instantiate(module).exports.main as () => number)()).toBe(42);
      expect(emitWat(module)).toContain("(type $Child (sub final 0 (struct");
      expect(emitWat(module)).toContain("(type $Parent (sub (struct");
    });
  }

  it("resolves signatures, tags, locals, globals, typed blocks and calls after multiple groups and a prefix", () => {
    const module = createEmptyModule();
    module.types.push(
      empty("Prefix"),
      {
        kind: "rec",
        types: [
          { kind: "struct", name: "Box", fields: [{ name: "value", type: i32, mutable: false }] },
          { kind: "func", name: "readBox", params: [ref(1)], results: [i32] },
        ],
      },
      { kind: "rec", types: [{ kind: "array", name: "Boxes", element: ref(1), mutable: true }] },
      { kind: "func", params: [], results: [i32] },
      { kind: "func", params: [ref(1)], results: [] },
      { kind: "func", params: [i32], results: [i32] },
    );
    const tagProvider = createEmptyModule();
    tagProvider.types = module.types;
    tagProvider.tags.push({ name: "signal", typeIdx: 5 });
    tagProvider.exports.push({ name: "signal", desc: { kind: "tag", index: 0 } });
    const signal = instantiate(tagProvider).exports.signal!;
    module.imports.push(
      { module: "env", name: "read", desc: { kind: "func", typeIdx: 2 } },
      { module: "env", name: "signal", desc: { kind: "tag", typeIdx: 5 } },
    );
    module.globals.push({ name: "box", type: ref(1), mutable: true, init: [{ op: "ref.null", typeIdx: 1 }] });
    const getter = fn(module, "get", 2, [
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: 1, fieldIdx: 0 },
    ]);
    const after = fn(module, "after", 6, [{ op: "local.get", index: 0 }]);
    module.tables.push({ elementType: "funcref", min: 1 });
    module.elements.push({ tableIdx: 0, offset: [{ op: "i32.const", value: 0 }], funcIndices: [getter] });
    fn(
      module,
      "main",
      4,
      [
        { op: "i32.const", value: 42 },
        { op: "struct.new", typeIdx: 1 },
        { op: "local.tee", index: 0 },
        { op: "global.set", index: 0 },
        {
          op: "block",
          blockType: { kind: "type", typeIdx: 4 },
          body: [
            { op: "global.get", index: 0 },
            { op: "call", funcIdx: 0 },
          ],
        },
        { op: "drop" },
        { op: "local.get", index: 0 },
        { op: "i32.const", value: 0 },
        { op: "call_indirect", typeIdx: 2, tableIdx: 0 },
        { op: "drop" },
        { op: "i32.const", value: 42 },
        { op: "call", funcIdx: after },
        { op: "drop" },
        { op: "local.get", index: 0 },
        { op: "ref.func", funcIdx: getter },
        { op: "call_ref", typeIdx: 2 },
      ],
      [ref(1)],
    );
    let importedCalls = 0;
    const instance = instantiate(module, {
      env: {
        signal,
        read: (value: unknown) => {
          expect(value).not.toBeNull();
          importedCalls++;
          return 42;
        },
      },
    });
    expect((instance.exports.main as () => number)()).toBe(42);
    expect(importedCalls).toBe(1);
    expect((instance.exports.after as (value: number) => number)(42)).toBe(42);
    const wat = emitWat(module);
    expect(wat.match(/\(rec\n/g)).toHaveLength(2);
    expect(wat).toContain("(type $type6 (func (param i32) (result i32)))");
    expect(wat).toContain("call_indirect (type 2)");
    expect(wat).toContain("(tag (type 5))");
  });

  for (const explicitRuntime of [false, true]) {
    it(`exchanges canonical runtime values across modules after unrelated prefixes, explicit=${explicitRuntime}`, () => {
      function runtime(prefix: boolean) {
        const module = createEmptyModule();
        const start = prefix ? 2 : 0;
        if (prefix) module.types.push({ kind: "rec", types: [empty("UnrelatedA"), empty("UnrelatedB")] });
        const members: TypeDef[] = [
          { kind: "array", name: "__str_data", element: i32, mutable: true },
          { kind: "struct", name: "NativeString", fields: [{ name: "data", type: ref(start), mutable: false }] },
        ];
        module.types.push(...(explicitRuntime ? [{ kind: "rec" as const, types: members }] : members));
        module.canonicalRuntimeRecGroup = { start, end: start + 1, abiVersion: RUNTIME_RECGROUP_ABI_VERSION };
        module.types.push(
          { kind: "func", params: [], results: [ref(start + 1)] },
          { kind: "func", params: [ref(start + 1)], results: [i32] },
        );
        fn(module, "make", start + 2, [
          { op: "i32.const", value: 42 },
          { op: "array.new_fixed", typeIdx: start, length: 1 },
          { op: "struct.new", typeIdx: start + 1 },
        ]);
        fn(module, "read", start + 3, [
          { op: "local.get", index: 0 },
          { op: "struct.get", typeIdx: start + 1, fieldIdx: 0 },
          { op: "i32.const", value: 0 },
          { op: "array.get", typeIdx: start },
        ]);
        const extracted = extractRuntimeGroup(module);
        expect(extracted.map((member) => member.absIndex)).toEqual([start, start + 1]);
        members.forEach((definition, i) => expect(extracted[i]!.def).toBe(definition));
        return module;
      }
      const a = runtime(false),
        b = runtime(true);
      const fingerprint = fingerprintRuntimeGroup(a);
      expect(fingerprint.count).toBe(2);
      expect(fingerprint.members).toEqual(["__str_data", "NativeString"]);
      expect(fingerprintRuntimeGroup(b)).toEqual(fingerprint);
      expect(verifyRuntimeRecGroupBinary(emitBinary(b), fingerprint).valid).toBe(true);
      const first = instantiate(a),
        second = instantiate(b);
      expect((second.exports.read as (value: unknown) => number)((first.exports.make as () => unknown)())).toBe(42);
      expect((first.exports.read as (value: unknown) => number)((second.exports.make as () => unknown)())).toBe(42);
    });
  }

  for (const emitter of [emitBinary, (module: WasmModule) => emitBinaryWithSourceMap(module).binary]) {
    for (const [name, mutation, message] of [
      [
        "field",
        (m: WasmModule) => {
          m.functions[0]!.body = [{ op: "struct.get", typeIdx: 0, fieldIdx: 2 }];
        },
        "struct field",
      ],
      [
        "field after group",
        (m: WasmModule) => {
          m.types.push({ kind: "struct", name: "Tail", fields: [{ name: "value", type: i32, mutable: false }] });
          m.functions[0]!.body = [{ op: "struct.get", typeIdx: 3, fieldIdx: 1 }];
        },
        "struct field",
      ],
      [
        "local",
        (m: WasmModule) => {
          m.functions[0]!.body = [{ op: "local.get", index: 0 }];
        },
        "local (local.get) index out of range",
      ],
      [
        "function kind",
        (m: WasmModule) => {
          m.functions[0]!.typeIdx = 1;
        },
        "function signature",
      ],
      [
        "import kind",
        (m: WasmModule) => {
          m.imports.push({ module: "env", name: "x", desc: { kind: "func", typeIdx: 1 } });
        },
        "function signature",
      ],
      [
        "tag kind",
        (m: WasmModule) => {
          m.tags.push({ name: "x", typeIdx: 1 });
        },
        "function signature",
      ],
      [
        "tag import kind",
        (m: WasmModule) => {
          m.imports.push({ module: "env", name: "x", desc: { kind: "tag", typeIdx: 1 } });
        },
        "function signature",
      ],
      [
        "block kind",
        (m: WasmModule) => {
          m.functions[0]!.body = [{ op: "block", blockType: { kind: "type", typeIdx: 1 }, body: [] }];
        },
        "function signature",
      ],
      [
        "call kind",
        (m: WasmModule) => {
          m.functions[0]!.body = [{ op: "call_ref", typeIdx: 1 }];
        },
        "function signature",
      ],
      [
        "global ref",
        (m: WasmModule) => {
          m.globals.push({ name: "x", type: ref(99), mutable: false, init: [] });
        },
        "heap type",
      ],
      [
        "local ref",
        (m: WasmModule) => {
          m.functions[0]!.locals.push({ name: "x", type: ref(99) });
        },
        "heap type",
      ],
    ] as const) {
      it(`rejects invalid ${name} with flattened lookup, emitter=${emitter.name}`, () => {
        const module = recursiveValueModule();
        mutation(module);
        expect(() => emitter(module)).toThrow(message);
      });
    }
  }
});
