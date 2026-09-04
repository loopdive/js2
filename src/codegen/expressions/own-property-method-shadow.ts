// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * An own property installed at RUNTIME over a prototype method of the same name
 * must win the method call (§10.1.8.1 OrdinaryGet — the own slot is consulted
 * before `[[Prototype]]`).
 *
 * `call-receiver-method.ts` already knows the collision exists, but only in its
 * DECLARED form: `hasUserClassField` looks for a struct field of externref type
 * named like the method, and declines the closed method dispatcher for it
 * ("a closed method dispatcher cannot represent that per-instance choice").
 * A shadow installed at runtime declares nothing, so that gate never fired:
 *
 *     class H { pre(x) { return x; } }
 *     const h = new H();
 *     h.pre = (x) => "W" + x;
 *     h.pre("a");            // → "a"  — the prototype method won   ✗
 *
 * The write itself is correct: it lands in the host sidecar (`_wasmStructProps`)
 * and `_safeGet` reads the sidecar BEFORE `_resolveClassMember`. Only the
 * compiled fast paths were wrong, because every one of them answers from the
 * receiver's STATIC class.
 *
 * ## Why a wrapper and not a decline
 *
 * The obvious fix — decline the static arm and let the generic host ladder
 * answer — is both too coarse and not conservative. Measured on the repro:
 * declining the two static call arms for `pre` made a receiver that carries NO
 * shadow return `null` instead of running its method, because the arms further
 * down do not all reconstruct a class-method call. And the decision has to be
 * taken from a compile-time scan that cannot see WHICH instance acquired the
 * slot, so a file-wide decline pessimises every unrelated receiver.
 *
 * So the fast path stays and gains a runtime guard. Each `(class, method)` that
 * a scan says COULD be shadowed gets one wrapper with the method's exact wasm
 * signature:
 *
 *     (func $__ownshadow_H_pre_1 (param (ref null $H) externref) (result externref)
 *       ;; own slot? → the ordinary dynamic call, which reads the sidecar first
 *       ;; else      → call $H_pre unchanged
 *
 * Call sites swap only the `funcIdx`; argument marshalling, arity padding,
 * `__argc` seeding and the result type are untouched, so a receiver without a
 * shadow runs the same body it always did, one `__hasOwnProperty` later.
 *
 * ## Why the dynamic arm cannot recurse
 *
 * `__extern_method_call(recv, "<name>", args)` resolves through the host proxy,
 * whose read prefers the sidecar. It reaches the class method only via
 * `__class_call_<name>_<arity>` — the RAW prototype entry point, which is
 * deliberately NOT wrapped. That matters for the marked shape, where the
 * installed hook closes over the method it displaced:
 *
 *     const a = r[o];                        // the prototype-method bridge
 *     r[o] = (c) => a.call(r, u.call(r, c)); // and calls it
 *
 * Wrapping the method BODY (or `__class_call_*`) instead would make `a.call(r,…)`
 * re-enter the guard, see the own slot, and loop forever.
 *
 * ## Scope of the scan
 *
 * Two admissions, both per SourceFile, both keyed on evidence that the file
 * installs a callable member:
 *
 *   1. a LITERAL-named write — `X.<m> = f`, `X["<m>"] = f`,
 *      `Object.defineProperty(X, "<m>", …)` — admits exactly `<m>`;
 *   2. a COMPUTED-key write — `X[k] = f` — admits every class method in the
 *      file, because `k` names nothing at compile time.
 *
 * (2) is the marked case and it is deliberately name-imprecise. Receiver
 * precision was tried first and does not exist to be had: TypeScript types
 * marked's `r` in `for (const o in n.hooks) { r[o] = … }` as `any` (measured
 * 2026-09-03 against the pinned 18.0.2 bundle — all four writes report
 * `symbol=undefined type=any`), so there is no class to key on. Over-admitting
 * costs one host predicate call per invocation of an otherwise-static method;
 * under-admitting returns the wrong value. Files with no callable member write
 * at all — the overwhelming majority — are byte-identical.
 *
 * JS-host lane only: the guard is `env.__hasOwnProperty` + `env.__extern_method_call`.
 * Standalone/WASI keeps its existing behaviour (see the issue file for that gap).
 */
