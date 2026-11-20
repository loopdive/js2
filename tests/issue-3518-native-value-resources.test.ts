import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptyModule } from "../src/ir/types.js";
import { emitBinary } from "../src/emit/binary.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import { prepareIrProgramSources, captureTypedIrProgramInput } from "../src/ir/program-source.js";
import { prepareTypedIrProgram } from "../src/ir/program-prepare-ir.js";
import { sourceInput, typedOptions, requireProgram } from "./helpers/typed-program-fixtures.js";
import { encodeTypedPacket, decodeTypedPacket } from "./helpers/typed-program-transport.mjs";
import {
  deriveNativeValueResourcePlan,
  assertNativeValueResourcePlan,
} from "../src/ir/program/native-value-resources.js";
import {
  reserveNativeValueResources,
  fillNativeValueResources,
  requireCompletedNativeValues,
  type NativeValueDependencies,
} from "../src/backend/wasmgc/resources/native-values.js";
import { buildUnboxNumberBody } from "../src/runtime/wasmgc/values/number-bodies.js";

afterEach(async () => {
  vi.restoreAllMocks();
  await setImmediate();
});
const policy = { backend: "wasmgc", target: "standalone" } as const;
const primitiveSource = "export function main(value: number): number { return value; }";
function prepare(replay = false, text = primitiveSource) {
  const source = prepareIrProgramSources({ ...sourceInput({ "./entry.ts": text }), policy });
  if (source.kind !== "prepared") throw Error(source.detail);
  const packet = captureTypedIrProgramInput(source);
  const program = requireProgram(
    prepareTypedIrProgram(replay ? decodeTypedPacket(encodeTypedPacket(packet)) : packet, {
      ...typedOptions,
      policy,
      runtimePolicies: [policy],
    }),
  );
  const projection = program.runtime[0]!;
  return { program, projection, plan: deriveNativeValueResourcePlan(program, projection, "primitive-only") };
}
let cached: ReturnType<typeof prepare> | undefined;
const actual = () => (cached ??= prepare());
const absent = (): NativeValueDependencies => ({ strings: { kind: "absent" } });

function reserve(plan = actual().plan) {
  const module = createEmptyModule(),
    tx = new PhysicalModuleReservations(module);
  const dependencies = absent();
  const pack = reserveNativeValueResources(tx, plan, dependencies);
  const f64 = { kind: "f64" } as const,
    i32 = { kind: "i32" } as const,
    extern = { kind: "externref" } as const;
  const roundtrip = tx.reserveFunction("control:roundtrip", "roundtrip", { params: [f64], results: [f64] });
  const small = tx.reserveFunction("control:small", "small", { params: [f64], results: [i32] });
  const boolean = tx.reserveFunction("control:boolean", "boolean", { params: [i32], results: [extern] });
  const undefinedValue = tx.reserveFunction("control:undefined", "undefinedValue", { params: [], results: [extern] });
  const tag = tx.reserveFunction("control:tag", "tag", { params: [], results: [i32] });
  return { module, tx, dependencies, plan, pack, roundtrip, small, boolean, undefinedValue, tag };
}

