// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #5150 — ES2015 standalone ArrayBuffer/DataView conformance, wave 1.
 *
 * Five clusters land here. Each has a STANDALONE control (the lane the issue is
 * about) plus a host control wherever the host lane exercises the same code —
 * `emitArrayBufferSlice` and the buffer-constructor arms are lane-agnostic,
 * while the DataView instance model and the TypedArray-over-buffer view are
 * host-bridged and unaffected. Every standalone control also asserts an EMPTY
 * import manifest: the fixes are Wasm-native, and a regression that pulled in a
 * host import would be scored `compile_error/host_import_leak` by CI's sharded
 * lane even though the in-process runner would still report a pass (#5272).
 *
 *  A — a DataView setter reached through the closed-method dispatcher pads its
 *      ABSENT value argument with the `undefined` singleton, so
 *      `ToNumber(undefined)` is NaN (a `null` pad silently wrote 0).
 *  C — `ArrayBuffer.prototype.slice` treats an EXPLICIT `undefined` end as "to
 *      the end of the buffer" while `null` still coerces to 0.
 *  D — the buffer constructors validate their arguments: an unallocatable
 *      length is a catchable RangeError (it used to TRAP), `ToIndex` runs
 *      `valueOf` and truncates, `new DataView(<non-buffer>, …)` is a TypeError
 *      raised BEFORE the byteOffset coercion, offset/length are bounds-checked
 *      against the buffer for the externref carrier too, an explicit
 *      `undefined` byteLength means "to the end", and calling either
 *      constructor without `new` throws.
 *  F — `new Uint8Array(buffer[, byteOffset])` assigned to a MODULE-LEVEL
 *      binding keeps its shared-backing `$__ta_view` slot type (test262
 *      declares every binding at top level).
 *  G — `ArrayBuffer.isView` read AS A VALUE mints a real closure instead of the
 *      generic "not yet implemented in --target standalone" throw, and the
 *      shared carrier chain now recognises `$__ta_view` structs.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildImports, compile, instantiateWasm } from "../src/index.js";
import { runTest262File } from "./test262-runner.js";
import { restoreHostBuiltins } from "./test262-restore-builtins.js";

type Lane = "host" | "standalone";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TEST262_ROOT = join(REPO_ROOT, "test262");

/**
 * Cluster F — the exact top-level shape every `DataView/prototype/set*` row
 * uses. A module-scope `var` initialised from `new Uint8Array(buffer, 0)` must
 * hold the shared-backing view, so element reads observe the DataView's write.
 */
const MODULE_GLOBAL_VIEW_SOURCE = `
  var buffer = new ArrayBuffer(4);
  var sample = new DataView(buffer, 0);
  var typedArray = new Uint8Array(buffer, 0);
  var whole = new Uint8Array(buffer);
  export function test(): number {
    let checks = 0;
    sample.setUint8(0, 42);
    if (typedArray[0] === 42) checks += 1;
    if (typedArray.length === 4) checks += 2;
    if (whole[0] === 42) checks += 4;
    typedArray[1] = 7;
    if (sample.getUint8(1) === 7) checks += 8;
    const windowed = new Uint8Array(buffer, 2);
    if (windowed.length === 2) checks += 16;
    sample.setUint8(2, 9);
    if (windowed[0] === 9) checks += 32;
    return checks;
  }
`;

/**
 * Cluster A — an absent setter value must coerce as `undefined` (ToNumber →
 * NaN), not `null` (ToNumber → 0), on both the statically typed receiver and
 * the `any` receiver that routes through the closed-method dispatcher.
 */
const MISSING_VALUE_PAD_SOURCE = `
  export function test(): number {
    let checks = 0;

    const dv1 = new DataView(new ArrayBuffer(8));
    dv1.setFloat32(0);
    const a: any = dv1.getFloat32(0);
    if (a !== a) checks += 1;

    const dv2: any = new DataView(new ArrayBuffer(8));
    dv2.setFloat32(0);
    const b: any = dv2.getFloat32(0);
    if (b !== b) checks += 2;

    const dv3: any = new DataView(new ArrayBuffer(8));
    dv3.setUint8(0, 200);
    const r: any = dv3.setUint8(0);
    if (r === undefined) checks += 4;
    if (r !== null) checks += 8;
    if (dv3.getUint8(0) === 0) checks += 16;

    return checks;
  }
`;

/** Cluster C — an explicit `undefined` end defaults to the buffer length. */
const SLICE_SOURCE = `
  export function test(): number {
    let checks = 0;
    const ab = new ArrayBuffer(8);
    const end: any = undefined;
    if (ab.slice(6, end).byteLength === 2) checks += 1;
    if (ab.slice(6, undefined).byteLength === 2) checks += 2;
    if (ab.slice(6).byteLength === 2) checks += 4;
    // null is NOT the absent-argument value — it still coerces to 0.
    const nullEnd: any = null;
    if (ab.slice(6, nullEnd).byteLength === 0) checks += 8;
    if (ab.slice(1, 3).byteLength === 2) checks += 16;
    if (ab.slice(-2).byteLength === 2) checks += 32;
    return checks;
  }
`;

