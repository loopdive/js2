// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import type { StringBackendEmitter } from "../src/ir/backend/string-contract.js";
import type { IrLowerResolver } from "../src/ir/backend/lower-contracts.js";
import { WasmGcEmitter } from "../src/ir/backend/wasmgc-emitter.js";
import { wasmValueTypeConverter } from "../src/ir/backend/wasm-lowering.js";
import type { AllocSiteId, IrFuncRef, IrGlobalRef, IrValueId, IrFunction } from "../src/ir/core/nodes.js";
import type { IrBindingId } from "../src/shared/contracts/ir-identity.js";
import type { Instr } from "../src/wasm/model/instructions.js";
import { lowerIrFunctionBody } from "../src/ir/lower-generic.js";
import * as strings from "../src/ir/lowering/string-operations.js";
import type { StringOperation, StringOperationContext } from "../src/ir/lowering/string-operations.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

const root = resolve(import.meta.dirname, "..");
const ids = createTestIrFunctionIdentityFactory("issue-6865-lowering-string-operations");
const value = (n: number) => n as IrValueId;
const alloc = 37 as AllocSiteId;
const provider: IrFuncRef = { kind: "func", name: "prepared", binding: { kind: "runtime", symbol: "prepared" } };
const materializer: IrFuncRef = { kind: "func", name: "large", binding: { kind: "runtime", symbol: "large" } };
const storage: IrGlobalRef = {
  kind: "global",
  name: "literal",
  binding: { kind: "support", bindingId: "literal" as IrBindingId },
};
const lengthProvider = { kind: "callable" as const, target: provider };
const base = { result: value(3), resultType: { kind: "string" as const }, alloc };
const operations: readonly StringOperation[] = [
  { ...base, kind: "string.const", value: "\ud800", storage },
  { ...base, kind: "string.concat", lhs: value(0), rhs: value(1), concatMode: "owned-append", provider },
  {
    ...base,
    kind: "string.repeat",
    value: value(0),
    count: value(1),
    encodingEvidence: "wtf16",
    provider,
    countedStringAppendTripCount: 7,
  },
  {
    ...base,
    kind: "string.eq",
    lhs: value(0),
    rhs: value(1),
    negate: true,
    provider,
    resultType: { kind: "val", val: { kind: "i32" } },
  },
  {
    ...base,
    kind: "string.len",
    value: value(0),
    inputEncoding: "ascii",
    provider: lengthProvider,
    resultType: { kind: "val", val: { kind: "f64" } },
  },
  {
    ...base,
    kind: "string.char_at",
    value: value(0),
    index: value(1),
    inputEncoding: "utf8-guaranteed",
    encodingEvidence: "wtf16",
    provider,
  },
  {
    ...base,
    kind: "string.char_code_at",
    value: value(0),
    index: value(1),
    inputEncoding: "wtf16",
    provider,
    resultType: { kind: "val", val: { kind: "f64" } },
  },
];
const operandOrder = [[], [0, 1], [0, 1], [0, 1], [0], [0, 1], [0, 1]];
const terminals = ["const", "concat", "repeat", "equals", "length", "charAt", "charCodeAt"];
type Trace = { operands: number[]; terminal?: { name: string; args: unknown[] } };
function tracing() {
  const out: Trace = { operands: [] };
  const receivers: unknown[] = [];
  const emit = (receiver: unknown, name: string, args: unknown[], sink: Trace) => {
    receivers.push(receiver);
    expect(sink).toBe(out);
    expect(sink.terminal).toBeUndefined();
    sink.terminal = { name, args };
  };
  const emitter: StringBackendEmitter<Trace> = {
    emitStringConst(v, a, sink, s, m) {
      emit(this, "const", [v, a, s, m], sink);
    },
    emitStringConcat(a, mode, sink, p) {
      emit(this, "concat", [a, mode, p], sink);
    },
    emitStringRepeat(a, encoding, sink, p, count) {
      emit(this, "repeat", [a, encoding, p, count], sink);
    },
    emitStringEquals(negate, sink, p) {
      emit(this, "equals", [negate, p], sink);
    },
    emitStringLength(encoding, sink, p) {
      emit(this, "length", [encoding, p], sink);
    },
    emitStringCharAt(a, encoding, sink, p) {
      emit(this, "charAt", [a, encoding, p], sink);
    },
    emitStringCharCodeAt(encoding, sink, p) {
      emit(this, "charCodeAt", [encoding, p], sink);
    },
  };
  const ctx: StringOperationContext<Trace> = {
    emitter,
    emitValue(v, sink) {
      expect(sink).toBe(out);
      expect(sink.terminal).toBeUndefined();
      sink.operands.push(v);
    },
  };
  return { ctx, out, receivers };
}

