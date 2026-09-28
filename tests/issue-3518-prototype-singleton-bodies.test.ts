// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import type { Instr } from "../src/wasm/model/instructions.js";
import { buildNativePrototypeType } from "../src/runtime/wasmgc/values/prototype-layouts.js";
import { buildPrototypeSingletonRead } from "../src/runtime/wasmgc/values/prototype-singleton-bodies.js";
import {
  applyPrototypeSingletonExtraction,
  prototypeSingletonReceipt,
  prototypeSingletonReceiptPath,
} from "./helpers/prototype-singleton-extraction.js";
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const receipt = prototypeSingletonReceipt();
const current = read(receipt.path);
const original = applyPrototypeSingletonExtraction(current, true);
interface Scenario {
  parent?: "present" | "missing" | "self" | "cycle";
  absent?: boolean;
  seeded?: boolean;
  standalone?: boolean;
  changing?: boolean;
  registered?: boolean;
  cached?: boolean;
}
function capture(source: string, s: Scenario) {
  const parsed = ts.createSourceFile("donor.ts", source, ts.ScriptTarget.Latest, true);
  const names = new Set(["registerNativeProtoType", "buildLazyNativeProtoGetInstrs"]);
  const functions = parsed.statements
    .filter((n) => ts.isFunctionDeclaration(n) && n.name && names.has(n.name.text))
    .map((n) => n.getText(parsed))
    .join("\n");
  const glues = new Map<number, { brand: number; memberCsv: string; name: string; parentBrand?: number }>([
    [100, { brand: 100, memberCsv: "x,y", name: "Child" }],
  ]);
  if (s.parent) glues.get(100)!.parentBrand = s.parent === "self" ? 100 : 101;
  if (s.parent === "present" || s.parent === "cycle")
    glues.set(101, {
      brand: 101,
      memberCsv: "p",
      name: "Parent",
      ...(s.parent === "cycle" ? { parentBrand: 100 } : {}),
    });
  const events: unknown[] = [];
  const pending: { op: "global.get"; index: number }[] = [];
  const ctx = {
    nativeProtoTypeIdx: s.cached ? 3 : (undefined as number | undefined),
    structMap: new Map<string, number>(s.registered ? [["__NativeProto", 3]] : []),
    typeIdxToStructName: new Map(),
    structFields: new Map(),
    mod: { types: [] as unknown[], globals: [] as unknown[] },
    numImportGlobals: 2,
    standalone: s.standalone !== false,
    funcMap: new Map<string, number>(),
    protoGlobals: new Map<number, number>(),
    progress: new Set<number>(),
    seeders: new Set<number>(),
  };
  const bindings = {
    buildNativePrototypeType,
    buildPrototypeSingletonRead,
    NATIVE_PROTO_STRUCT_NAME: "__NativeProto",
    BUILTIN_BRAND_BASE: 100,
    getNativeProtoBuiltinGlue: (_: unknown, b: number) => {
      events.push(["glue", b]);
      return s.absent ? undefined : glues.get(b);
    },
    nativeProtoGlobalName: (b: number) => `__native_proto_${b}`,
    nativeProtoGlobalMap: () => ctx.protoGlobals,
    parentEmitInProgress: () => ctx.progress,
    addStringConstantGlobal: (_: unknown, v: string) => events.push(["register-string", v]),
    stringConstantExternrefInstrs: (_: unknown, v: string) => {
      events.push(["literal", v]);
      const node = { op: "global.get" as const, index: 40 + pending.length };
      pending.push(node);
      if (s.changing) {
        glues.get(100)!.name = "Changed";
        ctx.funcMap.set("__protoidx_companion", 71);
      }
      return [node];
    },
    pushNativeStringToExternref: (_: Instr[]) => {},
    ensureNativeProtoCompanionSeeder: (_: unknown, b: number) => {
      events.push(["seed", b]);
      if (s.seeded) {
        ctx.seeders.add(b);
        ctx.funcMap.set("__protoidx_companion", s.changing ? 72 : 70);
      }
    },
    nativeProtoSeederRegistry: () => ctx.seeders,
  };
  const js = ts.transpileModule(functions, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const fn = new Function("exports", ...Object.keys(bindings), js + "\nreturn buildLazyNativeProtoGetInstrs;")(
    {},
    ...Object.values(bindings),
  );
  const first = fn(ctx, 100),
    second = fn(ctx, 100);
  const before = JSON.stringify([first, second]);
  for (const node of pending) node.index += 500;
  return { first, second, before, events, ctx, pending };
}
describe("prototype singleton donor and acquisition", () => {
  it("reconstructs the full signed file and replays current source", () => {
    expect(receipt.base).toBe("88e1975bc20272a154804c0afa6033a3b92bad73");
    expect(applyPrototypeSingletonExtraction(original, false)).toBe(current);
  });
  it.each([
    {},
    { absent: true },
    { registered: true },
    { cached: true },
    { parent: "present" },
    { parent: "missing" },
    { parent: "self" },
    { parent: "cycle" },
    { seeded: true },
    { seeded: true, standalone: false },
    { seeded: true, changing: true },
    { parent: "present", seeded: true, changing: true },
  ] as Scenario[])("preserves complete definitions and acquisition effects %j", (s) => {
    expect(capture(current, s)).toEqual(capture(original, s));
  });
  it("retains pending host literal instruction identities for later index patching", () => {
    const result = capture(current, { parent: "present", seeded: true });
    const nodes: Instr[] = [];
    const walk = (body: Instr[]) => {
      for (const n of body) {
        nodes.push(n);
        if (n.op === "if") {
          walk(n.then);
          if (n.else) walk(n.else);
        }
      }
    };
    walk(result.first);
    walk(result.second);
    expect(result.pending.length).toBeGreaterThan(0);
    for (const operand of result.pending) expect(nodes.some((n) => n === operand)).toBe(true);
    expect(JSON.stringify([result.first, result.second])).not.toBe(result.before);
  });
  it("creates fresh layout records", () => {
    const a = buildNativePrototypeType(),
      b = buildNativePrototypeType();
    expect(a).toEqual(b);
    expect(a.fields).not.toBe(b.fields);
    expect(a.fields[0]).not.toBe(b.fields[0]);
  });
  for (const direction of [false, true])
    it(`rejects unrecorded full-source changes inverse=${direction}`, () => {
      expect(() => applyPrototypeSingletonExtraction((direction ? current : original) + "\n", direction)).toThrow(
        /source mismatch/,
      );
    });
  it("rejects receipt substitution", () => {
    expect(() => prototypeSingletonReceipt((p) => read(p) + (p === prototypeSingletonReceiptPath ? " " : ""))).toThrow(
      /receipt/,
    );
  });
  for (const module of receipt.modules)
    it(`rejects altered builder ${module.path}`, () => {
      expect(() => prototypeSingletonReceipt((p) => read(p) + (p === module.path ? " " : ""))).toThrow(/builder/);
    });
  for (const wrongAt of [0, 1, 2, 3])
    it(`rejects out-of-order recipe response ${wrongAt}`, () => {
      const recipe = buildPrototypeSingletonRead(100, 0, 0);
      let state = recipe.next();
      for (let i = 0; i < wrongAt; i++)
        state = recipe.next(
          i === 0
            ? { kind: "parent", instructions: null }
            : i === 1
              ? { kind: "member-csv", instructions: [] }
              : { kind: "name", instructions: [] },
        );
      expect(state.done).toBe(false);
      expect(() =>
        recipe.next(
          wrongAt === 3 ? { kind: "parent", instructions: null } : { kind: "seed-companion", companion: undefined },
        ),
      ).toThrow(/expected/);
    });
});
