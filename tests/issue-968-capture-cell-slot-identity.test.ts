// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// Authored native diagnostics, not additional official Test262 originals.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports, markCoherentBuiltinRealm } from "../src/runtime.js";
import { createEmptyModule, type Instr } from "../src/ir/types.js";
import type { CodegenContext, FunctionContext } from "../src/codegen/context/types.js";
import { emitClosureConstruction, type ArrowClosureCapture } from "../src/codegen/closures/arrow-phases.js";
import { allocLocal, deduplicateLocals, restoreLocals, snapshotLocals } from "../src/codegen/context/locals.js";
import { assembleOriginalHarness } from "./test262-original-harness.js";
import { createTestSandbox, parseMeta } from "./test262-runner.js";
import { restoreHostBuiltins } from "./test262-restore-builtins.js";
import { instantiateTest262Module, TEST262_DYNAMIC_CODE_POLICY } from "../scripts/test262-import-object.mjs";
import { renderHarnessThrownText } from "../scripts/lib/wasm-exn-render.mjs";

const CAPTURE_CELL_CONTROLS = [
  {
    name: "unchanged case14 parameter and block shadows across activations",
    source: `let callback = function() { return 1; };
function make(callback) {
  let parameter = () => callback, block;
  { let callback = function() { return 3; }; block = () => callback; callback = null; }
  callback = undefined; return { parameter: parameter, block: block };
}
let first = make(function() { return 2; }), second = make(function() { return 4; });
assert.sameValue(first.parameter(), undefined); assert.sameValue(second.parameter(), undefined);
assert.sameValue(first.block(), null); assert.sameValue(second.block(), null);
assert.sameValue(callback(), 1);`,
  },
  {
    name: "outer let and inner let retain different live cells",
    source: `function make() {
  let callback = function() { return 1; }, outer = () => callback, inner;
  { let callback = function() { return 2; }; inner = () => callback; callback = null; }
  callback = undefined; return { outer: outer, inner: inner };
}
let pair = make(); assert.sameValue(pair.outer(), undefined); assert.sameValue(pair.inner(), null);`,
  },
  {
    name: "outer var and inner let retain different live cells",
    source: `function make() {
  var callback = function() { return 1; }; let outer = () => callback, inner;
  { let callback = function() { return 2; }; inner = () => callback; callback = null; }
  callback = undefined; return { outer: outer, inner: inner };
}
let pair = make(); assert.sameValue(pair.outer(), undefined); assert.sameValue(pair.inner(), null);`,
  },
  {
    name: "sibling shadow blocks retain independent cells",
    source: `function make() {
  let first, second;
  { let callback = function() { return 1; }; first = () => callback; callback = null; }
  { let callback = function() { return 2; }; second = () => callback; callback = undefined; }
  return { first: first, second: second };
}
let pair = make(); assert.sameValue(pair.first(), null); assert.sameValue(pair.second(), undefined);`,
  },
  {
    name: "three nested same-spelled bindings retain three values",
    source: `function make(callback) {
  let first = () => callback, second, third;
  { let callback = function() { return 2; }; second = () => callback;
    { let callback = function() { return 3; }; third = () => callback; callback = null; }
    callback = false;
  }
  callback = undefined; return { first: first, second: second, third: third };
}
let result = make(function() { return 1; });
assert.sameValue(result.first(), undefined); assert.sameValue(result.second(), false); assert.sameValue(result.third(), null);`,
  },
  {
    name: "captured loop-head bindings are fresh per iteration",
    source: `function make() {
  let readers = [];
  for (let callback = 0; callback < 3; ++callback) { readers[callback] = () => callback; }
  return readers;
}
let readers = make(); assert.sameValue(readers[0](), 0); assert.sameValue(readers[1](), 1); assert.sameValue(readers[2](), 2);`,
  },
  {
    name: "untaken conditional capture preserves the later write",
    source: `function make(flag) {
  let callback = function() { return 1; }, reader;
  if (flag) { reader = () => callback; }
  callback = null; return { callback: callback, reader: reader };
}
let skipped = make(false), taken = make(true);
assert.sameValue(skipped.callback, null); assert.sameValue(skipped.reader, undefined);
assert.sameValue(taken.callback, null); assert.sameValue(taken.reader(), null);`,
  },
  {
    name: "two readers of one binding share the existing live cell",
    source: `function make(callback) {
  let first = () => callback, second = () => callback;
  callback = null; return { first: first, second: second };
}
let pair = make(function() { return 1; }); assert.sameValue(pair.first(), null); assert.sameValue(pair.second(), null);`,
  },
  {
    name: "write-only closure and sibling reader share one binding",
    source: `function make(callback) {
  return { write: (value) => { callback = value; }, read: () => callback };
}
let pair = make(function() { return 1; }); pair.write(null); assert.sameValue(pair.read(), null);
pair.write(undefined); assert.sameValue(pair.read(), undefined);`,
  },
  {
    name: "null undefined and false stay distinct across shadow cells",
    source: `function make(callback) {
  let outer = () => callback, inner;
  { let callback = function() { return 2; }; inner = () => callback; callback = false; }
  callback = null; return { outer: outer, inner: inner, write: (value) => { callback = value; } };
}
let pair = make(function() { return 1; }); assert.sameValue(pair.outer(), null); assert.sameValue(pair.inner(), false);
pair.write(undefined); assert.sameValue(pair.outer(), undefined); assert.sameValue(pair.inner(), false);`,
  },
  {
    name: "source names with an ordinary boxed prefix can still shadow",
    source: `function make(__boxed_callback) {
  let outer = () => __boxed_callback, inner;
  { let __boxed_callback = function() { return 2; }; inner = () => __boxed_callback; __boxed_callback = null; }
  __boxed_callback = undefined; return { outer: outer, inner: inner };
}
let pair = make(function() { return 1; }); assert.sameValue(pair.outer(), undefined); assert.sameValue(pair.inner(), null);`,
  },
  {
    name: "interleaved activations preserve thrown identity and write order",
    source: `function make(callback, sentinel) {
  let parameter = () => callback, block, order = "";
  { let callback = function() { return 3; }; block = () => callback; callback = null; }
  callback = function() { order += "p"; throw sentinel; };
  return { parameter: parameter, block: block, order: () => order };
}
let firstSentinel = {}, secondSentinel = {}, caught;
let first = make(function() { return 1; }, firstSentinel), second = make(function() { return 2; }, secondSentinel);
try { first.parameter()(); } catch (error) { caught = error; } assert.sameValue(caught, firstSentinel);
caught = undefined;
try { second.parameter()(); } catch (error) { caught = error; } assert.sameValue(caught, secondSentinel);
caught = undefined;
try { first.parameter()(); } catch (error) { caught = error; } assert.sameValue(caught, firstSentinel);
assert.sameValue(first.order(), "pp"); assert.sameValue(second.order(), "p");
assert.sameValue(first.block(), null); assert.sameValue(second.block(), null);`,
  },
] as const;

