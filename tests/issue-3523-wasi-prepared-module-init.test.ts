// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#3523 R4 gap 3) Behavior pin for the WASI module-init shapes the prepared
 * exact-lexical selector admits.
 *
 * WASI is the last cell in the 12-cell R4 census still emitting a direct
 * (legacy) module-init body, and the mechanism that makes its `__module_init`
 * safe is `applyModuleInitGuard` — a POST-EMISSION splice that mints the
 * `__init_done` global, prepends an idempotence prologue to `__module_init`,
 * and prepends `call __module_init` to every other export. Gap 3 relocates
 * that splice into invocation-policy-driven prepared emission.
 *
 * The relocation has to be measured against a behavior pin rather than
 * self-certify, and the test probe found NO such pin for any shape the
 * selector admits: `issue-1789` uses an object-literal `valueOf` population,
 * `issue-1411` a plain-literal assignment and `issue-4376` an Unsupported
 * shape — all three stay on the legacy lane. This file pins the observable
 * contract for the ADMITTED grammar (initialized top-level lexical
 * declarations, optionally followed by exact scalar self-assignments):
 *
 *   α — a direct export call with no `_start` sees initialized state;
 *   β — `_start()` then an export initializes exactly once;
 *   γ — two distinct exports initialize exactly once between them.
 *
 * These must hold identically before and after the mechanism moves.
 */
import { describe, expect, it, vi } from "vitest";
import { analyzeSource } from "../src/checker/index.js";
import { generateModule } from "../src/codegen/index.js";
import { definedFuncAt } from "../src/codegen/func-space.js";
import { ProgramAbiExportRegistry } from "../src/codegen/program-abi-export-planning.js";
import type { CodegenContext } from "../src/codegen/context/types.js";
import { compile } from "../src/index.js";

// Register the codegen expression/statement delegates used by generateModule.
import "../src/codegen/expressions.js";

/** Shape (b) of the R4 census: one initialized top-level lexical binding. */
const SHAPE_B = `let v = 7;
export function test(): number { return v; }`;

/** Shape (c): a lexical declaration plus an exact scalar self-assignment. */
const SHAPE_C = `let total = 0;
total = total + 1;
export function test(): number { return total; }`;

/** Shape (c) with two distinct exported readers of the same init state. */
const SHAPE_C_TWO_EXPORTS = `let total = 0;
total = total + 1;
export function readA(): number { return total; }
export function readB(): number { return total; }`;

async function instantiateWasi(src: string): Promise<{
  exports: Record<string, unknown>;
  exportNames: readonly string[];
}> {
  const r = await compile(src, { fileName: "test.ts", target: "wasi" });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  // Empty import object — a genuine standalone instantiation, exactly as the
  // test262 standalone harness does it.
  const { instance } = await WebAssembly.instantiate(r.binary!, {});
  const exports = instance.exports as Record<string, unknown>;
  return { exports, exportNames: Object.keys(exports) };
}

describe("#3523 gap 3 — WASI module init for the prepared-admitted grammar", () => {
  it("α shape (b): a direct export call without _start sees the initialized binding", async () => {
    const { exports } = await instantiateWasi(SHAPE_B);
    expect((exports.test as () => number)()).toBe(7);
  });

  it("α shape (c): a direct export call without _start sees the assigned value", async () => {
    const { exports } = await instantiateWasi(SHAPE_C);
    expect((exports.test as () => number)()).toBe(1);
  });

  it("β shape (c): _start() then an export initializes exactly once", async () => {
    const { exports } = await instantiateWasi(SHAPE_C);
    expect(typeof exports._start).toBe("function");
    (exports._start as () => void)();
    // A second init would run `total = total + 1` again and read 2.
    expect((exports.test as () => number)()).toBe(1);
  });

  it("β shape (c): repeated _start() calls still initialize exactly once", async () => {
    const { exports } = await instantiateWasi(SHAPE_C);
    (exports._start as () => void)();
    (exports._start as () => void)();
    expect((exports.test as () => number)()).toBe(1);
  });

  it("γ shape (c): two distinct exports initialize exactly once between them", async () => {
    const { exports } = await instantiateWasi(SHAPE_C_TWO_EXPORTS);
    expect((exports.readA as () => number)()).toBe(1);
    expect((exports.readB as () => number)()).toBe(1);
    // And in the other order, on a fresh instance.
    const second = await instantiateWasi(SHAPE_C_TWO_EXPORTS);
    expect((second.exports.readB as () => number)()).toBe(1);
    expect((second.exports.readA as () => number)()).toBe(1);
  });

  it("publishes `_start` and never a `__module_init` export alias", async () => {
    for (const src of [SHAPE_B, SHAPE_C, SHAPE_C_TWO_EXPORTS]) {
      const { exportNames } = await instantiateWasi(src);
      expect(exportNames).toContain("_start");
      expect(exportNames).not.toContain("__module_init");
    }
  });

  it("wires no wasm start section — `_start` is the sole WASI startup adapter", async () => {
    const r = await compile(SHAPE_C, { fileName: "test.ts", target: "wasi" });
    expect(r.success).toBe(true);
    // Section id 8 is the wasm `start` section. Scan the top-level section
    // sequence rather than the raw bytes so a coincidental 0x08 in a payload
    // cannot make this pin vacuous.
    expect(topLevelSectionIds(r.binary!)).not.toContain(8);
  });
});

/** Top-level wasm section ids, in module order. */
function topLevelSectionIds(binary: Uint8Array): number[] {
  const ids: number[] = [];
  let offset = 8; // magic + version
  while (offset < binary.length) {
    const id = binary[offset]!;
    offset += 1;
    let size = 0;
    let shift = 0;
    for (;;) {
      const byte = binary[offset]!;
      offset += 1;
      size |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7;
    }
    ids.push(id);
    offset += size;
  }
  return ids;
}

