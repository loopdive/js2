// (#2877) Standalone exceptions expose no JS-readable message — HARNESS-level
// acceptance test, resolved by #2962's native render mechanism.
//
// #2877's acceptance: the harness records the real error message (or a
// precise class label) for a standalone-thrown exception instead of the
// #2870 opaque fallback ("uncaught Wasm-GC exception (non-stringifiable
// payload)"). #2962 satisfied it via `__exn_render_prepare`/`__exn_render_char`
// (the payload rendered through the module's own `__any_to_string`, §20.5.3.4)
// wired into `extractWasmExceptionMessage`. #2962's own test covers the
// module-level rendering; THIS test pins the end-to-end harness contract —
// compile standalone, throw, catch host-side, extract — across the payload
// shapes #2877's triage use-case needs.

import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { extractWasmExceptionMessage } from "./test262-runner.js";

async function throwAndExtract(src: string): Promise<string> {
  const r = await compile(src, { fileName: "t.ts", target: "standalone" as never, hostBridge: "always" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  try {
    (instance.exports as Record<string, () => unknown>).test();
    throw new Error("expected the module to throw");
  } catch (err) {
    return extractWasmExceptionMessage(err, instance);
  }
}

const OPAQUE_LABEL = "uncaught Wasm-GC exception (non-stringifiable payload)";

describe("#2877 — harness records real messages for standalone-thrown exceptions (via #2962)", () => {
  it("new TypeError('boom') → 'TypeError: boom'", async () => {
    expect(await throwAndExtract(`export function test(): number { throw new TypeError("boom"); }`)).toBe(
      "TypeError: boom",
    );
  });

  it("rope message (string concat) renders flattened", async () => {
    expect(
      await throwAndExtract(
        `export function test(): number { const x = "wor" + "ld"; throw new RangeError("hello " + x + "!"); }`,
      ),
    ).toBe("RangeError: hello world!");
  });

  it("no-message error → spec §20.5.3.4 name-only", async () => {
    expect(await throwAndExtract(`export function test(): number { throw new Error(); }`)).toBe("Error");
  });

  it("thrown bare string decodes to its own text", async () => {
    expect(await throwAndExtract(`export function test(): number { throw "bare string payload"; }`)).toBe(
      "bare string payload",
    );
  });

  it("Test262Error surfaces its real assertion message (the assert.js harness shape)", async () => {
    const message = await throwAndExtract(`
class Test262Error {
  message: string;
  constructor(message: string) { this.message = message; }
}
export function test(): number { throw new Test262Error("Expected a to equal b"); }
`);
    expect(message).toContain("Expected a to equal b");
  });

  it("non-Error non-string payload still yields a stable, non-crashing label", async () => {
    // Known #2962 residual: a thrown boxed number renders "[object Object]"
    // (construction-time ToString residual). Pin only the CONTRACT this issue
    // needs: extraction never throws and never regresses to a crash; do not
    // pin the residual text (it should improve to "42" eventually).
    const message = await throwAndExtract(`export function test(): number { throw 42; }`);
    expect(typeof message).toBe("string");
    expect(message.length).toBeGreaterThan(0);
  });

  it("real messages replace the #2870 opaque label for error payloads", async () => {
    const message = await throwAndExtract(
      `export function test(): number { throw new SyntaxError("triage needs this text"); }`,
    );
    expect(message).toBe("SyntaxError: triage needs this text");
    expect(message).not.toBe(OPAQUE_LABEL);
  });
});
