// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#2001 S1) Sparse-array hole representation — the `$Hole` anyref sentinel.
//
// A dense WasmGC vec (`struct(field0 length:i32, field1 data:(ref $arr_<elem>))`)
// has no native concept of an "absent" index. For an `any[]` / untyped array the
// element ValType is `externref`, and a literal elision (`OmittedExpression`,
// e.g. the gap in `[1, , 3]`) was previously lowered the same way an explicit
// `undefined` is — `emitUndefined` → the slot held JS `undefined`. A hole was
// therefore *indistinguishable* from a real `undefined`, so no array HOF could
// honour the spec's `HasProperty(O, ‹k›) is false ⇒ skip` rule (§23.1.3.*).
//
// The ratified representation (issue #2001 architect spec, 2026-06-21) is a
// single module-global **`$Hole`** sentinel: a unique, immutable, zero-field
// WasmGC struct whose ref identity is distinct from every value the language
// can produce (`undefined`, `null`, `$box_number`, NativeString, `$Object`,
// closures, i31ref, …). A vec slot equal to `$Hole` (by `ref.test (ref $Hole)`)
// *is* an absent index; anything else is present.
//
// **Scope (S1).** Only `any[]` / untyped array literals whose vec element
// ValType is `externref` participate. Typed `number[]` / `boolean[]` /
// `string[]` / struct `T[]` vecs (f64 / i32 / ref elements) are byte-identical —
// they never see a `$Hole` struct type, a `ref.test`, or any new op. This keeps
// the dense numeric kernel unchanged (the #1852 §3 typed-mainline-unboxed
// invariant applied locally).
//
// **Standalone parity.** `$Hole` is a pure WasmGC struct + global; the
// `ref.test` dispatch and `struct.new` const-init are engine-native and work
// identically under `--target standalone` / `wasi`. No host import. The
// read-boundary `$Hole → undefined` mapping reuses the existing `emitUndefined`
// (host: `__get_undefined`; standalone: `ref.null.extern`).
//
// **Critical invariant.** A hole is NEVER observed *as* the sentinel. Per
// §ToObject/Get, reading an absent index yields `undefined`, not the sentinel.
// Every value-producing read of a vec slot that may hold `$Hole` maps
// `$Hole → undefined` at the read boundary (`emitHoleToUndefined`); the sentinel
// is internal-only and must not leak into a binding, callback arg, coercion, or
// `===`.

import { ts, forEachChild } from "../ts-api.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import type { Instr, StructTypeDef } from "../ir/types.js";
import { allocTempLocal } from "./context/locals.js";
import { emitUndefined } from "./expressions/late-imports.js";

/**
 * Cheap AST pre-scan: set `ctx.usesArrayHoles` when the program contains any
 * array-literal elision (`OmittedExpression`). Runs once before body
 * compilation (mirrors `scanForNewTarget`). When clear — the common case — the
 * hole read-guard is never emitted and every array read stays byte-identical.
 *
 * Setting the flag in a pre-pass (rather than lazily at the first hole-store)
 * is what lets a `a[i]` element *read* in one function emit the `$Hole → undefined`
 * guard even though the hole-bearing literal lives in a *different* function
 * compiled later — function compilation order is not source order, so a per-site
 * lazy flag would desync reads against stores.
 */
export function scanForArrayHoles(ctx: CodegenContext, root: ts.Node): void {
  const visit = (node: ts.Node): void => {
    if (ctx.usesArrayHoles && ctx.arrayProtoIndexDirty) return;
    if (ts.isArrayLiteralExpression(node)) {
      for (const el of node.elements) {
        if (ts.isOmittedExpression(el)) {
          ctx.usesArrayHoles = true;
          break;
        }
      }
    }
    if (!ctx.arrayProtoIndexDirty && isArrayProtoIndexWrite(node)) {
      ctx.arrayProtoIndexDirty = true;
    }
    forEachChild(node, visit);
  };
  visit(root);
}

