// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3101 / E1 — the runtime ESTree → bytecode emitter (producer (a), doc §12.1).
// It walks an ESTree (node-acorn in E1; compiled-acorn `$Object`s in E2 — every
// `node.type`/`node.left` read is a dynamic member read by design) and drives an
// {@link Encoder} to produce a {@link FuncMeta}. Authored in the
// js2wasm-compilable subset so E2 self-compiles it.
//
// ── Register model (stack-discipline allocator, doc "Emitter notes") ──────────
//   regs[0]                     = receiver (`this`)               [reserved]
//   regs[1 .. 1+paramCount)     = declared parameters
//   regs[1+paramCount .. base)  = hoisted named locals (var/function/let/const)
//   regs[base .. )              = expression temporaries (bump + restore)
// All var/function/let/const names are hoisted to function scope and pinned to
// fixed registers up front (Phase 1: no block scoping, no TDZ — deferred). Every
// `emitExpr` leaves its value in `acc` and restores `regTop` (its scratch is
// transient); `regCount` is the high-water mark, finalized at emit end.
//
// ── ISA desugarings (the 37-op set is deliberately minimal) ───────────────────
// The ISA has Lt/Le/Eq/StrictEq but not `>`/`>=`/`!=`/`!==`, and no bitwise /
// exponent / shift ops. The emitter desugars what it can and rejects the rest:
//   a > b   → b < a        a >= b  → b <= a
//   a != b  → !(a == b)    a !== b → !(a === b)
//   +x      → -( -x )      (double-negate = ToNumber)
//   `a${x}` → "a" + x      (template → concat)
// Bitwise/shift/`**`/`delete`/`in`/`instanceof`, for-in/for-of, generators/async,
// destructuring, spread, and regex literals are Phase-1 out-of-scope: the emitter
// throws {@link UnsupportedNodeError} so the differential harness skips the body
// and reports coverage (they are named follow-ups in the issue).

import { Builtin, Encoder, type JumpSlot } from "./encoder.js";
import { FLAG_SCRIPT, FLAG_STRICT, type FuncMeta, type JSValue } from "./types.js";
import { Op } from "./opcodes.js";

/** Thrown when the emitter meets a Phase-1-out-of-scope ESTree node/operator. */
export class UnsupportedNodeError extends Error {
  readonly nodeType: string;
  constructor(what: string, nodeType: string) {
    super(`interp/emitter: unsupported in Phase 1: ${what}`);
    this.name = "UnsupportedNodeError";
    this.nodeType = nodeType;
  }
}

/** ESTree nodes are read dynamically (compiled-acorn `$Object`s in E2). */
type Node = any;

/** A lexical loop/switch target for break/continue back-patching. */
interface LoopCtx {
  label: string | null;
  breaks: JumpSlot[];
  continues: JumpSlot[];
  /** True for loops (continue is legal); false for a plain labeled block. */
  isLoop: boolean;
}

/**
 * Emits one function/script body. Construct with the params + body, then call
 * {@link emit} to get the {@link FuncMeta}.
 */
class FunctionEmitter {
  private readonly params: Node[];
  private readonly body: Node;
  private readonly name: JSValue;
  private readonly isScript: boolean;
  private readonly isExpressionBody: boolean;
  private readonly enc = new Encoder();
  /** name → fixed register (params + hoisted locals). */
  private readonly names = new Map<string, number>();
  /** Self-compile-stable membership mirror for `names`.
   *
   * A missing numeric Map value is not a reliable `undefined` discriminator in
   * every standalone generic-Map lowering. Register lookup still uses `names`;
   * global-builtin shadow classification uses this explicit string list.
   */
  private readonly boundNames: string[] = [];
  /** bump pointer: next free register (temporaries live at/above this). */
  private regTop = 1; // regs[0] reserved for `this`
  private maxReg = 1;
  private readonly loops: LoopCtx[] = [];
  /** In a script/eval body, the register holding the running completion value. */
  private completionReg = -1;
  /** Hoisted var/let/const binding names (collected before emission). */
  private readonly hoistedVars: string[] = [];
  /** Hoisted function declarations (collected before emission). */
  private readonly hoistedFuncs: Node[] = [];
  /** Function directive-prologue strictness (scripts keep their global-this entry semantics). */
  private strictMode = false;

  constructor(params: Node[], body: Node, name: JSValue, isScript: boolean, isExpressionBody: boolean) {
    // Use explicit fields instead of TypeScript parameter properties: the E2
    // self-compiler materialises declared class fields as WasmGC struct fields,
    // while parameter properties currently fall back to dynamic object reads.
    this.params = params;
    this.body = body;
    this.name = name;
    this.isScript = isScript;
    this.isExpressionBody = isExpressionBody; // arrow with expression body
  }

  // ── register allocation ────────────────────────────────────────────────────
  private allocReg(): number {
    const r = this.regTop;
    this.regTop += 1;
    if (this.regTop > this.maxReg) this.maxReg = this.regTop;
    return r;
  }
  private mark(): number {
    return this.regTop;
  }
  private release(m: number): void {
    this.regTop = m;
  }
  private bind(name: string): number {
    const existing = this.names.get(name);
    if (existing !== undefined) return existing;
    const r = this.allocReg();
    this.names.set(name, r);
    this.boundNames.push(name);
    return r;
  }

  /**
   * Completion-value UpdateEmpty base for control statements (§completion
   * semantics). `if`/`for`/`while`/`do`/`try`/labeled statements have a
   * NON-empty completion (undefined if their body yields no value), so in a
   * script/eval body they reset the running completion to undefined at entry —
   * `eval("1; for(;false;){}")` is undefined, not 1. Blocks/var/function/empty
   * propagate the empty completion (they do NOT reset). No-op outside script
   * context.
   */
  private resetCompletion(): void {
    if (this.isScript && this.completionReg >= 0) {
      this.enc.emit0(Op.LdaUndef);
      this.enc.emitReg(Op.Star, this.completionReg);
    }
  }

