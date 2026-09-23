// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6438 — `wrapExports(instance.exports)` silently marshalled a returned
// struct to `{}`.
//
// The raw-exports overload can only CONSUME a #3520 data-struct authority, not
// establish one (`_brandedInstanceExports` answers `undefined` for a bare
// record). Without an authority the host-bridge export view masks the
// compiler's own `__struct_field_names` to `undefined`, `_structFieldNamesRaw`
// answers `null`, `looksMarshalable` still answers `true` through its
// `hasVecLen` tail, and `_wasmToPlain` produces `{}` — indistinguishable from a
// genuinely field-less object. Measured on upstream/main 69ccb3494f:
// `wrapExports(instance, …).parse("x")` = `{type:"Program"}` while
// `wrapExports(instance.exports, …).parse("x")` = `{}` for the same module and
// call, with `__struct_field_names(raw)` answering `"type"` throughout.
//
// Contract pinned here: refuse loudly, never decode from a raw record (a
// mutable binding table cannot authenticate callable identity — #3520). The
// consume paths (`__setInstance`, or a prior Instance wrap) are unchanged.
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compileProject } from "../src/index.js";
import { wrapExports } from "../src/runtime.js";

const PARSER = fileURLToPath(new URL("./fixtures/issue-6438/parser.js", import.meta.url));
const USER_DECODER = fileURLToPath(new URL("./fixtures/issue-6438/user-decoder.js", import.meta.url));

const AUTHORITY = /data-struct authority/;

interface Compiled {
  readonly instance: WebAssembly.Instance;
  readonly importObject: Record<string, any>;
  readonly signatures: Record<string, any> | undefined;
}

// One instantiate per case: the data-struct authority is global per manifest,
// so a shared module would let an earlier case establish it for a later one.
async function compiled(entry: string): Promise<Compiled> {
  const result: any = await compileProject(entry, {
    allowJs: true,
    skipSemanticDiagnostics: true,
    target: "gc",
  });
  expect(result.success, (result.errors ?? []).map((error: any) => error.message).join("\n")).toBe(true);
  const importObject: Record<string, any> = (result.importObject ?? {}) as Record<string, any>;
  const { instance } = await WebAssembly.instantiate(result.binary, importObject as WebAssembly.Imports);
  return { instance, importObject, signatures: result.exportSignatures };
}

function wrapRaw(unit: Compiled): Record<string, any> {
  return wrapExports(unit.instance.exports, { signatures: unit.signatures });
}

function wrapInstance(unit: Compiled): Record<string, any> {
  return wrapExports(unit.instance, { signatures: unit.signatures });
}

describe("#6438 — struct results across both wrapExports overloads", () => {
  it("decodes through the documented Instance overload", async () => {
    const unit = await compiled(PARSER);
    unit.importObject.__setExports?.(unit.instance.exports);
    const wrapped = wrapInstance(unit);
    expect(wrapped.parse("x")).toEqual({ type: "Program" });
    expect(wrapped.nodes()).toEqual([{ type: "A" }]);
  });

  // Parent behaviour: both of these answered `{}` / `[{}]` with no error.
  it("refuses instead of answering {} on an unauthenticated raw record", async () => {
    const unit = await compiled(PARSER);
    unit.importObject.__setExports?.(unit.instance.exports);
    const wrapped = wrapRaw(unit);
    expect(() => wrapped.parse("x")).toThrow(TypeError);
    expect(() => wrapped.parse("x")).toThrow(AUTHORITY);
    expect(() => wrapped.parse("x")).toThrow(/__setInstance/);
    // A vec of undecodable structs marshalled to `[{}]` just as silently.
    expect(() => wrapped.nodes()).toThrow(AUTHORITY);
    // Non-struct results are untouched: the guard is about decoding, not calls.
    expect(wrapped.name("x")).toBe("Program");
  });

  it("still decodes through a raw record once __setInstance established the authority", async () => {
    const unit = await compiled(PARSER);
    unit.importObject.__setInstance?.(unit.instance);
    const wrapped = wrapRaw(unit);
    expect(wrapped.parse("x")).toEqual({ type: "Program" });
    expect(wrapped.nodes()).toEqual([{ type: "A" }]);
  });

  it("still decodes through a raw record wrapped after an Instance wrap of the same module", async () => {
    const unit = await compiled(PARSER);
    unit.importObject.__setExports?.(unit.instance.exports);
    wrapInstance(unit);
    expect(wrapRaw(unit).parse("x")).toEqual({ type: "Program" });
  });

  // Anti-vacuity control: "empty" must stay reachable. An authenticated view
  // still answers a (field-less) name list, so `{}` is a real answer there and
  // the guard is not "throw on every object".
  it("answers {} for a genuinely field-less struct on the authenticated view", async () => {
    const unit = await compiled(PARSER);
    unit.importObject.__setInstance?.(unit.instance);
    expect(wrapInstance(unit).empty()).toEqual({});
    expect(wrapRaw(unit).empty()).toEqual({});
  });

  it("hands back the raw handle under marshal:false without throwing", async () => {
    const unit = await compiled(PARSER);
    unit.importObject.__setExports?.(unit.instance.exports);
    const wrapped = wrapExports(unit.instance.exports, { signatures: unit.signatures, marshal: false });
    const handle = wrapped.parse("x");
    expect(typeof handle).toBe("object");
    expect(handle).not.toBeNull();
    // The handle is opaque, not a decoded copy — the raw `__sget_*` helpers
    // still answer off it.
    const raw = unit.instance.exports as Record<string, any>;
    expect(raw.__struct_field_names(handle)).toBe("type");
  });

  // #3520 control: a user-declared `__struct_field_names` never becomes the
  // decoder, so it neither rescues the raw record nor displaces the compiler's
  // names on the Instance overload.
  it("does not let a user-declared __struct_field_names become the decoder", async () => {
    const refuse = await compiled(USER_DECODER);
    refuse.importObject.__setExports?.(refuse.instance.exports);
    expect(() => wrapRaw(refuse).parse()).toThrow(AUTHORITY);

    const decode = await compiled(USER_DECODER);
    decode.importObject.__setExports?.(decode.instance.exports);
    expect(wrapInstance(decode).parse()).toEqual({ type: "Program" });
  });
});
