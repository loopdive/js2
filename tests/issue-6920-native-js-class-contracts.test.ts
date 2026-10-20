// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { ts } from "../src/ts-api.js";
import { buildIrUnitInventory } from "../src/ir/identity.js";
import { buildIrPlanningIdentityContext } from "../src/ir/planning-identity.js";
import { prepareSourceJsClassDefinitions } from "../src/ir/source-js-class-definition.js";
import { prepareIrJsClassAbiEntries } from "../src/ir/program/js-class-abi.js";
import { preparedIrJsClassDefinitions, irJsClassDefinitionBindingId } from "../src/ir/program/js-class-definition.js";
import {
  verifyIrJsClassDefinitionData,
  verifyIrJsClassInstruction,
  copyIrJsClassData,
} from "../src/ir/runtime/js-class-verify.js";
import { asValueId, directUses, forEachNestedBuffer, mapNestedBuffers, type IrInstr } from "../src/ir/core/nodes.js";
import { irDynamic, irSupportRef, irVal } from "../src/ir/core/types.js";
import { effectsOf, isSideEffecting } from "../src/ir/analysis/effects.js";
import { collectIrUses } from "../src/ir/backend/instruction-uses.js";
import { renameInstrOperands } from "../src/ir/passes/inline-small.js";
import { AllocSiteRegistry } from "../src/ir/analysis/alloc-registry.js";
import type { IrJsClassDefinition } from "../src/ir/js-class-contracts.js";

function originalDefinition(): { definition: IrJsClassDefinition; inventory: ReturnType<typeof buildIrUnitInventory> } {
  const file = "/contract.ts",
    source = ts.createSourceFile(
      file,
      "class C{a:number=3;b:number;read():number{return 7;}other():number{return 8;}}",
      ts.ScriptTarget.Latest,
      true,
    );
  const host = ts.createCompilerHost({ noLib: true });
  host.getSourceFile = (name) => (name === file ? source : undefined);
  const program = ts.createProgram([file], { noLib: true, strict: true }, host);
  const inventory = buildIrUnitInventory([source], { entrySource: source, wholeProgramClassConstructors: true });
  const definition = prepareSourceJsClassDefinitions(
    program.getTypeChecker(),
    buildIrPlanningIdentityContext(inventory),
  ).definitions[0]!;
  return { definition, inventory };
}
const clone = <T>(data: T): T => JSON.parse(JSON.stringify(data)) as T;
describe("native JS class closed DATA and explicit op protocols (no runtime issuance)", () => {
  it("extracts one immutable definition from its real canonical support:none ABI", () => {
    const { definition, inventory } = originalDefinition();
    let ordinal = 0;
    const entries = prepareIrJsClassAbiEntries([definition], inventory, () => ({
      sourceOrder: 0,
      declarationOrder: ordinal++,
    }));
    const rows = preparedIrJsClassDefinitions(entries);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.bindingId).toBe(irJsClassDefinitionBindingId(definition));
    expect(rows[0]!.definition).toEqual(definition);
    expect(Object.isFrozen(rows[0]!.definition.instanceElements)).toBe(true);
    expect(verifyIrJsClassDefinitionData(clone(definition))).toEqual([]);
  });
  it.each([
    [
      "wrong schema",
      (d: any) => {
        d.schema = "outsider";
      },
    ],
    [
      "numeric default carrier",
      (d: any) => {
        d.instanceElements[1].valueType = { kind: "val", val: { kind: "f64" } };
      },
    ],
    [
      "initializer USER arg",
      (d: any) => {
        d.instanceElements[0].initializer.params = [{ kind: "val", val: { kind: "f64" } }];
      },
    ],
    [
      "reordered initializer",
      (d: any) => {
        d.instanceElements.reverse();
      },
    ],
    [
      "reordered methods",
      (d: any) => {
        d.members.reverse();
      },
    ],
    [
      "mutable inner",
      (d: any) => {
        d.innerBinding.mutable = true;
      },
    ],
    [
      "foreign target",
      (d: any) => {
        d.members[0].body.target.binding.unitId = d.constructor.unitId;
      },
    ],
    [
      "foreign role",
      (d: any) => {
        d.roles.frame.binding.kind = "source";
      },
    ],
    [
      "wrong own field attrs",
      (d: any) => {
        d.instanceElements[0].attributes.enumerable = false;
      },
    ],
    [
      "unexplained DATA",
      (d: any) => {
        d.ready = true;
      },
    ],
  ])("rejects %s before any class authority", (_, mutate) => {
    const data = clone(originalDefinition().definition);
    mutate(data);
    expect(verifyIrJsClassDefinitionData(data).length).toBeGreaterThan(0);
  });
  it("rejects descriptor getter without executing it", () => {
    const d = clone(originalDefinition().definition);
    let reads = 0;
    Object.defineProperty(d, "members", {
      get() {
        reads++;
        return [];
      },
    });
    expect(verifyIrJsClassDefinitionData(d).length).toBeGreaterThan(0);
    expect(reads).toBe(0);
  });
  it("rejects sparse and cyclic DATA without an empty-census success", () => {
    const d = clone(originalDefinition().definition);
    Reflect.deleteProperty(d.members, "0");
    expect(Object.hasOwn(d.members, "0")).toBe(false);
    expect(verifyIrJsClassDefinitionData(d).length).toBeGreaterThan(0);
    const cycle: any = {};
    cycle.self = cycle;
    expect(() => copyIrJsClassData(cycle)).toThrow("cycle");
  });
  it("rejects copied foreign/duplicate support bindings", () => {
    const { definition, inventory } = originalDefinition();
    let ordinal = 0;
    const entries = prepareIrJsClassAbiEntries([definition], inventory, () => ({
      sourceOrder: 0,
      declarationOrder: ordinal++,
    }));
    const own = entries.find((entry) => entry.contract.kind === "support")!;
    expect(() => preparedIrJsClassDefinitions([...entries, own])).toThrow("duplicate");
    const foreign = clone(own);
    (foreign.plan as any).id = entries[0]!.plan.id;
    expect(() => preparedIrJsClassDefinitions([foreign])).toThrow("noncanonical");
  });
  it("reads/renames all genuine frame roots and preserves descriptor/site/result identities", () => {
    const { definition } = originalDefinition(),
      registry = new AllocSiteRegistry();
    const type = irSupportRef(definition.roles.frame, false),
      args = [0, 1, 2, 3].map(asValueId);
    const instr: Extract<IrInstr, { kind: "js.class.frame.new" }> = {
      kind: "js.class.frame.new",
      definition: irJsClassDefinitionBindingId(definition),
      environment: args[0]!,
      thisValue: args[1]!,
      homeObject: args[2]!,
      newTarget: args[3]!,
      result: asValueId(4),
      resultType: type,
      alloc: registry.fresh("object", type, { line: 1, column: 0 }),
    };
    expect(directUses(instr)).toEqual(args);
    expect(collectIrUses(instr)).toEqual(args);
    const next = renameInstrOperands(instr, new Map(args.map((v) => [v, asValueId(v + 10)]))) as typeof instr;
    expect(directUses(next)).toEqual([10, 11, 12, 13]);
    expect(next.definition).toBe(instr.definition);
    expect(next.alloc).toBe(instr.alloc);
    expect(next.result).toBe(instr.result);
    let buffers = 0;
    forEachNestedBuffer(instr, () => {
      buffers++;
    });
    expect(buffers).toBe(0);
    expect(
      mapNestedBuffers(instr, () => {
        throw Error("not a leaf");
      }),
    ).toBe(instr);
    const types = new Map(args.map((v) => [v, irSupportRef(definition.roles.environment, false)]));
    expect(verifyIrJsClassInstruction(instr, types)).toEqual([]);
    expect(isSideEffecting(instr)).toBe(true);
    expect(effectsOf(instr).control).toBe(true);
    const bad = { ...instr, resultType: irSupportRef(definition.roles.constructor, false) };
    expect(verifyIrJsClassInstruction(bad, types).some((problem) => problem.includes("result role"))).toBe(true);
    expect(verifyIrJsClassInstruction({ ...instr, alloc: undefined } as any, types).length).toBeGreaterThan(0);
  });
  it("keeps TDZ reads while identity remains a pure actual managed comparison", () => {
    const { definition } = originalDefinition(),
      type = irSupportRef(definition.roles.constructor, false),
      v = asValueId(0);
    const read: IrInstr = {
      kind: "js.class.binding.read",
      storage: { kind: "module", bindingId: definition.outerBinding!.id },
      result: v,
      resultType: type,
    };
    const identity: IrInstr = {
      kind: "js.class.identity",
      left: v,
      right: v,
      result: asValueId(1),
      resultType: irVal({ kind: "i32", boolean: true }),
    };
    expect(isSideEffecting(read)).toBe(true);
    expect(effectsOf(read).control).toBe(true);
    expect(isSideEffecting(identity)).toBe(false);
    expect(effectsOf(identity).control).toBe(false);
    expect(verifyIrJsClassInstruction(identity, new Map([[v, type]]))).toEqual([]);
  });
});