  // ── entry ──────────────────────────────────────────────────────────────────
  emit(): FuncMeta {
    // 1. Bind params to regs[1..1+paramCount).
    let paramCount = 0;
    for (const p of this.params) {
      if (p.type !== "Identifier") {
        throw new UnsupportedNodeError(`non-identifier parameter (${p.type})`, p.type);
      }
      this.bind(p.name);
      paramCount += 1;
    }

    // 2. Script/eval body: allocate the completion register (seeded undefined).
    if (this.isScript) {
      this.completionReg = this.allocReg();
      this.enc.emit0(Op.LdaUndef);
      this.enc.emitReg(Op.Star, this.completionReg);
    }

    // 3. Hoist var/function/let/const names, then initialise function decls.
    if (this.isExpressionBody) {
      // Arrow `=> expr`: the body IS an expression; its value is the return.
      this.emitExpr(this.body);
      this.enc.emit0(Op.Return);
    } else {
      const stmts: Node[] = this.body.body;
      if (!this.isScript) {
        // Detect the directive prologue inline. A newly-added late class helper
        // is not a stable self-compile call seam until #3651 lands.
        for (const statement of stmts) {
          if (statement.type !== "ExpressionStatement" || statement.expression.type !== "Literal") break;
          if (statement.expression.value === "use strict") {
            this.strictMode = true;
            break;
          }
          if (typeof statement.expression.value !== "string") break;
        }
      }
      // Collect all var/function/let/const declarations (function-scoped).
      this.collectHoist(stmts);
      if (this.isScript) {
        // Indirect-eval / Function-ctor GLOBAL scope (§19.2.1 / §20.2.1.1): top-
        // level var/function/let/const create GLOBAL bindings (NOT registers), so
        // a nested function's free identifier resolves to them by global lookup —
        // this is global resolution, not the lexical capture Phase 1 excludes.
        this.declareScriptGlobals();
      } else {
        // Function body: bind locals to registers, then initialise function decls.
        for (const name of this.hoistedVars) this.bind(name);
        for (const fn of this.hoistedFuncs) this.bind(fn.id.name);
        for (const fn of this.hoistedFuncs) {
          this.emitClosure(fn);
          this.storeName(fn.id.name);
        }
      }
      // 4. Body.
      for (const s of stmts) this.emitStatement(s);
      // 5. Fall-off return.
      if (this.isScript) {
        this.enc.emitReg(Op.Ldar, this.completionReg);
        this.enc.emit0(Op.Return);
      } else {
        this.enc.emit0(Op.LdaUndef);
        this.enc.emit0(Op.Return);
      }
    }

    const flags = (this.isScript ? FLAG_SCRIPT : 0) | (this.strictMode ? FLAG_STRICT : 0);
    return this.enc.finish(this.maxReg, paramCount, this.name, flags);
  }

  /** Recursively collect var/function/let/const binding names (function-scoped;
   *  does NOT descend into nested function bodies — those are separate scopes). */
  private collectHoist(stmts: Node[]): void {
    for (const s of stmts) this.collectHoistStatement(s);
  }
  private collectHoistStatement(s: Node): void {
    // Dynamic ESTree string discriminants deliberately use equality chains.
    // A standalone switch over a dynamic/native-string field does not share
    // the statically typed string switch representation.
    if (s.type === "VariableDeclaration") {
      for (const d of s.declarations) this.collectHoistPattern(d.id);
    } else if (s.type === "FunctionDeclaration") {
      if (s.id) this.hoistedFuncs.push(s);
    } else if (s.type === "IfStatement") {
      this.collectHoistStatement(s.consequent);
      if (s.alternate) this.collectHoistStatement(s.alternate);
    } else if (s.type === "BlockStatement") {
      this.collectHoist(s.body);
    } else if (s.type === "WhileStatement" || s.type === "DoWhileStatement") {
      this.collectHoistStatement(s.body);
    } else if (s.type === "ForStatement") {
      if (s.init && s.init.type === "VariableDeclaration") this.collectHoistStatement(s.init);
      this.collectHoistStatement(s.body);
    } else if (s.type === "TryStatement") {
      this.collectHoistStatement(s.block);
      if (s.handler) this.collectHoistStatement(s.handler.body);
      if (s.finalizer) this.collectHoistStatement(s.finalizer);
    } else if (s.type === "LabeledStatement") {
      this.collectHoistStatement(s.body);
    }
  }
  private collectHoistPattern(id: Node): void {
    if (id.type === "Identifier") {
      this.hoistedVars.push(id.name);
    } else {
      throw new UnsupportedNodeError(`destructuring binding (${id.type})`, id.type);
    }
  }

  /**
   * Declare a Script/eval body's hoisted bindings on the GLOBAL environment:
   * every var name is initialised to undefined (so a read-before-assign yields
   * undefined, not ReferenceError), then every function declaration installs its
   * closure (functions win over same-named vars). Phase-1 note: this uses the
   * env backing for `var` AND `let`/`const` (no separate global lexical record,
   * no TDZ) — a documented simplification; a `var <existingGlobalName>` with no
   * initialiser can shadow the real global (rare; the differential harness flags
   * it).
   */
  private declareScriptGlobals(): void {
    for (const name of this.hoistedVars) {
      this.enc.emit0(Op.LdaUndef);
      this.enc.emitConst(Op.StName, this.enc.internConst(name));
    }
    for (const fn of this.hoistedFuncs) {
      this.emitClosure(fn);
      this.enc.emitConst(Op.StName, this.enc.internConst(fn.id.name));
    }
  }