function filled(plan = actual().plan) {
  const state = reserve(plan);
  const { tx, dependencies, roundtrip, small, boolean, undefinedValue, tag } = state;
  tx.freezeReservations();
  fillNativeValueResources(tx, state.pack, dependencies);
  const pack = requireCompletedNativeValues(tx, state.pack, plan, dependencies);
  expect(pack).toBe(state.pack);
  tx.fillFunction(roundtrip, {
    locals: [],
    body: [
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: pack.functions.boxNumber.handle },
      { op: "call", funcIdx: pack.functions.unboxNumber.handle },
    ],
  });
  tx.fillFunction(small, {
    locals: [],
    body: [
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: pack.functions.boxNumber.handle },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: -20 },
    ],
  });
  tx.fillFunction(boolean, {
    locals: [],
    body: [
      { op: "local.get", index: 0 },
      { op: "struct.new", typeIdx: pack.types.boxedBoolean.typeIndex },
      { op: "extern.convert_any" },
    ],
  });
  tx.fillFunction(undefinedValue, {
    locals: [],
    body: [{ op: "global.get", index: tx.physicalIndex(pack.globals.undefined) }, { op: "extern.convert_any" }],
  });
  tx.fillFunction(tag, {
    locals: [],
    body: [
      { op: "global.get", index: tx.physicalIndex(pack.globals.undefined) },
      { op: "struct.get", typeIdx: pack.types.anyValue.typeIndex, fieldIdx: 0 },
    ],
  });
  for (const [name, fn] of Object.entries({
    box: pack.functions.boxNumber,
    unbox: pack.functions.unboxNumber,
    isNumber: pack.functions.isNumber,
    roundtrip,
    small,
    boolean,
    undefinedValue,
    tag,
  }))
    tx.defineExport("export:" + name, name, fn);
  return state;
}
interface Exports {
  box(value: number): unknown;
  unbox(value: unknown): number;
  isNumber(value: unknown): number;
  roundtrip(value: number): number;
  small(value: number): number;
  boolean(value: number): unknown;
  undefinedValue(): unknown;
  tag(): number;
}
function execute(plan = actual().plan) {
  const { module, tx, pack, dependencies } = filled(plan);
  const census = tx.seal();
  expect(requireCompletedNativeValues(tx, pack, plan, dependencies)).toBe(pack);
  const binary = emitBinary(module);
  const compiled = new WebAssembly.Module(binary as BufferSource);
  expect(WebAssembly.Module.imports(compiled)).toEqual([]);
  return { exports: new WebAssembly.Instance(compiled, {}).exports as unknown as Exports, census };
}
let execution: ReturnType<typeof execute> | undefined;
const executed = () => (execution ??= execute());

