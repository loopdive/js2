// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { readBeforeResumeMain } from "./helpers/resume-main-composition.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as bodies from "../src/runtime/wasmgc/values/carrier-bag-read-bodies.js";
import { createEmptyModule } from "../src/ir/types.js";
import type { Instr, ValType } from "../src/wasm/model/instructions.js";
import { emitBinary } from "../src/emit/binary.js";

const BASE = "cfff0f5cebb19e3b3773a4b892b0619ac2e511e3";
const SOURCE_SHA = "67101d82b65e733bb1e48e1ee15895375112a40127d1b809d803d2cbe27bd096";
const FIXTURE_SHA = "7f74045ebaf6255ff7becaf006d1c1048ea1d3a62164f0e94fc6e4b4b380e01c";
const fixtureText = readFileSync(new URL("./fixtures/issue-3518-carrier-bag-read-donor.json", import.meta.url), "utf8");
const adapter = readBeforeResumeMain("src/codegen/carrier-bag-visibility.ts");
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
interface Receipt {
  schemaVersion: number;
  base: string;
  path: string;
  gitBlob: string;
  sourceSha256: string;
  spans: { name: string; start: number; end: number; text: string; sha256: string }[];
  markerFunction: string;
  fillFunction: string;
}
function authenticate(text: string): Receipt {
  if (sha(text) !== FIXTURE_SHA) throw Error("carrier bag donor digest mismatch");
  const receipt = JSON.parse(text) as Receipt;
  if (
    receipt.schemaVersion !== 1 ||
    receipt.base !== BASE ||
    receipt.path !== "src/codegen/carrier-bag-visibility.ts" ||
    receipt.sourceSha256 !== SOURCE_SHA ||
    receipt.gitBlob !== "00c1a188fb5f255e2466f6966a90d8b1325e84ce"
  )
    throw Error("carrier bag donor provenance mismatch");
  expect(receipt.spans.map((r) => r.name)).toEqual(["marker", "bagOf", "has", "eqConstant"]);
  for (const span of receipt.spans) {
    if (span.end - span.start !== span.text.length || sha(span.text) !== span.sha256)
      throw Error("carrier bag donor span mismatch");
  }
  return receipt;
}
const receipt = authenticate(fixtureText);
function parse(source: string) {
  return ts.createSourceFile("carrier-bag-visibility.ts", source, ts.ScriptTarget.Latest, true);
}
function functions(source: string) {
  const sf = parse(source);
  const named = (name: string) =>
    sf.statements.find((n): n is ts.FunctionDeclaration => ts.isFunctionDeclaration(n) && n.name?.text === name)!;
  return { sf, marker: named("buildBagMarkerTestInstrs"), fill: named("fillCarrierBagVisibility") };
}
function restoreDonor(source: string) {
  const { sf, marker, fill } = functions(source);
  const markerCall = (marker.body!.statements.at(-1) as ts.ReturnStatement).expression!;
  const ofBlock = fill.body!.statements.find((n) => ts.isBlock(n) && n.getText(sf).includes("const arm ="))!;
  const hasCall = (
    fill.body!.statements.find(
      (n) =>
        ts.isExpressionStatement(n) &&
        ts.isCallExpression(n.expression) &&
        n.expression.arguments[0]?.getText(sf) === "CARRIER_BAG_HAS",
    ) as ts.ExpressionStatement
  ).expression as ts.CallExpression;
  expect(markerCall.getText(sf)).toBe("buildCarrierBagMarkerBody(propEntryTypeIdx, args)");
  expect(ts.isCallExpression(hasCall.arguments[2]!)).toBe(true);
  expect((hasCall.arguments[2] as ts.CallExpression).expression.getText(sf)).toBe("buildCarrierBagHasBody");
  const selected = [markerCall, ofBlock, hasCall.arguments[2]!];
  let result = source;
  for (const [index, node] of [...selected.entries()].reverse())
    result = result.slice(0, node.getStart(sf)) + receipt.spans[index]!.text + result.slice(node.end);
  const added = sf.statements.filter(
    (n): n is ts.ImportDeclaration =>
      ts.isImportDeclaration(n) &&
      ts.isStringLiteral(n.moduleSpecifier) &&
      n.moduleSpecifier.text === "../runtime/wasmgc/values/carrier-bag-read-bodies.js",
  );
  expect(added).toHaveLength(1);
  // All selected expression spans follow this import, so its offsets remain valid.
  result = result.slice(0, added[0]!.getStart(sf)) + result.slice(added[0]!.end + 1);
  const anchor = "/** `(externref obj) -> externref`";
  expect(result.split(anchor)).toHaveLength(2);
  result = result.replace(anchor, receipt.spans[3]!.text + anchor);
  if (sha(result) !== SOURCE_SHA) throw Error("unadmitted carrier bag source delta");
  return result;
}
const original = restoreDonor(adapter);
const predicates = [
  "__is_closure_prop_carrier",
  "__is_vec_prop_carrier",
  "__is_instance_expando_carrier",
  "__is_error_prop_carrier",
];
const lookups = ["__closure_bag_lookup", "__vec_bag_lookup", "__closure_bag_lookup", "__error_prop_bag_lookup"];
const published = ["__carrier_bag_of", "__carrier_bag_has", "__carrier_bag_gopd", "__carrier_bag_push_keys"];
const required = ["__obj_find", "__obj_ordered", "__obj_ordered_all", "__getOwnPropertyDescriptor", "__objvec_push"];
interface TraceOptions {
  mask?: number;
  absent?: string;
  noLayout?: boolean;
  mutateOnEnsure?: boolean;
  missingDefined?: boolean;
  publishLayout?: "changed" | "missing";
}
function trace(source: string, options: TraceOptions = {}) {
  const events: unknown[][] = [];
  const map = new Map(
    [...published, ...required, "__extern_length", "__extern_get_idx", ...predicates, ...new Set(lookups)].map(
      (name, i) => [name, 0x40000000 + i],
    ),
  );
  for (let i = 0; i < 4; i++) if (((options.mask ?? 15) & (1 << i)) === 0) map.delete(predicates[i]!);
  if (options.absent) map.delete(options.absent);
  const state = {
    objectRuntimeTypes: options.noLayout
      ? undefined
      : { objectTypeIdx: 100, propMapTypeIdx: 101, propEntryTypeIdx: 102 },
    funcMap: {
      get(name: string) {
        const value = map.get(name);
        events.push(["get", name, value]);
        return value;
      },
    },
  };
  const output = new Map<number, { locals?: unknown; body?: Instr[] }>();
  const sf = parse(source);
  let stripped = source;
  for (const node of [...sf.statements].reverse())
    if (ts.isImportDeclaration(node)) stripped = stripped.slice(0, node.getStart(sf)) + stripped.slice(node.end);
  const context = vm.createContext({
    exports: {},
    ...bodies,
    ensureExternStrictEqHelper(actual: unknown) {
      expect(actual).toBe(state);
      events.push(["ensureStrictEq"]);
      if (options.mutateOnEnsure) {
        for (const name of [...predicates, ...new Set(lookups)])
          if (map.has(name)) map.set(name, map.get(name)! + 1000);
        state.objectRuntimeTypes = { objectTypeIdx: 200, propMapTypeIdx: 201, propEntryTypeIdx: 202 };
      }
      return 0x40000100;
    },
    definedFuncAt(actual: unknown, index: number) {
      expect(actual).toBe(state);
      events.push(["defined", index]);
      if (options.publishLayout && index === map.get("__carrier_bag_of")) {
        state.objectRuntimeTypes =
          options.publishLayout === "missing"
            ? undefined
            : { objectTypeIdx: 300, propMapTypeIdx: 301, propEntryTypeIdx: 302 };
      }
      if (options.missingDefined) return undefined;
      const fn = {};
      output.set(index, fn);
      return fn;
    },
  });
  vm.runInContext(
    ts.transpileModule(stripped, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText,
    context,
  );
  const api = context.exports as {
    fillCarrierBagVisibility(ctx: unknown): void;
    buildBagMarkerTestInstrs(ctx: unknown, args: bodies.CarrierBagMarkerLocals): Instr[];
  };
  api.fillCarrierBagVisibility(state);
  return {
    events,
    output: [...output],
    marker: api.buildBagMarkerTestInstrs(state, { entryLocal: 9, bagLocal: 8, tmpAnyLocal: 7 }),
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await new Promise<void>((resolve) => setImmediate(resolve));
});

describe("fixed carrier-bag donor and real construction", () => {
  it("authenticates the donor and preserves all source outside four explicit moved spans/import", () => {
    expect(authenticate(fixtureText)).toEqual(receipt);
    expect(sha(original)).toBe(SOURCE_SHA);
    expect(functions(original).marker.getText()).toBe(receipt.markerFunction);
    expect(functions(original).fill.getText()).toBe(receipt.fillFunction);
    expect(() => authenticate(fixtureText.replace('"schemaVersion": 1', '"schemaVersion": 2'))).toThrow(
      "digest mismatch",
    );
    expect(() =>
      restoreDonor(
        adapter.replace(
          'const objOrderedIdx = ctx.funcMap.get("__obj_ordered")',
          'const objOrderedIdx = ctx.funcMap.get("__obj_find")',
        ),
      ),
    ).toThrow("unadmitted");
    expect(() =>
      restoreDonor(
        adapter.replace(
          'if (propEntryTypeIdx === undefined) return [{ op: "i32.const", value: 0 }]',
          'if (propEntryTypeIdx === undefined) return [{ op: "i32.const", value: 1 }]',
        ),
      ),
    ).toThrow("unadmitted");
  });
  for (let mask = 0; mask < 16; mask++)
    it(`preserves complete acquisition/publication trace and every body for carrier mask ${mask}`, () => {
      const expected = trace(original, { mask }),
        actual = trace(adapter, { mask });
      expect(actual).toEqual(expected);
      expect(actual.events.findIndex((e) => e[0] === "ensureStrictEq")).toBeLessThan(
        actual.events.findIndex((e) => e[1] === predicates[0]),
      );
      expect(actual.output).toHaveLength(mask === 0 ? 0 : 4);
      for (const lookup of new Set(lookups)) expect(actual.events.some((e) => e[1] === lookup)).toBe(true);
    });
  for (const absent of [published[0]!, ...required, ...new Set(lookups)])
    it(`retains refusal/read behavior without ${absent}`, () => {
      expect(trace(adapter, { absent })).toEqual(trace(original, { absent }));
    });
  it("keeps missing-layout false and the early fill return", () => {
    const actual = trace(adapter, { noLayout: true });
    expect(actual).toEqual(trace(original, { noLayout: true }));
    expect(actual.marker).toEqual([{ op: "i32.const", value: 0 }]);
    expect(actual.output).toEqual([]);
  });
  it("retains late marker layout reads and function handles after real reservation callback changes", () => {
    const actual = trace(adapter, { mutateOnEnsure: true });
    expect(actual).toEqual(trace(original, { mutateOnEnsure: true }));
    expect(actual.output).toHaveLength(4);
    expect(actual.marker[2]).toEqual({ op: "struct.get", typeIdx: 202, fieldIdx: 1 });
  });
  it("retains missing defined-function publication without manufacturing a body owner", () => {
    expect(trace(adapter, { missingDefined: true })).toEqual(trace(original, { missingDefined: true }));
  });
  for (const publishLayout of ["changed", "missing"] as const)
    it(`retains cached local types but re-reads a ${publishLayout} marker layout after bag-of publication`, () => {
      const actual = trace(adapter, { publishLayout });
      expect(actual).toEqual(trace(original, { publishLayout }));
      const has = actual.output[1]![1];
      expect(has.locals).toEqual([
        { name: "bag", type: { kind: "externref" } },
        { name: "e", type: { kind: "ref_null", typeIdx: 102 } },
        { name: "v", type: { kind: "anyref" } },
      ]);
      expect(has.body!.find((instr) => instr.op === "struct.get")).toEqual(
        publishLayout === "changed" ? { op: "struct.get", typeIdx: 302, fieldIdx: 1 } : undefined,
      );
      const cached = adapter.replace(
        "markerPropEntryTypeIdx: ctx.objectRuntimeTypes?.propEntryTypeIdx",
        "markerPropEntryTypeIdx: propEntryTypeIdx",
      );
      expect(trace(cached, { publishLayout })).not.toEqual(trace(original, { publishLayout }));
    });
  it("detects a lost second lookup and a lost whole-fill return after passing their original controls", () => {
    expect(trace(adapter, { mask: 0 })).toEqual(trace(original, { mask: 0 }));
    const skipped = adapter.replace(
      "const lookupIdx = ctx.funcMap.get(lookupName);",
      "const lookupIdx = isIdx === undefined ? undefined : ctx.funcMap.get(lookupName);",
    );
    expect(trace(skipped, { mask: 0 })).not.toEqual(trace(original, { mask: 0 }));
    const continued = adapter.replace(
      "if (body === undefined) return;",
      "if (body === undefined) { /* mutant continues */ }",
    );
    expect(trace(continued, { mask: 0 })).not.toEqual(trace(original, { mask: 0 }));
  });
  it("returns fresh nested instructions and imports only Wasm model types", () => {
    const a = bodies.buildCarrierBagMarkerBody(1, { entryLocal: 0, bagLocal: 1, tmpAnyLocal: 2 }),
      b = bodies.buildCarrierBagMarkerBody(1, { entryLocal: 0, bagLocal: 1, tmpAnyLocal: 2 });
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    expect(a[5]).not.toBe(b[5]);
    const leaf = readFileSync(
      new URL("../src/runtime/wasmgc/values/carrier-bag-read-bodies.ts", import.meta.url),
      "utf8",
    );
    const imports = parse(leaf).statements.filter(ts.isImportDeclaration);
    expect(imports).toHaveLength(1);
    expect(imports[0]!.importClause?.isTypeOnly).toBe(true);
    expect((imports[0]!.moduleSpecifier as ts.StringLiteral).text).toBe("../../../wasm/model/instructions.js");
  });
});

const EXT: ValType = { kind: "externref" },
  I32: ValType = { kind: "i32" },
  ANY: ValType = { kind: "anyref" };
type Alter = (body: Instr[], kind: "of" | "has") => Instr[];
function execute(predicatesEnabled: readonly boolean[], alter?: Alter) {
  // Concrete Wasm body-contract test: observable imports, not a claimed native resource pack.
  const module = createEmptyModule();
  module.types.push(
    { kind: "struct", name: "screened-bag", fields: [{ name: "identity", type: I32, mutable: false }] },
    { kind: "struct", name: "foreign-carrier", fields: [{ name: "other", type: { kind: "f64" }, mutable: false }] },
    {
      kind: "struct",
      name: "entry",
      fields: [
        { name: "key", type: ANY, mutable: false },
        { name: "value", type: ANY, mutable: true },
        { name: "flags", type: I32, mutable: true },
        { name: "seq", type: I32, mutable: true },
        { name: "get", type: ANY, mutable: true },
        { name: "set", type: ANY, mutable: true },
      ],
    },
    { kind: "func", params: [EXT], results: [I32] },
    { kind: "func", params: [EXT], results: [EXT] },
    { kind: "func", params: [{ kind: "ref", typeIdx: 0 }, EXT], results: [{ kind: "ref_null", typeIdx: 2 }] },
  );
  const events: unknown[][] = [],
    receiver = { receiver: true },
    key = { key: true };
  const values: unknown[] = [null, null, null];
  let entry: unknown = null;
  const control: WebAssembly.ModuleImports = {};
  for (let i = 0; i < 4; i++) {
    module.imports.push({ module: "control", name: `predicate${i}`, desc: { kind: "func", typeIdx: 3 } });
    control[`predicate${i}`] = (value: unknown) => {
      expect(value).toBe(receiver);
      events.push(["predicate", i]);
      return predicatesEnabled[i] ? 1 : 0;
    };
  }
  for (let i = 0; i < 3; i++) {
    module.imports.push({ module: "control", name: `lookup${i}`, desc: { kind: "func", typeIdx: 4 } });
    control[`lookup${i}`] = (value: unknown) => {
      expect(value).toBe(receiver);
      events.push(["lookup", i]);
      return values[i];
    };
  }
  module.imports.push({ module: "control", name: "find", desc: { kind: "func", typeIdx: 5 } });
  control.find = (bag: unknown, actualKey: unknown) => {
    expect(actualKey).toBe(key);
    events.push(["find", bag]);
    return entry;
  };
  const add = (
    name: string,
    params: ValType[],
    results: ValType[],
    locals: { name: string; type: ValType }[],
    body: Instr[],
  ) => {
    const typeIdx = module.types.length,
      index = 8 + module.functions.length;
    module.types.push({ kind: "func", params, results });
    module.functions.push({ name, typeIdx, locals, body });
    module.exports.push({ name, desc: { kind: "func", index } });
    return index;
  };
  add(
    "newBag",
    [],
    [EXT],
    [],
    [{ op: "i32.const", value: 0 }, { op: "struct.new", typeIdx: 0 }, { op: "extern.convert_any" }],
  );
  add(
    "newForeign",
    [],
    [EXT],
    [],
    [{ op: "f64.const", value: 0 }, { op: "struct.new", typeIdx: 1 }, { op: "extern.convert_any" }],
  );
  add(
    "newEntry",
    [EXT],
    [{ kind: "ref", typeIdx: 2 }],
    [],
    [
      { op: "ref.null", typeIdx: -18 },
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "i32.const", value: 0 },
      { op: "i32.const", value: 0 },
      { op: "ref.null", typeIdx: -18 },
      { op: "ref.null", typeIdx: -18 },
      { op: "struct.new", typeIdx: 2 },
    ],
  );
  let of = bodies.buildCarrierBagOfBody({
    objectTypeIdx: 0,
    closure: { predicate: 0, lookup: 4 },
    vec: { predicate: 1, lookup: 5 },
    instance: { predicate: 2, lookup: 4 },
    error: { predicate: 3, lookup: 6 },
  })!;
  of = alter?.(of, "of") ?? of;
  const bagOfIdx = add("of", [EXT], [EXT], [{ name: "bag", type: EXT }], of);
  let has = bodies.buildCarrierBagHasBody({ objectTypeIdx: 0, bagOfIdx, objFindIdx: 7, markerPropEntryTypeIdx: 2 });
  has = alter?.(has, "has") ?? has;
  add(
    "has",
    [EXT, EXT],
    [I32],
    [
      { name: "bag", type: EXT },
      { name: "entry", type: { kind: "ref_null", typeIdx: 2 } },
      { name: "value", type: ANY },
    ],
    has,
  );
  add(
    "marker",
    [{ kind: "ref_null", typeIdx: 2 }, EXT],
    [I32],
    [{ name: "scratch", type: ANY }],
    bodies.buildCarrierBagMarkerBody(2, { entryLocal: 0, bagLocal: 1, tmpAnyLocal: 2 }),
  );
  const binary = emitBinary(module),
    compiled = new WebAssembly.Module(binary as BufferSource);
  expect(WebAssembly.Module.imports(compiled)).toHaveLength(8);
  const api = new WebAssembly.Instance(compiled, { control }).exports as {
    newBag: () => unknown;
    newForeign: () => unknown;
    newEntry: (value: unknown) => unknown;
    of: (receiver: unknown) => unknown;
    has: (receiver: unknown, key: unknown) => number;
    marker: (entry: unknown, bag: unknown) => number;
  };
  for (let i = 0; i < 3; i++) values[i] = api.newBag();
  return {
    api,
    events,
    receiver,
    key,
    values,
    setEntry: (value: unknown) => {
      entry = value;
    },
  };
}
function replaceTest(body: Instr[], typeIdx: number): Instr[] {
  return body.flatMap((instr) =>
    instr.op === "ref.test" && instr.typeIdx === typeIdx
      ? ([{ op: "drop" }, { op: "i32.const", value: 1 }] as Instr[])
      : instr.op === "if"
        ? [
            {
              ...instr,
              then: replaceTest(instr.then, typeIdx),
              ...(instr.else ? { else: replaceTest(instr.else, typeIdx) } : {}),
            },
          ]
        : [instr],
  );
}
describe("executed bag screening and presence", () => {
  for (let selected = 0; selected < 4; selected++)
    it(`selects carrier ${selected} in closure/vec/instance/error order`, () => {
      const c = execute([0, 1, 2, 3].map((i) => i >= selected));
      const lookup = [0, 1, 0, 2][selected]!;
      expect(c.api.of(c.receiver)).toBe(c.values[lookup]);
      expect(c.events).toEqual([
        ...Array.from({ length: selected + 1 }, (_, i) => ["predicate", i]),
        ["lookup", lookup],
      ]);
    });
  for (const invalid of ["null", "host", "foreign"] as const)
    it(`screens ${invalid} without trying a later matching carrier or finder`, () => {
      const c = execute([true, true, true, true]);
      c.values[0] = invalid === "null" ? null : invalid === "host" ? {} : c.api.newForeign();
      expect(c.api.of(c.receiver)).toBeNull();
      expect(c.api.has(c.receiver, c.key)).toBe(0);
      expect(c.events).toEqual([
        ["predicate", 0],
        ["lookup", 0],
        ["predicate", 0],
        ["lookup", 0],
      ]);
    });
  it("returns absent for no matching carrier without a lookup", () => {
    const c = execute([false, false, false, false]);
    expect(c.api.has(c.receiver, c.key)).toBe(0);
    expect(c.events).toEqual([0, 1, 2, 3].map((i) => ["predicate", i]));
  });
  it("distinguishes a missing live entry, self marker, distinct bag identity and arbitrary stored value", () => {
    const c = execute([true, false, false, false]);
    expect(c.api.has(c.receiver, c.key)).toBe(0);
    c.setEntry(c.api.newEntry(c.values[0]));
    expect(c.api.has(c.receiver, c.key)).toBe(0);
    c.setEntry(c.api.newEntry(c.values[1]));
    expect(c.api.has(c.receiver, c.key)).toBe(1);
    c.setEntry(c.api.newEntry({ host: true }));
    expect(c.api.has(c.receiver, c.key)).toBe(1);
    c.setEntry(c.api.newEntry(null));
    expect(c.api.has(c.receiver, c.key)).toBe(1);
    expect(c.events.filter((e) => e[0] === "find")).toHaveLength(5);
  });
  it("detects screen removal after a passing foreign-carrier control", () => {
    const positive = execute([true, false, false, false]);
    positive.values[0] = positive.api.newForeign();
    expect(positive.api.of(positive.receiver)).toBeNull();
    const negative = execute([true, false, false, false], (body, kind) =>
      kind === "of" ? replaceTest(body, 0) : body,
    );
    negative.values[0] = negative.api.newForeign();
    expect(negative.api.of(negative.receiver)).toBe(negative.values[0]);
  });
  it("detects removal of the non-eq guard after a passing host-value control", () => {
    const positive = execute([true, false, false, false]);
    positive.setEntry(positive.api.newEntry({}));
    expect(positive.api.has(positive.receiver, positive.key)).toBe(1);
    const negative = execute([true, false, false, false], (body, kind) =>
      kind === "has" ? replaceTest(body, -19) : body,
    );
    negative.setEntry(negative.api.newEntry({}));
    expect(() => negative.api.has(negative.receiver, negative.key)).toThrow(WebAssembly.RuntimeError);
  });
  it("detects reversed carrier precedence after a passing shared-match control", () => {
    const positive = execute([true, true, false, false]);
    expect(positive.api.of(positive.receiver)).toBe(positive.values[0]);
    const negative = execute([true, true, false, false], (body, kind) =>
      kind === "of" ? [...body.slice(3, 6), ...body.slice(0, 3), ...body.slice(6)] : body,
    );
    expect(negative.api.of(negative.receiver)).toBe(negative.values[1]);
  });
});

