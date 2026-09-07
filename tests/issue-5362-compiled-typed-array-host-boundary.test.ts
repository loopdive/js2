// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#5362) A TypedArray built in COMPILED code must reach a host API as a real
// host TypedArray, not as the generic vec facade.
//
// A compiler-created `Uint8Array` and an ordinary `Array` share ONE WasmGC vec
// carrier; codegen brands the former by calling `__register_typed_array`.
// `__make_iterable`'s `convertToJS` honoured that brand and produced a concrete
// `Uint8Array`, but `_wrapForHost` — the marshaller EVERY host-call argument
// goes through — did not, and handed out the array-shaped Proxy instead.
//
// A Proxy can never satisfy a WebIDL `BufferSource` parameter: `ArrayBuffer
// .isView` reads internal slots, which a Proxy does not forward. So hono's
// signed-cookie helper
//
//     crypto.subtle.importKey('raw', secretBuf, {name:'HMAC', …}, false, ['sign'])
//
// rejected with "2nd argument is not instance of ArrayBuffer, Buffer,
// TypedArray, or DataView" whenever `secretBuf` was a compiled carrier. Nothing
// observed that rejection, so it became an UNHANDLED rejection that killed the
// dogfood worker process — the whole module scored 0 (hono 244 → 220/324, all
// 24 losses in `src/utils/cookie.test.ts`).
//
// Two shape details are load-bearing for non-vacuity, both learned by
// measurement rather than assumed:
//
//  * The typed array must be `const`-BOUND and passed on, exactly as
//    `cookie.test.ts:911` does. An INLINE `new Uint8Array([…])` call argument
//    does NOT reproduce — that arm constructs a host TypedArray directly.
//  * The host call must be made from an UNTYPED `.js` module (hono's published
//    `dist/utils/cookie.js`). With `: any` annotations the call routes through
//    a different arm.
//
// The second producer is `new Uint8Array(n)` + an index-fill loop — hono's own
// `verifySignature` idiom — rather than a bare `new TextEncoder().encode(…)`.
// A host-built typed array crossing a module boundary is narrowed into an
// UNBRANDED vec by `__vec_from_extern_<N>` and still arrives as a plain array,
// and `new Uint8Array(<host typed array>)` builds an EMPTY compiled carrier.
// Both are separate, pre-existing defects on the HOST-built side; neither is
// the regression fixed here, and both are recorded in #5362 as follow-ups.
// Covering them here would have made this test assert wrong behaviour.
//
// The lane matters too: this mirrors the dogfood worker's configuration
// (`deferTopLevelInit`, web platform, `buildCompiledImports` + `wrapExports`).
// The plain `instantiateWithRuntime` lane does NOT reproduce — it builds a host
// TypedArray for the same source and reports a false pass.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { compileProject } from "../src/index.js";
import { buildCompiledImports, wrapExports } from "../src/runtime.js";
import { getWebHostConstructors } from "../src/runtime/web-host-constructors.js";

