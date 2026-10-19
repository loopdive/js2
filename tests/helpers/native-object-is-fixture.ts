// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { descriptorFixture, descriptorSource, completeDescriptorFixture } from "./native-descriptor-fixture.js";
import { deriveNativeRealmRequirements } from "../../src/ir/program/native-realm-requirements.js";
import { deriveNativeVectorResourcePlan } from "../../src/ir/program/native-vector-resources.js";
import { planNativeRealmLiterals } from "../../src/backend/wasmgc/program/native-realm-literals.js";
import { reserveNativeVectorTypes } from "../../src/backend/wasmgc/resources/native-vectors.js";
import {
  declareNativeInvocationSubstrateResources,
  reserveNativeInvocationSubstrateResources,
  fillNativeInvocationSubstrateResources,
} from "../../src/backend/wasmgc/resources/native-invocation-substrate.js";
import { declareNativePublicBuiltinFunctionRequests } from "../../src/backend/wasmgc/resources/native-builtin-function-requests.js";
import {
  reserveNativeBooleanBoxResources,
  fillNativeBooleanBoxResources,
} from "../../src/backend/wasmgc/resources/native-booleans.js";
import {
  reserveNativeObjectIsAlgorithm,
  fillNativeObjectIsAlgorithm,
  requireCompletedNativeObjectIsAlgorithm,
} from "../../src/backend/wasmgc/resources/native-object-is.js";
import { reserveBigIntOperands, fillBigIntOperands } from "./native-bigint-carrier-fixture.js";
import { requireNativeStringLiteral } from "../../src/backend/wasmgc/resources/native-string-literals.js";
import { planNativeStringLiteral } from "../../src/runtime/wasmgc/values/string-literal-bodies.js";
import { emitBinary } from "../../src/emit/binary.js";
import type { ValType } from "../../src/wasm/model/instructions.js";