/** Structurally `Array.prototype` (`PropertyAccess(Identifier "Array", "prototype")`). */
function isArrayPrototypeExpr(node: ts.Node): boolean {
  return (
    ts.isPropertyAccessExpression(node) &&
    node.name.text === "prototype" &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "Array"
  );
}

/**
 * (#2001 S2 / PR #2832 park) Does this node WRITE an index property onto
 * `Array.prototype`? Detects the shapes test262 uses to make a hole's index
 * visible through the prototype chain (`HasProperty(O, k)` true although the
 * own slot is absent):
 *
 *   - `Object.defineProperty(Array.prototype, "0", …)` (and `defineProperties`
 *     / `Reflect.defineProperty`);
 *   - `Array.prototype[0] = …` / `Array.prototype["0"] = …` (any assignment
 *     operator; the index need not be a literal — `Array.prototype[i] = …`
 *     also counts).
 *
 * Property-name writes (`Array.prototype.foo = …`) do NOT set the flag — they
 * cannot make an integer index inherited. Reads (`Array.prototype.slice`) are
 * ignored entirely. This is a deliberate static over-approximation: a module
 * that dirties `Array.prototype` indices anywhere loses the HOF hole
 * visit-skip everywhere (falling back to the pre-S2 visit-with-`undefined`
 * behavior), because the flat vec cannot check the prototype per element at
 * runtime. See `arrayProtoIndexDirty` in context/types.ts.
 */
function isArrayProtoIndexWrite(node: ts.Node): boolean {
  // Object.defineProperty(Array.prototype, …) / Object.defineProperties /
  // Reflect.defineProperty — first argument is Array.prototype.
  if (ts.isCallExpression(node) && node.arguments.length > 0 && isArrayPrototypeExpr(node.arguments[0])) {
    const callee = node.expression;
    if (
      ts.isPropertyAccessExpression(callee) &&
      ts.isIdentifier(callee.expression) &&
      (callee.expression.text === "Object" || callee.expression.text === "Reflect") &&
      (callee.name.text === "defineProperty" || callee.name.text === "defineProperties")
    ) {
      return true;
    }
  }
  // Array.prototype[…] = … — element-access assignment target (any assignment op).
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
    ts.isElementAccessExpression(node.left) &&
    isArrayPrototypeExpr(node.left.expression)
  ) {
    return true;
  }
  return false;
}

/**
 * Lazily register the `$Hole` struct type and the `$__hole` singleton global.
 * Idempotent — returns the absolute global index, caches both the type index
 * (`ctx.holeTypeIdx`) and the global index (`ctx.holeGlobalIdx`).
 *
 * Registered **late** (during body compilation, after class collection) and
 * **once**, per `project_type_index_shift_and_deadelim`: pushing a struct type
 * mid-class-collection would desync class struct typeidxs. Both call sites
 * (literal store + element read) run inside `compileDeclarations`, so the type
 * is always appended after the class struct types are fixed.
 *
 * The global is **immutable** with a constant `struct.new $Hole` initializer —
 * a valid WasmGC constant init expression for a zero-field immutable struct, so
 * `$Hole`'s ref identity is fixed at instantiation and every `global.get`
 * yields the same ref (required for `ref.test`/`ref.eq` identity). A const init
 * never contains a `call`, so it is immune to late-import index shifts.
 */
export function ensureHoleType(ctx: CodegenContext): number {
  if (ctx.holeGlobalIdx !== undefined) return ctx.holeGlobalIdx;

  // $Hole = (struct) — zero fields, immutable.
  const holeTypeIdx = ctx.mod.types.length;
  ctx.mod.types.push({ kind: "struct", name: "Hole", fields: [] } as StructTypeDef);
  ctx.holeTypeIdx = holeTypeIdx;
  ctx.structMap.set("Hole", holeTypeIdx);
  ctx.typeIdxToStructName.set(holeTypeIdx, "Hole");
  ctx.structFields.set("Hole", []);

  // (global $__hole (ref $Hole) (struct.new $Hole)) — immutable singleton.
  const globalIdx = ctx.numImportGlobals + ctx.mod.globals.length;
  ctx.mod.globals.push({
    name: "__hole",
    type: { kind: "ref", typeIdx: holeTypeIdx },
    mutable: false,
    init: [{ op: "struct.new", typeIdx: holeTypeIdx } as Instr],
  });
  ctx.holeGlobalIdx = globalIdx;
  return globalIdx;
}

