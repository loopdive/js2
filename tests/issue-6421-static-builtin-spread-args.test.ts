// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #6421 — a SPREAD argument to a STATIC BUILTIN contributes its runtime element
 * count, not one slot.
 *
 * The third site of the idiom #5361 (`splice` / `push` / `Math.min`-`max` / the
 * generic `__extern_method_call` bridge) and #6411 (the two host-Array argument
 * builders) removed: build the argument list with ONE slot per AST node, which
 * is exact only while every argument is a single value.
 *
 *   String.fromCharCode(...[65, 66, 67])   // "\0"  — the array coerced to NaN
 *   String.fromCharCode(48, ...[65, 66, 67]) // "0\0" — fixed args survive
 *   Array.of(...[1, 2, 3]).length          // 1 (host lane); standalone would
 *                                          // not even instantiate
 *
 * That is hono's cookie blocker: `btoa(String.fromCharCode(...new
 * Uint8Array(signature)))` (`src/utils/cookie.ts:48`) signed every cookie as
 * `AA==`, base64 of one zero byte, instead of the real digest.
 *
 * Parent-commit counts (`699df289e1`), all four describes together: **20 failed
 * / 8 passed of 28**. With the fix: **28 passed**. The 11 host-lane failures are
 * value mismatches (`fromCodePoint` a thrown `RangeError: Invalid code point
 * NaN`); the 9 standalone ones all fail at INSTANTIATION, because a standalone
 * `Array.of(...xs)` leaked `__js_array_new` / `__array_of` and the native-first
 * adapter refuses to bind them. The 8 `control…` rows are the anti-vacuity
 * half — they pass on the parent too, and a fix that rerouted every
 * static-builtin call through one path would break them.
 *
 * Fixtures are untyped `.js` across two modules on purpose: hono's byte source
 * is an `any`-typed host `ArrayBuffer` from `crypto.subtle.sign`, which no
 * static element-type scan can see through.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { compile, compileProject } from "../src/index.js";
import { buildCompiledImports } from "../src/runtime.js";

const roots: string[] = [];
afterAll(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

/**
 * Every spread SOURCE the issue measured collapsing identically: an inline
 * array literal, a compiled TypedArray carrier, a buffer-backed view, a host
 * typed array handed in, and a dynamically-built host array.
 */
const LIB_SOURCE = `
export function fromLiteral() { return String.fromCharCode(...[65, 66, 67]); }
export function fromLiteralWithFixed() { return String.fromCharCode(48, ...[65, 66, 67]); }
export function fromCarrier() { return String.fromCharCode(...new Uint8Array([72, 73, 74])); }
export function fromBufferView(n) {
  const view = new Uint8Array(new ArrayBuffer(n));
  view[0] = 88;
  view[1] = 89;
  return String.fromCharCode(...view);
}
export function fromHostBuffer(buf) { return String.fromCharCode(...new Uint8Array(buf)); }
export function fromDynamicArray(csv) { return String.fromCharCode(...csv.split(",").map(Number)); }
export function codePointsFromLiteral() { return String.fromCodePoint(...[0x1f600, 65]); }
export function arrayOfSpread() { return Array.of(...[1, 2, 3]); }

// The hono shape (src/utils/cookie.ts:48). btoa is not bindable in either lane
// here, so the base64 step is spelled out; only the fromCharCode call is under
// test — with the defect the digest is one zero byte and encodes as "AA==".
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function base64(text) {
  let out = "";
  for (let i = 0; i < text.length; i += 3) {
    const c0 = text.charCodeAt(i);
    const has1 = i + 1 < text.length;
    const has2 = i + 2 < text.length;
    const c1 = has1 ? text.charCodeAt(i + 1) : 0;
    const c2 = has2 ? text.charCodeAt(i + 2) : 0;
    out = out + B64[c0 >> 2] + B64[((c0 & 3) << 4) | (c1 >> 4)];
    out = out + (has1 ? B64[((c1 & 15) << 2) | (c2 >> 6)] : "=");
    out = out + (has2 ? B64[c2 & 63] : "=");
  }
  return out;
}
export function signatureBase64(byteCount) {
  return base64(String.fromCharCode(...new Uint8Array(byteCount)));
}

// Controls — all four are CORRECT on the parent commit.
export function controlNoSpread() { return String.fromCharCode(65, 66, 67); }
export function controlApply() { return String.fromCharCode.apply(null, [65, 66, 67]); }
export function controlMathMax() { return Math.max(...[1, 5, 3]); }
export function controlArrayOf() { return Array.of(1, 2, 3); }
`;

const ENTRY_SOURCE = `
import {
  arrayOfSpread,
  codePointsFromLiteral,
  controlApply,
  controlArrayOf,
  controlMathMax,
  controlNoSpread,
  fromBufferView,
  fromCarrier,
  fromDynamicArray,
  fromHostBuffer,
  fromLiteral,
  fromLiteralWithFixed,
  signatureBase64,
} from "./lib.js";

