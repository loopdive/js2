import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { ts } from "../src/ts-api.js";
import { IrFunctionBuilder } from "../src/ir/builder.js";
import { collectDynamicStringLocalWidening } from "../src/ir/dynamic-local-widening.js";
import {
  asBlockId,
  asValueId,
  irDynamic,
  irVal,
  lowerIrFunctionToWasm,
  verifyIrFunction,
  type IrDynamicLowering,
  type IrFunction,
  type IrLowerResolver,
} from "../src/ir/index.js";
import type { FuncTypeDef, Instr, ValType } from "../src/ir/types.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";
import { walkInstructions } from "../src/codegen/walk-instructions.js";

const identities = createTestIrFunctionIdentityFactory("issue-3795-ir-dynamic-member-set");
const DYN = irDynamic();
const F64 = irVal({ kind: "f64" });

const PRIVATE_NAME_SOURCE = `
export function isPrivateNameConflicted(privateNameMap: any, element: any) {
  var name = element.key.name;
  var curr = privateNameMap[name];

  var next = "true";
  if (element.type === "MethodDefinition" && (element.kind === "get" || element.kind === "set")) {
    next = (element.static ? "s" : "i") + element.kind;
  }

  if (
    curr === "iget" && next === "iset" ||
    curr === "iset" && next === "iget" ||
    curr === "sget" && next === "sset" ||
    curr === "sset" && next === "sget"
  ) {
    privateNameMap[name] = "true";
    return false;
  } else if (!curr) {
    privateNameMap[name] = next;
    return false;
  } else {
    return true;
  }
}
`;

const NULLISH_IR_SOURCE = `
export function irGet(recv: any, key: any): any {
  return recv[key];
}

export function irSet(recv: any, key: any): void {
  recv[key] = "true";
}
`;

const NULLISH_DIRECT_SOURCE = `
function directNullValue(): any {
  var holder: any = { value: null };
  return holder.value;
}

function directUndefinedValue(): any {
  var holder: any = {};
  return holder.missing;
}

function directGet(recv: any): number {
  try {
    var value = recv["x"]++;
    return value ? 0 : 0;
  } catch {
    return 1;
  }
}

function directSet(recv: any): number {
  try {
    var value = recv["x"] += "true";
    return value ? 0 : 0;
  } catch {
    return 1;
  }
}

export function directGetNull(): number {
  return directGet(directNullValue());
}

export function directGetUndefined(): number {
  return directGet(directUndefinedValue());
}

export function directSetNull(): number {
  return directSet(directNullValue());
}

export function directSetUndefined(): number {
  return directSet(directUndefinedValue());
}
`;

const PRIVATE_NAME_WASM_DRIVER_SOURCE =
  PRIVATE_NAME_SOURCE +
  `
export function registerProofDependencies(): any {
  var map = Object.create(null);
  Object.freeze(map);
  Object.hasOwn(map, "__proto__");
  return [
    "name", "key", "type", "kind", "static",
    "get", "set", "field", "MethodDefinition", "PropertyDefinition",
    "x", "__proto__", "iget", "sset", "true"
  ];
}
`;