  // ── statements ─────────────────────────────────────────────────────────────
  private emitStatement(s: Node): void {
    if (s.type === "ExpressionStatement") {
      this.emitExpr(s.expression);
      if (this.isScript && this.completionReg >= 0) {
        // Completion-value semantics: the last value-producing statement's
        // value is the eval/script result — DO NOT drop it in script context.
        this.enc.emitReg(Op.Star, this.completionReg);
      }
    } else if (s.type === "VariableDeclaration") {
      this.emitVarDecl(s);
    } else if (s.type === "FunctionDeclaration") {
      return; // already hoisted + initialised
    } else if (s.type === "BlockStatement") {
      for (const inner of s.body) this.emitStatement(inner);
    } else if (s.type === "IfStatement") {
      this.resetCompletion();
      this.emitIf(s);
    } else if (s.type === "WhileStatement") {
      this.resetCompletion();
      this.emitWhile(s);
    } else if (s.type === "DoWhileStatement") {
      this.resetCompletion();
      this.emitDoWhile(s);
    } else if (s.type === "ForStatement") {
      this.resetCompletion();
      this.emitFor(s);
    } else if (s.type === "ReturnStatement") {
      if (s.argument) this.emitExpr(s.argument);
      else this.enc.emit0(Op.LdaUndef);
      this.enc.emit0(Op.Return);
    } else if (s.type === "BreakStatement") {
      this.emitBreak(s);
    } else if (s.type === "ContinueStatement") {
      this.emitContinue(s);
    } else if (s.type === "ThrowStatement") {
      this.emitExpr(s.argument);
      this.enc.emit0(Op.Throw);
    } else if (s.type === "TryStatement") {
      this.resetCompletion();
      this.emitTry(s);
    } else if (s.type === "LabeledStatement") {
      this.resetCompletion();
      this.emitLabeled(s);
    } else if (s.type !== "EmptyStatement") {
      throw new UnsupportedNodeError(`statement ${s.type}`, s.type);
    }
  }

  private emitVarDecl(s: Node): void {
    for (const d of s.declarations) {
      if (d.id.type !== "Identifier") throw new UnsupportedNodeError(`destructuring (${d.id.type})`, d.id.type);
      if (d.init) {
        this.emitExpr(d.init);
        this.storeName(d.id.name);
      }
      // no init: the register already holds undefined (Phase 1: no TDZ)
    }
  }

  private emitIf(s: Node): void {
    this.emitExpr(s.test);
    const toElse = this.enc.emitJump(Op.JumpIfFalse);
    this.emitStatement(s.consequent);
    if (s.alternate) {
      const toEnd = this.enc.emitJump(Op.Jump);
      this.enc.patch(toElse);
      this.emitStatement(s.alternate);
      this.enc.patch(toEnd);
    } else {
      this.enc.patch(toElse);
    }
  }

  private emitWhile(s: Node): void {
    const ctx = this.pushLoop(null, true);
    const top = this.enc.here();
    this.emitExpr(s.test);
    const exit = this.enc.emitJump(Op.JumpIfFalse);
    this.emitStatement(s.body);
    this.enc.emitJumpTo(Op.Jump, top);
    this.enc.patch(exit);
    this.popLoop(ctx, /*continueTarget*/ top);
  }

  private emitDoWhile(s: Node): void {
    const ctx = this.pushLoop(null, true);
    const top = this.enc.here();
    this.emitStatement(s.body);
    const testPc = this.enc.here();
    this.emitExpr(s.test);
    this.enc.emitJumpTo(Op.JumpIfTrue, top);
    this.popLoop(ctx, /*continueTarget*/ testPc);
  }

  private emitFor(s: Node): void {
    const outer = this.mark();
    if (s.init) {
      if (s.init.type === "VariableDeclaration") this.emitVarDecl(s.init);
      else this.emitExprStatementDiscard(s.init);
    }
    const ctx = this.pushLoop(null, true);
    const top = this.enc.here();
    let exit: JumpSlot | -1 = -1;
    if (s.test) {
      this.emitExpr(s.test);
      exit = this.enc.emitJump(Op.JumpIfFalse);
    }
    this.emitStatement(s.body);
    const updatePc = this.enc.here();
    if (s.update) this.emitExprStatementDiscard(s.update);
    this.enc.emitJumpTo(Op.Jump, top);
    if (exit !== -1) this.enc.patch(exit);
    this.popLoop(ctx, /*continueTarget*/ updatePc);
    this.release(outer);
  }

  private emitExprStatementDiscard(expr: Node): void {
    const m = this.mark();
    this.emitExpr(expr);
    this.release(m);
  }

  private emitTry(s: Node): void {
    // Side-table model: the loop wraps execution and, on a throw whose PC is
    // covered by a row, writes the caught value into handlerReg and jumps to
    // handlerPC. finally is Phase-1 best-effort (see below).
    const start = this.enc.here();
    this.emitStatement(s.block);
    const end = this.enc.here();
    const overCatch = this.enc.emitJump(Op.Jump); // normal completion skips the catch

    if (s.handler) {
      const handlerPc = this.enc.here();
      // Bind the caught value: the loop has already stored it into handlerReg.
      let handlerReg: number;
      if (s.handler.param) {
        if (s.handler.param.type !== "Identifier") {
          throw new UnsupportedNodeError(`catch destructuring (${s.handler.param.type})`, s.handler.param.type);
        }
        handlerReg = this.bind(s.handler.param.name);
      } else {
        handlerReg = this.allocReg(); // optional-catch-binding: scratch sink
      }
      this.enc.addExnRow(start, end, handlerPc, handlerReg);
      this.emitStatement(s.handler.body);
      // A throw inside the try with a catch lands here, then falls through to the
      // finalizer below (catch → finally ordering).
    }
    // NOTE (Phase-1 finally): for try/finally with NO catch we deliberately add
    // NO exn row — a throw in the try PROPAGATES (unwinds to an outer handler or
    // escapes), it is never swallowed. The finalizer therefore runs only on the
    // NORMAL completion path (below). Full finally-on-exceptional-path (run the
    // finalizer, then re-raise) is the documented cut-point / follow-up; the
    // exception is preserved either way (loud, never silent-wrong — invariant L1).
    this.enc.patch(overCatch);

    if (s.finalizer) {
      // Phase-1 finally: run the finalizer on the NORMAL completion path. Full
      // finally semantics (intercepting an in-flight throw/return/break that
      // escapes the try or catch) is the documented cut-point — a `throw`
      // uncaught by this try still unwinds past the finalizer here. Bodies that
      // rely on finally-intercepts-control-flow are reported as divergences by
      // the differential harness and tracked as a follow-up.
      this.emitStatement(s.finalizer);
    }
  }

