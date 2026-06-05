// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1886 Slice B — codegen for linear-backed `Uint8Array` buffers.
 *
 * A buffer proven linear-safe by the #1886 analysis (`ctx.linearUint8`, Slice A)
 * is represented as a `(ptr, len)` pair of i32 locals rather than a WasmGC vec
 * struct. This module owns the per-function buffer registry
 * (`fctx.linearU8Buffers`) and the small emit helpers the four wiring sites call:
 *
 *   - `tryEmitLinearU8New`  — `new Uint8Array(n)` / `new Uint8Array([..])` →
 *     bind `(ptr=__lin_u8_alloc(n), len=n)` instead of `array.new_default`.
 *   - `tryEmitLinearU8ElementGet` — `b[i]` → `i32.load8_u (ptr+i)` widened to f64
 *     (the observable element value type the GC path also returns).
 *   - `tryEmitLinearU8ElementSet` — `b[i] = v` → `i32.store8 (ptr+i), trunc(v)`.
 *   - `tryEmitLinearU8Length` — `b.length` → `len` widened to f64.
 *
 * All entry points are **additive guards**: they return `false`/`null` unless
 * the receiver is a registered linear-safe buffer, so any other `Uint8Array`
 * (escaping, non-WASI, or not yet bound here) falls through to the existing GC
 * path unchanged. Slice B is intraprocedural-only — buffers threaded through
 * function *parameters* keep the GC path until the Slice C signature rewrite.
 */
import type { Instr, ValType } from "../ir/types.js";
import { ts } from "../ts-api.js";
import { allocLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { ensureLinearU8AllocHelper } from "./index.js";
import { compileExpression } from "./shared.js";

/**
 * True when this `Uint8Array` binding (variable or param) was proven linear-safe
 * by Slice A. Resolves the identifier's symbol and consults
 * `ctx.linearUint8.safeBindings`. Returns false outside WASI or when the
 * analysis didn't run.
 */
export function isLinearSafeBinding(ctx: CodegenContext, node: ts.Node): boolean {
  if (!ctx.linearUint8) return false;
  if (!ts.isIdentifier(node)) return false;
  const sym = ctx.checker.getSymbolAtLocation(node);
  return !!sym && ctx.linearUint8.safeBindings.has(sym);
}

/** Look up the (ptr, len) locals for a linear-backed buffer identifier, if bound. */
function lookupBuffer(fctx: FunctionContext, node: ts.Node): { ptrLocalIdx: number; lenLocalIdx: number } | undefined {
  if (!fctx.linearU8Buffers || !ts.isIdentifier(node)) return undefined;
  return fctx.linearU8Buffers.get(node.text);
}

/**
 * `process.std{in.read,out.write,err.write}(buf, …)` argument index carrying the
 * buffer (0), or -1 if `call` is not a recognised std-stream I/O intrinsic. These
 * are the only call sites Slice B can linear-back, because the WASI lowering reads
 * `(ptr,len)` directly (zero-copy) rather than passing a GC vec across a call ABI.
 * Mirrors `ioBufferArgIndex` in linear-uint8-analysis.ts.
 */
function ioIntrinsicBufferArgIndex(call: ts.CallExpression): number {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee)) return -1;
  const method = callee.name.text;
  const stream = callee.expression;
  if (!ts.isPropertyAccessExpression(stream)) return -1;
  const streamName = stream.name.text;
  const root = stream.expression;
  if (!(ts.isIdentifier(root) && root.text === "process")) return -1;
  if (streamName === "stdin" && method === "read") return 0;
  if ((streamName === "stdout" || streamName === "stderr") && method === "write") return 0;
  return -1;
}

/** The function-like (or source-file) node that lexically encloses `node`. */
function enclosingFunctionOf(node: ts.Node): ts.Node {
  let n: ts.Node | undefined = node.parent;
  while (n) {
    if (
      ts.isFunctionDeclaration(n) ||
      ts.isFunctionExpression(n) ||
      ts.isArrowFunction(n) ||
      ts.isMethodDeclaration(n) ||
      ts.isSourceFile(n)
    ) {
      return n;
    }
    n = n.parent;
  }
  return node.getSourceFile();
}