describe("#3795 IR dynamic local widening and strict member set", () => {
  it("proves only Acorn's whole-local dynamic string widening", () => {
    const source = ts.createSourceFile(
      "issue-3795-analysis.ts",
      PRIVATE_NAME_SOURCE,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const fn = source.statements.find(ts.isFunctionDeclaration);
    expect(fn).toBeDefined();
    expect([...collectDynamicStringLocalWidening(fn!, new Set(["privateNameMap", "element"]))]).toEqual(["next"]);
  });

  it.each(["gc", "standalone"] as const)(
    "throws like direct codegen for nullish dynamic Get/Set on %s",
    async (target) => {
      const previousForce = process.env.JS2WASM_FORCE_DYN_MEMBER_SET;
      process.env.JS2WASM_FORCE_DYN_MEMBER_SET = "1";
      let irResult: Awaited<ReturnType<typeof compile>>;
      try {
        irResult = await compile(NULLISH_IR_SOURCE, {
          fileName: `issue-3795-nullish-ir-${target}.ts`,
          target,
          skipSemanticDiagnostics: true,
          trackIrOutcomes: true,
        });
      } finally {
        // biome-ignore lint/performance/noDelete: restore the test-only environment state exactly
        if (previousForce === undefined) delete process.env.JS2WASM_FORCE_DYN_MEMBER_SET;
        else process.env.JS2WASM_FORCE_DYN_MEMBER_SET = previousForce;
      }
      const directResult = await compile(NULLISH_DIRECT_SOURCE, {
        fileName: `issue-3795-nullish-direct-${target}.ts`,
        target,
        skipSemanticDiagnostics: true,
        trackIrOutcomes: true,
      });

      expect(irResult.success, irResult.errors.map((error) => error.message).join("\n")).toBe(true);
      expect(irResult.irPostClaimErrors ?? []).toEqual([]);
      expect(irResult.irCompiledFuncs ?? [], JSON.stringify(irResult.irOutcomes, null, 2)).toEqual(
        expect.arrayContaining(["irGet", "irSet"]),
      );
      expect(directResult.success, directResult.errors.map((error) => error.message).join("\n")).toBe(true);
      expect(directResult.irPostClaimErrors ?? []).toEqual([]);
      expect(directResult.irCompiledFuncs ?? []).not.toEqual(
        expect.arrayContaining(["directGetNull", "directGetUndefined", "directSetNull", "directSetUndefined"]),
      );

      const { instance: irInstance } = await WebAssembly.instantiate(irResult.binary, irResult.importObject);
      const { instance: directInstance } = await WebAssembly.instantiate(
        directResult.binary,
        directResult.importObject,
      );
      const directExports = directInstance.exports as Record<string, () => number>;
      for (const name of ["directGetNull", "directGetUndefined", "directSetNull", "directSetUndefined"]) {
        expect(directExports[name]!(), `${name} must catch RequireObjectCoercible TypeError`).toBe(1);
      }

      if (target === "gc") {
        const irExports = irInstance.exports as {
          irGet: (recv: unknown, key: unknown) => unknown;
          irSet: (recv: unknown, key: unknown) => void;
        };
        expect(() => irExports.irGet(null, "x")).toThrow();
        expect(() => irExports.irGet(undefined, "x")).toThrow();
        expect(() => irExports.irSet(null, "x")).toThrow();
        expect(() => irExports.irSet(undefined, "x")).toThrow();
      } else {
        const irExports = irInstance.exports as Record<string, () => unknown>;
        for (const name of ["__dms_null_get", "__dms_undefined_get", "__dms_null_set", "__dms_undefined_set"]) {
          expect(() => irExports[name]!(), `${name} must preserve RequireObjectCoercible`).toThrow();
        }
      }
    },
  );

  it("runs the private-name truth table entirely inside standalone Wasm", async () => {
    const target = "standalone" as const;
    const previousForce = process.env.JS2WASM_FORCE_DYN_MEMBER_SET;
    process.env.JS2WASM_FORCE_DYN_MEMBER_SET = "1";
    let result: Awaited<ReturnType<typeof compile>>;
    try {
      result = await compile(PRIVATE_NAME_WASM_DRIVER_SOURCE, {
        fileName: `issue-3795-private-name-wasm-driver-${target}.ts`,
        target,
        skipSemanticDiagnostics: true,
        trackIrOutcomes: true,
      });
    } finally {
      // biome-ignore lint/performance/noDelete: restore the test-only environment state exactly
      if (previousForce === undefined) delete process.env.JS2WASM_FORCE_DYN_MEMBER_SET;
      else process.env.JS2WASM_FORCE_DYN_MEMBER_SET = previousForce;
    }

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect(result.irCompiledFuncs ?? []).toContain("isPrivateNameConflicted");

    const { instance } = await WebAssembly.instantiate(result.binary, result.importObject);
    const exports = instance.exports as {
      __dms_private_name_checksum: () => number;
      __dms_private_name_strict_failure: () => void;
    };
    expect(exports.__dms_private_name_checksum()).toBe(0xffff);
    expect(() => exports.__dms_private_name_strict_failure()).toThrow();
  });

  it.each(["gc", "standalone"] as const)(
    "executes Acorn's exact private-name conflict family on %s",
    async (target) => {
      const result = await compile(PRIVATE_NAME_SOURCE, {
        fileName: `issue-3795-ir-dynamic-member-set-${target}.ts`,
        target,
        skipSemanticDiagnostics: true,
        trackIrOutcomes: true,
      });

      expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
      expect(result.irPostClaimErrors ?? []).toEqual([]);
      expect(result.irCompiledFuncs, JSON.stringify(result.irOutcomes, null, 2)).toContain("isPrivateNameConflicted");

      const { instance } = await WebAssembly.instantiate(result.binary, result.importObject);
      const exports = instance.exports as {
        isPrivateNameConflicted: (map: Record<string, unknown>, element: Record<string, unknown>) => number;
      };
      if (target === "gc") {
        const element = (kind: string, isStatic: boolean, name = "x") => ({
          key: { name },
          type: kind === "field" ? "PropertyDefinition" : "MethodDefinition",
          kind,
          static: isStatic,
        });
        const instanceMap = Object.create(null) as Record<string, unknown>;
        expect(exports.isPrivateNameConflicted(instanceMap, element("get", false))).toBe(0);
        expect(instanceMap.x).toBe("iget");
        expect(exports.isPrivateNameConflicted(instanceMap, element("set", false))).toBe(0);
        expect(instanceMap.x).toBe("true");
        expect(exports.isPrivateNameConflicted(instanceMap, element("get", false))).toBe(1);

        const staticMap = Object.create(null) as Record<string, unknown>;
        expect(exports.isPrivateNameConflicted(staticMap, element("set", true))).toBe(0);
        expect(staticMap.x).toBe("sset");
        expect(exports.isPrivateNameConflicted(staticMap, element("get", true))).toBe(0);
        expect(staticMap.x).toBe("true");

        const mixedMap = Object.create(null) as Record<string, unknown>;
        expect(exports.isPrivateNameConflicted(mixedMap, element("get", false))).toBe(0);
        expect(exports.isPrivateNameConflicted(mixedMap, element("set", true))).toBe(1);

        const nullProto = Object.create(null) as Record<string, unknown>;
        expect(exports.isPrivateNameConflicted(nullProto, element("field", false, "__proto__"))).toBe(0);
        expect(nullProto.__proto__).toBe("true");

        expect(() => exports.isPrivateNameConflicted(Object.freeze({}), element("field", false))).toThrow();
      }
    },
  );

  it("rejects annotated/wider writes before claim in overlay and IR-first", async () => {
    const source = `
function assignmentValue(map: any, key: any): any {
  var next = "true";
  next = key.kind + "x";
  return map[key] = next;
}

function widerValue(map: any, key: any, other: any): boolean {
  var next = "true";
  next = key.kind + "x";
  next = other;
  map[key] = next;
  return false;
}

function annotatedValue(map: any, key: any): boolean {
  var next: string = "true";
  next = key.kind + "x";
  map[key] = next;
  return false;
}

export function run(): number {
  return assignmentValue({}, "x") === "undefinedx" &&
    !widerValue({}, "x", "y") &&
    !annotatedValue({}, "x") ? 1 : 0;
}
`;
    for (const irFirst of [false, true]) {
      const previous = process.env.JS2WASM_IR_FIRST;
      if (irFirst) process.env.JS2WASM_IR_FIRST = "1";
      // biome-ignore lint/performance/noDelete: exercise the default policy without leaving a string sentinel
      else delete process.env.JS2WASM_IR_FIRST;
      let result: Awaited<ReturnType<typeof compile>>;
      try {
        result = await compile(source, {
          fileName: `issue-3795-ir-dynamic-member-set-negative-${irFirst ? "first" : "overlay"}.ts`,
          target: "gc",
          skipSemanticDiagnostics: true,
          trackIrOutcomes: true,
        });
      } finally {
        // biome-ignore lint/performance/noDelete: restore the test-only environment state exactly
        if (previous === undefined) delete process.env.JS2WASM_IR_FIRST;
        else process.env.JS2WASM_IR_FIRST = previous;
      }

      expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
      expect(result.irPostClaimErrors ?? []).toEqual([]);
      expect(result.irCompiledFuncs ?? []).not.toContain("assignmentValue");
      expect(result.irCompiledFuncs ?? []).not.toContain("widerValue");
      expect(result.irCompiledFuncs ?? []).not.toContain("annotatedValue");
    }
  });
});

describe("#3795 dyn.member_set node and lowering contract", () => {
  it("builds and verifies the canonical void node", () => {
    const builder = new IrFunctionBuilder(identities.next("builder"), [], false);
    const recv = builder.addParam("recv", DYN);
    const key = builder.addParam("key", DYN);
    const value = builder.addParam("value", DYN);
    builder.openBlock();
    builder.emitDynMemberSet(recv, key, value);
    builder.terminate({ kind: "return", values: [] });
    const fn = builder.finish();

    expect(fn.blocks[0]?.instrs[0]).toMatchObject({ kind: "dyn.member_set", recv, key, value });
    expect(verifyIrFunction(fn)).toEqual([]);
  });

  it("rejects concrete operands at construction and verification", () => {
    const builder = new IrFunctionBuilder(identities.next("builder-bad"), [], false);
    const recv = builder.addParam("recv", DYN);
    const key = builder.addParam("key", DYN);
    const concrete = builder.addParam("value", F64);
    builder.openBlock();
    expect(() => builder.emitDynMemberSet(recv, key, concrete)).toThrow(/value operand .* is not dynamic/);

    builder.terminate({ kind: "return", values: [] });
    const fn = builder.finish();
    const bad: IrFunction = {
      ...fn,
      blocks: [
        {
          ...fn.blocks[0]!,
          instrs: [{ kind: "dyn.member_set", recv, key, value: concrete } as never],
        },
      ],
    };
    expect(verifyIrFunction(bad).some((error) => /dyn\.member_set value must be a dynamic/.test(error.message))).toBe(
      true,
    );
  });

  it("lowers receiver, key, and value once in left-to-right order", () => {
    const recv = asValueId(0);
    const key = asValueId(1);
    const value = asValueId(2);
    const fn: IrFunction = {
      ...identities.next("lower"),
      params: [
        { value: recv, type: DYN, name: "recv" },
        { value: key, type: DYN, name: "key" },
        { value, type: DYN, name: "value" },
      ],
      resultTypes: [],
      blocks: [
        {
          id: asBlockId(0),
          blockArgs: [],
          blockArgTypes: [],
          instrs: [{ kind: "dyn.member_set", recv, key, value, result: null, resultType: null }],
          terminator: { kind: "return", values: [] },
        },
      ],
      exported: false,
      valueCount: 3,
    };
    const carrier: ValType = { kind: "externref" };
    const dynamic: IrDynamicLowering = {
      strategy: "host",
      carrier,
      emitBox: () => [],
      emitUnbox: () => [],
      emitAdd: () => [],
      emitEq: () => [],
      emitToNumber: () => [],
      emitMemberGet: () => [],
      emitElementGet: () => [],
      emitMemberSet: () => [{ op: "call", funcIdx: 0xbeef } as Instr],
    };
    const resolver: IrLowerResolver = {
      resolveFunc: () => 0,
      resolveGlobal: () => 0,
      resolveType: () => 0,
      internFuncType: (_type: FuncTypeDef) => 0,
      resolveDynamic: () => carrier,
      resolveDynamicLowering: () => dynamic,
    };

    const { func } = lowerIrFunctionToWasm(fn, resolver);
    const flattened: Instr[] = [];
    walkInstructions(func.body, (instruction) => flattened.push(instruction));
    const call = flattened.findIndex(
      (instruction) => instruction.op === "call" && (instruction as { funcIdx: number }).funcIdx === 0xbeef,
    );
    const operands = flattened
      .slice(0, call)
      .filter((instruction) => instruction.op === "local.get")
      .map((instruction) => (instruction as { index: number }).index);
    expect(operands.slice(-3)).toEqual([0, 1, 2]);
  });
});