  private emitLabeled(s: Node): void {
    const label: string = s.label.name;
    const inner = s.body;
    if (inner.type === "WhileStatement" || inner.type === "DoWhileStatement" || inner.type === "ForStatement") {
      // Re-emit the loop with the label attached so labeled break/continue work.
      this.emitLabeledLoop(label, inner);
    } else {
      // Labeled non-loop: only labeled break is meaningful.
      const ctx = this.pushLoop(label, false);
      this.emitStatement(inner);
      this.popLoop(ctx, -1);
    }
  }

  private emitLabeledLoop(label: string, s: Node): void {
    // Same shapes as emitWhile/DoWhile/For but with the label on the context.
    if (s.type === "WhileStatement") {
      const ctx = this.pushLoop(label, true);
      const top = this.enc.here();
      this.emitExpr(s.test);
      const exit = this.enc.emitJump(Op.JumpIfFalse);
      this.emitStatement(s.body);
      this.enc.emitJumpTo(Op.Jump, top);
      this.enc.patch(exit);
      this.popLoop(ctx, top);
    } else if (s.type === "DoWhileStatement") {
      const ctx = this.pushLoop(label, true);
      const top = this.enc.here();
      this.emitStatement(s.body);
      const testPc = this.enc.here();
      this.emitExpr(s.test);
      this.enc.emitJumpTo(Op.JumpIfTrue, top);
      this.popLoop(ctx, testPc);
    } else {
      const outer = this.mark();
      if (s.init) {
        if (s.init.type === "VariableDeclaration") this.emitVarDecl(s.init);
        else this.emitExprStatementDiscard(s.init);
      }
      const ctx = this.pushLoop(label, true);
      const top = this.enc.here();
      let exit: JumpSlot | -1 = -1;
      if (s.test) {
        this.emitExpr(s.test);
        exit = this.enc.emitJump(Op.JumpIfFalse);
      }
      this.emitStatement(s.body);
      const updatePc = this.enc.here();
      if (s.update) this.emitExprStatementDiscard(s.update);
      this.enc.emitJumpTo(Op.Jump, top);
      if (exit !== -1) this.enc.patch(exit);
      this.popLoop(ctx, updatePc);
      this.release(outer);
    }
  }

  // ── break / continue ─────────────────────────────────────────────────────────
  private pushLoop(label: string | null, isLoop: boolean): LoopCtx {
    const ctx: LoopCtx = { label, breaks: [], continues: [], isLoop };
    this.loops.push(ctx);
    return ctx;
  }
  private popLoop(ctx: LoopCtx, continueTarget: number): void {
    this.loops.pop();
    const end = this.enc.here();
    for (const b of ctx.breaks) this.enc.patch(b, end);
    if (continueTarget >= 0) for (const c of ctx.continues) this.enc.patch(c, continueTarget);
  }
  private findLoop(label: string | null, needLoop: boolean): LoopCtx {
    for (let i = this.loops.length - 1; i >= 0; i -= 1) {
      const ctx = this.loops[i]!;
      if (label === null) {
        if (!needLoop || ctx.isLoop) return ctx;
      } else if (ctx.label === label) {
        return ctx;
      }
    }
    throw new UnsupportedNodeError(`${needLoop ? "continue" : "break"} with no matching target`, "Break/Continue");
  }
  private emitBreak(s: Node): void {
    const ctx = this.findLoop(s.label ? s.label.name : null, false);
    ctx.breaks.push(this.enc.emitJump(Op.Jump));
  }
  private emitContinue(s: Node): void {
    const ctx = this.findLoop(s.label ? s.label.name : null, true);
    ctx.continues.push(this.enc.emitJump(Op.Jump));
  }