import { ts, forEachChild } from "../../ts-api.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import type { Instr, ValType, WasmFunction } from "../../ir/types.js";
import { definedFuncAt, definedFuncHandleOf, mintDefinedFunc, pushDefinedFunc } from "../func-space.js";
import { addFuncType } from "../registry/types.js";
import { addStringConstantGlobal } from "../registry/imports.js";
import { ensureLateImport, flushLateImportShifts } from "../shared.js";
import { allocLocal } from "../context/locals.js";
import { popBody, pushBody } from "../context/bodies.js";

const EXTERNREF: ValType = { kind: "externref" };
const I32: ValType = { kind: "i32" };

export interface OwnShadowWrapper {
  readonly funcIdx: number;
  readonly methodName: string;
  /**
   * The wrapped method's own definition record. The fill re-derives its handle
   * from the OBJECT (`definedFuncHandleOf`) rather than trusting a number
   * captured at reserve time — a numeric index is ambiguous across shifts, and
   * a stale one silently calls the neighbouring function.
   */
  readonly method: WasmFunction;
  /** Reserve-time handle, used only when the object is no longer resolvable. */
  readonly methodFuncIdx: number;
  /** Parameter types, `params[0]` being the struct receiver. */
  readonly params: readonly ValType[];
}

/** RHS shapes that can carry a function value. */
function mayBeCallable(rhs: ts.Expression): boolean {
  let node: ts.Expression = rhs;
  while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) {
    node = node.expression;
  }
  switch (node.kind) {
    case ts.SyntaxKind.StringLiteral:
    case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
    case ts.SyntaxKind.TemplateExpression:
    case ts.SyntaxKind.NumericLiteral:
    case ts.SyntaxKind.BigIntLiteral:
    case ts.SyntaxKind.TrueKeyword:
    case ts.SyntaxKind.FalseKeyword:
    case ts.SyntaxKind.NullKeyword:
    case ts.SyntaxKind.ObjectLiteralExpression:
    case ts.SyntaxKind.ArrayLiteralExpression:
      return false;
    default:
      return true;
  }
}

interface FileMemberWrites {
  /** Property names written with a possibly-callable value. */
  readonly names: Set<string>;
  /** The file writes a possibly-callable value under a key it cannot name. */
  readonly computed: boolean;
}

const _fileWrites = new WeakMap<ts.SourceFile, FileMemberWrites>();

function callableMemberWrites(sourceFile: ts.SourceFile): FileMemberWrites {
  const cached = _fileWrites.get(sourceFile);
  if (cached !== undefined) return cached;
  const names = new Set<string>();
  let computed = false;
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const target = node.left;
      if (mayBeCallable(node.right)) {
        if (ts.isPropertyAccessExpression(target) && !ts.isPrivateIdentifier(target.name)) {
          names.add(target.name.text);
        } else if (ts.isElementAccessExpression(target)) {
          const key = target.argumentExpression;
          if (ts.isStringLiteralLike(key)) names.add(key.text);
          else if (ts.isNumericLiteral(key)) names.add(key.text);
          else computed = true;
        }
      }
    } else if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      // `Object.defineProperty(X, "<m>", …)` installs an own slot too, and by a
      // route no assignment scan can see (the #4482 pairing).
      const callee = node.expression.name.text;
      if (callee === "defineProperty" && node.arguments.length >= 2) {
        const key = node.arguments[1]!;
        if (ts.isStringLiteralLike(key)) names.add(key.text);
        else computed = true;
      } else if (callee === "defineProperties" && node.arguments.length >= 2) {
        const descriptors = node.arguments[1]!;
        if (ts.isObjectLiteralExpression(descriptors)) {
          for (const property of descriptors.properties) {
            const name = property.name;
            if (name !== undefined && (ts.isIdentifier(name) || ts.isStringLiteralLike(name))) names.add(name.text);
          }
        } else {
          computed = true;
        }
      }
    }
    forEachChild(node, visit);
  };
  visit(sourceFile);
  const result: FileMemberWrites = { names, computed };
  _fileWrites.set(sourceFile, result);
  return result;
}

/**
 * True when the file containing `anchor` may install an own callable property
 * named `methodName` on some object. See the module header for the precision
 * argument behind the computed-key admission.
 */
export function fileMayInstallOwnCallableMember(anchor: ts.Node, methodName: string): boolean {
  const sourceFile = anchor.getSourceFile();
  if (sourceFile === undefined) return false;
  const writes = callableMemberWrites(sourceFile);
  return writes.computed || writes.names.has(methodName);
}

