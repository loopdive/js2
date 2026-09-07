// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { compile } from "../src/index.js";
import * as compatibility from "../src/ir/lower.js";
import * as generic from "../src/ir/lower-generic.js";
import * as wasm from "../src/ir/backend/wasm-lowering.js";
import { emitConstInstr } from "../src/ir/backend/wasm-constants.js";
import type { IrLowerResolver } from "../src/ir/backend/lower-contracts.js";
import { WasmGcEmitter } from "../src/ir/backend/wasmgc-emitter.js";
import { BytecodeEmitter, BytecodeSink, BytecodeTypeConverter } from "../src/ir/backend/bytecode-emitter.js";
import { runSink } from "../src/ir/backend/bytecode-vm.js";
import { irRuntimeFuncRef } from "../src/ir/callable-bindings.js";
import { asBlockId, asValueId, irVal, type IrFunction, type IrInstr } from "../src/ir/nodes.js";
import type { Instr, ValType } from "../src/ir/types.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

const repository = resolve(import.meta.dirname, "..");
const genericPath = "src/ir/lower-generic.ts";
const forbidden = [
  "src/ir/lower.ts",
  "src/ir/backend/wasm-lowering.ts",
  "src/ir/backend/wasmgc-emitter.ts",
  "src/ir/backend/linear-emitter.ts",
];
const identities = createTestIrFunctionIdentityFactory("issue-3518-lowering-cycle");
const F64 = irVal({ kind: "f64" });
const text = (path: string) => readFileSync(resolve(repository, path), "utf8");
const parse = (path: string, source = text(path)) => {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  if ((file as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length) {
    throw new Error("unparsed dependency: " + path);
  }
  return file;
};

// Bounded literal value-import projection, not a callback/type-graph or IR
// retirement proof. Nonliteral, external and unresolved loads fail closed.
function valueClosure(overrides = new Map<string, string>()) {
  const visited = new Set<string>();
  const edges: string[] = [];
  const visit = (path: string) => {
    if (forbidden.includes(path)) throw new Error("reverse dependency: " + path);
    if (visited.has(path)) return;
    visited.add(path);
    const file = parse(path, overrides.get(path) ?? text(path));
    const follow = (specifier: ts.Node | undefined) => {
      if (!specifier || !ts.isStringLiteralLike(specifier)) throw new Error("unknown dependency: " + path);
      if (!specifier.text.startsWith(".")) throw new Error("external dependency: " + specifier.text);
      const stem = resolve(repository, dirname(path), specifier.text);
      const target = [stem.replace(/\.js$/, ".ts"), stem, resolve(stem, "index.ts")].find(
        (candidate) => overrides.has(relative(repository, candidate)) || existsSync(candidate),
      );
      if (!target) throw new Error("unresolved dependency: " + specifier.text);
      const next = relative(repository, target);
      edges.push(path + " -> " + next);
      visit(next);
    };
    const walk = (node: ts.Node) => {
      if (ts.isImportDeclaration(node)) {
        const clause = node.importClause;
        if (!clause) follow(node.moduleSpecifier);
        else if (!clause.isTypeOnly) {
          const bindings = clause.namedBindings;
          if (
            clause.name ||
            !bindings ||
            !ts.isNamedImports(bindings) ||
            bindings.elements.some((e) => !e.isTypeOnly)
          ) {
            follow(node.moduleSpecifier);
          }
        }
      } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && !node.isTypeOnly) {
        if (
          !node.exportClause ||
          !ts.isNamedExports(node.exportClause) ||
          node.exportClause.elements.some((e) => !e.isTypeOnly)
        ) {
          follow(node.moduleSpecifier);
        }
      } else if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === "require"))
      ) {
        follow(node.arguments[0]);
      } else if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly) {
        if (!ts.isExternalModuleReference(node.moduleReference)) throw new Error("unknown dependency: " + path);
        follow(node.moduleReference.expression);
      }
      ts.forEachChild(node, walk);
    };
    walk(file);
  };
  visit(genericPath);
  return { modules: [...visited].sort(), edges };
}

function constant(value: Extract<IrInstr, { kind: "const" }>["value"]): Extract<IrInstr, { kind: "const" }> {
  return { kind: "const", value, result: asValueId(0), resultType: F64 };
}

function constantFunction(): IrFunction {
  return {
    ...identities.next("answer"),
    params: [],
    resultTypes: [F64],
    blocks: [
      {
        id: asBlockId(0),
        blockArgs: [],
        blockArgTypes: [],
        instrs: [constant({ kind: "f64", value: 42 })],
        terminator: { kind: "return", values: [asValueId(0)] },
      },
    ],
    valueCount: 1,
    exported: true,
  };
}