export function objectIsFixture(displaced = false, decoded = false, mode: "interned" | "allocating" = "interned") {
  const source = descriptorSource(decoded),
    realm = deriveNativeRealmRequirements(source.program, source.projection);
  if (!realm) throw Error("genuine source requires an actual realm catalog");
  const texts = planNativeRealmLiterals(realm, displaced).literals.map((row) => row.value);
  const f = descriptorFixture(displaced, source, texts, true),
    { tx } = f;
  const vectorPlan = deriveNativeVectorResourcePlan({
    anchor: f.valuePlan.anchor,
    functions: f.program.ir.functions,
    abiEntries: f.program.abi.entries,
    policy: f.projection.prepared.manifest.policy,
    providers: f.projection.prepared.manifest.providers,
    backend: "wasmgc",
    target: "standalone",
  });
  const vectors = reserveNativeVectorTypes(tx, vectorPlan);
  const substrateDependencies = { vectors, vectorPlan, strings: f.strings };
  const substrateRequirements = { key: "object-is:substrate" };
  const substratePlan = declareNativeInvocationSubstrateResources(
    substrateRequirements,
    vectors.base ? { vectorBaseKey: vectors.base.key } : {},
  );
  const substrate = reserveNativeInvocationSubstrateResources(
    tx,
    substrateRequirements,
    substrateDependencies,
    substratePlan,
  );
  const requestDependencies = {
    arguments: substrate.arguments,
    argumentPlan: substrate.argumentPlan,
    strings: f.strings,
  };
  const requests = declareNativePublicBuiltinFunctionRequests(tx, realm, requestDependencies);
  const booleanBoxes = reserveNativeBooleanBoxResources(
    tx,
    "object-is:booleans",
    f.values,
    f.valuePlan,
    f.valueDependencies,
    mode,
  );
  const dependencies = {
    requests,
    substrate,
    sameValue: f.sameValue,
    sameValueDependencies: f.sameValueDependencies,
    booleanBoxes,
  };
  const algorithm = reserveNativeObjectIsAlgorithm(tx, dependencies);
  return {
    ...f,
    realm,
    vectors,
    vectorPlan,
    substrate,
    substrateDependencies,
    requests,
    requestDependencies,
    booleanBoxes,
    objectIsDependencies: dependencies,
    objectIs: algorithm,
  };
}
export function fillObjectIsDependencies(f: ReturnType<typeof objectIsFixture>) {
  completeDescriptorFixture(f);
  fillNativeInvocationSubstrateResources(f.tx, f.substrate);
  fillNativeBooleanBoxResources(f.tx, f.booleanBoxes);
}
/** Actual canonical resources; observer exports do not publish source/public entry admission. */
export function objectIsRuntime(displaced = false, decoded = false, mode: "interned" | "allocating" = "interned") {
  const f = objectIsFixture(displaced, decoded, mode),
    { tx } = f;
  const bigintOperands = reserveBigIntOperands(tx);
  const ext: ValType = { kind: "externref" };
  const observer = (name: string, results: ValType[]) =>
    tx.reserveFunction("object-is:observer:" + name, name, { params: [], results });
  const key = observer("key", [ext]),
    textCopy = observer("textCopy", [ext]),
    undefinedValue = observer("undefinedValue", [ext]);
  const literal = planNativeStringLiteral(f.strings.layout, displaced, "name", displaced ? "utf8-guaranteed" : "wtf16");
  if (literal.kind !== "global") throw Error("short native text lost its actual literal allocation");
  const isUtf8 = displaced
    ? tx.reserveFunction("object-is:observer:isUtf8", "isUtf8", {
        params: [ext],
        results: [{ kind: "i32" }],
      })
    : undefined;
  fillObjectIsDependencies(f);
  fillNativeObjectIsAlgorithm(tx, f.objectIs);
  requireCompletedNativeObjectIsAlgorithm(tx, f.objectIs);
  fillBigIntOperands(tx, f.bigints, bigintOperands);
  const ref = requireNativeStringLiteral(tx, f.strings, "name");
  tx.fillFunction(key, {
    locals: [],
    body: [
      ref.kind === "global"
        ? { op: "global.get", index: tx.physicalIndex(ref.global) }
        : { op: "call", funcIdx: ref.function.handle },
      { op: "extern.convert_any" },
    ],
  });
  tx.fillFunction(textCopy, { locals: [], body: [...literal.init, { op: "extern.convert_any" }] });
  tx.fillFunction(undefinedValue, {
    locals: [],
    body: [{ op: "global.get", index: tx.physicalIndex(f.values.globals.undefined) }, { op: "extern.convert_any" }],
  });
  if (isUtf8) {
    tx.fillFunction(isUtf8, {
      locals: [],
      body: [
        { op: "local.get", index: 0 },
        { op: "any.convert_extern" },
        { op: "ref.test", typeIdx: f.strings.layout.utf8StrTypeIdx },
      ],
    });
    tx.defineExport("object-is:export:isUtf8", "isUtf8", isUtf8);
  }
  const exports = {
    algorithm: f.objectIs.algorithm,
    newVector: f.substrate.arguments.newVector,
    push: f.substrate.arguments.push,
    boxNumber: f.values.functions.boxNumber,
    boxBoolean: f.booleanBoxes.boxBoolean,
    unboxBoolean: f.booleans.unboxBoolean,
    isBoolean: f.booleans.isBoolean,
    symbol: f.symbols.functions.box,
    createNull: f.storage.createNull,
    key,
    textCopy,
    undefinedValue,
    ...bigintOperands,
  };
  for (const [name, token] of Object.entries(exports)) tx.defineExport("object-is:export:" + name, name, token);
  tx.seal();
  const bytes = emitBinary(f.module),
    module = new WebAssembly.Module(bytes as BufferSource);
  const imports = WebAssembly.Module.imports(module);
  if (imports.length) throw Error("Object.is native algorithm imports providers");
  const ex = new WebAssembly.Instance(module).exports as Record<string, (...args: any[]) => any>;
  const call = (args: readonly unknown[], receiver: unknown = null) => {
    const vector = ex.newVector!();
    args.forEach((value) => ex.push!(vector, value));
    return ex.algorithm!(receiver, vector);
  };
  const test = (args: readonly unknown[], receiver: unknown = null) => ex.unboxBoolean!(call(args, receiver));
  return { f, bytes, imports, ex, call, test };
}
