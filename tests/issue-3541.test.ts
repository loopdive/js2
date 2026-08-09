/**
 * #3541 (#2860) — standalone: `String.fromCodePoint.apply(null, vec)` returned
 * null (the `__str_concat` null-deref), the sole remaining gate on the 311
 * `built-ins/RegExp/property-escapes` baseline rows (all via regExpUtils.js
 * `buildString`).
 *
 * The reflective forms now lower natively on the native-string lanes
 * (`tryCompileFromCharCodeFamilyReflective` in call-builtin-static.ts):
 * `.call` → direct family call; `.apply(thisArg)` → ""; `.apply(thisArg, arr)`
 * → runtime fold over the native vec with the spec coercions (§7.1.8 ToUint16
 * for fromCharCode; §22.1.2.2 integral/[0,0x10FFFF] RangeError for
 * fromCodePoint).
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function runStandalone(source: string): Promise<{ ok: boolean; error?: string }> {
  const result = await compile(source, {
    allowJs: true,
    fileName: "test.js",
    skipSemanticDiagnostics: true,
    target: "standalone",
    deferTopLevelInit: true,
  });
  if (!result.success || result.errors.some((e) => e.severity === "error")) {
    return {
      ok: false,
      error: `compile: ${result.errors
        .filter((e) => e.severity === "error")
        .map((e) => e.message)
        .join("; ")}`,
    };
  }
  expect(result.imports).toHaveLength(0);
  const importObj = buildImports(result.imports, undefined, result.stringPool) as Record<string, unknown>;
  let instance: WebAssembly.Instance;
  try {
    ({ instance } = await WebAssembly.instantiate(result.binary, importObj as WebAssembly.Imports));
  } catch (err) {
    return { ok: false, error: `instantiate: ${String(err)}` };
  }
  const init = (instance.exports as Record<string, unknown>).__module_init;
  try {
    if (typeof init === "function") (init as () => void)();
  } catch (err) {
    return { ok: false, error: `init threw: ${String(err)}` };
  }
  return { ok: true };
}

async function expectPass(source: string): Promise<void> {
  const r = await runStandalone(source);
  expect(r.error ?? "").toBe("");
  expect(r.ok).toBe(true);
}

describe("#3541 reflective fromCharCode/fromCodePoint on the native-string lane", () => {
  it("fromCodePoint.apply over a vec identifier (the minimal repro)", async () => {
    await expectPass(`
var v = [0x41, 0x42, 0x43];
var s = String.fromCodePoint.apply(null, v);
if (s !== "ABC") throw new Error("bad: " + s);
`);
  });

  it("fromCodePoint.apply over a struct-field vec (obj.pts)", async () => {
    await expectPass(`
var obj = { pts: [0x41, 0x42, 0x43] };
var s = String.fromCodePoint.apply(null, obj.pts);
if (s !== "ABC") throw new Error("bad: " + s);
`);
  });

  it("fromCodePoint.apply over a grown array (the buildString codePoints shape)", async () => {
    await expectPass(`
var codePoints = [];
for (var length = 0, cp = 0x41; cp <= 0x45; cp++) {
  codePoints[length++] = cp;
}
var s = String.fromCodePoint.apply(null, codePoints);
if (s !== "ABCDE") throw new Error("bad: " + s);
`);
  });

  it("fromCharCode.apply applies ToUint16 per element", async () => {
    await expectPass(`
var v = [65, 65 + 65536, -65471];
var s = String.fromCharCode.apply(null, v);
if (s !== "AAA") throw new Error("bad: " + s);
`);
  });

  it("fromCodePoint.apply throws RangeError on an invalid code point", async () => {
    await expectPass(`
var v = [0x41, 0x110000];
var threw = false;
try {
  String.fromCodePoint.apply(null, v);
} catch (e) {
  threw = true;
  if (String(e).indexOf("RangeError") < 0) throw new Error("wrong error: " + e);
}
if (!threw) throw new Error("expected RangeError");
`);
  });

  it("empty and absent arg arrays yield the empty string", async () => {
    await expectPass(`
var empty = [];
var a = String.fromCodePoint.apply(null, empty);
var b = String.fromCharCode.apply(null);
if (a !== "" || b !== "") throw new Error("bad: [" + a + "][" + b + "]");
`);
  });

  it(".call routes to the direct family lowering", async () => {
    await expectPass(`
var s = String.fromCodePoint.call(null, 0x41, 0x42);
var t = String.fromCharCode.call(null, 67);
if (s + t !== "ABC") throw new Error("bad: " + s + t);
`);
  });

  it("supplementary-plane code points survive the fold", async () => {
    await expectPass(`
var v = [0x1f600];
var s = String.fromCodePoint.apply(null, v);
if (s.length !== 2) throw new Error("bad surrogate pair: " + s.length);
`);
  });
});
