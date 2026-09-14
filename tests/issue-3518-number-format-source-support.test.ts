// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ts } from "../src/ts-api.js";
import { buildSelfHostedIrBody } from "../src/frontend/builtins/build-ir.js";
import { prepareNumberFormatRuntimeSupport } from "../src/frontend/builtins/prepare-number-format.js";
import { numToStringRadixDef } from "../src/stdlib/number-format.js";
import { numberFormatRadixSupportDeclarations } from "../src/ir/program/formatter-support.js";
import {
  assertIrRuntimeSupport,
  irRuntimeSupportOccurrences,
  irNumberFormatDemandOwners,
} from "../src/ir/program/runtime-support.js";
import { prepareIrProgramSources } from "../src/ir/program-source.js";
import { AllocSiteRegistry } from "../src/ir/alloc-registry.js";
import { createIrSourceId } from "../src/ir/identity.js";
import { sourceInput } from "./helpers/typed-program-fixtures.js";

const ORIGINAL = readFileSync(new URL("../website/playground/examples/js/async.ts", import.meta.url), "utf8");
const policy = { backend: "wasmgc", target: "standalone", stringConst: { storage: "native" } } as const;
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

function source() {
  const result = prepareIrProgramSources({
    ...sourceInput({ "./entry.ts": ORIGINAL }),
    policy,
    promiseDelayProjection: "standalone-native",
    asyncFamilyProjection: "standalone-native",
  });
  if (result.kind !== "prepared") throw new Error(result.detail);
  return result;
}

function kernel() {
  const declarations = numberFormatRadixSupportDeclarations(
    createIrSourceId({
      sourceKey: "./entry.ts",
      kind: "entry",
      order: 0,
    }),
  );
  const definition = numToStringRadixDef(declarations.scratch.type);
  const input = {
    definition,
    ownerUnitId: declarations.ownerUnitId,
    callees: new Map(
      declarations.kernels.map((entry) => [
        entry.ref.name,
        { target: entry.ref, signature: { params: entry.params, returnType: entry.results[0] ?? null } },
      ]),
    ),
    allocRegistry: new AllocSiteRegistry(),
  };
  return { declarations, input };
}

describe("genuine radix source kernel", () => {
  it("pins the original source bytes and independent source occurrence order", () => {
    const { input } = kernel();
    expect(Buffer.byteLength(input.definition.source)).toBe(1618);
    expect(hash(input.definition.source)).toBe("7b13099fbed0a87079f92e9bddbf75959065ed28daf66d5ad344e0b240037dc6");
    const ast = ts.createSourceFile("radix.ts", input.definition.source, ts.ScriptTarget.Latest, true);
    const calls: string[] = [];
    const literals: string[] = [];
    const walk = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) calls.push(node.expression.getText(ast));
      if (ts.isStringLiteral(node)) literals.push(node.text);
      ts.forEachChild(node, walk);
    };
    walk(ast);
    expect(calls).toHaveLength(16);
    expect(calls.filter((name) => name === "Math.floor")).toHaveLength(4);
    expect(calls.filter((name) => name === "__nfd_set")).toHaveLength(7);
    expect(calls.filter((name) => name === "__nfd_get")).toHaveLength(2);
    for (const name of ["__nfd_new", "__nfd_fin", "__num_fmt_trap"])
      expect(calls.filter((actual) => actual === name)).toHaveLength(1);
    expect(literals).toEqual(["NaN", "Infinity", "-Infinity", "0"]);
    expect([...input.definition.calleeTypes.keys()]).toEqual([
      "__nfd_new",
      "__nfd_get",
      "__nfd_set",
      "__nfd_fin",
      "__num_fmt_trap",
    ]);
    expect(input.definition.memoKey).toBeUndefined();
  });

  it("retains the build owner and shared registry through actual hygiene", () => {
    const { input } = kernel();
    const body = buildSelfHostedIrBody(input);
    expect(body.unitId).toBe(input.ownerUnitId);
    const receipts = irRuntimeSupportOccurrences(body);
    expect(receipts.calls.length).toBeGreaterThan(0);
    expect(receipts.literals.length).toBeGreaterThan(0);
    const captured = input.allocRegistry.capturePreparationData({ body, receipts });
    expect(captured.data.body.unitId).toBe(body.unitId);
    expect(captured.data.receipts).toEqual(receipts);
    for (const occurrence of receipts.calls) {
      let actual: unknown = body;
      for (const key of occurrence.path) actual = (actual as Record<string | number, unknown>)[key];
      expect(actual).toMatchObject({ kind: "call", target: occurrence.target });
    }
  });

  it.each(["name", "arity", "trap", "order", "signature"] as const)(
    "rejects %s corruption after a genuine build",
    (mutation) => {
      const { input } = kernel();
      expect(buildSelfHostedIrBody(input).unitId).toBe(input.ownerUnitId);
      if (mutation === "name")
        expect(() => buildSelfHostedIrBody({ ...input, definition: { ...input.definition, name: "missing" } })).toThrow(
          /matching function/,
        );
      else if (mutation === "arity")
        expect(() => buildSelfHostedIrBody({ ...input, definition: { ...input.definition, paramTypes: [] } })).toThrow(
          /paramTypes/,
        );
      else {
        const callees = new Map(input.callees);
        if (mutation === "trap") callees.delete("__num_fmt_trap");
        if (mutation === "signature") {
          const entry = callees.get("__nfd_new")!;
          callees.set("__nfd_new", { ...entry, signature: { ...entry.signature, params: [] } });
        }
        const altered = mutation === "order" ? new Map([...callees].reverse()) : callees;
        expect(() => buildSelfHostedIrBody({ ...input, callees: altered })).toThrow(/callee declarations/);
      }
    },
  );
});