export function literal() { return fromLiteral(); }
export function literalLength() { return fromLiteral().length; }
export function literalWithFixed() { return fromLiteralWithFixed(); }
export function carrier() { return fromCarrier(); }
export function bufferView() { return fromBufferView(2); }
export function hostBuffer(buf) { return fromHostBuffer(buf); }
export function dynamicArray() { return fromDynamicArray("65,66,67"); }
export function codePoints() { return codePointsFromLiteral(); }
export function codePointsLength() { return codePointsFromLiteral().length; }
export function arrayOfJoin() { return arrayOfSpread().join("|"); }
export function arrayOfLength() { return arrayOfSpread().length; }
export function honoSignature() { return signatureBase64(4); }

export function controlNoSpreadValue() { return controlNoSpread(); }
export function controlApplyValue() { return controlApply(); }
export function controlMathMaxValue() { return controlMathMax(); }
export function controlArrayOfValue() { return controlArrayOf().join("|"); }
`;

let hostExports: Promise<WebAssembly.Exports> | undefined;
/** Host (`gc`) lane over an untyped two-file project. */
function hostLane(): Promise<WebAssembly.Exports> {
  hostExports ??= (async () => {
    const root = mkdtempSync(join(tmpdir(), "js2-6421-"));
    roots.push(root);
    writeFileSync(join(root, "lib.js"), LIB_SOURCE);
    const entry = join(root, "entry.js");
    writeFileSync(entry, ENTRY_SOURCE);
    const result = await compileProject(entry, {
      allowJs: true,
      skipSemanticDiagnostics: true,
      target: "gc",
      platform: "node",
      deferTopLevelInit: true,
    });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    const imports = buildCompiledImports(result, {}) as Record<string, unknown> & WebAssembly.Imports;
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    (imports.setInstance as ((i: WebAssembly.Instance) => void) | undefined)?.(instance);
    (imports.__setInstance as ((i: WebAssembly.Instance) => void) | undefined)?.(instance);
    (instance.exports.__module_init as (() => void) | undefined)?.();
    return instance.exports;
  })();
  return hostExports;
}

/** name → expected value, with what the parent commit answered instead. */
const HOST_ROWS: readonly { name: string; expected: string | number; parent: string | number | "threw" }[] = [
  { name: "literal", expected: "ABC", parent: "\0" },
  { name: "literalLength", expected: 3, parent: 1 },
  { name: "literalWithFixed", expected: "0ABC", parent: "0\0" },
  { name: "carrier", expected: "HIJ", parent: "\0" },
  { name: "bufferView", expected: "XY", parent: "\0" },
  { name: "dynamicArray", expected: "ABC", parent: "\0" },
  { name: "codePointsLength", expected: 3, parent: "threw" },
  { name: "arrayOfJoin", expected: "1|2|3", parent: "NaN" },
  { name: "arrayOfLength", expected: 3, parent: 1 },
  { name: "honoSignature", expected: "AAAAAA==", parent: "AA==" },
];

const HOST_CONTROLS: readonly { name: string; expected: string | number }[] = [
  { name: "controlNoSpreadValue", expected: "ABC" },
  { name: "controlApplyValue", expected: "ABC" },
  { name: "controlMathMaxValue", expected: 5 },
  { name: "controlArrayOfValue", expected: "1|2|3" },
];

describe("#6421 host lane — a spread into a static builtin expands every element", () => {
  for (const row of HOST_ROWS) {
    it(`${row.name} → ${JSON.stringify(row.expected)} (parent: ${JSON.stringify(row.parent)})`, async () => {
      const exports = await hostLane();
      const value = (exports[row.name] as () => unknown)();
      expect(typeof row.expected === "number" ? Number(value) : String(value)).toBe(row.expected);
    });
  }

  it('reads a HOST typed array handed across the boundary (parent: "\\0")', async () => {
    const exports = await hostLane();
    const bytes = new Uint8Array([80, 81, 82]);
    expect(String((exports.hostBuffer as (b: ArrayBuffer) => unknown)(bytes.buffer))).toBe("PQR");
  });
});

describe("#6421 host lane — the forms that already worked keep working", () => {
  for (const row of HOST_CONTROLS) {
    it(`${row.name} → ${JSON.stringify(row.expected)}`, async () => {
      const exports = await hostLane();
      const value = (exports[row.name] as () => unknown)();
      expect(typeof row.expected === "number" ? Number(value) : String(value)).toBe(row.expected);
    });
  }
});

/**
 * Standalone lane: the same calls with no host imports at all. Native strings
 * are not readable across the boundary, so each probe answers a number.
 */
const STANDALONE_SOURCE = `
function fromLiteral() { return String.fromCharCode(...[65, 66, 67]); }
function fromLiteralWithFixed() { return String.fromCharCode(48, ...[65, 66, 67]); }
function fromCarrier() { return String.fromCharCode(...new Uint8Array([72, 73, 74])); }
function fromDynamicArray(csv) { return String.fromCharCode(...csv.split(",").map(Number)); }
function codePointsFromLiteral() { return String.fromCodePoint(...[0x1f600, 65]); }
function arrayOfSpread() { return Array.of(...[1, 2, 3]); }