/**
 * (#3523 R4 gap 3, V-D) Fail-closed reachability for the PREPARED WASI route.
 *
 * `assertGraphGlobalInvocationPolicy`'s `wasi-start-export` case was written
 * for the unitless graph-global pass and never ran against a Prepared unit,
 * because `graphGlobalPass` is unset when a prepared exact unit owns the init.
 * `issue-3520-module-init-callable-abi` pins the four adapter mutations
 * (strip `_start`, retarget its call, duplicate `_start`, inject a compiler
 * `__module_init` alias) on the MULTI-source graph-global route. These are the
 * single-source prepared equivalents: same mutations, same diagnostics, now
 * reached through `preparedInvocationPass`.
 *
 * Without them the new authentication is unfalsifiable — it would pass whether
 * or not it ran.
 */
describe("#3523 gap 3 — the prepared WASI route fails closed", () => {
  const SOURCE = `let total = 0;
total = total + 1;
export function read(): number { return total; }`;

  function hardErrors(result: { readonly errors: readonly { readonly severity?: string }[] }) {
    return result.errors.filter((error) => error.severity !== "warning");
  }

  /** One real single-source WASI compile, optionally corrupting the wiring
   *  after the generic export registry has sealed its denominator — so a
   *  mutation cannot pass vacuously through an earlier duplicate-name or
   *  unowned-target guard. */
  function compilePreparedWasi(mutateAfterExports?: (ctx: CodegenContext) => void) {
    const ast = analyzeSource(SOURCE, "test.ts");
    const original = ProgramAbiExportRegistry.prototype.planRetained;
    const spy = vi.spyOn(ProgramAbiExportRegistry.prototype, "planRetained").mockImplementation(function (
      this: ProgramAbiExportRegistry,
    ) {
      const result = original.call(this);
      mutateAfterExports?.(this.ctx);
      return result;
    });
    try {
      return generateModule(ast, { experimentalIR: true, wasi: true, trackIrOutcomes: true });
    } finally {
      spy.mockRestore();
    }
  }

  it("authenticates the single prepared _start adapter (positive control)", () => {
    expect(hardErrors(compilePreparedWasi())).toEqual([]);
  });

  it("rejects a stripped _start export", () => {
    const violated = compilePreparedWasi((ctx) => {
      ctx.mod.exports = ctx.mod.exports.filter((entry) => entry.name !== "_start");
    });
    expect(
      hardErrors(violated)
        .map((error) => error.message)
        .join("\n"),
    ).toMatch(/expects exactly one observed _start adapter, found 0/);
  });

  it("rejects a duplicated _start export", () => {
    const violated = compilePreparedWasi((ctx) => {
      const start = ctx.mod.exports.find((entry) => entry.name === "_start");
      if (!start) throw new Error("missing exact _start export");
      ctx.mod.exports.push({ name: start.name, desc: { ...start.desc } });
    });
    expect(
      hardErrors(violated)
        .map((error) => error.message)
        .join("\n"),
    ).toMatch(/expects exactly one observed _start adapter, found 2/);
  });

  it("rejects a _start adapter retargeted away from the prepared initializer", () => {
    const violated = compilePreparedWasi((ctx) => {
      const start = ctx.mod.exports.find((entry) => entry.name === "_start");
      const other = ctx.mod.exports.find((entry) => entry.name === "read");
      if (!start || !other || start.desc.kind !== "func" || other.desc.kind !== "func") {
        throw new Error("missing exact _start/read function exports");
      }
      const adapter = definedFuncAt(ctx, start.desc.index);
      if (!adapter) throw new Error("missing exact _start allocator function");
      // Mutate the adapter's real first call, not just an export label, so the
      // recorded target-object / call-path seam is what rejects it.
      const first = adapter.body.find((instruction) => instruction.op === "call");
      if (!first || first.op !== "call") throw new Error("missing _start direct call");
      first.funcIdx = other.desc.index;
    });
    expect(
      hardErrors(violated)
        .map((error) => error.message)
        .join("\n"),
    ).toMatch(/_start adapter does not retain its exact selected entry call path/);
  });

  it("rejects an injected compiler __module_init alias", () => {
    const violated = compilePreparedWasi((ctx) => {
      const handle = ctx.programAbiModuleInitCallables?.firstHandle();
      if (handle === undefined) throw new Error("missing exact prepared init handle");
      ctx.mod.exports.push({ name: "__module_init", desc: { kind: "func", index: handle } });
    });
    expect(
      hardErrors(violated)
        .map((error) => error.message)
        .join("\n"),
    ).toMatch(/must not publish a compiler __module_init alias/);
  });

  it("rejects a prepared initializer whose planted idempotence guard is gone", async () => {
    // `applyModuleInitGuard` no longer splices a prepared body — it
    // authenticates the guard preparation planted. Strip that guard and the
    // compile must fail rather than emit a silently unguarded binary, in which
    // every exported entry would re-run module init on every call.
    const seam = "JS2WASM_TEST_STRIP_PREPARED_WASI_MODULE_INIT_GUARD";
    const previous = process.env[seam];
    process.env[seam] = "1";
    try {
      const violated = await compile(SOURCE, { fileName: "test.ts", target: "wasi" });
      expect(violated.success).toBe(false);
      expect(violated.errors.map((error) => error.message).join("\n")).toMatch(
        /lost its exact planted idempotence guard/,
      );
      expect(violated.binary?.length ?? 0).toBe(0);
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, seam);
      else process.env[seam] = previous;
    }
  });
});
