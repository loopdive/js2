// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { beforeAll, describe, expect, it, vi } from "vitest";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import { encodePreparedIrProgram, decodePreparedIrProgram } from "../src/ir/program-codec.js";
import { sourceInput, requireProgram } from "./helpers/typed-program-fixtures.js";
import { nativePreparedFrameKernel } from "./helpers/native-prepared-frame-kernel.js";
import { emitBinary } from "../src/emit/binary.js";
import type { PreparedNativeAsyncFrameInput } from "../src/ir/program/prepared-native-async-frame-plan.js";
import { fillPreparedNativeAsyncFrame } from "../src/backend/wasmgc/resources/prepared-native-async-frame.js";

const policy = {
  backend: "wasmgc",
  target: "standalone",
  stringConst: { storage: "native" },
  stringConcat: { concat: "native" },
  numberBoundary: { box: "native", unbox: "native" },
} as const;
const sources = {
  two: "export async function run(seed:number):Promise<number>{const first=await seed; const second=await first; return second;}",
  live: "export async function run(seed:number, other:number):Promise<number>{const first=await seed; await other; return first;}",
};
const programs = new Map<string, ReturnType<typeof requireProgram>>();
beforeAll(() => {
  vi.stubEnv("JS2WASM_IR_GVN", "0");
  try {
    for (const [name, source] of Object.entries(sources))
      programs.set(name, requireProgram(prepareWholeIrProgram({ ...sourceInput({ "./entry.ts": source }), policy })));
  } finally {
    vi.unstubAllEnvs();
  }
});
function input(name = "two", replay = false): PreparedNativeAsyncFrameInput {
  const original = programs.get(name)!;
  const program = replay ? decodePreparedIrProgram(encodePreparedIrProgram(original)) : original;
  return {
    fn: program.runtime[0]!.prepared.functions.find((f) => f.name === "run")!,
    backend: "wasmgc",
    target: "standalone",
    abiEntries: program.abi.entries,
    anchor: program.inventory.sources.find((s) => s.kind === "entry")!,
    declarationOrderStart: Math.max(...program.abi.entries.map((row) => row.plan.order.declarationOrder)) + 1,
  };
}
async function execute(name: string, replay: boolean) {
  const h = nativePreparedFrameKernel(undefined, input(name, replay));
  h.publish();
  const bytes = Uint8Array.from(emitBinary(h.module));
  const compiled = await WebAssembly.compile(bytes.buffer);
  expect(WebAssembly.Module.imports(compiled)).toEqual([]);
  const { exports } = await WebAssembly.instantiate(compiled, {});
  return { exports: exports as Record<string, CallableFunction>, bytes };
}
describe("source-owned native async frame materialization (kernel integration)", () => {
  it.each([false, true])("executes two genuine awaits, replay=%s", async (replay) => {
    const { exports: e } = await execute("two", replay);
    const values = [7, 7.25, -0, NaN, Infinity, -Infinity, 2 ** 40, ...Array.from({ length: 12 }, (_, i) => i)];
    const pending = values.map((value) => e.run!(value));
    expect(pending.map((p) => e.state!(p))).toEqual(values.map(() => 0));
    e.drain!();
    expect(pending.map((p) => e.state!(p))).toEqual(values.map(() => 1));
    pending.forEach((p, i) => expect(e.number!(e.value!(p))).toBe(values[i]));
  });
  it.each([false, true])("preserves a live first await across a different second await, replay=%s", async (replay) => {
    const { exports: e } = await execute("live", replay);
    const p = e.run!(17.25, 999);
    e.drain!();
    expect(e.state!(p)).toBe(1);
    expect(e.number!(e.value!(p))).toBe(17.25);
  });
  it("emits identical source bodies after codec replay", async () => {
    expect((await execute("live", true)).bytes).toEqual((await execute("live", false)).bytes);
  });
  it("rejects a foreign ledger dependency before filling frame bodies", () => {
    const a = nativePreparedFrameKernel(undefined, input()),
      b = nativePreparedFrameKernel(undefined, input());
    expect(() =>
      fillPreparedNativeAsyncFrame(a.tx, a.sourceFrame!, { ...a.dependencies, enqueue: b.dependencies.enqueue }),
    ).toThrow();
    expect(a.sourceFrame!.entry.object.body).toEqual([]);
    expect(a.sourceFrame!.resume.object.body).toEqual([]);
  });
  it("rejects a wrong bridge signature before filling frame bodies", () => {
    const h = nativePreparedFrameKernel(undefined, input());
    const bridges = new Map(h.dependencies.bridges);
    bridges.set("number.box", bridges.get("number.unbox")!);
    expect(() => fillPreparedNativeAsyncFrame(h.tx, h.sourceFrame!, { ...h.dependencies, bridges })).toThrow(
      "signature mismatch",
    );
    expect(h.sourceFrame!.entry.object.body).toEqual([]);
  });
  it("honors rejected parent acceptance before filling frame bodies", () => {
    const h = nativePreparedFrameKernel(undefined, input());
    expect(() =>
      fillPreparedNativeAsyncFrame(h.tx, h.sourceFrame!, {
        ...h.dependencies,
        assertAccepted() {
          throw Error("inventory incomplete");
        },
      }),
    ).toThrow("inventory incomplete");
    expect(h.sourceFrame!.entry.object.body).toEqual([]);
  });
  it("rejects a same-ledger carrier with the wrong reaction layout", () => {
    const h = nativePreparedFrameKernel(undefined, input());
    expect(() =>
      fillPreparedNativeAsyncFrame(h.tx, h.sourceFrame!, { ...h.dependencies, reaction: h.dependencies.promise }),
    ).toThrow("wrong native reaction layout");
    expect(h.sourceFrame!.entry.object.body).toEqual([]);
  });
  it("rejects dependency substitution during acceptance revalidation", () => {
    const h = nativePreparedFrameKernel(undefined, input());
    const bridges = new Map(h.dependencies.bridges);
    let calls = 0;
    const dependencies = {
      ...h.dependencies,
      bridges,
      assertAccepted() {
        if (++calls === 2) bridges.set("number.box", bridges.get("number.unbox")!);
      },
    };
    expect(() => fillPreparedNativeAsyncFrame(h.tx, h.sourceFrame!, dependencies)).toThrow(
      "changed dependency association",
    );
    expect(h.sourceFrame!.entry.object.body).toEqual([]);
  });
  it("rejects a changed frame layout before filling", () => {
    const h = nativePreparedFrameKernel(undefined, input());
    const frame = h.sourceFrame!.frame.object;
    if (frame.kind !== "struct") throw Error("expected frame struct");
    frame.fields[0]!.mutable = false;
    expect(() => fillPreparedNativeAsyncFrame(h.tx, h.sourceFrame!, h.dependencies)).toThrow();
    expect(h.sourceFrame!.entry.object.body).toEqual([]);
  });
});
