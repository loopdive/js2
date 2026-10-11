// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr, ValType } from "../../src/wasm/model/instructions.js";
import { emitBinary } from "../../src/emit/binary.js";
import { deriveNativePrototypeRequirements } from "../../src/ir/program/native-prototype-requirements.js";
import {
  bindNativePrototypeSeederResources,
  buildNativePrototypeSeedDescriptorTails,
  type NativePrototypeSeedDescriptor,
} from "../../src/backend/wasmgc/resources/native-prototype-seeder-bindings.js";
import { requireNativeStringLiteral } from "../../src/backend/wasmgc/resources/native-string-literals.js";
import { buildBuiltinClosureValueInstrs } from "../../src/runtime/wasmgc/values/closure-layouts.js";
import { completeDescriptorFixture, descriptorFixture } from "./native-descriptor-fixture.js";

export function seederBindingFixture(offset = false) {
  const descriptors = descriptorFixture(offset);
  const requirements = deriveNativePrototypeRequirements(descriptors.access);
  const dependencies = { descriptors: descriptors.pack, descriptorDependencies: descriptors.dependencies };
  const binding = bindNativePrototypeSeederResources(descriptors.tx, requirements, dependencies);
  return { descriptors, requirements, dependencies, binding };
}

export interface SeederDescriptorRuntime {
  create(): object;
  key(): object;
  other(): object;
  undefinedValue(): object;
  boxNumber(value: number): unknown;
  entry(object: object, key: object): [number, number, unknown, unknown, unknown];
  method(object: object, key: object, value: unknown): void;
  constructorData(object: object, key: object, value: unknown): void;
  stringData(object: object, key: object, value: unknown): void;
  numberData(object: object, key: object, value: unknown): void;
  symbolTag(object: object, key: object, value: unknown): void;
  readonlyMethod(object: object, key: object, value: unknown): void;
  getter(object: object, key: object, getter: unknown): void;
  accessor(object: object, key: object, getter: unknown, setter: unknown): void;
  closure(): object;
  exception: WebAssembly.Tag;
}

/**
 * Execute real descriptor resources with observed operands. The wrapper and
 * test closure are not builtin member, constructor or whole-prototype authority.
 */
export function seederDescriptorModule(offset = false, omitRequiredDrop = false) {
  const f = seederBindingFixture(offset),
    d = f.descriptors,
    tx = d.tx;
  const ext: ValType = { kind: "externref" },
    i32: ValType = { kind: "i32" };
  const families: ReadonlyArray<readonly [string, NativePrototypeSeedDescriptor]> = [
    ["method", { kind: "method", member: "valueOf" }],
    ["constructorData", { kind: "constructor" }],
    ["stringData", { kind: "string-data" }],
    ["numberData", { kind: "number-data" }],
    ["symbolTag", { kind: "symbol-tag" }],
    ["readonlyMethod", { kind: "method", member: "@@3" }],
    ["getter", { kind: "getter" }],
    ["accessor", { kind: "accessor-pair" }],
  ];
  const installers = families.map(([name, descriptor]) => ({
    name,
    descriptor,
    token: tx.reserveFunction("observer:seed:" + name, name, {
      params: descriptor.kind === "accessor-pair" ? [ext, ext, ext, ext] : [ext, ext, ext],
      results: [],
    }),
  }));
  const entry = tx.reserveFunction("observer:entry", "entry", {
    params: [ext, ext],
    results: [i32, i32, ext, ext, ext],
  });
  const values = ["key", "other", "undefinedValue", "closure"].map((name) => ({
    name,
    token: tx.reserveFunction("observer:" + name, name, { params: [], results: [ext] }),
  }));
  const lifted = tx.reserveFunction("observer:closure-body", "closureBody", {
    params: [{ kind: "ref", typeIdx: d.closures.root.typeIndex }],
    results: [{ kind: "f64" }],
  });
  completeDescriptorFixture(d);
  tx.fillFunction(lifted, { locals: [], body: [{ op: "f64.const", value: 7 }] });
  tx.declareFunctionReference(lifted);
  const tails = buildNativePrototypeSeedDescriptorTails(
    tx,
    f.binding,
    f.requirements,
    f.dependencies,
    installers.map(({ descriptor }) => descriptor),
  );
  for (const [index, { descriptor, token }] of installers.entries()) {
    const tail = tails[index]!;
    if (omitRequiredDrop && descriptor.kind === "method") tail.pop();
    tx.fillFunction(token, {
      locals: [],
      body: [
        { op: "local.get", index: 0 },
        { op: "local.get", index: 1 },
        { op: "local.get", index: 2 },
        ...(descriptor.kind === "getter"
          ? [{ op: "ref.null.extern" } as Instr]
          : descriptor.kind === "accessor-pair"
            ? [{ op: "local.get", index: 3 } as Instr]
            : []),
        ...tail,
      ],
    });
  }
  for (const { name, token } of values) {
    let body: Instr[];
    if (name === "undefinedValue") {
      body = [{ op: "global.get", index: tx.physicalIndex(d.values.globals.undefined) }, { op: "extern.convert_any" }];
    } else if (name === "closure") {
      body = [
        ...buildBuiltinClosureValueInstrs(d.closures.signatures[0]!.binding.type.typeIndex, lifted.handle, 0, false),
        { op: "extern.convert_any" },
      ];
    } else {
      const literal = requireNativeStringLiteral(tx, d.strings, name === "key" ? "value" : "other");
      body = [
        literal.kind === "global"
          ? { op: "global.get", index: tx.physicalIndex(literal.global) }
          : { op: "call", funcIdx: literal.function.handle },
        { op: "extern.convert_any" },
      ];
    }
    tx.fillFunction(token, { locals: [], body });
  }
  tx.fillFunction(entry, {
    locals: [],
    body: [2, 3, 1, 4, 5].flatMap((fieldIdx): Instr[] => [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: d.layouts.object.typeIndex },
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: d.lookup.findOwn.handle },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: d.layouts.propEntry.typeIndex, fieldIdx },
      ...(fieldIdx === 2 || fieldIdx === 3 ? [] : [{ op: "extern.convert_any" } as Instr]),
    ]),
  });
  const exports = {
    ...Object.fromEntries([...installers, ...values].map(({ name, token }) => [name, token])),
    entry,
    create: d.storage.createNull,
    boxNumber: d.values.functions.boxNumber,
    exception: d.exception,
  };
  for (const [name, token] of Object.entries(exports)) tx.defineExport("export:" + name, name, token);
  tx.seal();
  return Uint8Array.from(emitBinary(d.module));
}

export function seederDescriptorRuntime(
  offset = false,
  bytes: BufferSource = seederDescriptorModule(offset),
): SeederDescriptorRuntime {
  const module = new WebAssembly.Module(bytes);
  if (WebAssembly.Module.imports(module).length) throw Error("seeder descriptor test unexpectedly imports providers");
  return new WebAssembly.Instance(module).exports as unknown as SeederDescriptorRuntime;
}