for (const experimentalIR of [false, true])
  it(`delegates the real compiler's carrier bag construction and preserves deletion/query behavior, IR=${experimentalIR}`, async () => {
    const source = `
    function f(a, b) { return a + b; }
    export function test() {
      var before = ("missing" in f) || f.hasOwnProperty("missing");
      f.first = 7; f.second = 11;
      var live = ("first" in f) && f.hasOwnProperty("second");
      delete f.first;
      var deleted = ("first" in f) || f.hasOwnProperty("first");
      return !before && live && !deleted && f.second === 11 && Object.keys(f).length === 1 ? 1 : 0;
    }`;
    const oracle = vm.createContext({});
    vm.runInContext(source.replace("export ", ""), oracle);
    expect(vm.runInContext("test()", oracle)).toBe(1);
    const calls = [
      vi.spyOn(bodies, "buildCarrierBagOfBody"),
      vi.spyOn(bodies, "buildCarrierBagHasBody"),
      vi.spyOn(bodies, "buildCarrierBagMarkerBody"),
    ];
    const { compile } = await import("../src/index.js");
    const result = await compile(source, {
      target: "standalone",
      fileName: "carrier-bag-read.ts",
      allowJs: true,
      skipSemanticDiagnostics: true,
      experimentalIR,
    });
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    for (const call of calls) expect(call).toHaveBeenCalled();
    const compiled = new WebAssembly.Module(result.binary);
    expect(WebAssembly.Module.imports(compiled)).toEqual([]);
    const api = new WebAssembly.Instance(compiled, {}).exports as { __module_init?: () => void; test: () => number };
    api.__module_init?.();
    expect(api.test()).toBe(1);
  });