export function literalLength() { return fromLiteral().length; }
export function literalFirstCode() { return fromLiteral().charCodeAt(0); }
export function literalLastCode() { return fromLiteral().charCodeAt(2); }
export function literalWithFixedLength() { return fromLiteralWithFixed().length; }
export function carrierLength() { return fromCarrier().length; }
export function dynamicArrayLength() { return fromDynamicArray("65,66,67").length; }
export function codePointsLength() { return codePointsFromLiteral().length; }
export function arrayOfLength() { return arrayOfSpread().length; }
export function arrayOfSecond() { return arrayOfSpread()[1]; }

`;

/**
 * The standalone controls live in their OWN module. On the parent commit
 * `Array.of(...xs)` leaked `__js_array_new` / `__array_of` into a standalone
 * build, so the module above cannot be instantiated there at all — a control
 * sharing it would fail for that reason and prove nothing.
 */
const STANDALONE_CONTROL_SOURCE = `
export function controlNoSpreadLength() { return String.fromCharCode(65, 66, 67).length; }
export function controlCodePointNoSpread() { return String.fromCodePoint(0x1f600, 65).length; }
export function controlMathMax() { return Math.max(...[1, 5, 3]); }
export function controlArrayOfLength() { return Array.of(1, 2, 3).length; }
`;

const standaloneModules = new Map<string, Promise<WebAssembly.Exports>>();
function standaloneLane(key: string, source: string): Promise<WebAssembly.Exports> {
  let cached = standaloneModules.get(key);
  if (cached === undefined) {
    cached = (async () => {
      const result = await compile(source, {
        fileName: `issue-6421-${key}.js`,
        allowJs: true,
        skipSemanticDiagnostics: true,
        target: "standalone",
        hostBridge: "always",
      });
      expect(result.success, result.errors.map((error) => `L${error.line}: ${error.message}`).join("\n")).toBe(true);
      const { instance } = await WebAssembly.instantiate(result.binary, result.importObject ?? {});
      return instance.exports;
    })();
    standaloneModules.set(key, cached);
  }
  return cached;
}

const STANDALONE_ROWS: readonly { name: string; expected: number }[] = [
  { name: "literalLength", expected: 3 },
  { name: "literalFirstCode", expected: 65 },
  { name: "literalLastCode", expected: 67 },
  { name: "literalWithFixedLength", expected: 4 },
  { name: "carrierLength", expected: 3 },
  { name: "dynamicArrayLength", expected: 3 },
  { name: "codePointsLength", expected: 3 },
  { name: "arrayOfLength", expected: 3 },
  { name: "arrayOfSecond", expected: 2 },
];

const STANDALONE_CONTROLS: readonly { name: string; expected: number }[] = [
  { name: "controlNoSpreadLength", expected: 3 },
  { name: "controlCodePointNoSpread", expected: 3 },
  { name: "controlMathMax", expected: 5 },
  { name: "controlArrayOfLength", expected: 3 },
];

describe("#6421 standalone lane — the same expansion with no host imports", () => {
  // Parent commit: all nine fail at INSTANTIATION, not on a value — a
  // standalone `Array.of(...xs)` fell through to the host path and imported
  // `__js_array_new` / `__array_of`, which the native-first adapter refuses to
  // bind ("legacy-semantic import owned by #4397"). That is a harder failure
  // than the length-0 vec the issue predicted.
  for (const row of STANDALONE_ROWS) {
    it(`${row.name} → ${row.expected} (parent: module would not instantiate)`, async () => {
      const exports = await standaloneLane("standalone", STANDALONE_SOURCE);
      expect((exports[row.name] as () => number)()).toBe(row.expected);
    });
  }
});

describe("#6421 standalone lane — the forms that already worked keep working", () => {
  for (const row of STANDALONE_CONTROLS) {
    it(`${row.name} → ${row.expected}`, async () => {
      const exports = await standaloneLane("standalone-control", STANDALONE_CONTROL_SOURCE);
      expect((exports[row.name] as () => number)()).toBe(row.expected);
    });
  }
});