describe("actual JSValue invocation validation (no runtime authority)", () => {
  it("accepts actual tagged callable/argument transport and reads every operand", () => {
    const { definition } = originalDefinition();
    const instr: Extract<IrInstr, { kind: "js.class.invoke" }> = {
      kind: "js.class.invoke",
      callable: asValueId(0),
      receiver: asValueId(1),
      args: [asValueId(2)],
      signature: { params: [irDynamic()], result: irDynamic() },
      result: asValueId(3),
      resultType: irDynamic(),
    };
    const types = new Map([
      [asValueId(0), irDynamic()],
      [asValueId(1), irSupportRef(definition.roles.object, false)],
      [asValueId(2), irDynamic()],
    ]);
    expect(verifyIrJsClassInstruction(instr, types)).toEqual([]);
    expect(directUses(instr)).toEqual([0, 1, 2]);
    expect(collectIrUses(instr)).toEqual([0, 1, 2]);
    expect(isSideEffecting(instr)).toBe(true);
    const renamed = renameInstrOperands(
      instr,
      new Map([
        [asValueId(0), asValueId(10)],
        [asValueId(1), asValueId(11)],
        [asValueId(2), asValueId(12)],
      ]),
    );
    expect(directUses(renamed)).toEqual([10, 11, 12]);
    expect(
      verifyIrJsClassInstruction(
        instr,
        new Map([...types, [asValueId(0), irSupportRef(definition.roles.method, false)]]),
      ),
    ).not.toEqual([]);
    expect(verifyIrJsClassInstruction({ ...instr, resultType: irVal({ kind: "f64" }) }, types)).not.toEqual([]);
    expect(verifyIrJsClassInstruction({ ...instr, signature: { ...instr.signature, params: [] } }, types)).not.toEqual(
      [],
    );
    expect(verifyIrJsClassInstruction({ ...instr, signature: null } as any, types)).not.toEqual([]);
    let getters = 0;
    const signature = {
      get params() {
        getters++;
        return [];
      },
      result: irDynamic(),
    };
    expect(verifyIrJsClassInstruction({ ...instr, signature } as any, types)).not.toEqual([]);
    expect(getters).toBe(0);
  });
});