/**
 * Push the `$Hole` sentinel as an `externref`, ready to store into an
 * externref-element vec slot (`array.new_fixed` / `array.set`).
 * Stack: `[] → [externref]`.
 */
export function emitHoleSentinel(ctx: CodegenContext, fctx: FunctionContext): void {
  const globalIdx = ensureHoleType(ctx);
  fctx.body.push({ op: "global.get", index: globalIdx } as Instr);
  fctx.body.push({ op: "extern.convert_any" } as Instr);
}

/**
 * Read-boundary mapping: if the externref on the stack is the `$Hole` sentinel,
 * replace it with `undefined`; otherwise leave it unchanged.
 * Stack: `[externref] → [externref]`.
 *
 * The single most important correctness rule for sparse arrays — the sentinel
 * must never leak past a value-producing read. Reusable across S1 (element read,
 * join) and the later HOF / destructuring slices.
 */
export function emitHoleToUndefined(ctx: CodegenContext, fctx: FunctionContext): void {
  for (const instr of holeToUndefinedInstrs(ctx, fctx)) fctx.body.push(instr);
}

/**
 * Detached-`Instr[]` form of {@link emitHoleToUndefined}, for call sites that
 * assemble a callback-arg / loop-body instruction list off `fctx.body` (e.g.
 * `buildClosureCallInstrs`). Allocates the scratch temp via `fctx` and resolves
 * the `undefined` value up front (flushing any late-import shift into the
 * current body BEFORE the funcIdx is baked into the returned instrs), so the
 * sequence can be spliced anywhere. Stack: `[externref] → [externref]`.
 */
export function holeToUndefinedInstrs(ctx: CodegenContext, fctx: FunctionContext): Instr[] {
  // Callers gate on `ctx.usesArrayHoles`, so register `$Hole` here if a literal
  // store hasn't yet — function compilation order is not source order, and the
  // read of `a[i]` can be compiled before the `[1, , 3]` that introduces the
  // sentinel. Registering at the read site keeps the `ref.test` typeidx valid
  // either way (still after class collection — index-shift-safe).
  ensureHoleType(ctx);
  const holeTypeIdx = ctx.holeTypeIdx;
  const tmp = allocTempLocal(fctx, { kind: "externref" });

  // Resolve the `undefined` push now, flushing any late-import index shift into
  // `fctx.body` before the funcIdx is baked into the detached `then` arm.
  const undefBody: Instr[] = [];
  const saved = fctx.body;
  fctx.body = undefBody;
  emitUndefined(ctx, fctx);
  fctx.body = saved;

  return [
    { op: "local.tee", index: tmp } as Instr,
    { op: "any.convert_extern" } as Instr,
    { op: "ref.test", typeIdx: holeTypeIdx } as Instr,
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "externref" } },
      then: undefBody,
      else: [{ op: "local.get", index: tmp } as Instr],
    } as Instr,
  ];
}

/**
 * Instruction list form of the hole test for the array-join fold, where the
 * element-to-string conversion is assembled as a detached `Instr[]` (not pushed
 * onto `fctx.body`). Given the element `externref` already on the (virtual)
 * stack, returns instrs that leave `i32` = 1 iff the element is `$Hole`.
 * Caller wraps `whenHole` / `whenPresent` in the `if`. Registers `$Hole` on
 * demand (caller gates on `usesArrayHoles`), so the `ref.test` typeidx is valid
 * even if no hole-literal has been compiled yet in this module.
 */
export function holeTestInstrs(ctx: CodegenContext): Instr[] {
  ensureHoleType(ctx);
  const holeTypeIdx = ctx.holeTypeIdx;
  return [{ op: "any.convert_extern" } as Instr, { op: "ref.test", typeIdx: holeTypeIdx } as Instr];
}
