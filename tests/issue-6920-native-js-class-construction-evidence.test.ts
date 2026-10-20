// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { ts } from "../src/ts-api.js";
import { forEachInstrDeep } from "../src/ir/core/nodes.js";
import { analyzeMultiSource } from "../src/checker/index.js";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import {
  collectNativeProgramClassRequirements,
  describeNativeProgramClassPreflight,
  nativeProgramClassView,
  nativeProgramClassConstruction,
} from "../src/ir/program/native-program-resource-requirements.js";
import {
  reserveNativeJsClassPhysicalValues,
  reserveNativeJsClassPhysicalFunctions,
  reserveNativeJsClassPhysicalRealm,
  reserveNativeJsClassPhysicalModuleBindings,
  fillNativeJsClassPhysicalValues,
  fillNativeJsClassPhysicalRealm,
  fillNativeJsClassPhysicalModuleBindings,
  assertNativeJsClassPhysicalValuesCurrent,
  nativeJsClassPhysicalLowering,
  requireCompletedNativeJsClassPhysicalValues,
} from "../src/backend/wasmgc/program/native-realm.js";
import { createEmptyModule } from "../src/ir/types.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";

function prepare(text: string) {
  const policy = { backend: "wasmgc" as const, target: "standalone" as const };
  const ast = analyzeMultiSource({ "./entry.ts": text }, "./entry.ts");
  const result = prepareWholeIrProgram({
    sourceFiles: ast.sourceFiles,
    entrySource: ast.entryFile,
    checker: ast.checker,
    policy,
    runtimePolicies: [policy],
    deferTopLevelInit: false,
    linearVectorProjection: "native-f64",
  });
  if (result.kind !== "prepared") throw Error(JSON.stringify(result));
  return result.program;
}
it("derives exact constructor and newTarget roots without turning DATA into a physical token", async () => {
  await yieldTurn();
  const program = prepare("class A{constructor(){}}export function run():number{new A();return 1;}");
  const projection = program.runtime[0]!,
    requirements = collectNativeProgramClassRequirements(program, projection)!;
  expect(requirements.errors.some((row) => row.instruction.kind === "js.class.construct")).toBe(true);
  const view = nativeProgramClassView(requirements, program, projection);
  expect(view.routedFunctions.length).toBeGreaterThan(0);
  const construction = nativeProgramClassConstruction(requirements, program, projection);
  expect(construction).toHaveLength(1);
  const row = construction[0]!;
  expect(row.gap).toBeUndefined();
  expect(row.targets).toHaveLength(1);
  expect(row.newTargets).toEqual([row.targets[0]!.definitionId]);
  expect(projection.prepared.functions).toContain(row.targets[0]!.fn);
  const description = describeNativeProgramClassPreflight(program, projection);
  expect(description.gaps).toEqual([]);
  expect(description.exceptionRequired).toBe(true);
  expect(() => nativeProgramClassView({ ...requirements }, program, projection)).toThrow(
    "unissued logical acquisition",
  );
  await yieldTurn();
});
it("keeps an unsupported implicit field constructor as a located gap while allowing partial resources", async () => {
  await yieldTurn();
  const program = prepare("class A{x:number;}export function run():number{new A();return 1;}");
  const projection = program.runtime[0]!,
    requirements = collectNativeProgramClassRequirements(program, projection)!;
  const row = nativeProgramClassConstruction(requirements, program, projection)[0]!;
  expect(row.instruction.kind).toBe("js.class.construct");
  expect(row.gap).toMatch(/explicit base body|field initialization/);
  expect(
    describeNativeProgramClassPreflight(program, projection).gaps.some(
      (gap) => gap.unitId === row.unitId && gap.detail === row.gap,
    ),
  ).toBe(true);
  const module = createEmptyModule(),
    tx = new PhysicalModuleReservations(module);
  expect(reserveNativeJsClassPhysicalValues(tx, program, projection)).toBeDefined();
  expect(module.functions.length).toBeGreaterThan(0);
  expect(module.tags).toHaveLength(0);
  await yieldTurn();
});