/** True if `node` is lexically inside a loop body within its enclosing function. */
function isInsideLoop(node: ts.Node, stopAt: ts.Node): boolean {
  let n: ts.Node | undefined = node.parent;
  while (n && n !== stopAt) {
    if (
      ts.isForStatement(n) ||
      ts.isForOfStatement(n) ||
      ts.isForInStatement(n) ||
      ts.isWhileStatement(n) ||
      ts.isDoStatement(n)
    ) {
      return true;
    }
    n = n.parent;
  }
  return false;
}

/**
 * Slice B's bump arena (`__lin_u8_alloc`) is monotonic — it never frees within a
 * program run (arena reset is Slice D). So a `new Uint8Array(...)` that can run
 * more than once would leak linear memory on every iteration (observed: the
 * native-messaging host's per-frame `frame` buffer growing the arena ~1 MiB ×
 * frames). Until Slice D adds a stack/scope reset, Slice B only linear-backs an
 * allocation that is provably executed AT MOST ONCE per run:
 *   - the `new` is not lexically inside a loop in its own function, AND
 *   - its enclosing function is the module entry (compiled once) OR is never
 *     *called* from inside a loop and is not called more than once.
 * A buffer that fails this stays GC-backed (byte-identical to today), so the
 * host keeps its flat-memory guarantee; the per-frame win lands in Slice C/D.
 */
function isAllocatedAtMostOnce(checker: ts.TypeChecker, decl: ts.VariableDeclaration): boolean {
  const fn = enclosingFunctionOf(decl);
  // (1) the allocation must not be inside a loop in its own function.
  if (isInsideLoop(decl, fn)) return false;
  // The module entry (top-level / source-file scope) runs once.
  if (ts.isSourceFile(fn)) return true;
  // (2) the enclosing function must not be invoked from a loop, and must be
  // called at most once across the whole program. Resolve the function symbol
  // and scan every reference: a call ref inside a loop, or >1 call site,
  // disqualifies it (conservative — indirect/aliased calls can't be bounded).
  const fnName = ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn) ? fn.name : undefined;
  if (!fnName || !ts.isIdentifier(fnName)) return false; // anonymous / arrow / expr — can't bound call sites
  const fnSym = checker.getSymbolAtLocation(fnName);
  if (!fnSym) return false;

  let callCount = 0;
  let calledInLoop = false;
  const sf = decl.getSourceFile();
  const scan = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      if (checker.getSymbolAtLocation(node.expression) === fnSym) {
        callCount++;
        if (isInsideLoop(node, enclosingFunctionOf(node))) calledInLoop = true;
        // also a loop in any ancestor function chain would matter, but the
        // conservative single-call-site cap below already excludes the common
        // re-entry shapes; keep this simple + sound.
      }
    }
    ts.forEachChild(node, scan);
  };
  scan(sf);
  return callCount <= 1 && !calledInLoop;
}

/**
 * True when every reference to `sym` inside its declaring function is a use Slice
 * B can lower *intraprocedurally*: `b[i]` / `b[i] = v`, `b.length`, or an
 * I/O-intrinsic argument (`process.std*.{read,write}(b)`). A reference passed to
 * any **user function** (even one whose corresponding param Slice A proved
 * linear-safe) disqualifies the buffer here: Slice B does NOT rewrite callee
 * signatures (that is Slice C), so the callee still receives a GC vec while this
 * binding would be a `(ptr,len)` pair — a representation split the call ABI can't
 * bridge. Slice A's `safeBindings` is deliberately permissive (it admits the
 * cross-function flow for Slice C); this is the Slice-B-only tightening the
 * findings called for.
 */
