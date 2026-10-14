// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { forEachNestedBuffer, type IrInstr } from "../src/ir/core/nodes.js";
import { irDynamic } from "../src/ir/core/types.js";
import { verifyIrBackendLegality } from "../src/ir/analysis/backend-legality.js";
import {
  issueNativeNumberUndefinedRepresentability,
  assertNativeNumberUndefinedLegalityCurrent,
  nativeNumberUndefinedInstructionIsAdmitted,
  nativeNumberUndefinedTypeIsAdmitted,
  type NativeNumberUndefinedLogicalContext,
} from "../src/ir/analysis/allocation-evidence/native-number-undefined-legality.js";

async function fixture(backend: "wasmgc" | "linear" = "linear") {
  const { analyzeMultiSource } = await import("../src/checker/index.js");
  const { prepareIrProgramSources } = await import("../src/ir/program-source.js");
  const { analyzeNativeNumberUndefined } =
    await import("../src/ir/analysis/allocation-evidence/native-number-undefined-producer.js");
  const ast = analyzeMultiSource(
    { "./entry.ts": "export function run():number{const a=[2];const v=a[99];return v===undefined?1:0;}" },
    "./entry.ts",
  );
  // Genuine mutable source-stage IR and real allocation sites; neutral proof is not a GC program grant.
  const prepared = prepareIrProgramSources({
    sourceFiles: ast.sourceFiles,
    entrySource: ast.entryFile,
    checker: ast.checker,
    policy: { backend: "linear", target: "standalone" },
    deferTopLevelInit: false,
    linearVectorProjection: "native-f64",
  });
  if (prepared.kind !== "prepared") throw Error(JSON.stringify(prepared));
  analyzeNativeNumberUndefined(prepared.ir, prepared.allocations, true);
  const selected = { ...prepared.ir };
  const fn = selected.functions.find((f) => f.blocks.some((b) => b.instrs.some((i) => i.kind === "vec.new_fixed")));
  if (!fn) throw Error("missing genuine numeric-vector unit");
  const context: NativeNumberUndefinedLogicalContext = {
    original: prepared.ir,
    selected,
    registry: prepared.allocations.snapshot(),
    function: fn,
    backend,
  };
  const proof = issueNativeNumberUndefinedRepresentability(context);
  if (!proof) throw Error("positive native representation census was empty");
  const use = { proof, context };
  const all: IrInstr[] = [];
  const visit = (buffer: readonly IrInstr[]) => {
    for (const instr of buffer) {
      all.push(instr);
      forEachNestedBuffer(instr, visit);
    }
  };
  for (const block of context.function.blocks) visit(block.instrs);
  const box = all.find((i): i is Extract<IrInstr, { kind: "box" }> => i.kind === "box");
  if (!box) throw Error("missing actual NumberF64 box");
  return { use, context, box, all };
}

