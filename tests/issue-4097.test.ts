// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#4097) IR-lowered `throw <class instance>` renders like the legacy path.
//
// #4035 made the IR DECLINE `throw <class instance>` because an IR-lowered
// `throw new Test262Error(msg)` rendered "[object Object]" where legacy rendered
// "Test262Error: msg" — a silent wrong answer. The measured mechanism was NOT a
// struct-identity mismatch (both paths register the identical struct: same
// typeIdx, same name, same fields): legacy's `tryCompileBuiltinGlobalNew`
// INTERCEPTS `new Test262Error(...)` by name — a `class` declaration does not
// shadow-guard it, only a `function` one does — and allocates a native
// `$Error_struct`, which `__any_to_string` renders through §20.5.3.4
// `__error_to_string`. The IR allocates the real user-class struct, for which
// the renderer had no arm.
//
// The fix adds a path-INDEPENDENT arm to `__exn_render_prepare` for a thrown
// user-class instance carrying a `message` field, so both paths render the same
// text, and lifts the decline.
//
// Every assertion here is by VALUE, plus a non-vacuity check: the throwing
// function must appear in `irCompiledFuncs`, or the test would pass simply
// because the IR declined again.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { extractWasmExceptionMessage } from "./test262-runner.js";

interface Rendered {
  readonly message: string;
  readonly irCompiledFuncs: readonly string[];
}

async function throwAndExtract(src: string, experimentalIR: boolean): Promise<Rendered> {
  const r = await compile(src, {
    fileName: "t.ts",
    target: "standalone" as never,
    hostBridge: "always",
    experimentalIR,
  });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  try {
    (instance.exports as Record<string, () => unknown>).test();
    throw new Error("expected the module to throw");
  } catch (err) {
    return { message: extractWasmExceptionMessage(err, instance), irCompiledFuncs: r.irCompiledFuncs ?? [] };
  }
}

const TEST262_ERROR_SHAPE = `
class Test262Error {
  message: string;
  constructor(message: string) { this.message = message; }
}
export function test(): number { throw new Test262Error("Expected a to equal b"); }
`;

const USER_ERROR_CLASS = `
class MyErr {
  message: string;
  constructor(message: string) { this.message = message; }
}
export function test(): number { throw new MyErr("boom"); }
`;

const PLAIN_DATA_CLASS = `
class Pt {
  x: number;
  constructor(x: number) { this.x = x; }
}
export function test(): number { throw new Pt(1); }
`;

describe("#4097 — IR-lowered throw of a class instance renders like legacy", () => {
  it("renders the Test262Error assertion message (the shape #4035 declined)", async () => {
    const ir = await throwAndExtract(TEST262_ERROR_SHAPE, true);
    expect(ir.message).toBe("Test262Error: Expected a to equal b");
    // NON-VACUITY: the IR body is really in use — this is what #4035 gave up.
    expect(ir.irCompiledFuncs).toContain("test");
  });

  it("agrees with the legacy path by value on the same source", async () => {
    const legacy = await throwAndExtract(TEST262_ERROR_SHAPE, false);
    const ir = await throwAndExtract(TEST262_ERROR_SHAPE, true);
    expect(ir.message).toBe(legacy.message);
    expect(ir.message).not.toBe("[object Object]");
  });

  it("agrees on an ordinary user error class, with the IR body in use", async () => {
    const legacy = await throwAndExtract(USER_ERROR_CLASS, false);
    const ir = await throwAndExtract(USER_ERROR_CLASS, true);
    expect(ir.message).toBe(legacy.message);
    expect(ir.message).toBe("MyErr: boom");
    expect(ir.irCompiledFuncs).toContain("test");
  });

  it("leaves a class with no `message` field on the canonical opaque label", async () => {
    // The arm is gated on a `message` field, so a plain data class keeps the
    // §7.1.17 "[object Object]" text on BOTH paths — the gate that stops this
    // from becoming a blanket rename of every thrown struct.
    const legacy = await throwAndExtract(PLAIN_DATA_CLASS, false);
    const ir = await throwAndExtract(PLAIN_DATA_CLASS, true);
    expect(legacy.message).toBe("[object Object]");
    expect(ir.message).toBe(legacy.message);
  });

  it("control: the intrinsic Error family is unchanged", async () => {
    const src = `export function test(): number { throw new TypeError("boom"); }`;
    expect((await throwAndExtract(src, false)).message).toBe("TypeError: boom");
    expect((await throwAndExtract(src, true)).message).toBe("TypeError: boom");
  });
});