function isUsedOnlyIntraprocedurally(ctx: CodegenContext, sym: ts.Symbol): boolean {
  const decl = sym.getDeclarations?.()?.[0];
  if (!decl) return false;
  // The enclosing function/source whose body holds all of this local's uses.
  let scope: ts.Node = decl;
  while (
    scope.parent &&
    !ts.isFunctionDeclaration(scope) &&
    !ts.isFunctionExpression(scope) &&
    !ts.isArrowFunction(scope) &&
    !ts.isMethodDeclaration(scope) &&
    !ts.isSourceFile(scope)
  ) {
    scope = scope.parent;
  }

  let ok = true;
  const visit = (node: ts.Node): void => {
    if (!ok) return;
    if (ts.isIdentifier(node) && ctx.checker.getSymbolAtLocation(node) === sym) {
      const p = node.parent;
      // binding site (the `const b = …` name itself) — not a use.
      if (ts.isVariableDeclaration(p) && p.name === node) {
        ts.forEachChild(node, visit);
        return;
      }
      // b[i] / b[i] = v   (buffer is the object, not the index)
      if (ts.isElementAccessExpression(p) && p.expression === node) {
        ts.forEachChild(node, visit);
        return;
      }
      // b.length (the only allowed property read)
      if (ts.isPropertyAccessExpression(p) && p.expression === node && p.name.text === "length") {
        ts.forEachChild(node, visit);
        return;
      }
      // I/O-intrinsic argument: process.std*.{read,write}(b, …)
      if (ts.isCallExpression(p) && p.expression !== node) {
        const argIdx = p.arguments.indexOf(node as ts.Expression);
        if (argIdx >= 0 && ioIntrinsicBufferArgIndex(p) === argIdx) {
          ts.forEachChild(node, visit);
          return;
        }
      }
      // Any other use — incl. a user-function call argument — escapes Slice B.
      ok = false;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(scope);
  return ok;
}

/**
 * Slice B is intraprocedural: a binding qualifies for linear backing here only
 * if it is a `new Uint8Array(...)` *local* (not a parameter — params stay GC
 * until the Slice C signature rewrite). The Slice-A set includes params AND
 * locals that flow into linear-safe callee params (forward-looking to Slice C),
 * so Slice B additionally requires (a) the declaration to be a
 * `VariableDeclaration` initialised by `new Uint8Array(...)`, and (b) the
 * binding to be used ONLY intraprocedurally (no user-function call argument) —
 * see `isUsedOnlyIntraprocedurally`.
 */
export function isLocalLinearNewBinding(ctx: CodegenContext, nameNode: ts.Identifier): boolean {
  if (!isLinearSafeBinding(ctx, nameNode)) return false;
  const sym = ctx.checker.getSymbolAtLocation(nameNode);
  if (!sym) return false;
  const decls = sym.getDeclarations() ?? [];
  const newDecl = decls.find(
    (d): d is ts.VariableDeclaration =>
      ts.isVariableDeclaration(d) &&
      !!d.initializer &&
      ts.isNewExpression(d.initializer) &&
      ts.isIdentifier(d.initializer.expression) &&
      d.initializer.expression.text === "Uint8Array",
  );
  if (!newDecl) return false;
  if (!isUsedOnlyIntraprocedurally(ctx, sym)) return false;
  // Bump-arena leak guard until Slice D's arena reset: only back allocations
  // provably executed at most once per run (see isAllocatedAtMostOnce).
  return isAllocatedAtMostOnce(ctx.checker, newDecl);
}

/**
 * True iff at least one `const/let x = new Uint8Array(...)` binding in the source
 * actually qualifies for Slice-B linear backing (`isLocalLinearNewBinding`). Used
 * to gate the eager `__lin_u8_alloc` emit: if nothing qualifies, the helper is
 * never emitted (no dead code) and — since no `call __lin_u8_alloc` site exists —
 * the funcMap-shift hazard the eager emit defends against cannot arise either.
 * Walks the whole file once; cheap relative to compilation.
 */
export function sourceHasLinearBackedUint8(ctx: CodegenContext, sourceFile: ts.SourceFile): boolean {
  if (!ctx.linearUint8 || ctx.linearUint8.safeBindings.size === 0) return false;
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isNewExpression(node.initializer) &&
      isLocalLinearNewBinding(ctx, node.name)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

/**
 * `new Uint8Array(n)` / `new Uint8Array([a,b,…])` for a linear-safe local being
 * declared as `nameNode`. Allocates `(ptr, len)` i32 locals, calls
 * `__lin_u8_alloc(n)`, and (for the array-literal form) stores the literal
 * bytes. Registers the buffer in `fctx.linearU8Buffers` and leaves NOTHING on
 * the value stack (the binding lives in the two i32 locals). Returns true if it
 * handled the `new`; false to fall through to the GC path.
 *
 * Caller contract: invoked from the variable-declaration lowering for a
 * `const/let x = new Uint8Array(...)` where `isLocalLinearNewBinding(x)` holds.
 */
export function tryEmitLinearU8New(
  ctx: CodegenContext,
  fctx: FunctionContext,
  nameNode: ts.Identifier,
  newExpr: ts.NewExpression,
): boolean {
  if (!isLocalLinearNewBinding(ctx, nameNode)) return false;
  const allocIdx = ensureLinearU8AllocHelper(ctx);
  if (allocIdx < 0) return false;

  const args = newExpr.arguments ?? ([] as unknown as ts.NodeArray<ts.Expression>);
  const ptrLocal = allocLocal(fctx, `__linu8_ptr_${fctx.locals.length}`, {
    kind: "i32",
  });
  const lenLocal = allocLocal(fctx, `__linu8_len_${fctx.locals.length}`, {
    kind: "i32",
  });

  // Array-literal form: `new Uint8Array([a, b, c])` — length = element count,
  // then store each (constant or computed) byte.
  if (args.length === 1 && ts.isArrayLiteralExpression(args[0]!)) {
    const elems = args[0]!.elements;
    fctx.body.push({ op: "i32.const", value: elems.length } as Instr);
    fctx.body.push({ op: "local.set", index: lenLocal } as Instr);
    fctx.body.push({ op: "i32.const", value: elems.length } as Instr);
    fctx.body.push({ op: "call", funcIdx: allocIdx } as Instr);
    fctx.body.push({ op: "local.set", index: ptrLocal } as Instr);
    elems.forEach((el, i) => {
      // address = ptr + i
      fctx.body.push({ op: "local.get", index: ptrLocal } as Instr);
      if (i > 0) {
        fctx.body.push({ op: "i32.const", value: i } as Instr);
        fctx.body.push({ op: "i32.add" } as Instr);
      }
      // value = trunc(elem) — element expr compiled in f64 then truncated to a byte.
      compileExpression(ctx, fctx, el, { kind: "f64" });
      fctx.body.push({ op: "i32.trunc_sat_f64_s" } as Instr);
      fctx.body.push({ op: "i32.store8", align: 0, offset: 0 } as Instr);
    });
    registerBuffer(fctx, nameNode.text, ptrLocal, lenLocal);
    return true;
  }

  // Length form: `new Uint8Array(n)` (or `new Uint8Array()` ⇒ 0).
  if (args.length >= 1) {
    compileExpression(ctx, fctx, args[0]!, { kind: "f64" });
    fctx.body.push({ op: "i32.trunc_sat_f64_s" } as Instr);
  } else {
    fctx.body.push({ op: "i32.const", value: 0 } as Instr);
  }
  fctx.body.push({ op: "local.set", index: lenLocal } as Instr);
  // ptr = __lin_u8_alloc(len)
  fctx.body.push({ op: "local.get", index: lenLocal } as Instr);
  fctx.body.push({ op: "call", funcIdx: allocIdx } as Instr);
  fctx.body.push({ op: "local.set", index: ptrLocal } as Instr);
  registerBuffer(fctx, nameNode.text, ptrLocal, lenLocal);
  return true;
}

function registerBuffer(fctx: FunctionContext, name: string, ptrLocalIdx: number, lenLocalIdx: number): void {
  if (!fctx.linearU8Buffers) fctx.linearU8Buffers = new Map();
  fctx.linearU8Buffers.set(name, { ptrLocalIdx, lenLocalIdx });
}

/**
 * `b[i]` read for a linear-backed buffer → `i32.load8_u (ptr + trunc(i))`,
 * widened to f64 to match the observable element value type the GC path
 * returns. Returns the result ValType, or `null` if `b` is not linear-backed.
 */
export function tryEmitLinearU8ElementGet(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.ElementAccessExpression,
): ValType | null {
  const buf = lookupBuffer(fctx, expr.expression);
  if (!buf) return null;
  // address = ptr + trunc(index)
  fctx.body.push({ op: "local.get", index: buf.ptrLocalIdx } as Instr);
  compileExpression(ctx, fctx, expr.argumentExpression, { kind: "f64" });
  fctx.body.push({ op: "i32.trunc_sat_f64_s" } as Instr);
  fctx.body.push({ op: "i32.add" } as Instr);
  fctx.body.push({ op: "i32.load8_u", align: 0, offset: 0 } as Instr);
  fctx.body.push({ op: "f64.convert_i32_u" } as Instr);
  return { kind: "f64" };
}

/**
 * `b[i] = v` for a linear-backed buffer → `i32.store8 (ptr + trunc(i)),
 * trunc(v) & 0xff`. Returns the assigned value's ValType (f64) and **leaves the
 * assigned value on the stack** (the assignment-expression result, matching the
 * GC `array.set` path which returns `local.get valLocal`). Returns `null` if `b`
 * is not a linear-backed buffer (caller falls through to GC).
 *
 * Evaluation order matches JS + the GC path: index expression first, then the
 * value expression, then the store.
 */
export function tryEmitLinearU8ElementSet(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.ElementAccessExpression,
  valueExpr: ts.Expression,
): ValType | null {
  const buf = lookupBuffer(fctx, target.expression);
  if (!buf) return null;
  // Allocate the result/addr temps up-front so their slot indices are fixed
  // before the nested index/value sub-expressions compile (those allocate their
  // own temps as they go). Each sub-expression is fully evaluated into a temp
  // before the next is compiled, so no stash ever interleaves with another
  // expression's temp usage on the value stack (#1886).
  const addrLocal = allocLocal(fctx, `__linu8_addr_${fctx.locals.length}`, {
    kind: "i32",
  });
  const valLocal = allocLocal(fctx, `__linu8_val_${fctx.locals.length}`, {
    kind: "f64",
  });

  // addr = ptr + trunc(index)  (index evaluated first, per JS + the GC path)
  fctx.body.push({ op: "local.get", index: buf.ptrLocalIdx } as Instr);
  compileExpression(ctx, fctx, target.argumentExpression, { kind: "f64" });
  fctx.body.push({ op: "i32.trunc_sat_f64_s" } as Instr);
  fctx.body.push({ op: "i32.add" } as Instr);
  fctx.body.push({ op: "local.set", index: addrLocal } as Instr);
  // val = v (kept as f64 for the assignment-expression result)
  compileExpression(ctx, fctx, valueExpr, { kind: "f64" });
  fctx.body.push({ op: "local.set", index: valLocal } as Instr);
  // mem[addr] = (u8) trunc(val) — low byte kept by i32.store8.
  fctx.body.push({ op: "local.get", index: addrLocal } as Instr);
  fctx.body.push({ op: "local.get", index: valLocal } as Instr);
  fctx.body.push({ op: "i32.trunc_sat_f64_s" } as Instr);
  fctx.body.push({ op: "i32.store8", align: 0, offset: 0 } as Instr);
  // assignment-expression result = the assigned value (f64).
  fctx.body.push({ op: "local.get", index: valLocal } as Instr);
  return { kind: "f64" };
}

/** `b.length` for a linear-backed buffer → `len` widened to f64. */
export function tryEmitLinearU8Length(fctx: FunctionContext, expr: ts.PropertyAccessExpression): ValType | null {
  if (expr.name.text !== "length") return null;
  const buf = lookupBuffer(fctx, expr.expression);
  if (!buf) return null;
  fctx.body.push({ op: "local.get", index: buf.lenLocalIdx } as Instr);
  fctx.body.push({ op: "f64.convert_i32_u" } as Instr);
  return { kind: "f64" };
}

/** Accessor used by the WASI I/O intrinsics to get a buffer's (ptr, len) locals. */
export function getLinearU8Buffer(
  fctx: FunctionContext,
  node: ts.Node,
): { ptrLocalIdx: number; lenLocalIdx: number } | undefined {
  return lookupBuffer(fctx, node);
}

/**
 * Zero-copy `process.stdin.read(buf, off?)` for a linear-backed buffer.
 * `fd_read` targets `ptr + off` directly (no GC↔linear element-copy loop) and
 * returns the byte count (f64). Returns `null` if `buf` is not linear-backed.
 *
 * Layout reuse: the iovec lives at memory[0..7] and nwritten/nread at
 * memory[8..11] — the same scratch slots the existing `__wasi_write_*` helpers
 * and the GC stdin-read path use.
 */
export function tryEmitLinearU8StdinRead(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  fdReadIdx: number,
): ValType | null {
  const buf = lookupBuffer(fctx, expr.arguments[0]!);
  if (!buf) return null;

  // off = arg1 (trunc) or 0
  const offLocal = allocLocal(fctx, `__linu8_rdoff_${fctx.locals.length}`, {
    kind: "i32",
  });
  if (expr.arguments.length >= 2) {
    compileExpression(ctx, fctx, expr.arguments[1]!, { kind: "f64" });
    fctx.body.push({ op: "i32.trunc_sat_f64_s" } as Instr);
  } else {
    fctx.body.push({ op: "i32.const", value: 0 } as Instr);
  }
  fctx.body.push({ op: "local.set", index: offLocal } as Instr);

  // iovec.buf = ptr + off   (memory[0])
  fctx.body.push({ op: "i32.const", value: 0 } as Instr);
  fctx.body.push({ op: "local.get", index: buf.ptrLocalIdx } as Instr);
  fctx.body.push({ op: "local.get", index: offLocal } as Instr);
  fctx.body.push({ op: "i32.add" } as Instr);
  fctx.body.push({ op: "i32.store", align: 2, offset: 0 } as Instr);
  // iovec.buf_len = len - off   (memory[4])
  fctx.body.push({ op: "i32.const", value: 4 } as Instr);
  fctx.body.push({ op: "local.get", index: buf.lenLocalIdx } as Instr);
  fctx.body.push({ op: "local.get", index: offLocal } as Instr);
  fctx.body.push({ op: "i32.sub" } as Instr);
  fctx.body.push({ op: "i32.store", align: 2, offset: 0 } as Instr);
  // fd_read(fd=0, iovs=0, iovs_len=1, nread=8) — bytes land directly in linear
  // memory at ptr+off (zero copy).
  fctx.body.push({ op: "i32.const", value: 0 } as Instr);
  fctx.body.push({ op: "i32.const", value: 0 } as Instr);
  fctx.body.push({ op: "i32.const", value: 1 } as Instr);
  fctx.body.push({ op: "i32.const", value: 8 } as Instr);
  fctx.body.push({ op: "call", funcIdx: fdReadIdx } as Instr);
  fctx.body.push({ op: "drop" } as Instr);
  // return nread (memory[8]) as f64
  fctx.body.push({ op: "i32.const", value: 8 } as Instr);
  fctx.body.push({ op: "i32.load", align: 2, offset: 0 } as Instr);
  fctx.body.push({ op: "f64.convert_i32_s" } as Instr);
  return { kind: "f64" };
}

/**
 * Zero-copy `process.stdout/stderr.write(buf)` for a linear-backed buffer.
 * `fd_write` reads straight from `ptr` for `len` bytes — no GC→linear staging
 * copy. Returns `true` if handled (and leaves the i32 `1` write-result on the
 * stack, matching the GC write path), `null` if `buf` is not linear-backed.
 */
export function tryEmitLinearU8StdWrite(
  fctx: FunctionContext,
  bufArg: ts.Expression,
  fdWriteIdx: number,
  useStderr: boolean,
): boolean {
  const buf = lookupBuffer(fctx, bufArg);
  if (!buf) return false;
  const fd = useStderr ? 2 : 1;
  // iovec.buf = ptr (memory[0])
  fctx.body.push({ op: "i32.const", value: 0 } as Instr);
  fctx.body.push({ op: "local.get", index: buf.ptrLocalIdx } as Instr);
  fctx.body.push({ op: "i32.store", align: 2, offset: 0 } as Instr);
  // iovec.buf_len = len (memory[4])
  fctx.body.push({ op: "i32.const", value: 4 } as Instr);
  fctx.body.push({ op: "local.get", index: buf.lenLocalIdx } as Instr);
  fctx.body.push({ op: "i32.store", align: 2, offset: 0 } as Instr);
  // fd_write(fd, iovs=0, iovs_len=1, nwritten=8) — reads directly from ptr.
  fctx.body.push({ op: "i32.const", value: fd } as Instr);
  fctx.body.push({ op: "i32.const", value: 0 } as Instr);
  fctx.body.push({ op: "i32.const", value: 1 } as Instr);
  fctx.body.push({ op: "i32.const", value: 8 } as Instr);
  fctx.body.push({ op: "call", funcIdx: fdWriteIdx } as Instr);
  fctx.body.push({ op: "drop" } as Instr);
  return true;
}
