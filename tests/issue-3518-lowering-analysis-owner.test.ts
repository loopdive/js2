// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import type * as Layout from "../src/ir/analysis/contracts/linear-memory-layout.js";
import type * as Planner from "../src/ir/analysis/linear-memory-plan.js";
import {
  verifyIrBackendLegality as canonical,
  type IrBackendKind,
  type IrBackendLegalityError,
  type IrBackendFnctorResolver,
} from "../src/ir/analysis/backend-legality.js";
import { verifyIrBackendLegality as compatibility } from "../src/ir/backend/legality.js";
import { IrFunctionBuilder } from "../src/ir/builder.js";
import {
  asBlockId,
  asValueId,
  irVal,
  irFnctor,
  type IrFunction,
  type IrInstr,
  type IrType,
  type IrClassShape,
  type IrLabelId,
} from "../src/ir/nodes.js";
import type { IrFnctorShape } from "../src/ir/fnctor-abi.js";
import type { IrSourceId, IrUnitId, IrBindingId } from "../src/ir/identity.js";
import { verifyIrFunction } from "../src/ir/verify.js";
import { createTestIrClassId, createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

const identities = createTestIrFunctionIdentityFactory("lowering-analysis-owner");
const i32 = irVal({ kind: "i32" }),
  i64 = irVal({ kind: "i64" }),
  f32 = irVal({ kind: "f32" });
const backends: readonly IrBackendKind[] = ["wasmgc", "linear", "bytecode", "porffor"];
const verifiers = [canonical, compatibility];

function scalar(name = "healthy"): IrFunction {
  return {
    ...identities.next(name),
    params: [],
    resultTypes: [i32],
    blocks: [
      {
        id: asBlockId(0),
        blockArgs: [],
        blockArgTypes: [],
        instrs: [{ kind: "const", value: { kind: "i32", value: 7 }, result: asValueId(1), resultType: i32 }],
        terminator: { kind: "return", values: [asValueId(1)] },
      },
    ],
    exported: false,
    valueCount: 2,
  };
}
function parameter(name: string, type: IrType): IrFunction {
  const builder = new IrFunctionBuilder(identities.next(name), []);
  builder.addParam("input", type);
  builder.openBlock();
  builder.terminate({ kind: "return", values: [] });
  return builder.finish();
}
function certified(fn: IrFunction): IrFunction {
  expect(verifyIrFunction(fn)).toEqual([]);
  return fn;
}
function both(
  fn: IrFunction,
  backend: IrBackendKind,
  expected: readonly IrBackendLegalityError[],
  resolver?: IrBackendFnctorResolver,
): void {
  certified(fn);
  for (const verify of verifiers) expect(verify(fn, backend, resolver)).toEqual(expected);
}
function typeError(message: string, func: string, block?: number): IrBackendLegalityError {
  return { message, func, block };
}
function instructionError(message: string, func: string, instr: string): IrBackendLegalityError {
  return { message, func, block: 0, instr };
}
function shape(): IrFnctorShape {
  const unitId = "ir-unit:test:layout-legality:Parser" as IrUnitId;
  return {
    kind: "fnctor-shape",
    sourceId: "ir-source:test:layout-legality" as IrSourceId,
    constructorUnitId: unitId,
    constructorName: "Parser",
    constructorTarget: { kind: "func", name: "Parser", binding: { kind: "unit", unitId } },
    reservedLayout: {
      kind: "type",
      name: "ParserLayout",
      binding: { kind: "source", bindingId: "ir-binding:test:layout-legality" as IrBindingId },
    },
    fields: [{ name: "input", type: { kind: "string" }, ordinal: 0 }],
    captures: [],
    userParamTypes: [],
    hiddenIdentity: false,
    constructorIdentity: { unitId, paramIndex: 0 },
  };
}
function fnctorFunction(kind: "get" | "new", s: IrFnctorShape): IrFunction {
  const builder = new IrFunctionBuilder(
    identities.next(`fnctor-${kind}`),
    kind === "get" ? [{ kind: "string" }] : [irFnctor(s)],
  );
  const receiver = kind === "get" ? builder.addParam("parser", irFnctor(s)) : undefined;
  builder.openBlock();
  const result = kind === "get" ? builder.emitFnctorGet(receiver!, s, "input") : builder.emitFnctorNew(s, [], [], null);
  builder.terminate({ kind: "return", values: [result] });
  return builder.finish();
}

// These compile-time witnesses are checked by the focused native project.
// They are never invoked; negative assignments must remain compiler errors.
type OriginalDeclarations = [
  Planner.LinearStorageKind,
  Planner.LinearAllocationClass,
  Planner.LinearSizePlan,
  Planner.LinearFieldPlan,
  Planner.LinearPointerMap,
  Planner.LinearRecordLayoutPlan,
  Planner.LinearVectorLayoutPlan,
  Planner.LinearRuntimeOperation,
  Planner.LinearRootPlan,
  Planner.LinearSafepointPlan,
  Planner.LinearBarrierPlan,
  Planner.LinearLifetime,
  Planner.LinearAllocationDecision,
  Planner.LinearAllocationSitePlan,
];
type CanonicalDeclarations = [
  Layout.LinearStorageKind,
  Layout.LinearAllocationClass,
  Layout.LinearSizePlan,
  Layout.LinearFieldPlan,
  Layout.LinearPointerMap,
  Layout.LinearRecordLayoutPlan,
  Layout.LinearVectorLayoutPlan,
  Layout.LinearRuntimeOperation,
  Layout.LinearRootPlan,
  Layout.LinearSafepointPlan,
  Layout.LinearBarrierPlan,
  Layout.LinearLifetime,
  Layout.LinearAllocationDecision,
  Layout.LinearAllocationSitePlan,
];
function declarationAssignments(
  original: OriginalDeclarations,
  moved: CanonicalDeclarations,
  field: Layout.LinearFieldPlan,
  site: Layout.LinearAllocationSitePlan,
  record: Layout.LinearRecordLayoutPlan,
  string: Planner.LinearStringLayoutPlan,
  opaque: Planner.LinearOpaqueLayoutPlan,
): void {
  const canonicalValues: CanonicalDeclarations = original,
    originalValues: OriginalDeclarations = moved;
  const stringBase: Layout.LinearLayoutBase = string,
    opaqueBase: Layout.LinearLayoutBase = opaque;
  const optionalOrigin: Pick<Layout.LinearAllocationSitePlan, "origin" | "encoding" | "dataSegmentId"> = {};
  // @ts-expect-error Storage vocabulary cannot gain a guessed machine type.
  const storage: Layout.LinearStorageKind = "externref";
  // @ts-expect-error Lifetime remains the exact semantic literal union.
  const lifetime: Layout.LinearLifetime = "process";
  // @ts-expect-error Managed operations cannot gain arbitrary operation names.
  const operation: Layout.LinearRuntimeOperation = { family: "managed", operation: "grow" };
  // @ts-expect-error Vector operations require element storage.
  const incompleteOperation: Layout.LinearRuntimeOperation = {
    family: "vector",
    operation: "grow",
    allocationClass: "arena",
  };
  // @ts-expect-error Field offset is a number, not a string.
  const wrongField: Layout.LinearFieldPlan = { ...field, offset: "eight" };
  const { ownerFunction: omittedOwner, ...completeWithoutOwner } = site;
  const ownerOmission: Omit<Layout.LinearAllocationSitePlan, "ownerFunction"> = completeWithoutOwner;
  // @ts-expect-error Only ownerFunction is absent from the otherwise complete valid site.
  const missingOwner: Layout.LinearAllocationSitePlan = ownerOmission;
  void omittedOwner;
  // @ts-expect-error Declaration extraction must retain field readonly.
  field.offset = 99;
  // @ts-expect-error Nested field arrays remain readonly.
  record.fields.push(field);
  // @ts-expect-error Optional origin does not remove readonly.
  site.origin = undefined;
  void [
    canonicalValues,
    originalValues,
    stringBase,
    opaqueBase,
    optionalOrigin,
    storage,
    lifetime,
    operation,
    incompleteOperation,
    wrongField,
    missingOwner,
  ];
}
void declarationAssignments;

describe("D1 canonical lowering analysis ownership", () => {
  it("shares the actual verifier function without a compatibility wrapper", () => {
    expect(compatibility).toBe(canonical);
  });
  it.each(backends)("admits a verified constant-seven return for %s through both imports", (backend) => {
    both(scalar(), backend, []);
  });
  const negativeTypes: readonly [IrBackendKind, () => IrType, string][] = [
    [
      "wasmgc",
      () => irFnctor(shape()),
      "wasmgc backend does not support nominal fnctor types until an explicit ABI resolver is installed",
    ],
    [
      "linear",
      () => ({ kind: "vec", elementType: { kind: "string" }, nullable: false }),
      "linear backend does not support vec element IR type 'string'",
    ],
    ["bytecode", () => i64, "bytecode backend does not support ValType 'i64'"],
    ["porffor", () => f32, "porffor backend does not support ValType 'f32'"],
  ];
  it.each(negativeTypes)(
    "reports an independently expected unsupported parameter for %s",
    (backend, makeType, message) => {
      const fn = parameter(`negative-${backend}`, makeType());
      both(fn, backend, [typeError(`param input: ${message}`, fn.name)]);
      both(scalar(), backend, []);
    },
  );
  it("keeps all fourteen bidirectional public declaration assignments and retained layout inheritance", () => {
    const storage: Layout.LinearStorageKind = "pointer",
      original: Planner.LinearStorageKind = storage;
    const pointerMap: Layout.LinearPointerMap = { kind: "fixed", offsets: [8, 16] };
    expect(original).toBe("pointer");
    expect(pointerMap).toEqual({ kind: "fixed", offsets: [8, 16] });
  });
  it.each(["omitted", "null"] as const)("refuses a verified fnctor get with %s resolver", (mode) => {
    const fn = fnctorFunction("get", shape());
    const expected = [
      typeError(
        "param parser: wasmgc backend does not support nominal fnctor types until an explicit ABI resolver is installed",
        fn.name,
      ),
      instructionError(
        "block 0 instr fnctor.get: nominal fnctor instruction requires an explicit validated resolver",
        fn.name,
        "fnctor.get",
      ),
      typeError(
        "fnctor.get shape: wasmgc backend does not support nominal fnctor types until an explicit ABI resolver is installed",
        fn.name,
        0,
      ),
    ];
    both(fn, "wasmgc", expected, mode === "null" ? { resolveFnctor: () => null } : undefined);
    both(fn, "wasmgc", [], { resolveFnctor: () => ({ supportsConstruction: false, supportsFieldGet: true }) });
  });
  it("distinguishes get-only from construction while preserving ordered resolver shape references", () => {
    const s = shape(),
      get = fnctorFunction("get", s),
      make = fnctorFunction("new", s);
    certified(get);
    certified(make);
    for (const verify of verifiers) {
      const seen: IrFnctorShape[] = [],
        resolver = {
          resolveFnctor: (observed: IrFnctorShape) => {
            seen.push(observed);
            return { supportsConstruction: false, supportsFieldGet: true };
          },
        };
      expect(verify(get, "wasmgc", resolver)).toEqual([]);
      expect(seen).toEqual([s, s, s]);
      expect(seen.every((observed) => observed === s)).toBe(true);
      seen.length = 0;
      expect(verify(make, "wasmgc", resolver)).toEqual([
        instructionError(
          "block 0 instr fnctor.new: nominal fnctor instruction requires an explicit validated resolver",
          make.name,
          "fnctor.new",
        ),
      ]);
      expect(seen).toEqual([s, s, s, s]);
      expect(seen.every((observed) => observed === s)).toBe(true);
      expect(
        verify(make, "wasmgc", { resolveFnctor: () => ({ supportsConstruction: true, supportsFieldGet: true }) }),
      ).toEqual([]);
    }
  });
  it.each(["linear", "bytecode", "porffor"] as const)(
    "does not let a fnctor resolver admit a nominal instruction for %s",
    (backend) => {
      const fn = fnctorFunction("new", shape()),
        nominal = `${backend} backend does not support nominal fnctor types until an explicit ABI resolver is installed`;
      const records = [
        typeError(`result 0: ${nominal}`, fn.name),
        typeError(`fnctor.new result: ${nominal}`, fn.name, 0),
        instructionError(
          "block 0 instr fnctor.new: nominal fnctor instruction is only legal for the WasmGC ABI",
          fn.name,
          "fnctor.new",
        ),
        instructionError(
          `block 0 instr fnctor.new: ${backend} backend does not support IR instruction 'fnctor.new'${backend === "linear" ? " at the function-lowering boundary" : backend === "porffor" ? " before typed Porffor lowering" : ""}`,
          fn.name,
          "fnctor.new",
        ),
        typeError(`fnctor.new shape: ${nominal}`, fn.name, 0),
      ];
      let calls = 0;
      both(fn, backend, records, {
        resolveFnctor: () => {
          calls++;
          return { supportsConstruction: true, supportsFieldGet: true };
        },
      });
      expect(calls).toBe(0);
      both(scalar(), backend, []);
    },
  );
});

function wideConst(id: number): IrInstr {
  return { kind: "const", value: { kind: "i64", value: 9n }, result: asValueId(id), resultType: i64 };
}
const emptyResult = { result: null, resultType: null } as const;
const containerKinds = ["if", "if.stmt", "while.loop", "for.loop", "try", "labeled.block", "switch"] as const;
function nestedFixture(kind: (typeof containerKinds)[number]): {
  fn: IrFunction;
  buffers: number;
  parentRefused: boolean;
} {
  const base = scalar(`nested-${kind}`),
    leaf = (id: number): IrInstr[] =>
      id === 2
        ? [wideConst(id)]
        : [
            {
              kind: "binary",
              op: id === 3 ? "i32.add" : "i32.sub",
              lhs: asValueId(1),
              rhs: asValueId(1),
              result: asValueId(id),
              resultType: i32,
            },
          ],
    label = 10 as IrLabelId;
  let parent: IrInstr,
    buffers = 0;
  switch (kind) {
    case "if":
      parent = {
        kind,
        cond: asValueId(1),
        then: leaf(2),
        thenValue: asValueId(1),
        else: leaf(3),
        elseValue: asValueId(1),
        result: asValueId(9),
        resultType: i32,
      };
      buffers = 2;
      break;
    case "if.stmt":
      parent = { kind, cond: asValueId(1), then: leaf(2), else: leaf(3), ...emptyResult };
      buffers = 2;
      break;
    case "while.loop":
      parent = { kind, cond: leaf(2), condValue: asValueId(1), body: leaf(3), ...emptyResult };
      buffers = 2;
      break;
    case "for.loop":
      parent = { kind, cond: leaf(2), condValue: asValueId(1), body: leaf(3), update: leaf(4), ...emptyResult };
      buffers = 3;
      break;
    case "try":
      parent = {
        kind,
        body: leaf(2),
        catchClause: { payloadSlot: -1, body: leaf(3) },
        finallyBody: leaf(4),
        ...emptyResult,
      };
      buffers = 3;
      break;
    case "labeled.block":
      parent = { kind, label, body: leaf(2), ...emptyResult };
      buffers = 1;
      break;
    case "switch":
      parent = {
        kind,
        disc: asValueId(1),
        discSlot: 0,
        tests: [7, null],
        bodies: [leaf(2), leaf(3)],
        breakLabel: label,
        ...emptyResult,
      };
      buffers = 2;
      break;
  }
  const b = base.blocks[0]!;
  return {
    fn: {
      ...base,
      slots: kind === "switch" ? [{ index: 0, name: "discriminant", type: { kind: "i32" } }] : [],
      blocks: [{ ...b, instrs: [...b.instrs, parent] }],
      valueCount: 10,
    },
    buffers,
    parentRefused: kind !== "if",
  };
}

describe("D1 legality nested traversal and exact record order", () => {
  it.each(containerKinds)("visits every nested buffer of verified %s in order with the owning block", (kind) => {
    const { fn, buffers, parentRefused } = nestedFixture(kind),
      records: IrBackendLegalityError[] = [];
    if (parentRefused)
      records.push(
        instructionError(
          `block 0 instr ${kind}: bytecode backend does not support IR instruction '${kind}'`,
          fn.name,
          kind,
        ),
      );
    // Sibling buffers produce distinct records: a swap cannot preserve this ordered oracle.
    records.push(
      typeError("const result: bytecode backend does not support ValType 'i64'", fn.name, 0),
      instructionError("block 0 instr const: bytecode backend does not support const 'i64'", fn.name, "const"),
    );
    if (buffers >= 2)
      records.push(
        instructionError(
          "block 0 instr binary: bytecode backend does not support binary op 'i32.add'",
          fn.name,
          "binary",
        ),
      );
    if (buffers === 3)
      records.push(
        instructionError(
          "block 0 instr binary: bytecode backend does not support binary op 'i32.sub'",
          fn.name,
          "binary",
        ),
      );
    both(fn, "bytecode", records);
    both(fn, "wasmgc", []);
  });
  it("preserves parameter, result, slot, block argument and instruction ordering", () => {
    const base = scalar("ordered"),
      fn: IrFunction = {
        ...base,
        params: [{ name: "wide", value: asValueId(2), type: i64 }],
        resultTypes: [i64],
        slots: [{ index: 0, name: "wideSlot", type: { kind: "i64" } }],
        blocks: [
          {
            ...base.blocks[0]!,
            blockArgs: [asValueId(3)],
            blockArgTypes: [i64],
            instrs: [wideConst(1)],
            terminator: { kind: "return", values: [asValueId(1)] },
          },
        ],
        valueCount: 4,
      };
    both(fn, "bytecode", [
      typeError("param wide: bytecode backend does not support ValType 'i64'", fn.name),
      typeError("result 0: bytecode backend does not support ValType 'i64'", fn.name),
      typeError("slot wideSlot: bytecode backend does not support ValType 'i64'", fn.name),
      typeError("block arg 0: bytecode backend does not support ValType 'i64'", fn.name, 0),
      typeError("const result: bytecode backend does not support ValType 'i64'", fn.name, 0),
      instructionError("block 0 instr const: bytecode backend does not support const 'i64'", fn.name, "const"),
    ]);
    both(scalar(), "bytecode", []);
  });
  it("checks nested object fields with complete outer and inner diagnostics", () => {
    const fn = parameter("nested-object", {
      kind: "object",
      shape: { fields: [{ name: "deep", type: { kind: "object", shape: { fields: [{ name: "wide", type: i64 }] } } }] },
    });
    both(fn, "linear", [
      typeError("param input: linear backend does not support aggregate field ValType 'i64'", fn.name),
      typeError("param input.deep: linear backend does not support aggregate field ValType 'i64'", fn.name),
    ]);
    both(fn, "wasmgc", []);
  });
  it.each(["callable", "closure"] as const)(
    "checks nested %s parameter and return types in declaration order",
    (kind) => {
      const fn = parameter(`nested-${kind}`, { kind, signature: { params: [i64], returnType: i64 } });
      both(fn, "bytecode", [
        typeError(`param input: bytecode backend does not support IR type '${kind}'`, fn.name),
        typeError("param input.param0: bytecode backend does not support ValType 'i64'", fn.name),
        typeError("param input.return: bytecode backend does not support ValType 'i64'", fn.name),
      ]);
      both(fn, "wasmgc", []);
    },
  );
  it("terminates a recursive class shape and checks shared method signatures only once", () => {
    const fields: { name: string; type: IrType }[] = [],
      classShape: IrClassShape = {
        classId: createTestIrClassId("recursive-legality"),
        className: "Recursive",
        fields,
        methods: [{ name: "wide", params: [i64], returnType: i64 }],
        constructorParams: [],
      },
      classType: IrType = { kind: "class", shape: classShape };
    fields.push({ name: "self", type: classType });
    const fn = parameter("recursive-class", classType);
    both(fn, "bytecode", [
      typeError("param input: bytecode backend does not support IR type 'class'", fn.name),
      typeError("param input.self: bytecode backend does not support IR type 'class'", fn.name),
      typeError("param input.wide.param0: bytecode backend does not support ValType 'i64'", fn.name),
      typeError("param input.wide.return: bytecode backend does not support ValType 'i64'", fn.name),
    ]);
    both(fn, "wasmgc", []);
  });
});