/** Cluster D — constructor argument validation for both buffer constructors. */
const CTOR_VALIDATION_SOURCE = `
  export function test(): number {
    let checks = 0;

    // ToIndex: a plain object runs valueOf; a fractional length truncates.
    const lengthObject: any = { valueOf: function (): number { return 4; } };
    if (new ArrayBuffer(lengthObject).byteLength === 4) checks += 1;
    if (new ArrayBuffer(1.9).byteLength === 1) checks += 2;

    // An unallocatable length is a CATCHABLE RangeError, not a Wasm trap.
    try {
      const huge: any = 9007199254740991;
      new ArrayBuffer(huge);
    } catch (e: any) {
      if (e instanceof RangeError) checks += 4;
    }

    // The brand TypeError precedes ToIndex(byteOffset), so the offset's valueOf
    // must NOT run.
    let offsetTouched = 0;
    const offset: any = { valueOf: function (): number { offsetTouched += 1; return 0; } };
    const notABuffer: any = 0;
    try {
      new DataView(notABuffer, offset);
    } catch (e: any) {
      if (e instanceof TypeError) checks += 8;
    }
    if (offsetTouched === 0) checks += 16;

    // Offset/length bounds are checked against the buffer's byteLength.
    const small = new ArrayBuffer(1);
    try {
      new DataView(small, 2);
    } catch (e: any) {
      if (e instanceof RangeError) checks += 32;
    }
    try {
      new DataView(small, 0, 4);
    } catch (e: any) {
      if (e instanceof RangeError) checks += 64;
    }

    // An EXPLICIT undefined byteLength means "to the end of the buffer".
    const four = new ArrayBuffer(4);
    const absent: any = undefined;
    if (new DataView(four, 0, absent).byteLength === 4) checks += 128;

    return checks;
  }
`;

/**
 * Cluster D.5 — neither buffer constructor has a [[Call]] behaviour. The gate
 * is the DIRECT identifier call, which is the form both test262 rows use. The
 * indirect value form (`var f = ArrayBuffer; f(10)`) still succeeds; it needs
 * the #3177 slice-3 ctor-value arm extended to the buffer carriers and is left
 * to the follow-on wave.
 */
const CTOR_REQUIRES_NEW_SOURCE = `
  export function test(): number {
    let checks = 0;
    try {
      (ArrayBuffer as any)(10);
    } catch (e: any) {
      if (e instanceof TypeError) checks += 1;
    }
    // The arguments are still evaluated; they are simply never coerced.
    let touched = 0;
    const arg: any = { valueOf: function (): number { touched += 1; return 0; } };
    try {
      (DataView as any)(new ArrayBuffer(1), arg);
    } catch (e: any) {
      if (e instanceof TypeError) checks += 2;
    }
    if (touched === 0) checks += 4;
    return checks;
  }
`;

/** Cluster G — `ArrayBuffer.isView` extracted as a first-class value. */
const ISVIEW_VALUE_SOURCE = `
  export function test(): number {
    let checks = 0;
    const isView: any = ArrayBuffer.isView;
    if (typeof isView === "function") checks += 1;
    const buffer = new ArrayBuffer(8);
    const dv: any = new DataView(buffer);
    const ta: any = new Uint8Array(buffer);
    if (isView(dv) === true) checks += 2;
    if (isView(ta) === true) checks += 4;
    const nothing: any = undefined;
    if (isView(nothing) === false) checks += 8;
    if (isView === ArrayBuffer.isView) checks += 16;
    return checks;
  }
`;

async function runControl(source: string, lane: Lane): Promise<{ value: number; imports: string[] }> {
  const result = await compile(source, {
    allowJs: true,
    fileName: "issue-5150-es2015-buffers.ts",
    skipSemanticDiagnostics: true,
    ...(lane === "standalone" ? { target: "standalone" as const } : {}),
  });
  expect(
    result.success,
    `${lane} control compile failed:\n${result.errors.map((error) => `L${error.line}: ${error.message}`).join("\n")}`,
  ).toBe(true);
  if (!result.success) return { value: -1, imports: [] };

  const module = await WebAssembly.compile(result.binary);
  const imports = WebAssembly.Module.imports(module).map((entry) => `${entry.module}::${entry.name}`);
  if (lane === "standalone") {
    expect(imports, "standalone buffer controls must emit zero imports").toEqual([]);
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    return { value: (instance.exports as { test: () => number }).test(), imports };
  }

  const built = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await instantiateWasm(result.binary, built.env, built.string_constants);
  built.setInstance?.(instance);
  return { value: (instance.exports as { test: () => number }).test(), imports };
}