function resolver(events: string[] = []): IrLowerResolver {
  return {
    resolveFunc: () => {
      events.push("call");
      return 7;
    },
    resolveGlobal: () => {
      throw new Error("unexpected global");
    },
    resolveType: () => {
      throw new Error("unexpected type");
    },
    resolveParamPhysicalType: () => {
      events.push("parameter");
      return undefined;
    },
    internFuncType: () => {
      events.push("intern");
      return 11;
    },
  };
}

describe("lowering cycle separation", () => {
  it("retains all eight public function objects, with no facade implementations", () => {
    const owners = {
      lowerIrFunctionBody: generic.lowerIrFunctionBody,
      lowerIrTypeToValType: generic.lowerIrTypeToValType,
      bufferHasBrLabel: generic.bufferHasBrLabel,
      collectForOfBodyUses: generic.collectForOfBodyUses,
      wasmValueTypeConverter: wasm.wasmValueTypeConverter,
      projectIrFunctionSignature: wasm.projectIrFunctionSignature,
      lowerIrFunctionToWasm: wasm.lowerIrFunctionToWasm,
      emitConstInstr,
    };
    expect(Object.keys(compatibility).sort()).toEqual(Object.keys(owners).sort());
    for (const name of Object.keys(owners) as (keyof typeof owners)[]) expect(compatibility[name]).toBe(owners[name]);
    const file = parse("src/ir/lower.ts");
    expect(file.statements.length).toBe(4);
    for (const statement of file.statements) {
      expect(ts.isExportDeclaration(statement) && !!statement.exportClause && !!statement.moduleSpecifier).toBe(true);
    }
  });

  it("keeps generic emitter/converter arguments required and the public Wasm default optional", () => {
    const file = parse(genericPath);
    for (const name of ["lowerIrFunctionBody", "projectIrFunctionSignatureWithConverter"]) {
      const declaration = file.statements.find(
        (s) => ts.isFunctionDeclaration(s) && s.name?.text === name,
      ) as ts.FunctionDeclaration;
      expect(declaration.parameters).toHaveLength(4);
      for (const parameter of declaration.parameters) {
        expect(parameter.questionToken).toBeUndefined();
        expect(parameter.initializer).toBeUndefined();
      }
    }
    const wrapper = parse("src/ir/backend/wasm-lowering.ts").statements.find(
      (s) => ts.isFunctionDeclaration(s) && s.name?.text === "lowerIrFunctionToWasm",
    ) as ts.FunctionDeclaration;
    expect(wrapper.parameters).toHaveLength(3);
    expect(wrapper.parameters[2].initializer?.getText()).toBe("new WasmGcEmitter(resolver)");
    for (const path of ["src/ir/backend/lower-contracts.ts", "src/ir/backend/wasm-constants.ts"]) {
      for (const statement of parse(path).statements) {
        if (ts.isImportDeclaration(statement)) expect(statement.importClause?.isTypeOnly).toBe(true);
      }
    }
  });

  it("resolves the real transitive value graph without a wrapper/emitter/facade cycle", () => {
    const graph = valueClosure();
    expect(graph.modules).toHaveLength(17);
    expect(graph.edges).toHaveLength(19);
    expect(graph.modules).toContain("src/shared/contracts/identity-values.ts");
    expect(graph.edges.filter((edge) => edge.startsWith(genericPath + " -> "))).toHaveLength(12);
  });

  it.each(forbidden)("rejects an injected reverse edge through a barrel to %s", (target) => {
    const barrel = "src/ir/lowering-test-barrel.ts";
    const targetSpecifier = "./" + relative("src/ir", target).replace(/\.ts$/, ".js");
    expect(() =>
      valueClosure(
        new Map([
          [genericPath, text(genericPath) + '\nimport "./lowering-test-barrel.js";'],
          [barrel, "export * from " + JSON.stringify(targetSpecifier) + ";"],
        ]),
      ),
    ).toThrow("reverse dependency: " + target);
  });

  it.each([
    ["import(pathFromCaller);", "unknown dependency"],
    ['import("node:fs");', "external dependency"],
    ['import("./missing-lowering-module.js");', "unresolved dependency"],
    ["export {", "unparsed dependency"],
  ])("refuses unsupported graph input %s", (injection, error) => {
    expect(() => valueClosure(new Map([[genericPath, text(genericPath) + "\n" + injection]]))).toThrow(error);
  });

  it("lowers a nonempty body in a fresh process that refuses every concrete/wrapper import", () => {
    const allowed = valueClosure().modules;
    const script = `
      import assert from 'node:assert/strict';
      import { registerHooks } from 'node:module';
      import { realpathSync } from 'node:fs';
      import { relative, resolve } from 'node:path';
      import { fileURLToPath, pathToFileURL } from 'node:url';
      const root = realpathSync(process.cwd());
      const allowed = new Set(${JSON.stringify(allowed)});
      const visited = new Set();
      registerHooks({ resolve(specifier, context, next) {
        const result = next(specifier, context);
        if (result.url.startsWith('data:')) return result;
        if (!result.url.startsWith('file:')) throw new Error('forbidden load: ' + result.url);
        const path = relative(root, realpathSync(fileURLToPath(result.url)));
        if (!allowed.has(path)) throw new Error('forbidden load: ' + path);
        visited.add(path);
        return result;
      }});
      const { lowerIrFunctionBody } = await import('./src/ir/lower-generic.ts');
      const fn = ${JSON.stringify(constantFunction())};
      const emitter = {
        backend: 'bytecode', newSink: () => ({ ops: [] }),
        emitConst: (instr, name, out) => out.ops.push(instr.value.value),
        emitReturn: out => out.ops.push('return'),
      };
      const resolver = { resolveFunc() { throw Error('func'); }, resolveGlobal() { throw Error('global'); },
        resolveType() { throw Error('type'); }, internFuncType() { throw Error('intern'); } };
      const lowered = lowerIrFunctionBody(fn, resolver, emitter, { backend: 'bytecode', convertType: () => ['number'] });
      assert.deepEqual(lowered.body.ops, [42, 'return']);
      assert.deepEqual(lowered.results, [['number']]);
      for (const path of ${JSON.stringify(forbidden)}) {
        const injected = 'data:text/javascript,' + encodeURIComponent('import ' + JSON.stringify(pathToFileURL(resolve(root, path)).href));
        await assert.rejects(import(injected), /forbidden load:/);
      }
      console.log(JSON.stringify({ visited: [...visited].sort(), ops: lowered.body.ops }));
    `;
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: repository,
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(child.error).toBeUndefined();
    expect(child.signal).toBeNull();
    expect(child.status, child.stderr + child.stdout).toBe(0);
    const result = JSON.parse(child.stdout);
    expect(result.visited).toContain(genericPath);
    expect(result.visited.length).toBeGreaterThan(1);
    expect(result.ops).toEqual([42, "return"]);
  });

  it.each([
    [
      { kind: "i32", value: -2147483648 },
      { op: "i32.const", value: -2147483648 },
    ],
    [
      { kind: "i64", value: -9223372036854775808n },
      { op: "i64.const", value: -9223372036854775808n },
    ],
    [
      { kind: "f32", value: -0 },
      { op: "f32.const", value: -0 },
    ],
    [
      { kind: "f32", value: NaN },
      { op: "f32.const", value: NaN },
    ],
    [
      { kind: "f64", value: -0 },
      { op: "f64.const", value: -0 },
    ],
    [
      { kind: "f64", value: NaN },
      { op: "f64.const", value: NaN },
    ],
    [
      { kind: "bool", value: true },
      { op: "i32.const", value: 1 },
    ],
    [
      { kind: "bool", value: false },
      { op: "i32.const", value: 0 },
    ],
  ] as const)("preserves scalar constant case %#", (value, expected) => {
    const out: Instr[] = [];
    emitConstInstr(constant(value), out, "constant");
    expect(out).toEqual([expected]);
  });

  it("preserves exact constant failures and the emitter's separate typed-null path", () => {
    const out: Instr[] = [];
    expect(() => emitConstInstr(constant({ kind: "null" }), out, "nullish")).toThrow(
      "ir/lower: const null must be emitted through BackendEmitter.emitNull (nullish)",
    );
    expect(() => emitConstInstr(constant({ kind: "undefined" }), out, "nullish")).toThrow(
      "ir/lower: Phase 1 does not materialize 'undefined' constants (nullish)",
    );
    expect(out).toEqual([]);
    new WasmGcEmitter(resolver()).emitConst(
      { ...constant({ kind: "null" }), resultType: irVal({ kind: "externref" }) },
      "nullish",
      out,
    );
    expect(out).toEqual([{ op: "ref.null.extern" }]);
  });

  it("keeps default/explicit Wasm wrappers equivalent and signature projection body-free", () => {
    const fn: IrFunction = {
      ...constantFunction(),
      params: [{ name: "arg", type: F64, value: asValueId(1) }],
      valueCount: 2,
      blocks: [
        {
          id: asBlockId(0),
          blockArgs: [],
          blockArgTypes: [],
          instrs: [
            {
              kind: "call",
              target: irRuntimeFuncRef("provider"),
              args: [asValueId(1)],
              result: asValueId(0),
              resultType: F64,
            },
          ],
          terminator: { kind: "return", values: [asValueId(0)] },
        },
      ],
    };
    const events: string[] = [];
    const defaultResult = wasm.lowerIrFunctionToWasm(fn, resolver(events));
    expect(events.at(-1)).toBe("intern");
    expect(events.indexOf("call")).toBeLessThan(events.lastIndexOf("parameter"));
    const explicitResolver = resolver();
    expect(wasm.lowerIrFunctionToWasm(fn, explicitResolver, new WasmGcEmitter(explicitResolver))).toEqual(
      defaultResult,
    );
    events.length = 0;
    expect(wasm.projectIrFunctionSignature(fn, resolver(events))).toEqual({
      params: [{ name: "arg", slots: [{ kind: "f64" }] }],
      results: [[{ kind: "f64" }]],
    });
    expect(events).toEqual(["parameter"]);
  });

  it("retains foreign sinks, slot grouping and loud contract mismatch/empty-slot failures", () => {
    const fn = constantFunction();
    const emitter = new BytecodeEmitter();
    const lowered = generic.lowerIrFunctionBody(fn, resolver(), emitter, new BytecodeTypeConverter());
    expect(lowered.body).toBeInstanceOf(BytecodeSink);
    expect(lowered.results).toEqual([["number"]]);
    expect(runSink(lowered.body, [])).toBe(42);
    const pair = generic.lowerIrFunctionBody(fn, resolver(), emitter, {
      backend: "bytecode",
      convertType: () => ["lo", "hi"],
    });
    expect(pair.results).toEqual([["lo", "hi"]]);
    expect(() =>
      generic.lowerIrFunctionBody(fn, resolver(), emitter, { backend: "wasmgc", convertType: () => ["number"] }),
    ).toThrow("backend contract mismatch");
    expect(() =>
      generic.lowerIrFunctionBody(fn, resolver(), emitter, { backend: "bytecode", convertType: () => [] }),
    ).toThrow("type converter produced no slots");
  });

  it("assembles multi-slot Wasm names and preserves the sink object at the wrapper seam", () => {
    const body: Instr[] = [{ op: "unreachable" }];
    const types: ValType[] = [{ kind: "i32" }, { kind: "f64" }];
    const spy = vi.spyOn(generic, "lowerIrFunctionBody").mockReturnValue({
      name: "pair",
      body,
      params: [{ name: "arg", slots: types }],
      locals: [{ name: "scratch", slots: types }],
      results: [types],
      exported: true,
    });
    try {
      const seen: unknown[] = [];
      const result = wasm.lowerIrFunctionToWasm(constantFunction(), {
        ...resolver(),
        internFuncType: (type) => {
          seen.push(type);
          return 9;
        },
      });
      expect(spy).toHaveBeenCalledOnce();
      expect(result.func.body).toBe(body);
      expect(result.func.locals).toEqual([
        { name: "scratch", type: types[0] },
        { name: "scratch$1", type: types[1] },
      ]);
      expect(seen).toEqual([{ kind: "func", params: types, results: types }]);
      expect(result.func.typeIdx).toBe(9);
    } finally {
      spy.mockRestore();
    }
  });

  it("executes standalone scalar branches and loops through the unchanged public compiler", async () => {
    const result = await compile(
      "export function branch(a: number): number { if (a > 0) return a + 2; return a - 2; }" +
        "export function loop(n: number): number { let total = 0; for (let i = 0; i < n; i++) total += i; return total; }",
      { fileName: "lowering-cycle.ts", target: "standalone", experimentalIR: true, trackIrOutcomes: true },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect(result.irCompiledFuncs).toEqual(expect.arrayContaining(["branch", "loop"]));
    const module = await WebAssembly.compile(result.binary);
    expect(WebAssembly.Module.imports(module)).toEqual([]);
    const instance = await WebAssembly.instantiate(module, {});
    const branch = instance.exports.branch as (a: number) => number;
    const loop = instance.exports.loop as (n: number) => number;
    expect([branch(5), branch(0), branch(-5)]).toEqual([7, -2, -7]);
    expect([loop(0), loop(1), loop(5)]).toEqual([0, 0, 10]);
  });
});
