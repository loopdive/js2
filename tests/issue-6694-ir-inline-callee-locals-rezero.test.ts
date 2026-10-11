// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6694) The IR inliner relocates a callee's declared locals into fresh caller
 * locals. Wasm zero-initialises locals once per FRAME, so when the call site
 * sits inside a loop the inlined copy's second trip would start with whatever
 * the first trip left behind. A callee that reads a declared local before
 * writing it (relying on the Wasm default) must see the default on every
 * inlined invocation, exactly as it does on every real call.
 *
 * Hand-built module (TS codegen initialises its locals explicitly, so source
 * programs do not reach this shape; hand-written runtime helpers do — #6677's
 * RegExp `parseTerm` was the first):
 *
 *   callee(flag: i32) -> i32 { local q;  if (flag) q = <5>;  return <q as i32>; }
 *   drive() -> i32 { sum = 0; for (i = 0; i < 3; i++) sum += callee(i == 0); return sum; }
 *
 * Not inlined: 5 + 0 + 0 = 5. Inlined without re-zeroing: 5 + 5 + 5 = 15.
 */
import { afterEach, describe, expect, it } from "vitest";

import type { CodegenContext } from "../src/codegen/context/types.js";
import { inlineUserFunctions } from "../src/codegen/ir-inline.js";
import { emitBinary } from "../src/emit/binary.js";
import type { Instr, ValType, WasmFunction, WasmModule } from "../src/ir/types.js";

const FLAG = "JS2WASM_IR_INLINE";
const originalFlag = process.env[FLAG];

afterEach(() => {
  if (originalFlag === undefined) delete process.env[FLAG];
  else process.env[FLAG] = originalFlag;
});

const I32: ValType = { kind: "i32" };

/** The callee's declared local `q` is index 1 (param `flag` is 0). */
function buildModule(localType: ValType, setValue: Instr[], readAsI32: Instr[], loopSite = true): WasmModule {
  // callee(flag) — reads `q` on every path, writes it only when flag != 0.
  const callee: WasmFunction = {
    name: "__fn_callee",
    typeIdx: 0,
    locals: [{ name: "q", type: localType }],
    body: [
      { op: "local.get", index: 0 },
      { op: "if", blockType: { kind: "empty" }, then: [...setValue, { op: "local.set", index: 1 }] },
      { op: "local.get", index: 1 },
      ...readAsI32,
    ] as Instr[],
  };
  const site: Instr[] = [
    { op: "local.get", index: 1 },
    { op: "local.get", index: 0 },
    { op: "i32.eqz" },
    { op: "call", funcIdx: 0 },
    { op: "i32.add" },
    { op: "local.set", index: 1 },
  ] as Instr[];
  // drive() — locals: 0 = i, 1 = sum. Calls callee(i == 0) three times.
  const loopBody: Instr[] = [
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: 0 },
            { op: "i32.const", value: 3 },
            { op: "i32.ge_s" },
            { op: "br_if", depth: 1 },
            ...site,
            { op: "local.get", index: 0 },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: 0 },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
  ] as Instr[];
  const drive: WasmFunction = {
    name: "__fn_drive",
    typeIdx: 1,
    locals: [
      { name: "i", type: I32 },
      { name: "sum", type: I32 },
    ],
    exported: true,
    body: [...(loopSite ? loopBody : site), { op: "local.get", index: 1 }] as Instr[],
  };
  return {
    types: [
      { kind: "func", name: "callee_t", params: [I32], results: [I32] },
      { kind: "func", name: "drive_t", params: [], results: [I32] },
    ],
    imports: [],
    functions: [callee, drive],
    exports: [{ name: "drive", desc: { kind: "func", index: 1 } }],
    tables: [],
    elements: [],
    globals: [],
    tags: [],
    stringPool: [],
    externClasses: [],
    nodeBuiltinModules: new Set(),
    stringLiteralValues: new Map(),
    asyncFunctions: new Set(),
    declaredFuncRefs: [1],
    funcOrdinalToPosition: [],
    memories: [],
    dataSegments: [],
  } as unknown as WasmModule;
}

function ctxFor(mod: WasmModule): CodegenContext {
  return {
    mod,
    moduleInitChunkHelperNames: new Set<string>(),
    numImportGlobals: 0,
    callerStrictGlobalIdx: -1,
    sourceFunctionStrictness: new Map(),
    sourceFunctionStrictnessByBody: new WeakMap(),
  } as unknown as CodegenContext;
}

