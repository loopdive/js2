// #6699 — axios standalone-dynamic: two call-site ABI mismatches that emitted
// invalid Wasm (V8 rejected the module at compile time).
//
// 1. `header.forEach(deleteHeader)` where `deleteHeader` is a capture-carrying
//    nested declaration read through the runtime-eval dynamic-global path (the
//    module holds a `Function` site): the standalone dynamic-callback recovery
//    keyed the funcref wrapper on the LIFTED signature (captures + formals)
//    instead of the value's signature, so the `call_ref` expected 7 operands
//    and got 4.
// 2. A class with both `concat(...t)` and `static concat(first, ...t)`: the two
//    shared one `funcRestParams` entry (last-wins), so one member's call sites
//    packed arguments against the other's `restIndex`.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function compileStandalone(src: string) {
  const r = await compile(src, {
    fileName: "test.js",
    target: "standalone",
    allowJs: true,
    runtimeEvalProvider: false,
  } as never);
  expect(r.success, r.success ? "" : JSON.stringify(r.errors?.slice(0, 3))).toBe(true);
  let validationError = "";
  try {
    new WebAssembly.Module(r.binary);
  } catch (error) {
    validationError = (error as Error).message;
  }
  expect(validationError).toBe("");
  return new WebAssembly.Instance(new WebAssembly.Module(r.binary), {}).exports as Record<string, () => number>;
}

describe("#6699 — axios standalone callable ABI", () => {
  it("dynamic forEach callback that is a capture-carrying nested declaration", async () => {
    const exports = await compileStandalone(`
export function mk(s) { return new Function("x", s); }
function normalizeHeader(h) { return h && String(h).trim().toLowerCase(); }
function findKey(obj, key) { for (const k of Object.keys(obj)) if (k.toLowerCase() === key) return k; return null; }
class H {
  constructor() { this.a = 1; this.b = 2; }
  delete(header, matcher) {
    const self = this;
    let deleted = false;
    function deleteHeader(_header) {
      _header = normalizeHeader(_header);
      if (_header) {
        const key = findKey(self, _header);
        if (key && !matcher) { delete self[key]; deleted = true; }
      }
    }
    if (Array.isArray(header)) { header.forEach(deleteHeader); } else { deleteHeader(header); }
    return deleted;
  }
}
export function test() { return new H().delete(["a", "x"]) ? 1 : 0; }
`);
    expect(exports.test!()).toBe(1);
  });

  it.each([
    ["instance first", "concat(...t) { return t.length * 100 + this.x; }", ""],
    ["static first", "", "concat(...t) { return t.length * 100 + this.x; }"],
  ])("static and instance rest methods of one name keep separate ABIs (%s)", async (_label, before, after) => {
    const exports = await compileStandalone(`
class H {
  ${before}
  static concat(first, ...t) { return first * 10 + t.length; }
  constructor(x) { this.x = x; }
  ${after}
}
export function test() { return new H(3).concat(4, 5) + H.concat(7, 8, 9, 10); }
`);
    // instance: 2 rest args -> 200 + 3; static: 7 * 10 + 3 rest args
    expect(exports.test!()).toBe(276);
  });
});
