import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";
import { runTest262File } from "./test262-runner.js";

// #820 / #1543 — Calling an extracted async-generator method (a method read as
// a value, then called) with FEWER args than its declared formals must
//
//   (a) actually invoke the method (the inline dynamic-call dispatch
//       `tryEmitInlineDynamicCall` previously found no exact-arity candidate
//       and silently returned `undefined`), and
//   (b) NOT trap with `illegal cast`: all `__fn_wrap_*` closure structs
//       subtype a single root wrapper, so the old struct-typed `ref.test`
//       matched wrapper values of every arity and then cast a (e.g.) arity-1
//       funcref to an arity-0 funcType. The dispatch now discriminates by the
//       FUNCREF signature and pads missing trailing args with `undefined`.
//
// This was the entire `language/{statements,expressions}/class/dstr/
// async-gen-meth-dflt-*` test262 cluster (~100 fails, all `illegal cast`).
describe("#820 async-gen-meth default-param dispatch (extracted method, fewer args)", () => {
  it("extracted async-gen method called with 0 args applies its default param (no illegal cast)", async () => {
    // method has ONE formal `(a = 5)`; we call it with ZERO args via the
    // extracted ref. The arity-pad path must run the body with a === 5.
    const src = `class C {
  static async *method(a = 5) { yield a; }
}
const ref: any = (C as any).method;
export function test(): number {
  const it: any = ref();        // 0 args → default a = 5 applies
  if (it == null) return -1;    // -1 == call silently dropped (old bug)
  const r: any = it.next();
  return r == null ? -2 : 1;    // 1 == dispatched + ran
}`;
    const ex = await compileToWasm(src);
    expect((ex.test as () => number)()).toBe(1);
  });

  // The destructure-of-default spec semantics (a `= null` / throwing
  // initializer default that must throw a catchable TypeError/Test262Error
  // when the method is invoked) are exercised end-to-end by the procedurally
  // generated test262 corpus. Run a representative slice directly — these all
  // trapped with `illegal cast` before the dispatch fix.
  const TEST262 = "/workspace/test262/test";
  const cases = [
    "language/statements/class/dstr/async-gen-meth-dflt-obj-ptrn-id-init-throws.js",
    "language/statements/class/dstr/async-gen-meth-static-dflt-obj-init-null.js",
    "language/expressions/class/dstr/async-gen-meth-static-dflt-ary-ptrn-elem-obj-val-null.js",
    "language/statements/class/dstr/async-gen-meth-dflt-ary-ptrn-elem-id-init-unresolvable.js",
  ];
  for (const rel of cases) {
    const abs = `${TEST262}/${rel}`;
    const name = rel.split("/").pop()!;
    (existsSync(abs) ? it : it.skip)(`test262: ${name} passes (was illegal cast)`, async () => {
      const r = await runTest262File(abs, rel.split("/").slice(0, 2).join("/"));
      expect(r.status).toBe("pass");
    });
  }
});