describe("native primitive resources: executed bodies, not signature-only admission", () => {
  it("uses actual source-produced requirements and the complete single-ledger fill census", () => {
    const { program, plan } = actual();
    expect(plan.owners).toEqual(program.ir.functions.map((fn) => fn.unitId));
    expect(plan.owners.length).toBeGreaterThan(0);
    expect(executed().census.completedFunctions).toBe(8);
    expect(executed().census.completedGlobals).toBe(1);
    expect(executed().census.types).toBeGreaterThanOrEqual(6);
  });
  it.each([-1073741824, -1073741823, -1, 0, 1, 1073741822, 1073741823])(
    "executes signed-i31 boxing and numeric recovery for %s",
    (value) => {
      const x = executed().exports;
      expect(x.small(value)).toBe(1);
      expect(x.isNumber(x.box(value))).toBe(1);
      expect(Object.is(x.roundtrip(value), value)).toBe(true);
    },
  );
  it.each([-1073741825, 1073741824, 3e9, -0, 1.5, -1.5, NaN, Infinity, -Infinity])(
    "executes boxed-f64 preservation for %s",
    (value) => {
      const x = executed().exports;
      expect(x.small(value)).toBe(0);
      expect(x.isNumber(x.box(value))).toBe(1);
      expect(Object.is(x.roundtrip(value), value)).toBe(true);
    },
  );
  it("executes boolean conversion before the opaque fallback", () => {
    const x = executed().exports;
    expect(x.unbox(x.boolean(0))).toBe(0);
    expect(x.unbox(x.boolean(1))).toBe(1);
    expect(x.isNumber(x.boolean(1))).toBe(0);
  });
  it("executes distinct canonical undefined and null behavior", () => {
    const x = executed().exports,
      undefinedValue = x.undefinedValue();
    expect(undefinedValue).not.toBeNull();
    expect(x.undefinedValue()).toBe(undefinedValue);
    expect(x.tag()).toBe(1);
    expect(x.unbox(null)).toBe(0);
    expect(x.unbox(undefinedValue)).toBeNaN();
    expect(x.isNumber(null)).toBe(0);
    expect(x.isNumber(undefinedValue)).toBe(0);
  });
  it("keeps primitive-only absence source-bound across codec replay", () => {
    const direct = actual(),
      replay = prepare(true);
    expect(replay.plan).toEqual(direct.plan);
    expect(() => assertNativeValueResourcePlan(replay.plan)).not.toThrow();
    expect(() => assertNativeValueResourcePlan({ ...replay.plan })).toThrow("unissued");
  });
  it("rejects an unsealed program only after its real positive", () => {
    const { program, projection, plan } = actual();
    expect(() => assertNativeValueResourcePlan(plan)).not.toThrow();
    expect(() =>
      deriveNativeValueResourcePlan(
        { ...program, sealed: false } as unknown as typeof program,
        projection,
        "primitive-only",
      ),
    ).toThrow("complete prepared program");
  });
  it("rejects an omitted selected owner after authentic scalar preparation", () => {
    const { program, projection, plan } = actual();
    assertNativeValueResourcePlan(plan);
    const missing = { ...projection, prepared: { ...projection.prepared, functions: [] } };
    const changed = { ...program, runtime: [missing] };
    expect(() => deriveNativeValueResourcePlan(changed, missing, "primitive-only")).toThrow("owner population");
  });
  it("does not infer scanner absence from a source owner with an unaccounted carrier", () => {
    const { program, projection, plan } = actual();
    assertNativeValueResourcePlan(plan);
    const first = program.ir.functions[0]!;
    const functions = [
      { ...first, resultTypes: [{ kind: "val", val: { kind: "externref" } } as const] },
      ...program.ir.functions.slice(1),
    ];
    const changed = { ...program, ir: { ...program.ir, functions } };
    expect(() => deriveNativeValueResourcePlan(changed, projection, "primitive-only")).toThrow(
      "reference/unknown signature",
    );
  });
  it("does not turn a missing scanner into absence in the native-string representation", () => {
    const { program, projection } = actual();
    expect(() => reserve()).not.toThrow();
    const plan = deriveNativeValueResourcePlan(program, projection, "native-string");
    const tx = new PhysicalModuleReservations(createEmptyModule());
    expect(() => reserveNativeValueResources(tx, plan, absent())).toThrow("actual StringToNumber");
  });
  it("requires explicit builder-side string selection", () => {
    expect(buildUnboxNumberBody(0, 1, { kind: "absent", evidence: "selected-primitive-only" })).not.toHaveLength(0);
    expect(() => buildUnboxNumberBody(0, 1, undefined!)).toThrow("explicit string conversion");
    expect(() =>
      buildUnboxNumberBody(0, 1, { kind: "native-string", anyStringTypeIdx: 2, toNumber: undefined! }),
    ).toThrow("unresolved string conversion");
  });
  it("rejects fills before freeze and duplicate fills", () => {
    const first = reserve();
    expect(() => fillNativeValueResources(first.tx, first.pack, first.dependencies)).toThrow(
      "physical index requested in reserving",
    );
    const second = filled();
    expect(() => fillNativeValueResources(second.tx, second.pack, second.dependencies)).toThrow("duplicate");
  });
  it("rejects a foreign transaction and copied resource wrapper", () => {
    const state = filled();
    expect(() =>
      fillNativeValueResources(new PhysicalModuleReservations(createEmptyModule()), state.pack, state.dependencies),
    ).toThrow("foreign");
    expect(() => fillNativeValueResources(state.tx, { ...state.pack }, state.dependencies)).toThrow("foreign");
  });
  it("retains missing-fill failure for real reserved resources", () => {
    expect(executed().census.completedGlobals).toBe(1);
    const state = reserve();
    state.tx.freezeReservations();
    expect(() => state.tx.seal()).toThrow(/missing .* fill/);
  });
  it("rejects stale/altered primitive layout after a real positive", () => {
    expect(executed().exports.roundtrip(3e9)).toBe(3e9);
    const state = reserve();
    const type = state.pack.types.boxedNumber.object;
    if (type.kind !== "struct") throw Error("missing actual number struct");
    type.fields[0]!.mutable = true;
    expect(() => state.tx.freezeReservations()).toThrow("altered");
  });
  it("rejects a wrong callable signature at the original ledger boundary", () => {
    expect(executed().exports.roundtrip(-0)).toBe(-0);
    const state = reserve();
    state.pack.functions.unboxNumber.object.typeIdx = state.pack.functions.boxNumber.object.typeIdx;
    expect(() => state.tx.freezeReservations()).toThrow();
  });
  it.each([0, 1, 2, 3, 4, 5])("rejects a changed undefined initializer instruction %s", (index) => {
    expect(executed().exports.tag()).toBe(1);
    const state = filled();
    state.pack.globals.undefined.object.init[index] = { op: "i32.const", value: 42 };
    expect(() => state.tx.seal()).toThrow("altered");
  });
});