async function runNativeControl(body: string): Promise<void> {
  const source = `/*---\nflags: [noStrict]\n---*/\n${body}\n`;
  const assembled = assembleOriginalHarness(source, parseMeta(source));
  expect(assembled.strictRerun).toBeUndefined();
  const result = await compile(assembled.primary.source, {
    allowJs: true,
    skipSemanticDiagnostics: true,
    sourceMap: true,
    emitWat: true,
    target: "standalone",
    semanticProviders: "native-first",
    deferTopLevelInit: true,
    inferModuleStrictArguments: false,
    hostBridge: "always",
    fileName: "issue-968-capture-cell-control.js",
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(result.imports).toEqual([]);
  expect(result.hostImportInventory).toEqual([]);
  expect(result.linkedModules ?? []).toHaveLength(0);
  expect(result.wat).toContain("(module");
  const module = new WebAssembly.Module(result.binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const sandbox = createTestSandbox(undefined, false);
  markCoherentBuiltinRealm(sandbox);
  const imports = buildImports(result.imports, {}, result.stringPool, {
    globalSandbox: sandbox,
    dynamicCode: TEST262_DYNAMIC_CODE_POLICY,
  });
  let instance: WebAssembly.Instance | undefined;
  try {
    instance = await instantiateTest262Module(result.binary, imports, {
      target: "standalone",
      semanticProviders: "native-first",
      linkedModules: [],
    });
    imports.setInstance?.(instance);
    expect(typeof instance.exports.__module_init).toBe("function");
    (instance.exports.__module_init as () => void)();
  } catch (error) {
    throw new Error(renderHarnessThrownText(error, instance));
  } finally {
    restoreHostBuiltins();
  }
}

describe("#968 native capture-cell slot identity", () => {
  for (const control of CAPTURE_CELL_CONTROLS) {
    it(control.name, () => runNativeControl(control.source), 120_000);
  }
});

function allocationFixture() {
  const ctx = {
    mod: createEmptyModule(),
    refCellTypeMap: new Map(),
    constructibleClosureTypeIdxs: new Set(),
  } as unknown as CodegenContext;
  const fctx = {
    params: [
      { name: "callback", type: { kind: "externref" } },
      { name: "other", type: { kind: "externref" } },
    ],
    locals: [],
    localMap: new Map([
      ["callback", 0],
      ["other", 1],
    ]),
    body: [],
    activationEntryBody: [],
  } as unknown as FunctionContext;
  function emit(localIdx: number, dominating = false) {
    const cap: ArrowClosureCapture = {
      name: "callback",
      type: { kind: "externref" },
      localIdx,
      mutable: true,
      alreadyBoxed: false,
      hasTdzFlag: false,
      eagerDominatingBox: dominating,
    };
    emitClosureConstruction(ctx, fctx, [cap], 0, 0, 0);
    return fctx.localMap.get("callback")!;
  }
  function shadow(dominating = false) {
    fctx.boxedCaptures?.delete("callback");
    const raw = allocLocal(fctx, "callback", { kind: "externref" });
    return emit(raw, dominating);
  }
  return { ctx, fctx, emit, shadow };
}

describe("#968 real allocation and unchanged dedup contracts", () => {
  it("keeps both fresh allocation arms distinct after ordinary local dedup", () => {
    for (const dominating of [false, true]) {
      const { fctx, emit, shadow } = allocationFixture();
      expect(emit(0, dominating)).toBe(2);
      expect(shadow(dominating)).toBe(4);
      const names = fctx.locals.filter((local) => local.name.startsWith("__boxed_")).map((local) => local.name);
      expect(names).toEqual(["__boxed_callback@cell:2", "__boxed_callback@cell:4"]);
      deduplicateLocals(fctx);
      expect(fctx.locals).toHaveLength(3);
      expect(fctx.locals.filter((local) => local.name.startsWith("__boxed_")).map((local) => local.name)).toEqual(
        names,
      );
      const body = dominating ? fctx.activationEntryBody! : fctx.body;
      const stores = body.filter((instr) => instr.op === (dominating ? "local.set" : "local.tee"));
      expect(stores).toEqual([
        { op: dominating ? "local.set" : "local.tee", index: 2 },
        { op: dominating ? "local.set" : "local.tee", index: 4 },
      ]);
    }
  });

  it("still merges equal-name/type disposable temps without merging real cell names", () => {
    const { fctx, emit, shadow } = allocationFixture();
    emit(0);
    shadow();
    allocLocal(fctx, "__disposable", { kind: "i32" });
    allocLocal(fctx, "__disposable", { kind: "i32" });
    deduplicateLocals(fctx);
    expect(fctx.locals.filter((local) => local.name === "__disposable")).toHaveLength(1);
    expect(fctx.locals.filter((local) => local.name.startsWith("__boxed_callback@cell:"))).toHaveLength(2);
  });

  it("remaps a shared instruction object only once during compaction", () => {
    const shared: Instr = { op: "local.get", index: 3 };
    const fctx = {
      params: [],
      locals: [
        { name: "__keep", type: { kind: "i32" } },
        { name: "__dup", type: { kind: "i32" } },
        { name: "__dup", type: { kind: "i32" } },
        { name: "payload", type: { kind: "i32" } },
      ],
      body: [{ op: "if", blockType: { kind: "empty" }, then: [shared], else: [shared] }],
    } as unknown as FunctionContext;
    deduplicateLocals(fctx);
    expect(fctx.locals).toHaveLength(3);
    expect(shared).toEqual({ op: "local.get", index: 2 });
  });

  it("can reuse a rolled-back ordinal without duplicating a surviving cell identity", () => {
    const { fctx, emit, shadow } = allocationFixture();
    const snapshot = snapshotLocals(fctx),
      bodyLength = fctx.body.length;
    emit(0);
    const removedName = fctx.locals[0]!.name;
    restoreLocals(fctx, snapshot);
    fctx.body.length = bodyLength;
    expect(fctx.locals).toHaveLength(0);
    expect(fctx.localMap.get("callback")).toBe(0);
    expect(fctx.boxedCaptures).toBeUndefined();
    emit(0);
    expect(fctx.locals[0]!.name).toBe(removedName);
    shadow();
    deduplicateLocals(fctx);
    const names = fctx.locals.filter((local) => local.name.startsWith("__boxed_")).map((local) => local.name);
    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);
  });
});