async function run(mod: WasmModule): Promise<number> {
  const { instance } = await WebAssembly.instantiate(emitBinary(mod), {});
  return (instance.exports.drive as () => number)();
}

/** Every instruction of `body`, nested ones included. */
function flat(body: Instr[]): Instr[] {
  const out: Instr[] = [];
  const walk = (b: Instr[]): void => {
    for (const instr of b) {
      out.push(instr);
      for (const key of ["body", "then", "else"] as const) {
        const child = (instr as unknown as Record<string, unknown>)[key];
        if (Array.isArray(child)) walk(child as Instr[]);
      }
    }
  };
  walk(body);
  return out;
}

const callsCallee = (mod: WasmModule): boolean =>
  flat(mod.functions[1]!.body).some((i) => i.op === "call" && i.funcIdx === 0);

const SHAPES: Array<[string, ValType, Instr[], Instr[]]> = [
  ["i32", I32, [{ op: "i32.const", value: 5 }], []],
  ["f64", { kind: "f64" }, [{ op: "f64.const", value: 5 }], [{ op: "i32.trunc_f64_s" }]],
  ["i64", { kind: "i64" }, [{ op: "i64.const", value: 5n }], [{ op: "i32.wrap_i64" }]],
  // funcref: 5 when non-null (`ref.func $drive`), 0 for the default null.
  [
    "funcref",
    { kind: "funcref" },
    [{ op: "ref.func", funcIdx: 1 }],
    [{ op: "ref.is_null" }, { op: "i32.eqz" }, { op: "i32.const", value: 5 }, { op: "i32.mul" }],
  ],
] as Array<[string, ValType, Instr[], Instr[]]>;

describe("#6694 — an inlined callee's declared locals start at the Wasm default on every trip", () => {
  it.each(SHAPES)("%s local read before written, call site in a loop", async (_name, type, setValue, read) => {
    // Control: the non-inlined module answers 5 (only the first trip sets q).
    process.env[FLAG] = "0";
    const plain = buildModule(type, setValue, read);
    inlineUserFunctions(ctxFor(plain));
    expect(callsCallee(plain)).toBe(true);
    expect(await run(plain)).toBe(5);

    delete process.env[FLAG]; // shipped default: enabled
    const inlined = buildModule(type, setValue, read);
    inlineUserFunctions(ctxFor(inlined));
    // Anti-vacuity: the site really was inlined.
    expect(callsCallee(inlined)).toBe(false);
    expect(await run(inlined)).toBe(5);
  });

  it("adds no reset when the callee writes the local before any read", async () => {
    // callee(flag) { q = 7; if (flag) q = 5; return q; } — q is written first on
    // every path, so re-zeroing it would be pure growth.
    delete process.env[FLAG];
    const mod = buildModule(I32, [{ op: "i32.const", value: 5 }], []);
    mod.functions[0]!.body.unshift({ op: "i32.const", value: 7 }, { op: "local.set", index: 1 });
    inlineUserFunctions(ctxFor(mod));
    expect(callsCallee(mod)).toBe(false);
    // 5 + 7 + 7
    expect(await run(mod)).toBe(19);
    const q = mod.functions[1]!.locals.findIndex((l) => l.name.endsWith("_q"));
    expect(q).toBeGreaterThanOrEqual(0);
    const qIdx = q; // drive has no params
    const sets = flat(mod.functions[1]!.body).filter((i) => i.op === "local.set" && i.index === qIdx);
    expect(sets.length).toBe(2); // the callee's own two writes, no reset
  });

  it("adds no reset when the call site is not inside a loop", async () => {
    delete process.env[FLAG];
    const mod = buildModule(I32, [{ op: "i32.const", value: 5 }], [], false);
    inlineUserFunctions(ctxFor(mod));
    expect(callsCallee(mod)).toBe(false);
    expect(await run(mod)).toBe(5);
    const q = mod.functions[1]!.locals.findIndex((l) => l.name.endsWith("_q"));
    const sets = flat(mod.functions[1]!.body).filter((i) => i.op === "local.set" && i.index === q);
    expect(sets.length).toBe(1);
  });
});