const roots: string[] = [];
afterAll(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

// Untyped package half — every value here is `any` to the checker, exactly like
// hono's published `dist/utils/cookie.js`.
const MOD = `const algorithm = { name: "HMAC", hash: "SHA-256" };

export function describeValue(probe, value) {
  return probe.describe(value);
}

export function importRaw(secret) {
  return crypto.subtle.importKey("raw", secret, algorithm, false, ["sign"]);
}

export function fillRandom(buf) {
  crypto.getRandomValues(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i];
  return sum;
}`;

const ENTRY = `import { describeValue, importRaw, fillRandom } from "./mod.js";

const describe_ = describeValue as unknown as (probe: unknown, value: unknown) => string;
const importRaw_ = importRaw as unknown as (secret: unknown) => unknown;
const fillRandom_ = fillRandom as unknown as (buf: unknown) => number;

export function shapeOfConstBound(probe: unknown): string {
  const secret = new Uint8Array([172, 142, 204, 63, 210, 136, 58, 143, 25, 18, 159, 16, 161, 34, 94]);
  return describe_(probe, secret);
}

export function shapeOfSizedAndFilled(probe: unknown): string {
  const text = "secret ingredient";
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  return describe_(probe, bytes);
}

export function shapeOfPlainArray(probe: unknown): string {
  const values = [172, 142, 204];
  return describe_(probe, values);
}

export function keyFromConstBound(): unknown {
  const secret = new Uint8Array([172, 142, 204, 63, 210, 136, 58, 143, 25, 18, 159, 16, 161, 34, 94]);
  return importRaw_(secret);
}

export function keyFromSizedAndFilled(): unknown {
  const text = "secret ingredient";
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  return importRaw_(bytes);
}

export function randomSumOfCompiledBuffer(): number {
  const buf = new Uint8Array(24);
  return fillRandom_(buf);
}`;

/** Host-side observer: what did the compiled value actually arrive as? */
const probe = {
  describe(value: unknown): string {
    if (ArrayBuffer.isView(value)) return `view:${(value as object).constructor.name}`;
    if (Array.isArray(value)) return "array";
    return `other:${typeof value}`;
  },
};

type Exports = {
  shapeOfConstBound: (probe: unknown) => unknown;
  shapeOfSizedAndFilled: (probe: unknown) => unknown;
  shapeOfPlainArray: (probe: unknown) => unknown;
  keyFromConstBound: () => unknown;
  keyFromSizedAndFilled: () => unknown;
  randomSumOfCompiledBuffer: () => unknown;
};

let cached: Promise<Exports> | undefined;

function compiled(): Promise<Exports> {
  cached ??= (async () => {
    const root = mkdtempSync(join(tmpdir(), "js2-5362-"));
    roots.push(root);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "mod.js"), MOD);
    writeFileSync(join(root, "entry.ts"), ENTRY);
    const result = await compileProject(join(root, "entry.ts"), {
      allowJs: true,
      skipSemanticDiagnostics: true,
      target: "gc",
      platform: "web",
      experimentalIR: true,
      emitWat: false,
      deferTopLevelInit: true,
    });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    const imports = buildCompiledImports(result, { ...getWebHostConstructors(), crypto: globalThis.crypto });
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    (imports as { setInstance?: (i: WebAssembly.Instance) => void }).setInstance?.(instance);
    (instance.exports as { __module_init?: () => void }).__module_init?.();
    return wrapExports(instance, { signatures: result.exportSignatures }) as unknown as Exports;
  })();
  return cached;
}

describe("#5362 a compiled TypedArray crosses to a host API as a TypedArray", () => {
  it("a const-bound Uint8Array arrives as a Uint8Array, not an array facade", async () => {
    const exports = await compiled();
    expect(String(await exports.shapeOfConstBound(probe))).toBe("view:Uint8Array");
  });

  it("a sized-and-filled Uint8Array arrives as a Uint8Array", async () => {
    const exports = await compiled();
    expect(String(await exports.shapeOfSizedAndFilled(probe))).toBe("view:Uint8Array");
  });

  // Anti-vacuity: the brand is what decides. An ordinary array literal shares
  // the same vec carrier and must keep arriving as a plain Array — if this
  // flipped to a view, the fix would be marshalling every vec as a TypedArray.
  it("a plain array literal still arrives as a plain array", async () => {
    const exports = await compiled();
    expect(String(await exports.shapeOfPlainArray(probe))).toBe("array");
  });

  it("WebCrypto importKey accepts a const-bound compiled Uint8Array", async () => {
    const exports = await compiled();
    const key = (await exports.keyFromConstBound()) as { type?: string };
    expect(key?.type).toBe("secret");
  });

  it("WebCrypto importKey accepts a sized-and-filled compiled Uint8Array", async () => {
    const exports = await compiled();
    const key = (await exports.keyFromSizedAndFilled()) as { type?: string };
    expect(key?.type).toBe("secret");
  });

  // The array facade wrote host mutations straight through to the vec. The
  // mirror must not lose that: `crypto.getRandomValues(buf)` fills the buffer
  // in place, and compiled code reads the result back off the vec.
  it("a host API that WRITES into the buffer is still observed by compiled code", async () => {
    const exports = await compiled();
    expect(Number(await exports.randomSumOfCompiledBuffer())).toBeGreaterThan(0);
  });
});
