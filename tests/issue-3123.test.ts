/**
 * #3123 — `class C extends F` where F is a top-level PLAIN FUNCTION (fnctor)
 * with a runtime-assigned `.prototype` (the test262 harness `Iterator` shim).
 *
 * Five stacked fixes, mirroring the residual Iterator-helper cluster
 * (`exhaustion-does-not-call-return` / `return-is-forwarded` /
 * `iterable-to-iterator-fallback`, ~8 files):
 *  1. ctor registration (`__register_fnctor_instance`) — instances resolve
 *     INHERITED members through F's live `.prototype` chain host-side
 *     (`_fnctorInstanceCtor` → `_fnctorProtoLookup`).
 *  2. class-member kind exports (`__member_kind_<k>` / `__call_get_<k>`) —
 *     the host reads compiled class methods (`next`/`return`) and getters
 *     (`get next()`) off the instance, marshaled via the #3049 bridges.
 *  3. calls.ts dynamic routes — a method MISS on a fnctor-subclass receiver
 *     (`.drop(0)`) and every member call on a WIDENED binding dispatch via
 *     `__extern_method_call` instead of the graceful-null / null-self-static
 *     paths; the any-receiver class-INFERENCE scan skips fnctor subclasses.
 *  4. slot widening — a `let` binding of fnctor-subclass type reassigned
 *     with a foreign value (`iterator = iterator.drop(0)`) gets an externref
 *     slot so the host wrapper is not nulled by the guarded cast.
 *  5. host-lane deferral of capturing DERIVED classes (#2818 gate narrowed to
 *     standalone) — a try-block `class C extends F { m() { ++captured; } }`
 *     promotes its captures instead of silently compiling `++captured` to a
 *     no-op (`f64.const NaN; drop`).
 * Plus: computed well-known-symbol struct FIELDS (`{ [Symbol.iterator]: 0 }`)
 * are host-readable via `__sget_@@<name>`, so GetIteratorFlattenable throws
 * TypeError on a non-callable @@iterator per spec.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";

async function run(src: string): Promise<any> {
  const result = await compile(src, {
    fileName: "test.ts",
    skipSemanticDiagnostics: true,
    deferTopLevelInit: true,
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

const SHIM = `
function Iterator(this: any): void {}
(Iterator as any).prototype = Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()));
`;

describe("#3123 — class extends fnctor: live-prototype member resolution", () => {
  it("instance resolves own methods AND inherited helpers dynamically", async () => {
    const src = `${SHIM}
class TestIterator extends Iterator {
  next(): any { return { done: false, value: 1 }; }
  return(): any { return {}; }
}
export function test(): number {
  const it: any = new TestIterator();
  if (it == null) return -1;
  if (typeof it.next !== "function") return -2;
  if (typeof it.drop !== "function") return -3;
  return 1;
}
`;
    await expect(run(src)).resolves.toBe(1);
  });

  it("return-is-forwarded: helper wrapper forwards return() to the instance ONCE", async () => {
    const src = `${SHIM}
let returnCount = 0;
class TestIterator extends Iterator {
  next(): any { return { done: false, value: 1 }; }
  return(): any { ++returnCount; return {}; }
}
export function test(): number {
  let iterator: any = new TestIterator().drop(0);
  const c0: number = returnCount;
  iterator.return();
  const c1: number = returnCount;
  iterator.return();
  const c2: number = returnCount;
  return c0 * 100 + c1 * 10 + c2; // expect 0/1/1 → 11
}
`;
    await expect(run(src)).resolves.toBe(11);
  });

  it("captured block-local in a try-scoped fnctor subclass increments (host defer)", async () => {
    const src = `${SHIM}
export function test(): number {
  let out = -100;
  try {
    let returnCount = 0;
    class TestIterator extends Iterator {
      next() {
        return { done: false, value: 1 };
      }
      return() {
        ++returnCount;
        return {};
      }
    }
    let iterator = new TestIterator().drop(0);
    const c0 = returnCount;
    iterator.return();
    const c1 = returnCount;
    iterator.return();
    const c2 = returnCount;
    out = c0 * 100 + c1 * 10 + c2;
  } catch (e) {
    return -1;
  }
  return out; // expect 0/1/1 → 11
}
`;
    await expect(run(src)).resolves.toBe(11);
  });

  it("widened binding: reassigned fnctor-subclass let holds the host wrapper (getter next)", async () => {
    const src = `${SHIM}
export function test(): number {
  try {
    let calls = 0;
    class TestIterator extends Iterator {
      get next() {
        return function (): any {
          ++calls;
          return calls <= 2 ? { done: false, value: calls } : { done: true, value: undefined };
        };
      }
      return() {
        throw new Error("return must NOT be called on exhaustion");
      }
    }
    let iterator = new TestIterator();
    iterator = iterator.drop(0);
    iterator.next();
    iterator.next();
    iterator.next();
    iterator.next(); // exhausted — must not call return()
    return 1;
  } catch (e) {
    return -1;
  }
}
`;
    await expect(run(src)).resolves.toBe(1);
  });

  it("non-callable computed @@iterator field is host-visible (GetMethod throws TypeError)", async () => {
    const src = `
function* g(): any {
  yield 0;
}
export function test(): number {
  const iter: any = g().flatMap(function (v: any): any {
    return { [Symbol.iterator]: 0, next: function (): any { return { done: true, value: undefined }; } };
  });
  try {
    iter.next();
    return -1; // should have thrown TypeError
  } catch (e) {
    return 1;
  }
}
`;
    await expect(run(src)).resolves.toBe(1);
  });

  it("static dispatch on a never-reassigned fnctor-subclass binding is unaffected", async () => {
    const src = `${SHIM}
export function test(): number {
  let n = 0;
  class A extends Iterator {
    bump(): void {
      ++n;
    }
  }
  const a = new A();
  a.bump();
  a.bump();
  return n; // typed static dispatch — 2
}
`;
    await expect(run(src)).resolves.toBe(2);
  });
});