describe("IR source maps: string operation extraction", () => {
  it.each(operations.map((instr, index) => ({ instr, index })))(
    "preserves operands and evidence for $instr.kind",
    ({ instr, index }) => {
      const { ctx, out, receivers } = tracing();
      strings.emitStringOperation(instr, ctx, out);
      expect(out.operands).toEqual(operandOrder[index]);
      expect(out.terminal?.name).toBe(terminals[index]);
      expect(receivers).toEqual([ctx.emitter]);
      const expected = [
        ["\ud800", alloc, storage, undefined],
        [alloc, "owned-append", provider],
        [alloc, "wtf16", provider, 7],
        [true, provider],
        ["ascii", lengthProvider],
        [alloc, "utf8-guaranteed", provider],
        ["wtf16", provider],
      ][index]!;
      expect(out.terminal?.args).toHaveLength(expected.length);
      expected.forEach((arg, n) => expect(out.terminal?.args[n]).toBe(arg));
    },
  );

  it("retains absent evidence and immutable concat default without selecting a provider", () => {
    const { ctx, out } = tracing();
    strings.emitStringOperation({ ...base, kind: "string.concat", lhs: value(0), rhs: value(1) }, ctx, out);
    expect(out.terminal?.args).toEqual([alloc, "immutable", undefined]);
    const literal = tracing();
    strings.emitStringOperation(
      { ...base, kind: "string.const", value: "large", materializer },
      literal.ctx,
      literal.out,
    );
    expect(literal.out.terminal?.args[2]).toBeUndefined();
    expect(literal.out.terminal?.args[3]).toBe(materializer);
  });

  it("does not emit the terminal or later operands after an operand throws", () => {
    const { ctx, out } = tracing();
    const failure = new Error("operand failed");
    const throwing = {
      emitter: ctx.emitter,
      emitValue(v: IrValueId, sink: Trace) {
        sink.operands.push(v);
        throw failure;
      },
    };
    expect(() => strings.emitStringOperation(operations[1]!, throwing, out)).toThrow(failure);
    expect(out.operands).toEqual([0]);
    expect(out.terminal).toBeUndefined();
  });

  // Real lowerer and WasmGC terminal routing; injected recipes deliberately do
  // not claim native string semantics or public prepared-owner qualification.
  it.each(operations)("routes $kind through the root helper and real emitter once", (instr) => {
    const resolver: IrLowerResolver = {
      resolveFunc: () => 0,
      resolveGlobal: () => 0,
      resolveType: () => 0,
      internFuncType: () => 0,
      resolveString: () => ({ kind: "externref" }),
      emitStringConst: () => [{ op: "ref.null.extern" }],
      emitStringConcat: () => [{ op: "call", funcIdx: 40 }],
      emitStringRepeat: () => [{ op: "call", funcIdx: 41 }],
      emitStringEquals: () => [{ op: "call", funcIdx: 42 }],
      emitStringLen: () => [{ op: "call", funcIdx: 43 }],
      emitStringCharAt: () => [{ op: "call", funcIdx: 44 }],
      emitStringCharCodeAt: () => [{ op: "call", funcIdx: 45 }],
    };
    const fn: IrFunction = {
      unitId: ids.next(instr.kind).unitId,
      name: instr.kind,
      params: [0, 1].map((n) => ({ name: `p${n}`, type: { kind: "string" as const }, value: value(n) })),
      resultTypes: [instr.resultType!],
      exported: false,
      valueCount: 4,
      funcKind: "regular",
      blocks: [
        {
          id: 0 as IrFunction["blocks"][number]["id"],
          blockArgs: [],
          blockArgTypes: [],
          instrs: [instr],
          terminator: { kind: "return", values: [value(3)] },
        },
      ],
    };
    const spy = vi.spyOn(strings, "emitStringOperation");
    try {
      const lowered = lowerIrFunctionBody(
        fn,
        resolver,
        new WasmGcEmitter(resolver),
        wasmValueTypeConverter("wasmgc", resolver, fn.name),
      );
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]![0]).toBe(instr);
      expect((lowered.body as Instr[]).length).toBeGreaterThan(0);
      expect(lowered.body.at(-1)?.op).toBe("return");
    } finally {
      spy.mockRestore();
    }
  });

  it("preserves the real emitter refusal when the runtime contract is absent", () => {
    const emitter = new WasmGcEmitter();
    const out: Instr[] = [];
    const emitted: IrValueId[] = [];
    expect(() =>
      strings.emitStringOperation(
        operations[1]!,
        {
          emitter,
          emitValue(v) {
            emitted.push(v);
          },
        },
        out,
      ),
    ).toThrow();
    expect(emitted).toEqual([value(0), value(1)]);
    expect(out).toEqual([]);
  });

  it("transpiles the actual generic leaf with no runtime imports", () => {
    const path = "src/ir/lowering/string-operations.ts";
    const source = readFileSync(resolve(root, path), "utf8");
    const result = ts.transpileModule(source, {
      fileName: path,
      reportDiagnostics: true,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, verbatimModuleSyntax: true },
    });
    expect(result.diagnostics).toEqual([]);
    const tree = ts.createSourceFile(path, result.outputText, ts.ScriptTarget.Latest, true);
    expect(
      tree.statements.filter((s) => ts.isImportDeclaration(s) || (ts.isExportDeclaration(s) && s.moduleSpecifier)),
    ).toEqual([]);
    expect(result.outputText).toContain("export function emitStringOperation");
  });

  it("loads and exercises the actual leaf in a fresh process with a forbidden-target denial control", () => {
    const script = `
      import assert from 'node:assert/strict';
      import { registerHooks } from 'node:module';
      import { realpathSync } from 'node:fs';
      import { relative } from 'node:path';
      import { fileURLToPath } from 'node:url';
      const root = realpathSync(process.cwd()), visited = new Set();
      const leaf = 'src/ir/lowering/string-operations.ts';
      registerHooks({ resolve(specifier, context, next) {
        const result = next(specifier, context);
        if (!result.url.startsWith('file:')) throw Error('forbidden dependency: ' + result.url);
        const path = relative(root, realpathSync(fileURLToPath(result.url)));
        if (path !== leaf) throw Error('forbidden dependency: ' + path);
        visited.add(path); return result;
      }});
      const generic = await import('./' + leaf);
      assert.deepEqual(Object.keys(generic), ['emitStringOperation']);
      const trace = [], emitter = { emitStringConcat(alloc, mode, out, provider) {
        assert.equal(this, emitter); assert.equal(out, trace); assert.equal(alloc, 37);
        assert.equal(mode, 'immutable'); assert.equal(provider, undefined); out.push('terminal');
      }};
      generic.emitStringOperation({kind:'string.concat', lhs:0, rhs:1, alloc:37},
        {emitter, emitValue(v,out) {out.push(v)}}, trace);
      assert.deepEqual(trace, [0,1,'terminal']);
      await assert.rejects(import('./src/ir/backend/wasmgc-emitter.ts'), /forbidden dependency:/);
      console.log(JSON.stringify([...visited]));
    `;
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: root,
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(child.error).toBeUndefined();
    expect(child.signal).toBeNull();
    expect(child.status, child.stderr + child.stdout).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual(["src/ir/lowering/string-operations.ts"]);
  });
});