function wrapperName(className: string, methodName: string, arity: number): string {
  return `__ownshadow_${className}_${methodName}_${arity}`;
}

/**
 * Reserve (or fetch) the own-property guard wrapper for `<className>.<methodName>`,
 * returning its funcMap NAME. The wrapper has the SAME signature as
 * `methodFuncIdx`, so a caller substitutes it for the method index and changes
 * nothing else.
 *
 * Returns `undefined` (keep the direct call) when the guard does not apply:
 * a non-host lane, a signature the guard cannot re-express, or a file with no
 * evidence of a callable member write.
 */
export function ownShadowGuardedMethodName(
  ctx: CodegenContext,
  anchor: ts.Node,
  className: string,
  methodName: string,
  methodFuncIdx: number,
): string | undefined {
  // Host lane only: the guard is two `env` imports.
  if (ctx.standalone || ctx.wasi) return undefined;
  if (methodName.startsWith("__priv_") || methodName.startsWith("@@") || methodName.startsWith("__cmdyn$")) {
    return undefined;
  }
  if (!ctx.classSet.has(className) || !ctx.classMethodSet.has(`${className}_${methodName}`)) return undefined;
  if (!fileMayInstallOwnCallableMember(anchor, methodName)) return undefined;

  const method = definedFuncAt(ctx, methodFuncIdx);
  if (!method) return undefined;
  const methodType = ctx.mod.types[method.typeIdx];
  if (methodType?.kind !== "func") return undefined;
  const params = methodType.params;
  const results = methodType.results;
  // The guard re-expresses the call as `__extern_method_call(recv, name, args)`,
  // which speaks externref only. Accept exactly the shape an `allowJs` class
  // method has: a struct receiver, externref user parameters, one externref
  // result. Anything else keeps the unguarded direct call.
  if (params.length < 1 || results.length !== 1) return undefined;
  if (params[0]!.kind !== "ref" && params[0]!.kind !== "ref_null") return undefined;
  if (!params.slice(1).every((p) => p.kind === "externref")) return undefined;
  if (results[0]!.kind !== "externref") return undefined;

  const arity = params.length - 1;
  const name = wrapperName(className, methodName, arity);
  if (ctx.funcMap.has(name)) return name;

  // Register every dependency NOW, while function indices are still
  // append-safe; the fill only READS funcMap (the #1719 reserve-then-fill rule).
  const hasOwn = ensureLateImport(ctx, "__hasOwnProperty", [EXTERNREF, EXTERNREF], [I32]);
  const methodCall = ensureLateImport(ctx, "__extern_method_call", [EXTERNREF, EXTERNREF, EXTERNREF], [EXTERNREF]);
  const arrayNew = ensureLateImport(ctx, "__js_array_new", [], [EXTERNREF]);
  const arrayPush = ensureLateImport(ctx, "__js_array_push", [EXTERNREF, EXTERNREF], []);
  if (hasOwn === undefined || methodCall === undefined || arrayNew === undefined || arrayPush === undefined) {
    return undefined;
  }
  addStringConstantGlobal(ctx, methodName);

  const typeIdx = addFuncType(ctx, [...params], [...results], `$ownshadow_type_${className}_${methodName}_${arity}`);
  const funcIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, funcIdx, {
    name,
    typeIdx,
    locals: [],
    // Placeholder; `fillOwnShadowWrappers` replaces it. `unreachable` keeps the
    // stub valid for the externref result if a fill is ever skipped.
    body: [{ op: "unreachable" }],
    exported: false,
  });
  ctx.funcMap.set(name, funcIdx);
  (ctx.ownShadowWrappers ??= new Map<string, OwnShadowWrapper>()).set(name, {
    funcIdx,
    methodName,
    method,
    methodFuncIdx,
    params: [...params],
  });
  return name;
}

/**
 * Resolve a wrapper NAME to its current funcIdx. Late imports shift defined
 * function indices, so call sites hold the name and re-read it immediately
 * before the `call` is pushed — the same discipline the class-member keys use.
 */
export function ownShadowFuncIdx(ctx: CodegenContext, name: string | undefined): number | undefined {
  return name === undefined ? undefined : ctx.funcMap.get(name);
}