describe("independently issued closed carrier representation proof", () => {
  it.each(["wasmgc", "linear"] as const)("admits only actual checked %s definition fields", async (backend) => {
    const f = await fixture(backend);
    expect(verifyIrBackendLegality(f.context.function, backend, undefined, f.use)).toEqual([]);
    expect(nativeNumberUndefinedInstructionIsAdmitted(f.use, f.context.function, backend, f.box)).toBe(true);
    expect(nativeNumberUndefinedTypeIsAdmitted(f.use, f.context.function, backend, f.box, f.box.toType)).toBe(true);
    expect(nativeNumberUndefinedTypeIsAdmitted(f.use, f.context.function, backend, f.box, { ...f.box.toType })).toBe(
      false,
    );
    expect(nativeNumberUndefinedInstructionIsAdmitted(f.use, f.context.function, backend, { ...f.box })).toBe(false);
  });
  it("does not evaluate an outsider type getter before exact field identity", async () => {
    const f = await fixture();
    let reads = 0;
    const outsider = {
      get kind() {
        reads++;
        return "dynamic";
      },
    };
    expect(nativeNumberUndefinedTypeIsAdmitted(f.use, f.context.function, "linear", f.box, outsider as never)).toBe(
      false,
    );
    expect(reads).toBe(0);
  });
  it("never calls forged noop/caller authority", async () => {
    const f = await fixture();
    let calls = 0;
    const fake = {
      assertFunction() {
        calls++;
      },
      owns() {
        calls++;
        return true;
      },
    };
    expect(() => verifyIrBackendLegality(f.context.function, "linear", undefined, fake as never)).toThrow("own DATA");
    expect(calls).toBe(0);
  });
  it("rejects a copied kind-only proof", async () => {
    const f = await fixture();
    expect(() =>
      assertNativeNumberUndefinedLegalityCurrent({ ...f.use, proof: { ...f.use.proof } }, f.context.function, "linear"),
    ).toThrow("unissued or copied proof");
  });
  it("rejects an executable context accessor without evaluating it", async () => {
    const f = await fixture();
    let calls = 0;
    const fake = {
      proof: f.use.proof,
      get context() {
        calls++;
        return f.context;
      },
    };
    expect(() => assertNativeNumberUndefinedLegalityCurrent(fake, f.context.function, "linear")).toThrow("own DATA");
    expect(calls).toBe(0);
  });
  it("rejects a wrong backend", async () => {
    const f = await fixture("wasmgc");
    expect(() => verifyIrBackendLegality(f.context.function, "linear", undefined, f.use)).toThrow("backend context");
  });
  it("rejects a foreign equal-looking member function", async () => {
    const f = await fixture();
    expect(() => verifyIrBackendLegality({ ...f.context.function }, "linear", undefined, f.use)).toThrow(
      "function/signature",
    );
  });
  it("replays the entire current body, including ordinary arithmetic", async () => {
    const f = await fixture();
    const instr = f.all.find((i) => i.kind === "const" && i.value.kind === "f64");
    if (!instr || instr.kind !== "const") throw Error("missing primitive control");
    (instr as { value: unknown }).value = { kind: "f64", value: 73 };
    expect(() => assertNativeNumberUndefinedLegalityCurrent(f.use, f.context.function, "linear")).toThrow("stale");
  });
  it("rejects equivalent instruction and type replacements", async () => {
    const f = await fixture();
    (f.box as { resultType: unknown }).resultType = { ...f.box.resultType! };
    expect(() => assertNativeNumberUndefinedLegalityCurrent(f.use, f.context.function, "linear")).toThrow(
      "identities changed",
    );
  });
  it("rejects a replacement selected function array", async () => {
    const f = await fixture();
    const use = {
      ...f.use,
      context: { ...f.context, selected: { ...f.context.selected, functions: [...f.context.selected.functions] } },
    };
    expect(() => assertNativeNumberUndefinedLegalityCurrent(use, f.context.function, "linear")).toThrow("stale");
  });
  it("accepts a fresh selected wrapper with the same actual body array", async () => {
    const f = await fixture();
    const use = { ...f.use, context: { ...f.context, selected: { ...f.context.selected } } };
    expect(() => assertNativeNumberUndefinedLegalityCurrent(use, f.context.function, "linear")).not.toThrow();
  });
  it("refuses current signature drift", async () => {
    const f = await fixture();
    (f.context.function as { resultTypes: unknown }).resultTypes = [irDynamic()];
    expect(() => assertNativeNumberUndefinedLegalityCurrent(f.use, f.context.function, "linear")).toThrow("stale");
  });
  it("refuses current allocation/site/type evidence drift", async () => {
    const f = await fixture();
    const live = f.context.registry.entries.find((entry) => entry.state === "live");
    if (!live || live.state !== "live") throw Error("missing real live allocation control");
    (live.site as { type: unknown }).type = irDynamic();
    expect(() => assertNativeNumberUndefinedLegalityCurrent(f.use, f.context.function, "linear")).toThrow("stale");
  });
  it("does not issue a dynamic public parameter or result proof", async () => {
    const f = await fixture();
    (f.context.function as { resultTypes: unknown }).resultTypes = [irDynamic()];
    expect(() => issueNativeNumberUndefinedRepresentability(f.context)).toThrow();
  });
  it("requires actual independent ownership and escape namespaces", async () => {
    const f = await fixture();
    (f.context.registry as { metadata: unknown }).metadata = [];
    expect(() => issueNativeNumberUndefinedRepresentability(f.context)).toThrow("ownership and escape");
  });
  it("refuses a foreign namespace without relying on a program validation prelude", async () => {
    const f = await fixture();
    const row = f.context.registry.metadata.find((entry) => entry.entries.length > 0);
    if (!row) throw Error("missing real namespace positive control");
    (row.entries as unknown as [string, unknown][]).push(["foreign-proof-namespace", { admitted: true }]);
    expect(() => issueNativeNumberUndefinedRepresentability(f.context)).toThrow();
  });
  it("rejects malformed context DATA before independent inspection", () => {
    expect(() => issueNativeNumberUndefinedRepresentability({} as never)).toThrow("context fields");
  });
});
