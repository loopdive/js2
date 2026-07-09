/**
 * #3049 — Iterator.prototype helpers on plain-iterator receivers.
 *
 * Three stacked fixes, each with a dedicated test:
 *  - Layer 1: top-level `F.prototype = <expr>` for a top-level function F is
 *    KEPT in host `__module_init` (was silently elided — the harness shim
 *    `Iterator.prototype = getPrototypeOf(getPrototypeOf([][Symbol.iterator]()))`
 *    never ran).
 *  - Layer 3: the `__iterator` vec-fallback iterator inherits through a shared
 *    `%ArrayIteratorPrototype%` middle proto (§23.1.5.2), so the two-hop
 *    `getPrototypeOf(getPrototypeOf(arrayIter))` walk lands on the
 *    helper-bearing `%IteratorPrototype%` instead of `Object.prototype`.
 *  - Bridge-exit marshaling (#3049): compiled closures invoked from host code
 *    return host-READABLE results (IteratorResult structs → live-mirror
 *    proxies; getter-returned closures → host-callable bridges), and
 *    captured-mutable writebacks are persistent for `.call/.apply/.bind`
 *    args + re-synced at for-of loop exit.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";

async function run(src: string, opts?: { defer?: boolean }): Promise<any> {
  const result = await compile(src, {
    fileName: "test.ts",
    skipSemanticDiagnostics: true,
    ...(opts?.defer ? { deferTopLevelInit: true } : {}),
  });
  if (!result.success) {
    throw new Error(`compile failed: ${result.errors.map((e) => e.message).join("; ")}`);
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await instantiateWasm(
    new Uint8Array(result.binary),
    imports.env,
    imports.string_constants,
    imports.string_constants16,
  );
  const ex: any = instance.exports;
  if (imports.setExports) imports.setExports(ex);
  const mi = ex.__module_init;
  if (typeof mi === "function") mi();
  return ex.test();
}

describe("#3049 — top-level fnctor prototype init + iterator-helper resolution", () => {
  it("Layer 1: top-level F.prototype = <obj> is kept in __module_init (own member)", async () => {
    const src = `
function F(this: any): void {}
(F as any).prototype = { own: 42 };
export function test(): number {
  var p: any = (F as any).prototype;
  if (p == null) return -1;
  var v: any = p.own;
  if (typeof v !== "number") return -2;
  return v;
}
`;
    await expect(run(src)).resolves.toBe(42);
  });

  it("Layer 1: top-level F.prototype assignment preserves object identity", async () => {
    const src = `
var src: any = { own: 42 };
function F(this: any): void {}
(F as any).prototype = src;
export function test(): number {
  var p: any = (F as any).prototype;
  return p === src ? 1 : 0;
}
`;
    await expect(run(src)).resolves.toBe(1);
  });

  it("Layer 3: double getPrototypeOf on an array iterator reaches the helper proto", async () => {
    const src = `
export function test(): number {
  var proto: any = Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()));
  if (proto == null) return -1;
  if (typeof proto.map !== "function") return -2;
  return 1;
}
`;
    await expect(run(src)).resolves.toBe(1);
  });

  it("full harness-shim shape: Iterator.prototype helpers resolve after deferred init", async () => {
    const src = `
function Iterator(this: any): void {}
(Iterator as any).prototype = Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()));
export function test(): number {
  var p: any = (Iterator as any).prototype;
  if (p == null) return -1;
  if (typeof p.map !== "function") return -2;
  if (typeof p.take !== "function") return -3;
  return 1;
}
`;
    await expect(run(src, { defer: true })).resolves.toBe(1);
  });

  it("this-plain-iterator: helper .call on a getter-next plain iterator counts mapper calls", async () => {
    // The exact shape of built-ins/Iterator/prototype/map/this-plain-iterator.js:
    // getter-next receiver + compiled mapper closure counting via a captured
    // local, drained by for-of.
    const src = `
function Iterator(this: any): void {}
(Iterator as any).prototype = Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()));
export function test(): number {
  let iter: any = {
    get next() {
      let count = 3;
      return function () {
        --count;
        return count >= 0 ? { done: false, value: count } : { done: true, value: undefined };
      };
    },
  };
  let mapperCalls = 0;
  iter = (Iterator as any).prototype.map.call(iter, function (v: any): any {
    ++mapperCalls;
    return v;
  });
  for (let e of iter);
  return mapperCalls;
}
`;
    await expect(run(src, { defer: true })).resolves.toBe(3);
  });

  it("bridge-exit marshal: compiled IteratorResult structs are host-readable (chain terminates)", async () => {
    const src = `
function Iterator(this: any): void {}
(Iterator as any).prototype = Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()));
export function test(): number {
  let count = 3;
  let iter: any = {
    next: function () {
      --count;
      return count >= 0 ? { done: false, value: count } : { done: true, value: undefined };
    },
  };
  let mapped: any = (Iterator as any).prototype.map.call(iter, function (v: any): any { return v; });
  var r: any = mapped.next();
  if (r == null || r.done) return -1;
  if (r.value !== 2) return -2;
  r = mapped.next();
  r = mapped.next();
  r = mapped.next();
  if (!r.done) return -3;
  return 1;
}
`;
    await expect(run(src, { defer: true })).resolves.toBe(1);
  });
});