async function runRow(relativePath: string, lane: Lane) {
  const filePath = join(TEST262_ROOT, "test", relativePath);
  try {
    return await runTest262File(filePath, `issue-5150-${lane}`, 120_000, lane === "standalone" ? lane : undefined);
  } finally {
    restoreHostBuiltins();
  }
}

/**
 * One representative row per mechanism this wave fixes, each measured `fail` at
 * its base and `pass` after. The wave flips SIXTEEN rows in total; the rest are
 * held out of the vitest file deliberately — every row compiles a full test262
 * harness IN-PROCESS, and the fork pool caps a worker's V8 old-space at 512 MB
 * (`VITEST_FORK_MAX_OLD_SPACE_SIZE`, vitest.config.ts). Measured on this
 * change: nine of these rows reach the limit and the worker dies with
 * "Ineffective mark-compacts near heap limit". The complete flipped list, and
 * the before/after run behind it, is recorded in
 * `plan/issues/5150-es2015-standalone-buffers-wave1.md`; CI's sharded lane runs
 * all of them anyway.
 */
const STANDALONE_ROWS = [
  // A — absent setter value pads as `undefined`, and F — the module-global view.
  "built-ins/DataView/prototype/setUint8/no-value-arg.js",
  // D — the brand TypeError, raised before ToIndex(byteOffset). Was a
  // COMPILE_ERROR: the primitive argument mis-typed the buffer local and the
  // whole module failed Wasm validation.
  "built-ins/DataView/buffer-not-object-throws.js",
  // D — the allocation ceiling. Was an UNCATCHABLE trap.
  "built-ins/ArrayBuffer/allocation-limit.js",
  // C — an explicit `undefined` end defaults to the buffer length.
  "built-ins/ArrayBuffer/prototype/slice/end-default-if-undefined.js",
] as const;

describe("#5150 ES2015 standalone buffers wave 1", () => {
  it("module-level buffer views alias their backing buffer (standalone)", async () => {
    const outcome = await runControl(MODULE_GLOBAL_VIEW_SOURCE, "standalone");
    expect(outcome.value).toBe(63);
    expect(outcome.imports).toEqual([]);
  });

  it("module-level buffer views keep their host-lane behaviour", async () => {
    // The host lane constructs a REAL host TypedArray over a host ArrayBuffer
    // (#3097), a different mechanism that this wave does not touch. 18 is what
    // it answered before the change; pinned so a host regression still fails.
    expect((await runControl(MODULE_GLOBAL_VIEW_SOURCE, "host")).value).toBe(18);
  });

  it("an absent setter value pads as undefined, not null (standalone)", async () => {
    const outcome = await runControl(MISSING_VALUE_PAD_SOURCE, "standalone");
    expect(outcome.value).toBe(31);
    expect(outcome.imports).toEqual([]);
  });

  it("slice defaults an explicit undefined end (standalone)", async () => {
    const outcome = await runControl(SLICE_SOURCE, "standalone");
    expect(outcome.value).toBe(63);
    expect(outcome.imports).toEqual([]);
  });

  it("buffer constructors validate their arguments (standalone)", async () => {
    const outcome = await runControl(CTOR_VALIDATION_SOURCE, "standalone");
    expect(outcome.value).toBe(255);
    expect(outcome.imports).toEqual([]);
  });

  it("buffer constructors validate their arguments (host)", async () => {
    // Host mode reaches the same ArrayBuffer arm (ToIndex + the allocation
    // RangeError, bits 1|2|4); the DataView halves are host-bridged and stay
    // out of scope. Before this wave the whole control TRAPPED.
    expect((await runControl(CTOR_VALIDATION_SOURCE, "host")).value).toBe(7);
  });

  it("buffer constructors require new (standalone)", async () => {
    const outcome = await runControl(CTOR_REQUIRES_NEW_SOURCE, "standalone");
    expect(outcome.value).toBe(7);
    expect(outcome.imports).toEqual([]);
  });

  it("buffer constructors require new (host)", async () => {
    expect((await runControl(CTOR_REQUIRES_NEW_SOURCE, "host")).value).toBe(7);
  });

  it("ArrayBuffer.isView reads as a callable value (standalone)", async () => {
    const outcome = await runControl(ISVIEW_VALUE_SOURCE, "standalone");
    expect(outcome.value).toBe(31);
    expect(outcome.imports).toEqual([]);
  });

  it("ArrayBuffer.isView keeps its host-lane behaviour", async () => {
    // Host mode answers through the `__arraybuffer_isView` import, untouched
    // here. 29 is the pre-change value (the DataView bit is a host-repr gap).
    expect((await runControl(ISVIEW_VALUE_SOURCE, "host")).value).toBe(29);
  });

  for (const row of STANDALONE_ROWS) {
    it(`standalone: ${row}`, async () => {
      const outcome = await runRow(row, "standalone");
      expect(outcome.status, `${row}: ${JSON.stringify(outcome)}`).toBe("pass");
    }, 240_000);
  }
});
