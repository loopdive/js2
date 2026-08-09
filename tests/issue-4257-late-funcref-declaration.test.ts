// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#4257) Every `ref.func` in a function body must be DECLARED.
//
// ## The rule this pins
//
// WasmGC/reference-types §3.4.1: `ref.func x` validates only when `x ∈ C.refs`
// — the set of function indices reachable from OUTSIDE any function body
// (element segments, global initialisers, exports). A body-only `ref.func`
// is a validation error, and V8 words it
// `undeclared reference to function #N`.
//
// js2wasm satisfies the rule with a DECLARATIVE element segment built from
// `mod.declaredFuncRefs`, populated by `collectDeclaredFuncRefs`'s body scan.
//
// ## Why a general invariant test and not a narrow repro
//
// That scan runs ONCE, mid-finalize — long before the `__extern_get` /
// dispatcher body FILLS that splice arms into already-emitted bodies. So a
// `ref.func` whose ONLY occurrence is inside a late-spliced arm was never
// declared. Two arms had already been bitten and hand-patched by pushing their
// own index (#2963's method trampolines, #2175's eval callables); the third
// (#4248 RC3's inherited builtin-proto method arm) was NOT, and shipped a
// module that V8 refused — but only on a large program, because on a small one
// the same closure happened to be `ref.func`ed by some OTHER site that the
// mid-finalize scan DID see. That accidental cover is exactly why a narrow
// repro is worthless here: it passes for the wrong reason at any size a unit
// test can afford.
//
// So this asserts the INVARIANT instead. Any future late fill that emits a
// `ref.func` without re-declaring it fails here, not in a downstream
// 460k-char provider build.
import { describe, expect, it } from "vitest";
import { analyzeSource } from "../src/checker/index.js";
import { generateModule } from "../src/codegen/index.js";
import { absoluteFuncIndex } from "../src/emit/resolve-layout.js";
import type { Instr, WasmModule } from "../src/ir/types.js";

/** Every `ref.func` target reachable from `instrs`, nested arms included. */
function refFuncTargets(instrs: Instr[], out: number[]): void {
  for (const instr of instrs) {
    if (instr.op === "ref.func") out.push((instr as { op: "ref.func"; funcIdx: number }).funcIdx);
    const nested = instr as unknown as Record<string, unknown>;
    for (const key of ["body", "then", "else", "catchAll"]) {
      const arm = nested[key];
      if (Array.isArray(arm)) refFuncTargets(arm as Instr[], out);
    }
    if (Array.isArray(nested.catches)) {
      for (const c of nested.catches as { body?: Instr[] }[]) if (Array.isArray(c.body)) refFuncTargets(c.body, out);
    }
  }
}

/**
 * The spec's `C.refs` as this emitter can produce it: the declarative segment,
 * plus every other index named outside a body (elem segments, their offsets,
 * global inits, exports). Resolved to ABSOLUTE indices — `declaredFuncRefs`
 * may hold stable handles (#1916) that a raw compare would miss.
 */
function declaredSet(mod: WasmModule): Set<number> {
  const declared = new Set<number>();
  const add = (h: number): void => void declared.add(absoluteFuncIndex(mod, h));
  for (const h of mod.declaredFuncRefs) add(h);
  for (const el of mod.elements) {
    for (const fi of el.funcIndices) add(fi);
    const offsetRefs: number[] = [];
    refFuncTargets(el.offset, offsetRefs);
    for (const fi of offsetRefs) add(fi);
  }
  for (const g of mod.globals) {
    const initRefs: number[] = [];
    refFuncTargets(g.init, initRefs);
    for (const fi of initRefs) add(fi);
  }
  for (const ex of mod.exports) if (ex.desc.kind === "func") add(ex.desc.index);
  return declared;
}

/** Function names whose body holds an undeclared `ref.func`, with the target. */
function undeclaredBodyRefs(mod: WasmModule): string[] {
  const declared = declaredSet(mod);
  const offenders: string[] = [];
  for (const func of mod.functions) {
    const targets: number[] = [];
    refFuncTargets(func.body, targets);
    for (const t of targets) {
      const abs = absoluteFuncIndex(mod, t);
      if (!declared.has(abs)) offenders.push(`${func.name} -> #${abs}`);
    }
  }
  return offenders;
}

// A tag-bearing user class plus the builtin-proto reads that mint
// `__proto_method_*` closures: the exact shape whose late `__extern_get` arm
// (#4248 RC3) emits a `ref.func` after the mid-finalize declaration scan.
const PROTO_METHOD_HEAVY = `
class Marker { x: number = 1; }
const marker = new Marker();

export function inheritedIsOwn(): boolean {
  const n: any = new Number(1);
  return n.toString === Number.prototype.toString;
}
export function protoThroughBinding(): boolean {
  const NP: any = Number.prototype;
  return typeof NP.valueOf === "function";
}
export function objectProtoToString(): boolean {
  const o: any = {};
  return o.toString === Object.prototype.toString;
}
export function stringProtoMethod(): boolean {
  const s: any = new String("a");
  return s.charAt === String.prototype.charAt;
}
export function marked(): number { return marker.x; }
`;

// Closures + higher-order calls: the pre-existing `ref.func` population, so a
// regression in the ORIGINAL scan (not just the late one) also trips.
const CLOSURE_HEAVY = `
export function apply(f: (n: number) => number, n: number): number { return f(n); }
export function makeAdder(k: number): (n: number) => number { return (n) => n + k; }
export function total(xs: number[]): number { return xs.map((x) => x * 2).reduce((a, b) => a + b, 0); }
`;

describe("#4257 — no body-only `ref.func` survives finalize", () => {
  it("standalone: late `__extern_get` arms declare the closures they reference", () => {
    const { module } = generateModule(analyzeSource(PROTO_METHOD_HEAVY), { standalone: true, nativeStrings: true });
    expect(undeclaredBodyRefs(module)).toEqual([]);
  });

  it("standalone: closure-heavy programs keep the invariant", () => {
    const { module } = generateModule(analyzeSource(CLOSURE_HEAVY), { standalone: true, nativeStrings: true });
    expect(undeclaredBodyRefs(module)).toEqual([]);
  });

  it("js-host: the invariant is not standalone-specific", () => {
    const { module } = generateModule(analyzeSource(CLOSURE_HEAVY), {});
    expect(undeclaredBodyRefs(module)).toEqual([]);
  });

  it("the detector is not vacuous — a hand-planted body-only ref.func IS reported", () => {
    const { module } = generateModule(analyzeSource(CLOSURE_HEAVY), {});
    const victim = module.functions[0]!;
    const undeclared = module.declaredFuncRefs.length + module.functions.length + module.imports.length + 1;
    victim.body = [{ op: "ref.func", funcIdx: undeclared } as Instr, ...victim.body];
    expect(undeclaredBodyRefs(module)).toEqual([`${victim.name} -> #${undeclared}`]);
  });
});