  // ── expressions (each leaves its value in acc, restores regTop) ──────────────
  private emitExpr(node: Node): void {
    if (node.type === "Literal") this.emitLiteral(node);
    else if (node.type === "Identifier") {
      if (node.name === "globalThis" && !this.isBoundName("globalThis")) {
        this.enc.emitCallBuiltin(Builtin.GlobalThis, 0, 0);
      } else {
        this.emitLoadName(node.name);
      }
    } else if (node.type === "ThisExpression") this.enc.emitReg(Op.Ldar, 0);
    else if (node.type === "ArrayExpression") this.emitArray(node);
    else if (node.type === "ObjectExpression") this.emitObject(node);
    else if (node.type === "MemberExpression") this.emitMemberGet(node);
    else if (node.type === "CallExpression") this.emitCall(node);
    else if (node.type === "NewExpression") this.emitNew(node);
    else if (node.type === "AssignmentExpression") this.emitAssign(node);
    else if (node.type === "UpdateExpression") this.emitUpdate(node);
    else if (node.type === "BinaryExpression") this.emitBinary(node);
    else if (node.type === "LogicalExpression") this.emitLogical(node);
    else if (node.type === "UnaryExpression") this.emitUnary(node);
    else if (node.type === "ConditionalExpression") this.emitConditional(node);
    else if (node.type === "SequenceExpression") this.emitSequence(node);
    else if (node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression") this.emitClosure(node);
    else if (node.type === "TemplateLiteral") this.emitTemplate(node);
    else throw new UnsupportedNodeError(`expression ${node.type}`, node.type);
  }

  private emitLiteral(node: Node): void {
    const v = node.value;
    if (node.regex) throw new UnsupportedNodeError("regex literal", "Literal");
    if (v === null) {
      // Distinguish JSON `null` literal from bigint/undefined shapes.
      this.enc.emit0(Op.LdaNull);
      return;
    }
    const t = typeof v;
    if (t === "boolean") {
      this.enc.emit0(v ? Op.LdaTrue : Op.LdaFalse);
      return;
    }
    if (t === "number" && v === 0 && 1 / v === Infinity) {
      // +0 fast path (leave -0 to the const pool so it round-trips exactly).
      this.enc.emit0(Op.LdaZero);
      return;
    }
    if (t === "bigint") throw new UnsupportedNodeError("bigint literal", "Literal");
    this.enc.emitConst(Op.LdaConst, this.enc.internConst(v));
  }

  private emitLoadName(name: string): void {
    const r = this.names.get(name);
    if (r !== undefined) this.enc.emitReg(Op.Ldar, r);
    else this.enc.emitConst(Op.LdName, this.enc.internConst(name));
  }
  private storeName(name: string): void {
    // acc holds the value; leaves acc unchanged (assignment-expression value).
    const r = this.names.get(name);
    if (r !== undefined) this.enc.emitReg(Op.Star, r);
    else this.enc.emitConst(Op.StName, this.enc.internConst(name));
  }

  /** Whether a syntactic global name is shadowed anywhere in this function.
   *
   * Hoisted script bindings are environment-backed rather than register-backed,
   * so checking only `names` would incorrectly fold `var Error; new Error()`
   * to the intrinsic. The explicit scans keep this helper inside the
   * self-compile subset.
   */
  private isBoundName(name: string): boolean {
    for (const bound of this.boundNames) {
      if (bound === name) return true;
    }
    for (const local of this.hoistedVars) {
      if (local === name) return true;
    }
    for (const fn of this.hoistedFuncs) {
      if (fn.id && fn.id.name === name) return true;
    }
    return false;
  }

  private emitArray(node: Node): void {
    const m = this.mark();
    const base = this.regTop;
    let n = 0;
    for (const el of node.elements) {
      if (el === null) {
        this.enc.emit0(Op.LdaUndef); // elision → hole ≈ undefined (Phase 1)
      } else if (el.type === "SpreadElement") {
        throw new UnsupportedNodeError("array spread", "SpreadElement");
      } else {
        this.emitExpr(el);
      }
      const slot = this.allocReg();
      this.enc.emitReg(Op.Star, slot);
      n += 1;
    }
    this.enc.emitCallBuiltin(Builtin.ArrayLiteral, base, n);
    this.release(m);
  }

  private emitObject(node: Node): void {
    const m = this.mark();
    const base = this.regTop;
    let count = 0;
    for (const prop of node.properties) {
      if (prop.type === "SpreadElement") throw new UnsupportedNodeError("object spread", "SpreadElement");
      if (prop.kind !== "init") throw new UnsupportedNodeError(`object ${prop.kind}`, "Property");
      if (prop.method) throw new UnsupportedNodeError("object method shorthand", "Property");
      // key
      if (prop.computed) {
        this.emitExpr(prop.key);
      } else if (prop.key.type === "Identifier") {
        this.enc.emitConst(Op.LdaConst, this.enc.internConst(prop.key.name));
      } else if (prop.key.type === "Literal") {
        this.enc.emitConst(Op.LdaConst, this.enc.internConst(String(prop.key.value)));
      } else {
        throw new UnsupportedNodeError(`object key ${prop.key.type}`, prop.key.type);
      }
      const kSlot = this.allocReg();
      this.enc.emitReg(Op.Star, kSlot);
      // value
      this.emitExpr(prop.value);
      const vSlot = this.allocReg();
      this.enc.emitReg(Op.Star, vSlot);
      count += 2;
    }
    this.enc.emitCallBuiltin(Builtin.ObjectLiteral, base, count);
    this.release(m);
  }

  /** `obj.p` / `obj[k]` → acc. */
  private emitMemberGet(node: Node): void {
    if (node.computed) {
      const m = this.mark();
      this.emitExpr(node.object);
      const rObj = this.allocReg();
      this.enc.emitReg(Op.Star, rObj);
      this.emitExpr(node.property);
      const rKey = this.allocReg();
      this.enc.emitReg(Op.Star, rKey);
      this.enc.emitReg(Op.Ldar, rObj); // acc = obj
      this.enc.emitReg(Op.GetElem, rKey); // acc = obj[key]
      this.release(m);
    } else {
      this.emitExpr(node.object); // acc = obj
      this.enc.emitConst(Op.GetProp, this.enc.internConst(node.property.name)); // acc = obj.p
    }
  }

  private emitCall(node: Node): void {
    if (node.optional) throw new UnsupportedNodeError("optional call", "CallExpression");
    // Resolve the small Phase-1 generic-builtin surface that has no property on
    // the sparse standalone global object. Keep this classification inline:
    // the current self-compiler can lose a newly-added late class-method call
    // on this dynamic ESTree receiver (#3651's adjacent method seam).
    const directCallee = node.callee;
    let directBuiltin = -1;
    if (directCallee.type === "Identifier" && !this.isBoundName(directCallee.name)) {
      if (directCallee.name === "Number") directBuiltin = Builtin.Number;
    } else if (
      directCallee.type === "MemberExpression" &&
      !directCallee.optional &&
      !directCallee.computed &&
      directCallee.object.type === "Identifier" &&
      directCallee.object.name === "Math" &&
      !this.isBoundName("Math") &&
      directCallee.property.type === "Identifier"
    ) {
      const mathName = directCallee.property.name;
      if (mathName === "max") directBuiltin = Builtin.MathMax;
      else if (mathName === "min") directBuiltin = Builtin.MathMin;
      else if (mathName === "abs") directBuiltin = Builtin.MathAbs;
      else if (mathName === "floor") directBuiltin = Builtin.MathFloor;
      else if (mathName === "ceil") directBuiltin = Builtin.MathCeil;
      else if (mathName === "round") directBuiltin = Builtin.MathRound;
    }
    if (directBuiltin >= 0) {
      const builtinCallMark = this.mark();
      const builtinCallBase = this.regTop;
      for (let i = 0; i < node.arguments.length; i += 1) this.allocReg();
      this.emitArgWindow(node.arguments, builtinCallBase);
      this.enc.emitCallBuiltin(directBuiltin, builtinCallBase, node.arguments.length);
      this.release(builtinCallMark);
      return;
    }

    const argc = node.arguments.length;
    const m = this.mark();
    const base = this.regTop;
    // Reserve the arg window regs[base .. base+argc] (receiver + argc args).
    for (let i = 0; i <= argc; i += 1) this.allocReg();

    const callee = node.callee;
    let rCallee: number;
    if (callee.type === "MemberExpression" && !callee.optional) {
      // Method call: receiver = obj, callee = obj.member.
      this.emitExpr(callee.object);
      this.enc.emitReg(Op.Star, base); // window[0] = receiver
      if (callee.computed) {
        this.emitExpr(callee.property);
        const rKey = this.allocReg();
        this.enc.emitReg(Op.Star, rKey);
        this.enc.emitReg(Op.Ldar, base);
        this.enc.emitReg(Op.GetElem, rKey); // acc = receiver[key]
      } else {
        this.enc.emitReg(Op.Ldar, base);
        this.enc.emitConst(Op.GetProp, this.enc.internConst(callee.property.name)); // acc = receiver.m
      }
      rCallee = this.allocReg();
      this.enc.emitReg(Op.Star, rCallee);
    } else {
      // Plain call: receiver = undefined.
      this.enc.emit0(Op.LdaUndef);
      this.enc.emitReg(Op.Star, base);
      this.emitExpr(callee);
      rCallee = this.allocReg();
      this.enc.emitReg(Op.Star, rCallee);
    }

    // Evaluate args into window[1..argc].
    this.emitArgWindow(node.arguments, base + 1);

    this.enc.emitReg(Op.Ldar, rCallee); // acc = callee
    this.enc.emitCall(Op.Call, base, argc);
    this.release(m);
  }

  private emitNew(node: Node): void {
    // The standalone global object is deliberately a per-module open object,
    // not a complete JS realm. Lower the direct, unshadowed native Error family
    // through CallBuiltin so the E4 boundary can transport real catchable error
    // values without requiring host globals or synthetic constructor carriers.
    // Alias/dynamic-constructor forms continue through the ordinary Construct
    // seam; this arm is the Phase-1 acceptance path.
    if (node.callee.type === "Identifier" && !this.isBoundName(node.callee.name)) {
      const builtinId = this.errorBuiltinId(node.callee.name);
      if (builtinId >= 0) {
        // Keep names distinct from the ordinary Construct locals below. The
        // self-compiler currently flattens block-scoped locals in this method
        // before its TDZ pass (#3651), so reusing `m`/`base` in sibling blocks
        // produces a false "before initialization" diagnostic.
        const builtinMark = this.mark();
        const builtinBase = this.regTop;
        for (let i = 0; i < node.arguments.length; i += 1) this.allocReg();
        this.emitArgWindow(node.arguments, builtinBase);
        this.enc.emitCallBuiltin(builtinId, builtinBase, node.arguments.length);
        this.release(builtinMark);
        return;
      }
    }

    const argc = node.arguments.length;
    const m = this.mark();
    const base = this.regTop;
    for (let i = 0; i <= argc; i += 1) this.allocReg(); // window[0] unused (newTarget), args at [1..]
    this.enc.emit0(Op.LdaUndef);
    this.enc.emitReg(Op.Star, base);
    this.emitExpr(node.callee);
    const rCallee = this.allocReg();
    this.enc.emitReg(Op.Star, rCallee);
    this.emitArgWindow(node.arguments, base + 1);
    this.enc.emitReg(Op.Ldar, rCallee);
    this.enc.emitCall(Op.Construct, base, argc);
    this.release(m);
  }

  private errorBuiltinId(name: string): number {
    if (name === "Error") return Builtin.Error;
    if (name === "TypeError") return Builtin.TypeError;
    if (name === "RangeError") return Builtin.RangeError;
    if (name === "SyntaxError") return Builtin.SyntaxError;
    if (name === "ReferenceError") return Builtin.ReferenceError;
    return -1;
  }

  private emitArgWindow(args: Node[], firstSlot: number): void {
    let slot = firstSlot;
    for (const arg of args) {
      if (arg.type === "SpreadElement") throw new UnsupportedNodeError("call spread", "SpreadElement");
      this.emitExpr(arg);
      this.enc.emitReg(Op.Star, slot);
      slot += 1;
    }
  }

  private emitAssign(node: Node): void {
    const op: string = node.operator;
    const target = node.left;
    if (op === "=") {
      if (target.type === "Identifier") {
        this.emitExpr(node.right);
        this.storeName(target.name);
      } else if (target.type === "MemberExpression") {
        this.emitMemberSet(target, node.right);
      } else {
        throw new UnsupportedNodeError(`assignment target ${target.type}`, target.type);
      }
      return;
    }
    // Compound assignment `x op= v` → `x = x <binop> v` (binop is op without `=`).
    const binOp = op.slice(0, op.length - 1);
    const rt = this.binaryOpcode(binOp);
    if (rt === -1) throw new UnsupportedNodeError(`compound assignment ${op}`, "AssignmentExpression");
    if (target.type === "Identifier") {
      const m = this.mark();
      this.emitLoadName(target.name); // acc = x
      const rLeft = this.allocReg();
      this.enc.emitReg(Op.Star, rLeft);
      this.emitExpr(node.right); // acc = v
      this.emitBinaryWithLeft(binOp, rLeft); // acc = x op v
      this.storeName(target.name);
      this.release(m);
    } else if (target.type === "MemberExpression") {
      this.emitCompoundMember(target, binOp, node.right);
    } else {
      throw new UnsupportedNodeError(`compound target ${target.type}`, target.type);
    }
  }

  /** `obj.p = v` / `obj[k] = v`, leaving acc = v. */
  private emitMemberSet(target: Node, rhs: Node): void {
    const m = this.mark();
    this.emitExpr(target.object);
    const rObj = this.allocReg();
    this.enc.emitReg(Op.Star, rObj);
    if (target.computed) {
      this.emitExpr(target.property);
      const rKey = this.allocReg();
      this.enc.emitReg(Op.Star, rKey);
      this.emitExpr(rhs); // acc = value
      this.enc.emitRegReg(Op.SetElem, rKey, rObj); // regs[rObj][regs[rKey]] = acc
    } else {
      this.emitExpr(rhs); // acc = value
      this.enc.emitConstReg(Op.SetProp, this.enc.internConst(target.property.name), rObj);
    }
    this.release(m);
  }

  /** `obj.p op= v` / `obj[k] op= v`, evaluating the object/key once, acc = result. */
  private emitCompoundMember(target: Node, binOp: string, rhs: Node): void {
    const m = this.mark();
    this.emitExpr(target.object);
    const rObj = this.allocReg();
    this.enc.emitReg(Op.Star, rObj);
    let rKey = -1;
    if (target.computed) {
      this.emitExpr(target.property);
      rKey = this.allocReg();
      this.enc.emitReg(Op.Star, rKey);
      this.enc.emitReg(Op.Ldar, rObj);
      this.enc.emitReg(Op.GetElem, rKey); // acc = obj[key]
    } else {
      this.enc.emitReg(Op.Ldar, rObj);
      this.enc.emitConst(Op.GetProp, this.enc.internConst(target.property.name)); // acc = obj.p
    }
    const rLeft = this.allocReg();
    this.enc.emitReg(Op.Star, rLeft); // regs[rLeft] = current value
    this.emitExpr(rhs); // acc = v
    this.emitBinaryWithLeft(binOp, rLeft); // acc = current op v
    if (target.computed) {
      this.enc.emitRegReg(Op.SetElem, rKey, rObj);
    } else {
      this.enc.emitConstReg(Op.SetProp, this.enc.internConst(target.property.name), rObj);
    }
    this.release(m);
  }

  private emitUpdate(node: Node): void {
    // x++/++x/x--/--x, desugared to read → (± 1) → write, with pre/post value.
    const target = node.argument;
    const isInc = node.operator === "++";
    const prefix: boolean = node.prefix;
    const m = this.mark();
    if (target.type === "Identifier") {
      this.emitLoadName(target.name); // acc = old (already coerced by later ops)
      // ToNumber(old): +old = -(-old); keep old numeric value in a reg.
      this.enc.emit0(Op.Neg);
      this.enc.emit0(Op.Neg); // acc = ToNumber(old)
      const rOld = this.allocReg();
      this.enc.emitReg(Op.Star, rOld);
      // acc = 1; then new = old ± 1 via `acc = regs[rOld] op acc`.
      this.enc.emitConst(Op.LdaConst, this.enc.internConst(1));
      if (isInc)
        this.enc.emitReg(Op.Add, rOld); // acc = old + 1
      else this.enc.emitReg(Op.Sub, rOld); // acc = old - 1
      const rNew = this.allocReg();
      this.enc.emitReg(Op.Star, rNew);
      this.storeName(target.name); // store new (acc = new)
      // result value
      if (prefix) this.enc.emitReg(Op.Ldar, rNew);
      else this.enc.emitReg(Op.Ldar, rOld);
    } else if (target.type === "MemberExpression") {
      throw new UnsupportedNodeError("update on member expression", "UpdateExpression");
    } else {
      throw new UnsupportedNodeError(`update target ${target.type}`, target.type);
    }
    this.release(m);
  }

  private emitBinary(node: Node): void {
    const op: string = node.operator;
    // Comparison desugarings the ISA lacks. NOTE `>`/`>=` are NOT desugared to
    // swapped Lt/Le (#3356): §13.10.1 is IsLessThan(b, a, LeftFirst=FALSE), so
    // ToPrimitive must run in source order — the dedicated Gt/Ge ops (native
    // `>`/`>=`) carry that flag correctly; a `Lt(b, a)` swap coerced b first.
    if (op === "!=") {
      this.emitNegated(Op.Eq, node.left, node.right); // !(a == b)
      return;
    }
    if (op === "!==") {
      this.emitNegated(Op.StrictEq, node.left, node.right); // !(a === b)
      return;
    }
    const rt = this.binaryOpcode(op);
    if (rt === -1) throw new UnsupportedNodeError(`binary operator '${op}'`, "BinaryExpression");
    const m = this.mark();
    this.emitExpr(node.left);
    const rLeft = this.allocReg();
    this.enc.emitReg(Op.Star, rLeft);
    this.emitExpr(node.right);
    this.enc.emitReg(rt, rLeft); // acc = regs[rLeft] op acc
    this.release(m);
  }

  /** `left OP right` where a register already (will) hold the left operand. */
  private emitBinaryWithLeft(op: string, rLeft: number): void {
    const rt = this.binaryOpcode(op);
    if (rt === -1) throw new UnsupportedNodeError(`binary operator '${op}'`, "BinaryExpression");
    this.enc.emitReg(rt, rLeft);
  }

  private emitNegated(eqOp: number, left: Node, right: Node): void {
    const m = this.mark();
    this.emitExpr(left);
    const rLeft = this.allocReg();
    this.enc.emitReg(Op.Star, rLeft);
    this.emitExpr(right);
    this.enc.emitReg(eqOp, rLeft); // acc = (left == right)
    this.enc.emit0(Op.Not); // acc = !(...)
    this.release(m);
  }

  private binaryOpcode(op: string): number {
    switch (op) {
      case "+":
        return Op.Add;
      case "-":
        return Op.Sub;
      case "*":
        return Op.Mul;
      case "/":
        return Op.Div;
      case "%":
        return Op.Mod;
      case "==":
        return Op.Eq;
      case "===":
        return Op.StrictEq;
      case "<":
        return Op.Lt;
      case "<=":
        return Op.Le;
      case ">":
        return Op.Gt; // (#3356) own op — LeftFirst=false, see emitBinary note
      case ">=":
        return Op.Ge; // (#3356)
      default:
        return -1; // bitwise / shift / ** / in / instanceof — Phase-1 out of scope
    }
  }

  private emitLogical(node: Node): void {
    const op: string = node.operator;
    if (op === "&&") {
      this.emitExpr(node.left);
      const end = this.enc.emitJump(Op.JumpIfFalse); // false → result is left (in acc)
      this.emitExpr(node.right);
      this.enc.patch(end);
    } else if (op === "||") {
      this.emitExpr(node.left);
      const end = this.enc.emitJump(Op.JumpIfTrue); // true → result is left (in acc)
      this.emitExpr(node.right);
      this.enc.patch(end);
    } else if (op === "??") {
      // left ?? right: if left is null/undefined → right, else left.
      const m = this.mark();
      this.emitExpr(node.left);
      const rLeft = this.allocReg();
      this.enc.emitReg(Op.Star, rLeft);
      // nullish test: `left == null` is true iff left is null OR undefined.
      this.enc.emit0(Op.LdaNull);
      this.enc.emitReg(Op.Eq, rLeft); // acc = (regs[rLeft] == null)
      const toRight = this.enc.emitJump(Op.JumpIfTrue);
      this.enc.emitReg(Op.Ldar, rLeft); // acc = left
      const toEnd = this.enc.emitJump(Op.Jump);
      this.enc.patch(toRight);
      this.emitExpr(node.right);
      this.enc.patch(toEnd);
      this.release(m);
    } else {
      throw new UnsupportedNodeError(`logical operator '${op}'`, "LogicalExpression");
    }
  }

  private emitUnary(node: Node): void {
    const op: string = node.operator;
    const arg = node.argument;
    if (op === "typeof" && arg.type === "Identifier" && this.names.get(arg.name) === undefined) {
      // typeof <possibly-undeclared global> must NOT throw ReferenceError.
      const m = this.mark();
      this.enc.emitConst(Op.LdaConst, this.enc.internConst(arg.name));
      const r = this.allocReg();
      this.enc.emitReg(Op.Star, r);
      this.enc.emitCallBuiltin(Builtin.TypeofName, r, 1);
      this.release(m);
      return;
    }
    if (op === "typeof") {
      this.emitExpr(arg);
      this.enc.emit0(Op.TypeOf);
      return;
    }
    if (op === "!") {
      this.emitExpr(arg);
      this.enc.emit0(Op.Not);
      return;
    }
    if (op === "-") {
      this.emitExpr(arg);
      this.enc.emit0(Op.Neg);
      return;
    }
    if (op === "+") {
      // +x = ToNumber(x) = -(-x)
      this.emitExpr(arg);
      this.enc.emit0(Op.Neg);
      this.enc.emit0(Op.Neg);
      return;
    }
    if (op === "void") {
      this.emitExprStatementDiscard(arg);
      this.enc.emit0(Op.LdaUndef);
      return;
    }
    throw new UnsupportedNodeError(`unary operator '${op}'`, "UnaryExpression");
  }

  private emitConditional(node: Node): void {
    this.emitExpr(node.test);
    const toElse = this.enc.emitJump(Op.JumpIfFalse);
    this.emitExpr(node.consequent);
    const toEnd = this.enc.emitJump(Op.Jump);
    this.enc.patch(toElse);
    this.emitExpr(node.alternate);
    this.enc.patch(toEnd);
  }

  private emitSequence(node: Node): void {
    const exprs: Node[] = node.expressions;
    for (let i = 0; i < exprs.length; i += 1) {
      if (i < exprs.length - 1) this.emitExprStatementDiscard(exprs[i]);
      else this.emitExpr(exprs[i]);
    }
  }

  private emitTemplate(node: Node): void {
    // `q0${e0}q1${e1}…` → "" + q0 + e0 + q1 + … via `+` (concat). Template does
    // ToString(expr); `+` does ToPrimitive — equal for the common cases, a
    // documented Phase-1 approximation for exotic objects with asymmetric
    // toString/valueOf.
    const quasis: Node[] = node.quasis;
    const exprs: Node[] = node.expressions;
    const m = this.mark();
    // acc = "" + quasis[0].cooked
    this.enc.emitConst(Op.LdaConst, this.enc.internConst(quasis[0].value.cooked));
    for (let i = 0; i < exprs.length; i += 1) {
      // acc (accumulated string) → reg; eval expr → acc; Add reg → concat
      const rAcc = this.allocReg();
      this.enc.emitReg(Op.Star, rAcc);
      this.emitExpr(exprs[i]);
      this.enc.emitReg(Op.Add, rAcc); // acc = accumulated + expr
      // append quasi i+1
      const rAcc2 = this.allocReg();
      this.enc.emitReg(Op.Star, rAcc2);
      this.enc.emitConst(Op.LdaConst, this.enc.internConst(quasis[i + 1].value.cooked));
      this.enc.emitReg(Op.Add, rAcc2); // acc = (accumulated + expr) + quasi
      this.release(rAcc); // both temps released; loop reuses the slots
    }
    this.release(m);
  }

  /** Build a nested FuncMeta for a function/arrow node and leave a closure in acc. */
  private emitClosure(node: Node): void {
    const isArrow = node.type === "ArrowFunctionExpression";
    const isExprBody = isArrow && node.body.type !== "BlockStatement";
    const nm = node.id && node.id.name ? node.id.name : "";
    const child = new FunctionEmitter(node.params, node.body, nm, /*isScript*/ false, isExprBody);
    const meta = child.emit();
    const m = this.mark();
    this.enc.emitConst(Op.LdaConst, this.enc.internConst(meta));
    const r = this.allocReg();
    this.enc.emitReg(Op.Star, r);
    this.enc.emitCallBuiltin(Builtin.MakeClosure, r, 1);
    this.release(m);
  }
}

/** Emit a top-level Script/eval body (completion-value semantics) → FuncMeta. */
export function emitProgram(ast: Node): FuncMeta {
  if (ast.type !== "Program") throw new UnsupportedNodeError(`top-level ${ast.type}`, ast.type);
  const emitter = new FunctionEmitter([], ast, "", /*isScript*/ true, /*isExpressionBody*/ false);
  return emitter.emit();
}

/** Emit one parsed function node to callable metadata.
 *
 * `new Function` is parsed through a synthetic `FunctionDeclaration`, then
 * handed here instead of compiling the enclosing `Program` as an eval script.
 * The resulting metadata binds the parsed parameters in `regs[1..]`, returns
 * from the function body normally, and carries the synthetic `anonymous` name
 * without installing it as a global declaration.
 */
export function emitFunction(node: Node): FuncMeta {
  if (
    node.type !== "FunctionDeclaration" &&
    node.type !== "FunctionExpression" &&
    node.type !== "ArrowFunctionExpression"
  ) {
    throw new UnsupportedNodeError(`function entry ${node.type}`, node.type);
  }
  const isArrow = node.type === "ArrowFunctionExpression";
  const isExpressionBody = isArrow && node.body.type !== "BlockStatement";
  const name = node.id && node.id.name ? node.id.name : "";
  const emitter = new FunctionEmitter(node.params, node.body, name, /*isScript*/ false, isExpressionBody);
  return emitter.emit();
}