describe("native value producer completion authority", () => {
  it("returns exact pack with a fresh containing dependency record without side effects", () => {
    const state = filled();
    const before = structuredClone(state.module);
    const spies = [
      vi.spyOn(state.tx, "reserveType"),
      vi.spyOn(state.tx, "reserveFunction"),
      vi.spyOn(state.tx, "reserveGlobal"),
      vi.spyOn(state.tx, "internFunctionType"),
      vi.spyOn(state.tx, "fillFunction"),
      vi.spyOn(state.tx, "fillGlobal"),
      vi.spyOn(state.tx, "defineExport"),
      vi.spyOn(state.tx, "seal"),
    ];
    expect(requireCompletedNativeValues(state.tx, state.pack, state.plan, absent())).toBe(state.pack);
    expect(state.tx.state).toBe("filling");
    expect(state.module).toStrictEqual(before);
    spies.forEach((spy) => expect(spy).not.toHaveBeenCalled());
  });
  it("executes decoded source-bound resources through completion before and after seal", () => {
    const x = execute(prepare(true).plan).exports;
    for (const value of [-1073741824, 1073741823, 70, 3e9, -0, 1.5, NaN, Infinity, -Infinity]) {
      expect(Object.is(x.roundtrip(value), value)).toBe(true);
      expect(x.isNumber(x.box(value))).toBe(1);
    }
    expect(x.tag()).toBe(1);
    expect(x.unbox(x.undefinedValue())).toBeNaN();
    expect(x.unbox(null)).toBe(0);
    expect(x.unbox(x.boolean(1))).toBe(1);
  });
  it("rejects a distinct genuinely issued equal-visible plan", () => {
    const state = filled();
    expect(requireCompletedNativeValues(state.tx, state.pack, state.plan, state.dependencies)).toBe(state.pack);
    const { program, projection } = actual();
    const other = deriveNativeValueResourcePlan(program, projection, "primitive-only");
    assertNativeValueResourcePlan(other);
    expect(other).toEqual(state.plan);
    expect(other).not.toBe(state.plan);
    expect(() => requireCompletedNativeValues(state.tx, state.pack, other, state.dependencies)).toThrow(
      "substituted native value requirements",
    );
  });
  it("rejects foreign transactions and copied packs after a real completion", () => {
    const state = filled();
    expect(requireCompletedNativeValues(state.tx, state.pack, state.plan, state.dependencies)).toBe(state.pack);
    expect(() =>
      requireCompletedNativeValues(
        new PhysicalModuleReservations(createEmptyModule()),
        state.pack,
        state.plan,
        state.dependencies,
      ),
    ).toThrow("foreign");
    expect(() => requireCompletedNativeValues(state.tx, { ...state.pack }, state.plan, state.dependencies)).toThrow(
      "foreign",
    );
  });
  it("rejects a genuine unfilled pack without marking it completed", () => {
    const positive = filled();
    expect(requireCompletedNativeValues(positive.tx, positive.pack, positive.plan, positive.dependencies)).toBe(
      positive.pack,
    );
    const state = reserve();
    state.tx.freezeReservations();
    expect(() => requireCompletedNativeValues(state.tx, state.pack, state.plan, state.dependencies)).toThrow(
      "incomplete native value resources",
    );
    expect(state.tx.state).toBe("filling");
  });
  for (const stopped of [0, 1, 2, 3])
    it(`rejects real producer interrupted at fill ${stopped}`, () => {
      const positive = filled();
      expect(requireCompletedNativeValues(positive.tx, positive.pack, positive.plan, positive.dependencies)).toBe(
        positive.pack,
      );
      const state = reserve();
      state.tx.freezeReservations();
      const sentinel = new Error("stop actual fill " + stopped);
      const global = state.tx.fillGlobal.bind(state.tx),
        fn = state.tx.fillFunction.bind(state.tx);
      let calls = 0;
      vi.spyOn(state.tx, "fillGlobal").mockImplementation((...args) => {
        if (calls++ === stopped) throw sentinel;
        return global(...args);
      });
      vi.spyOn(state.tx, "fillFunction").mockImplementation((...args) => {
        if (calls++ === stopped) throw sentinel;
        return fn(...args);
      });
      let caught: unknown;
      try {
        fillNativeValueResources(state.tx, state.pack, state.dependencies);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBe(sentinel);
      expect(calls).toBe(stopped + 1);
      expect(state.tx.state).toBe("filling");
      expect(() => requireCompletedNativeValues(state.tx, state.pack, state.plan, state.dependencies)).toThrow(
        "incomplete native value resources",
      );
    });
  // Mandatory countermodels: returning from an intercepted ledger operation is
  // not proof that its token entered the ledger's successful-fill map.
  for (const omitted of [0, 1, 2, 3])
    it(`rejects nonthrowing omission of fill ${omitted}`, () => {
      const positive = filled();
      expect(requireCompletedNativeValues(positive.tx, positive.pack, positive.plan, positive.dependencies)).toBe(
        positive.pack,
      );
      const state = reserve();
      state.tx.freezeReservations();
      const global = state.tx.fillGlobal.bind(state.tx),
        fn = state.tx.fillFunction.bind(state.tx);
      let calls = 0;
      vi.spyOn(state.tx, "fillGlobal").mockImplementation((...args) => {
        if (calls++ === omitted) return;
        return global(...args);
      });
      vi.spyOn(state.tx, "fillFunction").mockImplementation((...args) => {
        if (calls++ === omitted) return;
        return fn(...args);
      });
      fillNativeValueResources(state.tx, state.pack, state.dependencies);
      expect(calls).toBe(4);
      expect(() => requireCompletedNativeValues(state.tx, state.pack, state.plan, state.dependencies)).toThrow();
    });
  for (const mutation of ["body", "locals", "initializer", "type"] as const)
    it(`rejects post-fill ${mutation} drift via completion accessor`, () => {
      const state = filled();
      expect(requireCompletedNativeValues(state.tx, state.pack, state.plan, state.dependencies)).toBe(state.pack);
      if (mutation === "body") state.pack.functions.boxNumber.object.body.push({ op: "unreachable" });
      if (mutation === "locals")
        state.pack.functions.unboxNumber.object.locals.push({ name: "foreign", type: { kind: "i32" } });
      if (mutation === "initializer") state.pack.globals.undefined.object.init[0] = { op: "i32.const", value: 42 };
      if (mutation === "type") state.pack.types.boxedBoolean.object.name = "foreign";
      expect(() => requireCompletedNativeValues(state.tx, state.pack, state.plan, state.dependencies)).toThrow();
    });
});
function replaceOnce(text: string, before: string, after: string): string {
  const start = text.indexOf(before);
  if (start < 0 || text.indexOf(before, start + before.length) >= 0)
    throw Error("missing/duplicate mapped edit: " + before);
  return text.slice(0, start) + after + text.slice(start + before.length);
}

const followupImportsForwardText = readFileSync(
  resolve(import.meta.dirname, "fixtures/issue-3518-native-value-main-followup-forward.json"),
  "utf8",
);

const mainImportsForwardText = readFileSync(
  resolve(import.meta.dirname, "fixtures/issue-3518-native-value-delivered-main-import-forward.json"),
  "utf8",
);

describe("BigInt extraction outer inverse", () => {});

describe("Boolean extraction precedes historical native-value inverses", () => {
  const donorHash = "143a0f5cdc03fa58704b467ea180576913a104080d064011d7caed60f14f378c";
  const bodies = () =>
    readFileSync(resolve(import.meta.dirname, "../src/runtime/wasmgc/values/boolean-bodies.ts"), "utf8");
});

describe("authenticated intervening main native-value changes", () => {
  const fixture = JSON.parse(followupImportsForwardText) as { spans: { id: string; before: string; after: string }[] };
});

describe("independently authenticated delivered-main native-value import update", () => {
  const fixture = JSON.parse(mainImportsForwardText) as { spans: { before: string; after: string }[] };
  if (fixture.spans.length !== 1) throw Error("native-value main-forward span population");
  const span = fixture.spans[0]!;

  const mutations: readonly [string, (source: string) => string][] = [
    ["M1 removed exported tag span", (source) => replaceOnce(source, span.after, "")],
    ["M2 duplicated exported tag span", (source) => replaceOnce(source, span.after, span.after + span.after)],
    [
      "M3 altered imported-tag condition",
      (source) =>
        replaceOnce(
          source,
          span.after,
          replaceOnce(span.after, "ctx.sharedExnTag || ctx.exnTagImported", "ctx.sharedExnTag && ctx.exnTagImported"),
        ),
    ],
    [
      "M4 changed import-space documentation",
      (source) => replaceOnce(source, span.after, replaceOnce(span.after, "IMPORT space", "DEFINED space")),
    ],
  ];
});

describe("independently authenticated prepared native-value import additions", () => {
  const sidecar =
    "  shiftMap(ctx.classStaticSidecarGlobals); // (#5195 Step 2 / #5383 S2i) — ditto for the static sidecar\n";
  const callable = '  registerNative("__is_callable", externrefToI32, [{ op: "i32.const", value: 0 }]);\n';
  const mutations: readonly [string, (source: string) => string][] = [
    ["S1 missing sidecar shift", (source) => replaceOnce(source, sidecar, "")],
    ["S2 duplicate sidecar shift", (source) => replaceOnce(source, sidecar, sidecar + sidecar)],
    [
      "S3 wrong shifted map",
      (source) => replaceOnce(source, sidecar, sidecar.replace("classStaticSidecarGlobals", "protoGlobals")),
    ],
    ["S4 wrong shift operation", (source) => replaceOnce(source, sidecar, sidecar.replace("shiftMap(", "shiftArray("))],
    [
      "S5 changed sidecar documentation",
      (source) => replaceOnce(source, sidecar, sidecar.replace("static sidecar", "unrelated map")),
    ],
    [
      "S6 reordered sidecar shift",
      (source) => {
        const following = "  shiftMap(ctx.methodClosureGlobals); // (#1394) — cached per-method closure globals\n";
        return replaceOnce(replaceOnce(source, sidecar, ""), following, following + sidecar);
      },
    ],
    ["C1 missing callable registration", (source) => replaceOnce(source, callable, "")],
    ["C2 duplicate callable registration", (source) => replaceOnce(source, callable, callable + callable)],
    [
      "C3 changed callable name",
      (source) => replaceOnce(source, callable, callable.replace("__is_callable", "__typeof_function")),
    ],
    [
      "C4 changed callable signature",
      (source) => replaceOnce(source, callable, callable.replace("externrefToI32", "f64ToExternref")),
    ],
    [
      "C5 changed callable placeholder",
      (source) => replaceOnce(source, callable, callable.replace("value: 0", "value: 1")),
    ],
    [
      "C6 reordered callable registration",
      (source) => {
        const preceding = '  registerNative("__typeof_function", externrefToI32, [{ op: "i32.const", value: 0 }]);\n';
        return replaceOnce(replaceOnce(source, callable, ""), preceding, callable + preceding);
      },
    ],
    [
      "C7 changed callable documentation",
      (source) => replaceOnce(source, "  // only class-object singletons.\n", "  // also class-object singletons.\n"),
    ],
  ];
});

describe("mandatory live native-value donor reconstruction", () => {});

describe("legacy source callers of the same canonical native number bodies", () => {
  it.each([
    ["boolean true", "Number(new Boolean(true))", 1],
    ["boolean false", "Number(new Boolean(false))", 0],
    ["StringToNumber", '(new String("3e9") as any) - 0', 3e9],
    ["StringToNumber exponent", '(new String(" 1.25e2 ") as any) - 0', 125],
  ] as const)("executes the actual standalone %s path without host imports", async (_label, expression, expected) => {
    const { compile } = await import("../src/index.js");
    const result = await compile(`export function main(): number { return ${expression}; }`, {
      target: "standalone",
      skipSemanticDiagnostics: true,
    });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.binary.length).toBeGreaterThan(0);
    const module = await WebAssembly.compile(result.binary as BufferSource);
    expect(WebAssembly.Module.imports(module)).toEqual([]);
    const instance = await WebAssembly.instantiate(module, {});
    expect((instance.exports.main as () => number)()).toBe(expected);
  });
});