/**
 * Fill every reserved own-property guard at FINALIZE, once late imports have
 * stopped shifting indices. Read-only over `funcMap` / `stringGlobalMap`.
 *
 * A wrapper whose dependencies did not survive to finalize degrades to a plain
 * forward to the wrapped method, which is exactly the pre-guard behaviour.
 */
export function fillOwnShadowWrappers(ctx: CodegenContext): void {
  const table = ctx.ownShadowWrappers as Map<string, OwnShadowWrapper> | undefined;
  if (!table || table.size === 0) return;
  const hasOwnIdx = ctx.funcMap.get("__hasOwnProperty");
  const methodCallIdx = ctx.funcMap.get("__extern_method_call");
  const arrayNewIdx = ctx.funcMap.get("__js_array_new");
  const arrayPushIdx = ctx.funcMap.get("__js_array_push");

  for (const reserved of table.values()) {
    const fn = definedFuncAt(ctx, reserved.funcIdx);
    if (!fn) continue;
    const arity = reserved.params.length - 1;
    const forward: Instr[] = [];
    for (let i = 0; i < reserved.params.length; i++) forward.push({ op: "local.get", index: i });
    forward.push({ op: "call", funcIdx: definedFuncHandleOf(ctx, reserved.method) ?? reserved.methodFuncIdx });

    const nameGlobal = ctx.stringGlobalMap.get(reserved.methodName);
    if (
      hasOwnIdx === undefined ||
      methodCallIdx === undefined ||
      arrayNewIdx === undefined ||
      arrayPushIdx === undefined ||
      nameGlobal === undefined
    ) {
      applyBody(fn, [], forward);
      continue;
    }

    const recvLocal = reserved.params.length; // first appended local
    const argsLocal = recvLocal + 1;
    const locals: WasmFunction["locals"] = [
      { name: "__ownshadow_recv", type: EXTERNREF },
      { name: "__ownshadow_args", type: EXTERNREF },
    ];

    const dynamic: Instr[] = [
      { op: "call", funcIdx: arrayNewIdx },
      { op: "local.set", index: argsLocal },
    ];
    for (let i = 1; i <= arity; i++) {
      dynamic.push({ op: "local.get", index: argsLocal });
      dynamic.push({ op: "local.get", index: i });
      dynamic.push({ op: "call", funcIdx: arrayPushIdx });
    }
    dynamic.push({ op: "local.get", index: recvLocal });
    dynamic.push({ op: "global.get", index: nameGlobal });
    dynamic.push({ op: "local.get", index: argsLocal });
    dynamic.push({ op: "call", funcIdx: methodCallIdx });

    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "extern.convert_any" },
      { op: "local.tee", index: recvLocal },
      { op: "global.get", index: nameGlobal },
      { op: "call", funcIdx: hasOwnIdx },
      { op: "if", blockType: { kind: "val", type: EXTERNREF }, then: dynamic, else: forward },
    ];
    applyBody(fn, locals, body);
  }
}

/**
 * Replace a RESERVED wrapper's placeholder body in place. Not a speculative
 * rollback: the body being discarded is the `unreachable` stub minted at
 * reserve time (#1719 reserve-then-fill), never a probe compile, so there are
 * no locals, late imports or errors to unwind with it.
 */
function applyBody(fn: WasmFunction, locals: WasmFunction["locals"], body: Instr[]): void {
  fn.locals.length = 0;
  fn.locals.push(...locals);
  fn.body.length = 0; // not-a-probe-rollback (#1919)
  fn.body.push(...body);
}

/**
 * The READ half. `const f = h.pre` must yield the own slot when one exists —
 * the guard on the CALL arms does not cover it, because a member read resolves
 * to the canonical per-method closure singleton (`c.m === C.prototype.m`, #1394)
 * without ever consulting the receiver.
 *
 * `emitStatic` emits the unguarded read (the singleton access) and reports
 * whether it produced a value. When the guard applies this wraps it as
 *
 *     ownSlot?  __extern_get(recv, "<name>")  :  <singleton>
 *
 * and consumes `recvType` from the stack instead of dropping it. Returns false
 * when the guard does not apply, having emitted NOTHING — the caller then keeps
 * its existing drop-then-read sequence.
 */