function physicalKit(mode: "defined" | "imported" | "none" | "copied" | "foreign" | "wrong-payload" = "defined") {
  const program = prepare("class A{constructor(){}}export function run():number{new A();return 1;}");
  const module = createEmptyModule(),
    tx = new PhysicalModuleReservations(module);
  const ownTag =
    mode === "none"
      ? undefined
      : tx.reserveTag(
          "physical:exception-tag",
          { params: [{ kind: mode === "wrong-payload" ? "i32" : "externref" }], results: [] },
          mode === "imported" ? { kind: "import", module: "env", name: "__exn" } : { kind: "defined", name: "__exn" },
        );
  const tag =
    mode === "copied"
      ? { ...ownTag! }
      : mode === "foreign"
        ? new PhysicalModuleReservations(createEmptyModule()).reserveTag(
            "physical:exception-tag",
            { params: [{ kind: "externref" }], results: [] },
            { kind: "defined", name: "__exn" },
          )
        : ownTag;
  const values = reserveNativeJsClassPhysicalValues(tx, program, program.runtime[0]!, tag)!;
  reserveNativeJsClassPhysicalFunctions(values);
  reserveNativeJsClassPhysicalRealm(values);
  reserveNativeJsClassPhysicalModuleBindings(values);
  tx.freezeReservations();
  fillNativeJsClassPhysicalValues(values);
  fillNativeJsClassPhysicalRealm(values);
  fillNativeJsClassPhysicalModuleBindings(values);
  return { program, module, tx, tag, values };
}
it("screens an actual issued exception-tag getter before any whole-owner physical layout read", async () => {
  await yieldTurn();
  const kit = physicalKit();
  expect(() => assertNativeJsClassPhysicalValuesCurrent(kit.values)).not.toThrow();
  if (kit.tag?.kind !== "tag") throw Error("missing actual defined tag");
  const object = kit.tag.object,
    original = Object.getOwnPropertyDescriptor(object, "typeIdx")!;
  let reads = 0;
  Object.defineProperty(object, "typeIdx", {
    configurable: true,
    get() {
      reads++;
      throw Error("tag getter executed");
    },
  });
  try {
    expect(() => assertNativeJsClassPhysicalValuesCurrent(kit.values)).toThrow();
    expect(reads).toBe(0);
  } finally {
    Object.defineProperty(object, "typeIdx", original);
  }
  await yieldTurn();
});

function actualRead(kit: ReturnType<typeof physicalKit>) {
  for (const fn of kit.program.runtime[0]!.prepared.functions)
    for (const block of fn.blocks)
      for (const instruction of block.instrs)
        if (instruction.kind === "js.class.binding.read") return { fn, instruction };
  throw Error("missing genuine source constructor binding read");
}
it.each(["defined", "imported"] as const)(
  "uses only the actual %s tag for a genuine null-message TDZ recipe",
  async (mode) => {
    await yieldTurn();
    const kit = physicalKit(mode),
      { fn, instruction } = actualRead(kit);
    const code = nativeJsClassPhysicalLowering(kit.values, fn).emit(instruction, [], () => {
      throw Error("binding read must not allocate scratch");
    });
    expect(code[0]).toMatchObject({ op: "global.get" });
    const guard = code.find((row) => row.op === "if");
    if (guard?.op !== "if" || !kit.tag) throw Error("missing actual TDZ branch/tag");
    expect(guard.then[0]).toEqual({ op: "ref.null.extern" });
    expect(guard.then[1]?.op).toBe("call");
    expect(guard.then[2]).toEqual({ op: "throw", tagIdx: kit.tx.physicalIndex(kit.tag) });
    expect(code.at(-1)).toEqual({ op: "ref.as_non_null" });
    await yieldTurn();
  },
);
it.each(["none", "copied", "foreign", "wrong-payload"] as const)(
  "refuses %s tag custody before new binding-error effects",
  async (mode) => {
    await yieldTurn();
    const kit = physicalKit(mode),
      { fn, instruction } = actualRead(kit);
    expect(kit.program.runtime[0]!.prepared.functions).toContain(fn);
    const lowering = nativeJsClassPhysicalLowering(kit.values, fn);
    expect(instruction.kind).toBe("js.class.binding.read");
    let scratchCalls = 0;
    expect(() => lowering.emit(instruction, [], () => ++scratchCalls)).toThrow();
    expect(scratchCalls).toBe(0);
    await yieldTurn();
  },
);
it("screens an actual imported tag desc getter before whole-owner layout replay", async () => {
  await yieldTurn();
  const kit = physicalKit("imported");
  expect(() => assertNativeJsClassPhysicalValuesCurrent(kit.values)).not.toThrow();
  if (kit.tag?.kind !== "tag-import") throw Error("missing actual imported tag");
  const object = kit.tag.object,
    original = Object.getOwnPropertyDescriptor(object, "desc")!;
  let reads = 0;
  Object.defineProperty(object, "desc", {
    configurable: true,
    get() {
      reads++;
      throw Error("imported tag desc getter ran");
    },
  });
  try {
    expect(() => assertNativeJsClassPhysicalValuesCurrent(kit.values)).toThrow();
    expect(reads).toBe(0);
  } finally {
    Object.defineProperty(object, "desc", original);
  }
  await yieldTurn();
});
it("refuses a changed actual tag payload coordinate before a class recipe", async () => {
  await yieldTurn();
  const kit = physicalKit();
  expect(() => assertNativeJsClassPhysicalValuesCurrent(kit.values)).not.toThrow();
  if (kit.tag?.kind !== "tag") throw Error("missing actual defined tag");
  const object = kit.tag.object,
    prior = object.typeIdx;
  object.typeIdx = kit.module.types.length + 100;
  try {
    expect(() => assertNativeJsClassPhysicalValuesCurrent(kit.values)).toThrow();
  } finally {
    object.typeIdx = prior;
  }
  await yieldTurn();
});

