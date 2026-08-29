// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #5169 — a module that compiles clean and does NOT validate:
//   `CompileError: … immutable global #988 cannot be assigned`
//
// WHY compile() cannot see it. `compile()` reports success because nothing is
// wrong with the SOURCE — the defect is an index that drifts inside the
// emitter. String constants are IMPORTED globals (`(import "string_constants"
// … (global … externref))`, registered `mutable: false`), and an import is
// inserted at the END of the import-global range, i.e. the START of the
// module-global range. So every intern shifts every module global up by one,
// and `fixupModuleGlobalIndices` repairs the already-baked `global.get`/
// `global.set` instructions it can REACH: `ctx.mod.functions`,
// `ctx.currentFunc.body` + its `savedBodies`, `ctx.funcStack`,
// `ctx.parentBodiesStack`, `ctx.pendingInitBody`, and `ctx.liveBodies`.
//
// THE HOLE. `tryEmitConstructorViaTag` (src/codegen/property-access.ts) lowers
// an `any`-receiver `.constructor` read into a flat `__tag`-equality dispatch,
// one arm per tag-bearing class. It builds each arm in a DETACHED buffer via
// the manual swap `savedBody = fctx.body; fctx.body = arm`. During that window
// the enclosing body is reachable from nothing on the list above —
// `ctx.currentFunc.body` IS the arm — and `emitLazyClassObjectGet` interns
// freely (its static-method CSV, `name`, the class name, every static method
// name, and via the nested `emitLazyProtoGet` the instance-method CSV). So the
// PREVIOUS arm, already spliced into the enclosing body, kept its pre-shift
// indices.
//
// WHY ONE MISS IS FATAL. The miss costs exactly one slot — and then the index
// sits BELOW the next fixup's threshold, so it is frozen there permanently
// while the module-global range keeps sliding up. On the linked
// `@js-temporal/polyfill@0.5.1` + `jsbi@4.3.0` bundle it drifted 848 slots and
// landed the class-object `global.set` on string-constant import #988.
//
// THE FIXTURE. Four classes with static + instance methods (so each arm interns
// a CSV no other constant already covers), one `any`-typed `.constructor` read
// that is not inlined away, and enough distinct string literals afterwards to
// push the import range past the frozen index — which is what turns a silently
// WRONG global into an invalid module. Both halves are asserted: `compile()`
// clean (true before the fix too) AND `WebAssembly.compile()` accepting the
// binary (false before the fix).

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/** Four tag-bearing classes; each carries two statics and two instance methods. */
const CLASSES = ["Alpha", "Beta", "Gamma", "Delta"]
  .map(
    (c, i) => `
class ${c} {
  f${i} = ${i};
  static make${c}() { return new ${c}(); }
  static probe${c}() { return ${i}; }
  ${c.toLowerCase()}One() { return this.f${i}; }
  ${c.toLowerCase()}Two() { return this.f${i} + 1; }
}`,
  )
  .join("\n");

/**
 * 150 distinct literals interned AFTER the dispatch is emitted. A frozen index
 * only becomes INVALID once the import-global range grows past it; without this
 * tail the stale `global.set` still lands on a (mutable) module global, so the
 * module validates while quietly writing the wrong singleton.
 */
const LITERAL_TAIL = Array.from({ length: 150 }, (_, i) => `  sink("zz_distinct_literal_${i}");`).join("\n");

const SOURCE = `${CLASSES}
let acc = 0;
function sink(s) { acc += s.length; }
export function ctorOf(v) {
  try {
    const c = v.constructor;
    if (c === Alpha) return 1;
    if (c === Beta) return 2;
    if (c === Gamma) return 4;
    if (c === Delta) return 8;
  } catch (e) { return -1; }
  return 0;
}
export function run() {
  const n = ctorOf(new Alpha()) + ctorOf(new Beta()) + ctorOf(new Gamma()) + ctorOf(new Delta());
${LITERAL_TAIL}
  return acc + n;
}
`;

describe("#5169 — class-object singleton index must survive a detached dispatch arm", () => {
  it("compiles clean AND emits a module WebAssembly.compile accepts", async () => {
    const result = await compile(SOURCE, { allowJs: true, skipSemanticDiagnostics: true, emitWat: true });

    // Half one — always true, including on the buggy compiler. Stated so a
    // future failure is unambiguous about WHICH gate moved.
    expect(result.success).toBe(true);
    expect((result.errors ?? []).filter((e) => e.severity !== "warning")).toEqual([]);
    expect(result.binary && result.binary.length).toBeTruthy();

    // Half two — the actual regression. Before the fix this rejected with
    // `… immutable global #<N> cannot be assigned` in `ctorOf` on this fixture
    // (the exact slot moves with unrelated codegen; the second test asserts the
    // engine-independent invariant behind it).
    await expect(WebAssembly.compile(result.binary!)).resolves.toBeInstanceOf(WebAssembly.Module);
  });

  it("emits no store into the immutable imported-global range", async () => {
    const result = await compile(SOURCE, { allowJs: true, skipSemanticDiagnostics: true, emitWat: true });
    const lines = (result.wat ?? "").split("\n");

    // Import globals occupy [0, importGlobalCount); every one of them is a
    // `string_constants` carrier registered `mutable: false`.
    let importGlobalCount = 0;
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("(import") && /\(global\s/.test(trimmed)) importGlobalCount++;
    }
    expect(importGlobalCount).toBeGreaterThan(0);

    // A direct read of the invariant, independent of any one engine's error
    // text: no `global.set` may name a slot inside the import range.
    let currentFunc = "<top-level>";
    const offenders: string[] = [];
    for (const line of lines) {
      const funcStart = /^\s*\(func \$(\S+)/.exec(line);
      if (funcStart) currentFunc = funcStart[1]!;
      const store = /^\s*global\.set (\d+)\s*$/.exec(line);
      if (store && Number(store[1]) < importGlobalCount) offenders.push(`${currentFunc} → global.set ${store[1]}`);
    }
    expect(offenders).toEqual([]);
  });
});