export function emitOwnShadowGuardedMethodRead(
  ctx: CodegenContext,
  fctx: FunctionContext,
  anchor: ts.Node,
  className: string,
  methodName: string,
  recvType: ValType,
  emitStatic: () => boolean,
): boolean {
  if (ctx.standalone || ctx.wasi) return false;
  if (!ctx.classSet.has(className) || !ctx.classMethodSet.has(`${className}_${methodName}`)) return false;
  if (methodName.startsWith("__priv_") || methodName.startsWith("@@") || methodName.startsWith("__cmdyn$")) {
    return false;
  }
  if (!fileMayInstallOwnCallableMember(anchor, methodName)) return false;
  if (recvType.kind !== "ref" && recvType.kind !== "ref_null" && recvType.kind !== "externref") return false;

  const hasOwn = ensureLateImport(ctx, "__hasOwnProperty", [EXTERNREF, EXTERNREF], [I32]);
  const externGet = ensureLateImport(ctx, "__extern_get", [EXTERNREF, EXTERNREF], [EXTERNREF]);
  if (hasOwn === undefined || externGet === undefined) return false;
  addStringConstantGlobal(ctx, methodName);
  // The two imports above may have shifted every baked defined-function index
  // in this body; settle that before the singleton access bakes its own.
  flushLateImportShifts(ctx, fctx);
  if (!ctx.stringGlobalMap.has(methodName)) return false;

  const recvLocal = allocLocal(fctx, `__ownshadow_recv_${fctx.locals.length}`, EXTERNREF);
  if (recvType.kind !== "externref") fctx.body.push({ op: "extern.convert_any" });
  fctx.body.push({ op: "local.set", index: recvLocal });

  const savedForStatic = pushBody(fctx);
  const produced = emitStatic();
  const staticArm = fctx.body;
  popBody(fctx, savedForStatic);
  if (!produced) {
    // The static read declined after the receiver was already consumed. Put it
    // back so the caller's own drop-then-fallback sequence stays balanced, and
    // report the decline.
    fctx.body.push({ op: "local.get", index: recvLocal });
    return false;
  }

  const dynamicArm: Instr[] = [
    { op: "local.get", index: recvLocal },
    { op: "global.get", index: ctx.stringGlobalMap.get(methodName)! },
    { op: "call", funcIdx: externGet },
  ];
  fctx.body.push({ op: "local.get", index: recvLocal });
  fctx.body.push({ op: "global.get", index: ctx.stringGlobalMap.get(methodName)! });
  fctx.body.push({ op: "call", funcIdx: hasOwn });
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: EXTERNREF },
    then: dynamicArm,
    else: staticArm,
  });
  return true;
}

/**
 * The CLOSED-DISPATCHER half. `__call_m_<name>_<arity>` type-switches over every
 * closed struct that has `<Struct>_<name>` and runs the matching body — so an
 * `any`-typed receiver that happens to be a class instance takes the class arm
 * regardless of what it carries in its own slot. That is the marked path:
 * `i.hooks.preprocess(md)` reaches the dispatcher, the `_Hooks` arm wins, and
 * the installed hook is never seen.
 *
 * The fill runs at finalize with no AST in hand, so the decision is taken HERE,
 * at reserve time, and the guard's one extra dependency (`__hasOwnProperty`)
 * is registered while imports are still index-safe. Records nothing when the
 * file shows no evidence of a callable member write, which leaves every other
 * dispatcher byte-identical.
 */
export function noteOwnShadowDispatchCandidate(ctx: CodegenContext, anchor: ts.Node, methodName: string): void {
  if (ctx.standalone || ctx.wasi) return;
  if (methodName.startsWith("__priv_") || methodName.startsWith("@@") || methodName.startsWith("__cmdyn$")) return;
  if (!fileMayInstallOwnCallableMember(anchor, methodName)) return;
  if (ensureLateImport(ctx, "__hasOwnProperty", [EXTERNREF, EXTERNREF], [I32]) === undefined) return;
  addStringConstantGlobal(ctx, methodName);
  (ctx.ownShadowDispatchNames ??= new Set<string>()).add(methodName);
}

/** True when the closed dispatcher for `methodName` should guard its class arms. */
export function closedDispatchGuardsOwnSlot(ctx: CodegenContext, methodName: string): boolean {
  return ctx.ownShadowDispatchNames?.has(methodName) === true;
}