it("requires the actual exception tag at whole-program completion independently of a failed recipe", async () => {
  await yieldTurn();
  const kit = physicalKit("none");
  expect(kit.program.runtime[0]!.prepared.functions.length).toBeGreaterThan(0);
  expect(() => assertNativeJsClassPhysicalValuesCurrent(kit.values)).not.toThrow();
  expect(() => requireCompletedNativeJsClassPhysicalValues(kit.values)).toThrow("lacks its issued exception tag");
  await yieldTurn();
});

it.each(["original", "selected"] as const)(
  "preserves immutable %s source bodies and rejects borrowed constructor custody",
  async (view) => {
    await yieldTurn();
    const program = prepare("class A{constructor(){}}export function run():number{new A();return 1;}"),
      projection = program.runtime[0]!,
      requirements = collectNativeProgramClassRequirements(program, projection)!;
    expect(nativeProgramClassConstruction(requirements, program, projection)[0]!.gap).toBeUndefined();
    const fn = (view === "original" ? program.ir.functions : projection.prepared.functions)[0]!;
    expect(Object.isFrozen(fn)).toBe(true);
    expect(Object.getOwnPropertyDescriptor(fn, "name")!.writable).toBe(false);
    expect(Reflect.set(fn, "name", "changed_after_acquisition")).toBe(false);
    expect(Reflect.defineProperty(fn, "name", { value: "changed_after_acquisition" })).toBe(false);
    const foreign = prepare("class A{constructor(){}}export function run():number{new A();return 2;}");
    expect(foreign).not.toBe(program);
    expect(() => nativeProgramClassConstruction(requirements, foreign, foreign.runtime[0]!)).toThrow(
      "unissued logical acquisition",
    );
    expect(nativeProgramClassConstruction(requirements, program, projection)[0]!.gap).toBeUndefined();
    await yieldTurn();
  },
);
it("replays complete physical custody immediately after a real constructor scratch effect", async () => {
  await yieldTurn();
  const kit = physicalKit(),
    fn = kit.program.runtime[0]!.prepared.functions.find((row) =>
      row.blocks.some((block) => block.instrs.some((instruction) => instruction.kind === "js.class.construct")),
    )!;
  const instruction = fn.blocks.flatMap((block) => block.instrs).find((row) => row.kind === "js.class.construct")!;
  expect(instruction.kind).toBe("js.class.construct");
  const port = nativeJsClassPhysicalLowering(kit.values, fn),
    helper = kit.module.functions.find((row) => row.name === "__class_function_prototype")!;
  expect(helper.body.length).toBeGreaterThan(0);
  const originalLength = helper.body.length;
  let scratchCalls = 0,
    mutationSucceeded = false;
  try {
    expect(() =>
      port.emit(instruction, [[], []], () => {
        scratchCalls++;
        helper.body.push({ op: "unreachable" });
        mutationSucceeded = helper.body.length === originalLength + 1;
        return 0;
      }),
    ).toThrow();
    expect(scratchCalls).toBe(1);
    expect(mutationSucceeded).toBe(true);
  } finally {
    helper.body.splice(originalLength);
  }
  await yieldTurn();
});

it("retains actual missing and extra arguments with an independently observed scalar effect", async () => {
  await yieldTurn();
  const text =
    "let count:number=0;function bump():number{count=count+1;return count;}class A{constructor(value:number){}}export function run():number{new A();new A(bump(),bump());return count;}";
  const javascript = ts.transpileModule(text, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const reference: { run?: () => number } = {};
  new Function("exports", javascript)(reference);
  expect(reference.run!()).toBe(2);
  const program = prepare(text),
    projection = program.runtime[0]!,
    requirements = collectNativeProgramClassRequirements(program, projection)!;
  const rows = nativeProgramClassConstruction(requirements, program, projection);
  expect(rows).toHaveLength(2);
  expect(rows.map((row) => row.instruction.args.length)).toEqual([0, 2]);
  for (const row of rows) {
    expect(row.gap).toBeUndefined();
    expect(row.targets).toHaveLength(1);
    expect(row.targets[0]!.fn.params).toHaveLength(5);
  }
  let boxes = 0;
  for (const fn of projection.prepared.functions)
    for (const block of fn.blocks)
      for (const root of block.instrs)
        forEachInstrDeep(root, (instruction) => {
          if (instruction.kind === "box") boxes++;
        });
  expect(boxes).toBeGreaterThanOrEqual(2);
  await yieldTurn();
});