describe("real native family support producer", () => {
  it("builds separate support without manufacturing primary source units", () => {
    const prepared = source();
    const functions = prepared.ir.functions;
    const inventory = prepared.inventory;
    const support = prepareNumberFormatRuntimeSupport(prepared, policy);
    expect(support?.batches).toHaveLength(1);
    const batch = support!.batches[0]!;
    expect(batch.demandOwners).toEqual(irNumberFormatDemandOwners(functions));
    expect(batch.demandOwners.length).toBeGreaterThan(0);
    expect(irRuntimeSupportOccurrences(batch.implementation.body)).toEqual({
      calls: batch.calls,
      literals: batch.literals,
    });
    expect(prepared.ir.functions).toBe(functions);
    expect(prepared.inventory).toBe(inventory);
    expect(functions.includes(batch.implementation.body)).toBe(false);
    expect(() => prepareNumberFormatRuntimeSupport(prepared, { backend: "wasmgc", target: "host" })).toThrow();
  });

  it("omits support for genuine no-demand source", () => {
    const prepared = prepareIrProgramSources(sourceInput());
    if (prepared.kind !== "prepared") throw new Error(prepared.detail);
    expect(prepareNumberFormatRuntimeSupport(prepared, policy)).toBeUndefined();
  });

  it("rejects changed source, owner, target and allocation evidence after genuine joint capture", () => {
    const prepared = source();
    const support = prepareNumberFormatRuntimeSupport(prepared, policy)!;
    const captured = prepared.allocations.capturePreparationData({
      inventory: prepared.inventory,
      ir: prepared.ir,
      derivedUnits: prepared.derivedUnits,
      support,
    });
    const input = { ...captured.data, allocations: captured.allocations };
    const original = captured.data.support;
    expect(() => assertIrRuntimeSupport(input, original)).not.toThrow();
    const batch = original.batches[0]!;
    const foreign = numberFormatRadixSupportDeclarations(
      createIrSourceId({
        kind: "entry",
        order: 1,
        sourceKey: "./foreign.ts",
      }),
    );
    const mutations = [
      { ...batch, source: { ...batch.source, utf8Bytes: 1617 as 1618 } },
      {
        ...batch,
        implementation: {
          ...batch.implementation,
          body: { ...batch.implementation.body, unitId: foreign.ownerUnitId },
        },
      },
      { ...batch, implementation: { ...batch.implementation, declaration: foreign.implementation } },
      { ...batch, literals: [] },
    ];
    for (const altered of mutations)
      expect(() => assertIrRuntimeSupport(input, { ...original, batches: [altered] })).toThrow();
    const empty = new AllocSiteRegistry().captureSnapshot();
    expect(() => assertIrRuntimeSupport({ ...input, allocations: empty }, original)).toThrow();
    expect(() => assertIrRuntimeSupport(input, undefined)).toThrow();
  });
});
