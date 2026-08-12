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
// ── ISA desugarings (the append-only opcode set is deliberately minimal) ─────────────
// The ISA has dedicated relational/equality ops and only the signed shifts
// needed by the runtime-eval acceptance slice. The emitter desugars what it can:
//   a != b  → !(a == b)    a !== b → !(a === b)
//   +x      → -( -x )      (double-negate = ToNumber)
//   `a${x}` → "a" + x      (template → concat)
// Bitwise/unsigned-shift/`**`/`in`/`instanceof`, generators/async, destructuring,
// spread, and regex literals are Phase-1 out-of-scope: the emitter
// throws {@link UnsupportedNodeError} so the differential harness skips the body
// and reports coverage (they are named follow-ups in the issue).

import { Builtin, Encoder, type JumpSlot } from "./encoder.js";
import { appendPatternBoundNames } from "./eval-environment.js";
import { FLAG_CLASS_CONSTRUCTOR, FLAG_SCRIPT, FLAG_STRICT, type FuncMeta, type JSValue } from "./types.js";
import {
  BUILTIN_ASSIGN_OUTER_NAME,
  BUILTIN_DIRECT_EVAL,
  BUILTIN_DEFINE_CLASS_METHOD,
  BUILTIN_FINALIZE_CLASS,
  BUILTIN_FOR_IN_KEYS,
  BUILTIN_FOR_OF_VALUES,
  BUILTIN_OBJECT_DEFINE_PROPERTY,
  BUILTIN_PUSH_OBJECT_ENV,
  BUILTIN_PUSH_LEXICAL_ENV,
  BUILTIN_REGEXP_CREATE,
  BUILTIN_RESTORE_ENV,
  BUILTIN_SAVE_ENV,
  Op,
} from "./opcodes.js";

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
  /** Jump slots for control contexts; lexical-scope markers reuse the same
   * existing carrier for their active binding-name strings. */
  continues: any[];
  /** True for loops (continue is legal); false for a plain labeled block. */
  isLoop: boolean;
}

/** Internal marker stored in the existing control-context stack for an active
 * lexical or object environment. It cannot collide with an ECMAScript label. */
const LEXICAL_SCOPE_LABEL = "\u0000lexical-env";

/**
 * Same marker, for a **simple** `catch (e)` parameter's declarative record. It
 * is a lexical environment for every purpose except one: B.3.5 exempts a simple
 * `CatchParameter: BindingIdentifier` from cancelling B.3.3's web-compat var
 * binding, so `try {} catch (f) { { function f(){} } }` must still update the
 * enclosing var `f`. A destructuring parameter does cancel, and `emitTry`
 * rejects those earlier, so this label always means "does not cancel" (#4137).
 */
const SIMPLE_CATCH_SCOPE_LABEL = LEXICAL_SCOPE_LABEL + "catch-param";

/** Both markers denote a pushed environment record on the control stack. */
function isEnvScopeLabel(label: string | null): boolean {
  return label === LEXICAL_SCOPE_LABEL || label === SIMPLE_CATCH_SCOPE_LABEL;
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
  /** Logical length of `loops`. Self-compiled growable class-field vectors do
   * not reliably retain `.pop()` shrinkage, so stale physical slots are
   * overwritten and ignored beyond this pointer. */
  private loopTop = 0;
  /** In a script/eval body, the register holding the running completion value. */
  private completionReg = -1;
  /** Hoisted var/let/const binding names (collected before emission). */
  private readonly hoistedVars: string[] = [];
  /** Script lexical names, predeclared in a private eval environment. */
  private readonly hoistedLexicals: string[] = [];
  /** Hoisted function declarations (collected before emission). */
  private readonly hoistedFuncs: Node[] = [];
  /** Function directive-prologue strictness (scripts keep their global-this entry semantics). */
  private strictMode = false;
  /** True when PerformEval already created the script's environment bindings. */
  private readonly scriptBindingsPredeclared: boolean;
  /** Caller lexical names that cancel sloppy B.3.3 synthetic outer vars. */
  private readonly annexBCancelledNames: JSValue;

  constructor(
    params: Node[],
    body: Node,
    name: JSValue,
    isScript: boolean,
    isExpressionBody: boolean,
    forceStrict: boolean,
    scriptBindingsPredeclared: boolean,
    annexBCancelledNames: JSValue,
  ) {
    // Use explicit fields instead of TypeScript parameter properties: the E2
    // self-compiler materialises declared class fields as WasmGC struct fields,
    // while parameter properties currently fall back to dynamic object reads.
    this.params = params;
    this.body = body;
    this.name = name;
    this.isScript = isScript;
    this.isExpressionBody = isExpressionBody; // arrow with expression body
    this.strictMode = forceStrict;
    this.scriptBindingsPredeclared = scriptBindingsPredeclared;
    this.annexBCancelledNames = annexBCancelledNames;
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
        for (const name of this.hoistedLexicals) this.bind(name);
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

  /** Collect root declarations plus nested `var`s. Nested lexical and function
   * declarations are installed by `emitBlock` instead of being flattened into
   * the eval/function environment. */
  private collectHoist(stmts: Node[]): void {
    // Record every root binding first. Annex B eligibility for a nested block
    // function depends on lexical declarations that may occur later in source.
    for (const s of stmts) {
      if (s.type === "VariableDeclaration") {
        for (const d of s.declarations) {
          this.collectHoistPattern(d.id, s.kind !== "var");
        }
      } else if (s.type === "FunctionDeclaration") {
        if (s.id) this.hoistedFuncs.push(s);
      } else if (s.type === "ClassDeclaration") {
        if (s.id) this.collectHoistPattern(s.id, true);
      }
    }
    for (const s of stmts) {
      if (s.type !== "VariableDeclaration" && s.type !== "FunctionDeclaration" && s.type !== "ClassDeclaration") {
        this.collectNestedVarHoist(s, []);
      }
    }
  }
  private collectNestedVarHoist(s: Node, lexicalAncestors: string[]): void {
    if (s.type === "VariableDeclaration") {
      if (s.kind === "var") for (const d of s.declarations) this.collectHoistPattern(d.id, false);
    } else if (s.type === "FunctionDeclaration") {
      if (!this.strictMode && s.id) {
        let conflict = false;
        for (const rootName of this.hoistedLexicals) {
          if (rootName === s.id.name) conflict = true;
        }
        for (const outerName of lexicalAncestors) {
          if (outerName === s.id.name) conflict = true;
        }
        for (let i = 0; i < this.annexBCancelledNames.length; i += 1) {
          if (this.annexBCancelledNames[i] === s.id.name) conflict = true;
        }
        if (!conflict) this.collectHoistPattern(s.id, false);
      }
      return;
    } else if (s.type === "ClassDeclaration") {
      return;
    } else if (s.type === "IfStatement") {
      this.collectNestedVarHoist(s.consequent, lexicalAncestors);
      if (s.alternate) this.collectNestedVarHoist(s.alternate, lexicalAncestors);
    } else if (s.type === "BlockStatement") {
      const nestedLexicals: string[] = [];
      for (const name of lexicalAncestors) nestedLexicals.push(name);
      for (const inner of s.body) {
        if (inner.type === "VariableDeclaration" && inner.kind !== "var") {
          for (const declaration of inner.declarations) {
            if (declaration.id.type === "Identifier") nestedLexicals.push(declaration.id.name);
          }
        } else if (inner.type === "ClassDeclaration" && inner.id) {
          nestedLexicals.push(inner.id.name);
        }
      }
      for (const inner of s.body) this.collectNestedVarHoist(inner, nestedLexicals);
    } else if (s.type === "WhileStatement" || s.type === "DoWhileStatement" || s.type === "WithStatement") {
      this.collectNestedVarHoist(s.body, lexicalAncestors);
    } else if (s.type === "ForStatement") {
      const loopLexicals: string[] = [];
      for (const name of lexicalAncestors) loopLexicals.push(name);
      if (s.init && s.init.type === "VariableDeclaration") {
        if (s.init.kind === "var") {
          this.collectNestedVarHoist(s.init, lexicalAncestors);
        } else {
          for (const declaration of s.init.declarations) {
            if (declaration.id.type === "Identifier") loopLexicals.push(declaration.id.name);
          }
        }
      }
      this.collectNestedVarHoist(s.body, loopLexicals);
    } else if (s.type === "ForInStatement" || s.type === "ForOfStatement") {
      const loopLexicals: string[] = [];
      for (const name of lexicalAncestors) loopLexicals.push(name);
      if (s.left.type === "VariableDeclaration") {
        if (s.left.kind === "var") {
          this.collectNestedVarHoist(s.left, lexicalAncestors);
        } else {
          for (const declaration of s.left.declarations) {
            if (declaration.id.type === "Identifier") loopLexicals.push(declaration.id.name);
          }
        }
      }
      this.collectNestedVarHoist(s.body, loopLexicals);
    } else if (s.type === "SwitchStatement") {
      const switchLexicals: string[] = [];
      for (const name of lexicalAncestors) switchLexicals.push(name);
      for (const switchCase of s.cases) {
        for (const consequent of switchCase.consequent) {
          if (consequent.type === "VariableDeclaration" && consequent.kind !== "var") {
            for (const declaration of consequent.declarations) {
              if (declaration.id.type === "Identifier") switchLexicals.push(declaration.id.name);
            }
          } else if (consequent.type === "ClassDeclaration" && consequent.id) {
            switchLexicals.push(consequent.id.name);
          }
        }
      }
      for (const switchCase of s.cases) {
        for (const consequent of switchCase.consequent) {
          this.collectNestedVarHoist(consequent, switchLexicals);
        }
      }
    } else if (s.type === "TryStatement") {
      this.collectNestedVarHoist(s.block, lexicalAncestors);
      if (s.handler) {
        // Mirrors `collectNestedVarDeclarations`: a SIMPLE catch parameter is
        // B.3.5-exempt and does not shadow the handler descent, a
        // destructuring one is not exempt and must.
        const handlerLexicals: string[] = [];
        for (const name of lexicalAncestors) handlerLexicals.push(name);
        if (s.handler.param && s.handler.param.type !== "Identifier") {
          appendPatternBoundNames(s.handler.param, handlerLexicals);
        }
        this.collectNestedVarHoist(s.handler.body, handlerLexicals);
      }
      if (s.finalizer) this.collectNestedVarHoist(s.finalizer, lexicalAncestors);
    } else if (s.type === "LabeledStatement") {
      this.collectNestedVarHoist(s.body, lexicalAncestors);
    }
  }
  private collectHoistPattern(id: Node, lexical: boolean): void {
    if (id.type === "Identifier") {
      if (lexical) this.hoistedLexicals.push(id.name);
      else this.hoistedVars.push(id.name);
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
    if (!this.scriptBindingsPredeclared) {
      for (const name of this.hoistedVars) {
        this.enc.emit0(Op.LdaUndef);
        this.enc.emitConst(Op.StName, this.enc.internConst(name));
      }
      for (const name of this.hoistedLexicals) {
        this.enc.emit0(Op.LdaUndef);
        this.enc.emitConst(Op.StName, this.enc.internConst(name));
      }
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
    } else if (s.type === "ClassDeclaration") {
      if (!s.id) throw new UnsupportedNodeError("anonymous class declaration", "ClassDeclaration");
      this.emitClass(s);
      if (this.isActiveBlockLexical(s.id.name) || (this.isScript && this.scriptBindingsPredeclared)) {
        this.initializeName(s.id.name);
      } else {
        this.storeName(s.id.name);
      }
    } else if (s.type === "BlockStatement") {
      this.emitBlock(s);
    } else if (s.type === "WithStatement") {
      this.emitWith(s);
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
    } else if (s.type === "ForInStatement" || s.type === "ForOfStatement") {
      this.resetCompletion();
      this.emitForInOf(s, null);
    } else if (s.type === "SwitchStatement") {
      this.resetCompletion();
      this.emitSwitch(s);
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

  /** Emit one lexical block. Only blocks that declare let/const/class/function
   * need an EnvRec; declaration-free blocks retain the previous bytecode shape. */
  private emitBlock(s: Node): void {
    const lexicalNames: string[] = [];
    const functions: Node[] = [];
    const annexBFunctionNames: string[] = [];
    for (const inner of s.body) {
      if (inner.type === "VariableDeclaration" && inner.kind !== "var") {
        for (const declaration of inner.declarations) {
          if (declaration.id.type !== "Identifier") {
            throw new UnsupportedNodeError(`destructuring (${declaration.id.type})`, declaration.id.type);
          }
          lexicalNames.push(declaration.id.name);
        }
      } else if (inner.type === "FunctionDeclaration") {
        if (inner.id) {
          lexicalNames.push(inner.id.name);
          functions.push(inner);
          let outerLexicalConflict = this.cancelsAnnexBVarBinding(inner.id.name);
          if (!outerLexicalConflict) {
            for (const rootLexical of this.hoistedLexicals) {
              if (rootLexical === inner.id.name) {
                outerLexicalConflict = true;
                break;
              }
            }
          }
          if (!outerLexicalConflict) {
            for (let i = 0; i < this.annexBCancelledNames.length; i += 1) {
              if (this.annexBCancelledNames[i] === inner.id.name) outerLexicalConflict = true;
            }
          }
          if (!this.strictMode && !outerLexicalConflict) annexBFunctionNames.push(inner.id.name);
        }
      } else if (inner.type === "ClassDeclaration" && inner.id) {
        lexicalNames.push(inner.id.name);
      }
    }

    if (lexicalNames.length === 0) {
      for (const inner of s.body) this.emitStatement(inner);
      return;
    }

    const blockMark = this.mark();
    const namesReg = this.allocReg();
    const saveReg = this.allocReg();
    this.enc.emitConst(Op.LdaConst, this.enc.internConst(lexicalNames));
    this.enc.emitReg(Op.Star, namesReg);
    this.enc.emitCallBuiltin(BUILTIN_PUSH_LEXICAL_ENV, namesReg, 1);
    this.enc.emitReg(Op.Star, saveReg);
    const scopeCtx: LoopCtx = {
      label: LEXICAL_SCOPE_LABEL,
      breaks: [saveReg],
      continues: lexicalNames,
      isLoop: false,
    };
    this.installLoopCtx(scopeCtx);

    for (const fn of functions) {
      this.emitClosure(fn);
      this.initializeName(fn.id.name);
    }
    for (const inner of s.body) {
      if (inner.type === "FunctionDeclaration") {
        this.emitAnnexBFunctionAssignment(inner, annexBFunctionNames);
      } else {
        this.emitStatement(inner);
      }
    }

    this.enc.emitCallBuiltin(BUILTIN_RESTORE_ENV, saveReg, 1);
    this.loopTop -= 1;
    this.release(blockMark);
  }

  /** Emit a sloppy `with` statement as one Object Environment Record link.
   * The parser rejects `with` in strict code. Reusing the environment-scope
   * control marker makes break/continue and catch unwinding restore the same
   * saved parent as lexical blocks. */
  private emitWith(s: Node): void {
    const withMark = this.mark();
    this.emitExpr(s.object);
    const objectReg = this.allocReg();
    this.enc.emitReg(Op.Star, objectReg);
    const saveReg = this.allocReg();
    this.enc.emitCallBuiltin(BUILTIN_PUSH_OBJECT_ENV, objectReg, 1);
    this.enc.emitReg(Op.Star, saveReg);

    const scopeCtx: LoopCtx = {
      label: LEXICAL_SCOPE_LABEL,
      breaks: [saveReg],
      continues: [],
      isLoop: false,
    };
    this.installLoopCtx(scopeCtx);

    this.emitStatement(s.body);

    this.enc.emitCallBuiltin(BUILTIN_RESTORE_ENV, saveReg, 1);
    this.loopTop -= 1;
    this.release(withMark);
  }

  /** Execute B.3.3's synthetic outer assignment at the declaration's source
   * position. The lexical function itself was initialized at scope entry; an
   * unselected switch clause or an earlier abrupt completion must not publish
   * it to the surrounding var environment. */
  private emitAnnexBFunctionAssignment(fn: Node, annexBFunctionNames: string[]): void {
    if (!fn.id) return;
    let annexB = false;
    for (const name of annexBFunctionNames) {
      if (name === fn.id.name) {
        annexB = true;
        break;
      }
    }
    if (!annexB) return;

    const assignmentMark = this.mark();
    this.emitLoadName(fn.id.name);
    if (this.isScript) {
      const closureReg = this.allocReg();
      this.enc.emitReg(Op.Star, closureReg);
      const nameReg = this.allocReg();
      this.enc.emitConst(Op.LdaConst, this.enc.internConst(fn.id.name));
      this.enc.emitReg(Op.Star, nameReg);
      this.enc.emitCallBuiltin(BUILTIN_ASSIGN_OUTER_NAME, closureReg, 2);
    } else {
      // Function bodies keep their var environment in fixed registers. The
      // active lexical binding has the same name, so bypass storeName and write
      // the pre-hoisted outer register explicitly.
      const outerReg = this.names.get(fn.id.name);
      if (outerReg !== undefined) this.enc.emitReg(Op.Star, outerReg);
    }
    // Annex B models this as a synthetic assignment statement. Unlike the
    // lexical FunctionDeclaration's empty completion, that assignment carries
    // the closure value through UpdateEmpty (for example, eval of a selected
    // switch-clause function returns the function object).
    if (this.isScript && this.completionReg >= 0) {
      this.enc.emitReg(Op.Star, this.completionReg);
    }
    this.release(assignmentMark);
  }

  /** `skipCatchParam` excludes the B.3.5-exempt simple catch parameter. */
  private scopeBindsName(name: string, skipCatchParam: boolean): boolean {
    for (let i = this.loopTop - 1; i >= 0; i -= 1) {
      const ctx = this.loops[i]!;
      if (skipCatchParam ? ctx.label !== LEXICAL_SCOPE_LABEL : !isEnvScopeLabel(ctx.label)) continue;
      for (let j = ctx.continues.length - 1; j >= 0; j -= 1) {
        if (ctx.continues[j] === name) return true;
      }
    }
    return false;
  }

  private isActiveBlockLexical(name: string): boolean {
    return this.scopeBindsName(name, false);
  }

  /** The Annex B B.3.3 cancellation test — as {@link isActiveBlockLexical} but a
   * simple catch parameter does not count (B.3.5 exempts it). */
  private cancelsAnnexBVarBinding(name: string): boolean {
    return this.scopeBindsName(name, true);
  }

  private lexicalEnvDepth(): number {
    let depth = 0;
    for (let i = 0; i < this.loopTop; i += 1) {
      const ctx = this.loops[i]!;
      if (isEnvScopeLabel(ctx.label)) depth += 1;
    }
    return depth;
  }

  /** Emit one exact environment restoration before an abrupt jump. The first
   * exited scope's save register already points at the requested target depth. */
  private restoreEnvToDepth(depth: number): void {
    let currentDepth = 0;
    for (let i = 0; i < this.loopTop; i += 1) {
      const ctx = this.loops[i]!;
      if (!isEnvScopeLabel(ctx.label)) continue;
      if (currentDepth === depth) {
        this.enc.emitCallBuiltin(BUILTIN_RESTORE_ENV, ctx.breaks[0]!, 1);
        return;
      }
      currentDepth += 1;
    }
  }

  private emitVarDecl(s: Node): void {
    for (const d of s.declarations) {
      if (d.id.type !== "Identifier") throw new UnsupportedNodeError(`destructuring (${d.id.type})`, d.id.type);
      if (d.init) {
        this.emitExpr(d.init);
        if (
          s.kind !== "var" &&
          (this.isActiveBlockLexical(d.id.name) || (this.isScript && this.scriptBindingsPredeclared))
        ) {
          this.initializeName(d.id.name);
        } else this.storeName(d.id.name);
      } else if (
        s.kind !== "var" &&
        (this.isActiveBlockLexical(d.id.name) || (this.isScript && this.scriptBindingsPredeclared))
      ) {
        this.enc.emit0(Op.LdaUndef);
        this.initializeName(d.id.name);
      }
      // no init: the register already holds undefined (Phase 1: no TDZ)
    }
  }

  private emitIf(s: Node): void {
    this.emitExpr(s.test);
    const toElse = this.enc.emitJump(Op.JumpIfFalse);
    this.emitConditionalStatement(s.consequent);
    if (s.alternate) {
      const toEnd = this.enc.emitJump(Op.Jump);
      this.enc.patch(toElse, this.enc.here());
      this.emitConditionalStatement(s.alternate);
      this.enc.patch(toEnd, this.enc.here());
    } else {
      this.enc.patch(toElse, this.enc.here());
    }
  }

  /** Annex B accepts a FunctionDeclaration directly as an if arm in sloppy
   * code. Its semantics are those of a one-item implicit block: a lexical
   * function binding plus the conditional outer-var initialization. */
  private emitConditionalStatement(statement: Node): void {
    if (statement.type !== "FunctionDeclaration") {
      this.emitStatement(statement);
      return;
    }
    const block: Node = {};
    block.type = "BlockStatement";
    block.body = [statement];
    this.emitBlock(block);
  }

  private emitWhile(s: Node): void {
    const ctx = this.pushLoop(null, true);
    const top = this.enc.here();
    this.emitExpr(s.test);
    const exit = this.enc.emitJump(Op.JumpIfFalse);
    this.emitStatement(s.body);
    this.enc.emitJumpTo(Op.Jump, top);
    this.enc.patch(exit, this.enc.here());
    this.enc.patchTargetMarker(ctx.breaks[1]!, this.enc.here());
    this.popLoop(ctx, /*continueTarget*/ top);
  }

  private emitDoWhile(s: Node): void {
    const ctx = this.pushLoop(null, true);
    const top = this.enc.here();
    this.emitStatement(s.body);
    const testPc = this.enc.here();
    this.emitExpr(s.test);
    this.enc.emitJumpTo(Op.JumpIfTrue, top);
    this.enc.patchTargetMarker(ctx.breaks[1]!, this.enc.here());
    this.popLoop(ctx, /*continueTarget*/ testPc);
  }

  private emitFor(s: Node): void {
    const outer = this.mark();
    let lexicalSaveReg = -1;
    if (s.init && s.init.type === "VariableDeclaration" && s.init.kind !== "var") {
      const lexicalNames: string[] = [];
      for (const declaration of s.init.declarations) {
        if (declaration.id.type !== "Identifier") {
          throw new UnsupportedNodeError(`for destructuring (${declaration.id.type})`, declaration.id.type);
        }
        lexicalNames.push(declaration.id.name);
      }
      const namesReg = this.allocReg();
      lexicalSaveReg = this.allocReg();
      this.enc.emitConst(Op.LdaConst, this.enc.internConst(lexicalNames));
      this.enc.emitReg(Op.Star, namesReg);
      this.enc.emitCallBuiltin(BUILTIN_PUSH_LEXICAL_ENV, namesReg, 1);
      this.enc.emitReg(Op.Star, lexicalSaveReg);
      const scopeCtx: LoopCtx = {
        label: LEXICAL_SCOPE_LABEL,
        breaks: [lexicalSaveReg],
        continues: lexicalNames,
        isLoop: false,
      };
      this.installLoopCtx(scopeCtx);
    }
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
    if (exit !== -1) this.enc.patch(exit, this.enc.here());
    this.enc.patchTargetMarker(ctx.breaks[1]!, this.enc.here());
    this.popLoop(ctx, /*continueTarget*/ updatePc);
    if (lexicalSaveReg >= 0) {
      this.enc.emitCallBuiltin(BUILTIN_RESTORE_ENV, lexicalSaveReg, 1);
      this.loopTop -= 1;
    }
    this.release(outer);
  }

  /** Emit the bounded Phase-1 subset of ForIn/OfBodyEvaluation. Enumeration is
   * materialized once by a runtime helper, while the bytecode owns iteration,
   * abrupt-control routing, and a fresh lexical binding environment per turn. */
  private emitForInOf(s: Node, label: string | null): void {
    if (s.type === "ForOfStatement" && s.await) {
      throw new UnsupportedNodeError("for-await-of", "ForOfStatement");
    }

    const outer = this.mark();
    this.emitExpr(s.right);
    const sourceReg = this.allocReg();
    this.enc.emitReg(Op.Star, sourceReg);
    this.enc.emitCallBuiltin(s.type === "ForInStatement" ? BUILTIN_FOR_IN_KEYS : BUILTIN_FOR_OF_VALUES, sourceReg, 1);
    const valuesReg = this.allocReg();
    this.enc.emitReg(Op.Star, valuesReg);
    this.enc.emit0(Op.LdaZero);
    const indexReg = this.allocReg();
    this.enc.emitReg(Op.Star, indexReg);

    const ctx = this.pushLoop(label, true);
    const top = this.enc.here();
    this.enc.emitReg(Op.Ldar, valuesReg);
    this.enc.emitConst(Op.GetProp, this.enc.internConst("length"));
    this.enc.emitReg(Op.Lt, indexReg);
    const exit = this.enc.emitJump(Op.JumpIfFalse);

    this.enc.emitReg(Op.Ldar, valuesReg);
    this.enc.emitReg(Op.GetElem, indexReg);
    const valueReg = this.allocReg();
    this.enc.emitReg(Op.Star, valueReg);

    let lexicalSaveReg = -1;
    if (s.left.type === "VariableDeclaration") {
      if (s.left.declarations.length !== 1) {
        throw new UnsupportedNodeError("for-in/of declaration list", s.left.type);
      }
      const declaration = s.left.declarations[0]!;
      if (declaration.id.type !== "Identifier") {
        throw new UnsupportedNodeError(`for-in/of destructuring (${declaration.id.type})`, declaration.id.type);
      }
      if (s.left.kind === "var") {
        this.enc.emitReg(Op.Ldar, valueReg);
        this.storeName(declaration.id.name);
      } else {
        const namesReg = this.allocReg();
        lexicalSaveReg = this.allocReg();
        this.enc.emitConst(Op.LdaConst, this.enc.internConst([declaration.id.name]));
        this.enc.emitReg(Op.Star, namesReg);
        this.enc.emitCallBuiltin(BUILTIN_PUSH_LEXICAL_ENV, namesReg, 1);
        this.enc.emitReg(Op.Star, lexicalSaveReg);
        const scopeCtx: LoopCtx = {
          label: LEXICAL_SCOPE_LABEL,
          breaks: [lexicalSaveReg],
          continues: [declaration.id.name],
          isLoop: false,
        };
        this.installLoopCtx(scopeCtx);
        this.enc.emitReg(Op.Ldar, valueReg);
        this.initializeName(declaration.id.name);
      }
    } else if (s.left.type === "Identifier") {
      this.enc.emitReg(Op.Ldar, valueReg);
      this.storeName(s.left.name);
    } else {
      throw new UnsupportedNodeError(`for-in/of target ${s.left.type}`, s.left.type);
    }

    this.emitStatement(s.body);
    if (lexicalSaveReg >= 0) {
      this.enc.emitCallBuiltin(BUILTIN_RESTORE_ENV, lexicalSaveReg, 1);
      this.loopTop -= 1;
    }
    const updatePc = this.enc.here();
    this.enc.emitConst(Op.LdaConst, this.enc.internConst(1));
    this.enc.emitReg(Op.Add, indexReg);
    this.enc.emitReg(Op.Star, indexReg);
    this.enc.emitJumpTo(Op.Jump, top);

    this.enc.patch(exit, this.enc.here());
    this.enc.patchTargetMarker(ctx.breaks[1]!, this.enc.here());
    this.popLoop(ctx, updatePc);
    this.release(outer);
  }

  /** Emit §14.12 SwitchStatement with one CaseBlock lexical environment.
   * Case tests are evaluated in source order (skipping the default clause),
   * the selected clause falls through naturally, and an unlabeled break exits
   * this switch while continue continues to resolve to an enclosing loop. */
  private emitSwitch(s: Node): void {
    const switchMark = this.mark();
    this.emitExpr(s.discriminant);
    const discriminantReg = this.allocReg();
    this.enc.emitReg(Op.Star, discriminantReg);

    // The target is outside the CaseBlock environment. Register it before
    // pushing that environment so abrupt breaks restore the correct outer env.
    const switchCtx = this.pushLoop(null, false);

    const lexicalNames: string[] = [];
    const nonFunctionLexicalNames: string[] = [];
    const functions: Node[] = [];
    const annexBFunctionNames: string[] = [];
    for (const switchCase of s.cases) {
      for (const consequent of switchCase.consequent) {
        if (consequent.type === "VariableDeclaration" && consequent.kind !== "var") {
          for (const declaration of consequent.declarations) {
            if (declaration.id.type !== "Identifier") {
              throw new UnsupportedNodeError(`destructuring (${declaration.id.type})`, declaration.id.type);
            }
            lexicalNames.push(declaration.id.name);
            nonFunctionLexicalNames.push(declaration.id.name);
          }
        } else if (consequent.type === "FunctionDeclaration" && consequent.id) {
          lexicalNames.push(consequent.id.name);
          functions.push(consequent);
        } else if (consequent.type === "ClassDeclaration" && consequent.id) {
          lexicalNames.push(consequent.id.name);
          nonFunctionLexicalNames.push(consequent.id.name);
        }
      }
    }
    for (const fn of functions) {
      let outerLexicalConflict = this.cancelsAnnexBVarBinding(fn.id.name);
      if (!outerLexicalConflict) {
        for (const rootLexical of this.hoistedLexicals) {
          if (rootLexical === fn.id.name) {
            outerLexicalConflict = true;
            break;
          }
        }
      }
      if (!outerLexicalConflict) {
        for (const lexicalName of nonFunctionLexicalNames) {
          if (lexicalName === fn.id.name) {
            outerLexicalConflict = true;
            break;
          }
        }
      }
      if (!outerLexicalConflict) {
        for (let i = 0; i < this.annexBCancelledNames.length; i += 1) {
          if (this.annexBCancelledNames[i] === fn.id.name) outerLexicalConflict = true;
        }
      }
      if (!this.strictMode && !outerLexicalConflict) annexBFunctionNames.push(fn.id.name);
    }

    let lexicalSaveReg = -1;
    if (lexicalNames.length > 0) {
      const namesReg = this.allocReg();
      lexicalSaveReg = this.allocReg();
      this.enc.emitConst(Op.LdaConst, this.enc.internConst(lexicalNames));
      this.enc.emitReg(Op.Star, namesReg);
      this.enc.emitCallBuiltin(BUILTIN_PUSH_LEXICAL_ENV, namesReg, 1);
      this.enc.emitReg(Op.Star, lexicalSaveReg);
      const scopeCtx: LoopCtx = {
        label: LEXICAL_SCOPE_LABEL,
        breaks: [lexicalSaveReg],
        continues: lexicalNames,
        isLoop: false,
      };
      this.installLoopCtx(scopeCtx);

      // BlockDeclarationInstantiation initializes every function before the
      // first case expression is evaluated. B.3.3's OUTER assignment remains
      // at the declaration's executed source position below.
      for (const fn of functions) {
        this.emitClosure(fn);
        this.initializeName(fn.id.name);
      }
    }

    const caseJumps: any[] = [];
    let defaultIndex = -1;
    for (let i = 0; i < s.cases.length; i += 1) {
      const switchCase = s.cases[i]!;
      if (switchCase.test === null) {
        defaultIndex = i;
        caseJumps.push(-1);
      } else {
        this.emitExpr(switchCase.test);
        this.enc.emitReg(Op.StrictEq, discriminantReg);
        caseJumps.push(this.enc.emitJump(Op.JumpIfTrue));
      }
    }
    const noMatch = this.enc.emitJump(Op.Jump);

    for (let i = 0; i < s.cases.length; i += 1) {
      const switchCase = s.cases[i]!;
      const caseJump = caseJumps[i];
      if (caseJump >= 0) this.enc.patch(caseJump, this.enc.here());
      if (i === defaultIndex) this.enc.patch(noMatch, this.enc.here());
      for (const consequent of switchCase.consequent) {
        if (consequent.type === "FunctionDeclaration") {
          this.emitAnnexBFunctionAssignment(consequent, annexBFunctionNames);
        } else {
          this.emitStatement(consequent);
        }
      }
    }
    if (defaultIndex < 0) this.enc.patch(noMatch, this.enc.here());

    if (lexicalSaveReg >= 0) {
      this.enc.emitCallBuiltin(BUILTIN_RESTORE_ENV, lexicalSaveReg, 1);
      this.loopTop -= 1;
    }
    this.enc.patchTargetMarker(switchCtx.breaks[1]!, this.enc.here());
    this.popLoop(switchCtx, -1);
    this.release(switchMark);
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
    const tryMark = this.mark();
    let handlerEnvReg = -1;
    if (s.handler) {
      handlerEnvReg = this.allocReg();
      this.enc.emitCallBuiltin(BUILTIN_SAVE_ENV, 0, 0);
      this.enc.emitReg(Op.Star, handlerEnvReg);
    }
    const start = this.enc.here();
    this.emitStatement(s.block);
    const end = this.enc.here();
    const overCatchMarker = 1800000000 - start;
    this.enc.emitJumpMarker(Op.Jump, overCatchMarker); // normal completion skips the catch

    if (s.handler) {
      const handlerPc = this.enc.here();
      this.enc.emitCallBuiltin(BUILTIN_RESTORE_ENV, handlerEnvReg, 1);
      // The loop has already stored the caught value into handlerReg.
      //
      // §14.15.3 gives the CatchParameter its OWN declarative Environment
      // Record. `bind()` cannot express that — `names` is a FLAT, function-wide
      // name→register map with no pop — so `catch (f)` used to shadow `f` for
      // the rest of the body and every name resolution emitted AFTER the clause
      // read the catch register. Route it through the same lexical-scope
      // machinery blocks use, so `emitLoadName` / `storeName` /
      // `initializeName` / the `typeof` fast path see it via
      // `isActiveBlockLexical` and stop seeing it when the clause ends (#4137).
      let handlerReg: number;
      let catchSaveReg = -1;
      if (s.handler.param && s.handler.param.type === "ObjectPattern") {
        // Minimal destructuring slice: non-computed Identifier keys with
        // Identifier values (`{ f }`, `{ a: b }`). Defaults, rest, nesting and
        // ArrayPattern stay refused.
        //
        // The record is labelled LEXICAL_SCOPE_LABEL, NOT
        // SIMPLE_CATCH_SCOPE_LABEL: B.3.5 exempts only
        // `CatchParameter : BindingIdentifier`, so a DESTRUCTURING parameter
        // must cancel B.3.3's synthetic var binding, and the plain label makes
        // `cancelsAnnexBVarBinding` count it with no extra code.
        const boundNames: string[] = [];
        const keyNames: string[] = [];
        const properties = s.handler.param.properties;
        for (let i = 0; i < properties.length; i += 1) {
          const prop = properties[i];
          if (prop.type !== "Property" || prop.computed || prop.key.type !== "Identifier") {
            throw new UnsupportedNodeError(`catch destructuring (${prop.type})`, prop.type);
          }
          if (prop.value.type !== "Identifier") {
            throw new UnsupportedNodeError(`catch destructuring (${prop.value.type})`, prop.value.type);
          }
          boundNames.push(prop.value.name);
          keyNames.push(prop.key.name);
        }
        handlerReg = this.allocReg(); // scratch sink for the thrown value
        const namesReg = this.allocReg();
        catchSaveReg = this.allocReg();
        this.enc.emitConst(Op.LdaConst, this.enc.internConst(boundNames));
        this.enc.emitReg(Op.Star, namesReg);
        this.enc.emitCallBuiltin(BUILTIN_PUSH_LEXICAL_ENV, namesReg, 1);
        this.enc.emitReg(Op.Star, catchSaveReg);
        const catchScope: LoopCtx = {
          label: LEXICAL_SCOPE_LABEL,
          breaks: [catchSaveReg],
          continues: boundNames,
          isLoop: false,
        };
        this.installLoopCtx(catchScope);
        for (let i = 0; i < boundNames.length; i += 1) {
          this.enc.emitReg(Op.Ldar, handlerReg);
          this.enc.emitConst(Op.GetProp, this.enc.internConst(keyNames[i]!));
          this.initializeName(boundNames[i]!);
        }
      } else if (s.handler.param) {
        if (s.handler.param.type !== "Identifier") {
          throw new UnsupportedNodeError(`catch destructuring (${s.handler.param.type})`, s.handler.param.type);
        }
        const catchName: string = s.handler.param.name;
        handlerReg = this.allocReg(); // scratch sink for the thrown value
        const namesReg = this.allocReg();
        catchSaveReg = this.allocReg();
        this.enc.emitConst(Op.LdaConst, this.enc.internConst([catchName]));
        this.enc.emitReg(Op.Star, namesReg);
        this.enc.emitCallBuiltin(BUILTIN_PUSH_LEXICAL_ENV, namesReg, 1);
        this.enc.emitReg(Op.Star, catchSaveReg);
        const catchScope: LoopCtx = {
          label: SIMPLE_CATCH_SCOPE_LABEL,
          breaks: [catchSaveReg],
          continues: [catchName],
          isLoop: false,
        };
        this.installLoopCtx(catchScope);
        // BindingInitialization of the CatchParameter: the record's cell starts
        // in TDZ, so this must be an initialize, not a store.
        this.enc.emitReg(Op.Ldar, handlerReg);
        this.initializeName(catchName);
      } else {
        handlerReg = this.allocReg(); // optional-catch-binding: scratch sink
      }
      this.enc.addExnRow(start, end, handlerPc, handlerReg);
      this.emitStatement(s.handler.body);
      if (catchSaveReg >= 0) {
        this.enc.emitCallBuiltin(BUILTIN_RESTORE_ENV, catchSaveReg, 1);
        this.loopTop -= 1;
      }
      // A throw inside the try with a catch lands here, then falls through to the
      // finalizer below (catch → finally ordering).
    }
    // NOTE (Phase-1 finally): for try/finally with NO catch we deliberately add
    // NO exn row — a throw in the try PROPAGATES (unwinds to an outer handler or
    // escapes), it is never swallowed. The finalizer therefore runs only on the
    // NORMAL completion path (below). Full finally-on-exceptional-path (run the
    // finalizer, then re-raise) is the documented cut-point / follow-up; the
    // exception is preserved either way (loud, never silent-wrong — invariant L1).
    this.enc.patchTargetMarker(overCatchMarker, this.enc.here());

    if (s.finalizer) {
      // Phase-1 finally: run the finalizer on the NORMAL completion path. Full
      // finally semantics (intercepting an in-flight throw/return/break that
      // escapes the try or catch) is the documented cut-point — a `throw`
      // uncaught by this try still unwinds past the finalizer here. Bodies that
      // rely on finally-intercepts-control-flow are reported as divergences by
      // the differential harness and tracked as a follow-up.
      this.emitStatement(s.finalizer);
    }
    this.release(tryMark);
  }

  private emitLabeled(s: Node): void {
    const label: string = s.label.name;
    const inner = s.body;
    if (
      inner.type === "WhileStatement" ||
      inner.type === "DoWhileStatement" ||
      inner.type === "ForStatement" ||
      inner.type === "ForInStatement" ||
      inner.type === "ForOfStatement"
    ) {
      // Re-emit the loop with the label attached so labeled break/continue work.
      this.emitLabeledLoop(label, inner);
    } else {
      // Labeled non-loop: only labeled break is meaningful.
      const ctx = this.pushLoop(label, false);
      this.emitStatement(inner);
      this.enc.patchTargetMarker(ctx.breaks[1]!, this.enc.here());
      this.popLoop(ctx, -1);
    }
  }

  private emitLabeledLoop(label: string, s: Node): void {
    // Same shapes as emitWhile/DoWhile/For but with the label on the context.
    if (s.type === "ForInStatement" || s.type === "ForOfStatement") {
      this.emitForInOf(s, label);
    } else if (s.type === "WhileStatement") {
      const ctx = this.pushLoop(label, true);
      const top = this.enc.here();
      this.emitExpr(s.test);
      const exit = this.enc.emitJump(Op.JumpIfFalse);
      this.emitStatement(s.body);
      this.enc.emitJumpTo(Op.Jump, top);
      this.enc.patch(exit, this.enc.here());
      this.enc.patchTargetMarker(ctx.breaks[1]!, this.enc.here());
      this.popLoop(ctx, top);
    } else if (s.type === "DoWhileStatement") {
      const ctx = this.pushLoop(label, true);
      const top = this.enc.here();
      this.emitStatement(s.body);
      const testPc = this.enc.here();
      this.emitExpr(s.test);
      this.enc.emitJumpTo(Op.JumpIfTrue, top);
      this.enc.patchTargetMarker(ctx.breaks[1]!, this.enc.here());
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
      if (exit !== -1) this.enc.patch(exit, this.enc.here());
      this.enc.patchTargetMarker(ctx.breaks[1]!, this.enc.here());
      this.popLoop(ctx, updatePc);
      this.release(outer);
    }
  }

  // ── break / continue ─────────────────────────────────────────────────────────
  /** Install a loop/scope context at the top of the control stack.
   *
   * Physical slots are never popped, only logically released via `loopTop`.
   * Slot REUSE must NOT use an index-store (`this.loops[i] = ctx`): that store
   * is a silent no-op under the provider self-compile (follow-up 1 in
   * `plan/issues/2200-annexb-block-level-function-hoisting.md` — only the FULL
   * `build-runtime-eval-provider.mjs` build reproduces it), leaving the stale
   * popped scope visible to `scopeBindsName`/`findLoop` and the new ctx
   * invisible. Mutate the resident slot's fields in place — ALL FOUR, a partial
   * write reproduces the bug shape — and return THE SLOT, since callers patch
   * `breaks` markers through the returned ctx. */
  private installLoopCtx(ctx: LoopCtx): LoopCtx {
    if (this.loopTop < this.loops.length) {
      const slot = this.loops[this.loopTop]!;
      slot.label = ctx.label;
      slot.breaks = ctx.breaks;
      slot.continues = ctx.continues;
      slot.isLoop = ctx.isLoop;
      this.loopTop += 1;
      return slot;
    }
    this.loops.push(ctx);
    this.loopTop += 1;
    return ctx;
  }

  private pushLoop(label: string | null, isLoop: boolean): LoopCtx {
    const markerSeed = this.enc.here() + 1;
    const ctx: LoopCtx = {
      label,
      // [retained lexical depth, deferred break marker, deferred continue marker]
      breaks: [-this.lexicalEnvDepth() - 1, 2000000000 - markerSeed * 2, 1999999999 - markerSeed * 2],
      continues: [],
      isLoop,
    };
    return this.installLoopCtx(ctx);
  }
  private popLoop(ctx: LoopCtx, continueTarget: number): void {
    this.loopTop -= 1;
    if (continueTarget >= 0) this.enc.patchTargetMarker(ctx.breaks[2]!, continueTarget);
  }
  private findLoop(label: string | null, needLoop: boolean): LoopCtx {
    for (let i = this.loopTop - 1; i >= 0; i -= 1) {
      const ctx = this.loops[i]!;
      if (isEnvScopeLabel(ctx.label)) continue;
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
    this.restoreEnvToDepth(-ctx.breaks[0]! - 1);
    this.enc.emitJumpMarker(Op.Jump, ctx.breaks[1]!);
  }
  private emitContinue(s: Node): void {
    const ctx = this.findLoop(s.label ? s.label.name : null, true);
    this.restoreEnvToDepth(-ctx.breaks[0]! - 1);
    this.enc.emitJumpMarker(Op.Jump, ctx.breaks[2]!);
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
    else if (node.type === "ClassExpression") this.emitClass(node);
    else if (node.type === "TemplateLiteral") this.emitTemplate(node);
    else throw new UnsupportedNodeError(`expression ${node.type}`, node.type);
  }

  private emitLiteral(node: Node): void {
    const v = node.value;
    if (node.regex) {
      // (#4137) `/pattern/flags` → %RegExpCreate%(pattern, flags). Read the
      // source-exact text off `node.regex`, never `node.value`: acorn only
      // materialises `value` when the host can construct the RegExp, so it is
      // null for any pattern the host rejects and absent in the compiled lane.
      const m = this.mark();
      const base = this.regTop;
      this.enc.emitConst(Op.LdaConst, this.enc.internConst(node.regex.pattern));
      this.enc.emitReg(Op.Star, this.allocReg());
      this.enc.emitConst(Op.LdaConst, this.enc.internConst(node.regex.flags));
      this.enc.emitReg(Op.Star, this.allocReg());
      this.enc.emitCallBuiltin(BUILTIN_REGEXP_CREATE, base, 2);
      this.release(m);
      return;
    }
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
    if (this.isActiveBlockLexical(name)) {
      this.enc.emitConst(Op.LdName, this.enc.internConst(name));
      return;
    }
    const r = this.names.get(name);
    if (r !== undefined) this.enc.emitReg(Op.Ldar, r);
    else this.enc.emitConst(Op.LdName, this.enc.internConst(name));
  }
  private storeName(name: string): void {
    // acc holds the value; leaves acc unchanged (assignment-expression value).
    if (this.isActiveBlockLexical(name)) {
      this.enc.emitConst(Op.StName, this.enc.internConst(name));
      return;
    }
    const r = this.names.get(name);
    if (r !== undefined) this.enc.emitReg(Op.Star, r);
    else this.enc.emitConst(Op.StName, this.enc.internConst(name));
  }

  private initializeName(name: string): void {
    if (this.isActiveBlockLexical(name)) {
      this.enc.emitConst(Op.InitName, this.enc.internConst(name));
      return;
    }
    const r = this.names.get(name);
    if (r !== undefined) this.enc.emitReg(Op.Star, r);
    else this.enc.emitConst(Op.InitName, this.enc.internConst(name));
  }

  /** Whether a syntactic global name is shadowed anywhere in this function.
   *
   * Hoisted script bindings are environment-backed rather than register-backed,
   * so checking only `names` would incorrectly fold `var Error; new Error()`
   * to the intrinsic. The explicit scans keep this helper inside the
   * self-compile subset.
   */
  private isBoundName(name: string): boolean {
    if (this.isActiveBlockLexical(name)) return true;
    for (const bound of this.boundNames) {
      if (bound === name) return true;
    }
    for (const local of this.hoistedVars) {
      if (local === name) return true;
    }
    for (const local of this.hoistedLexicals) {
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
    // A direct-eval candidate is defined by syntax, then confirmed at runtime:
    // after resolving the IdentifierReference, PerformEval is direct only when
    // the resulting value is the current realm's intrinsic %eval%.  Passing the
    // resolved callee in window[0] preserves Reference-before-arguments order
    // and lets a local shadow, `with` binding, or reassigned global fall back to
    // an ordinary call without a second environment lookup.
    if (node.callee.type === "Identifier" && node.callee.name === "eval") {
      const evalMark = this.mark();
      const evalBase = this.regTop;
      for (let i = 0; i <= node.arguments.length; i += 1) this.allocReg();
      this.emitExpr(node.callee);
      this.enc.emitReg(Op.Star, evalBase);
      this.emitArgWindow(node.arguments, evalBase + 1);
      this.enc.emitCallBuiltin(BUILTIN_DIRECT_EVAL, evalBase, node.arguments.length + 1);
      this.release(evalMark);
      return;
    }
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
    } else if (
      directCallee.type === "MemberExpression" &&
      !directCallee.optional &&
      !directCallee.computed &&
      directCallee.object.type === "Identifier" &&
      directCallee.object.name === "Object" &&
      !this.isBoundName("Object") &&
      directCallee.property.type === "Identifier" &&
      directCallee.property.name === "defineProperty"
    ) {
      directBuiltin = BUILTIN_OBJECT_DEFINE_PROPERTY;
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
      case "<<":
        return Op.Shl;
      case ">>":
        return Op.Shr;
      case ">>>":
        return Op.ShrU; // (#4137)
      case "|":
        return Op.BitOr; // (#4137)
      case "&":
        return Op.BitAnd; // (#4137)
      case "^":
        return Op.BitXor; // (#4137)
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
        return -1; // ** / in / instanceof — Phase-1 out of scope
    }
  }

  private emitLogical(node: Node): void {
    const op: string = node.operator;
    if (op === "&&") {
      this.emitExpr(node.left);
      const end = this.enc.emitJump(Op.JumpIfFalse); // false → result is left (in acc)
      this.emitExpr(node.right);
      this.enc.patch(end, this.enc.here());
    } else if (op === "||") {
      this.emitExpr(node.left);
      const end = this.enc.emitJump(Op.JumpIfTrue); // true → result is left (in acc)
      this.emitExpr(node.right);
      this.enc.patch(end, this.enc.here());
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
      this.enc.patch(toRight, this.enc.here());
      this.emitExpr(node.right);
      this.enc.patch(toEnd, this.enc.here());
      this.release(m);
    } else {
      throw new UnsupportedNodeError(`logical operator '${op}'`, "LogicalExpression");
    }
  }

  private emitUnary(node: Node): void {
    const op: string = node.operator;
    const arg = node.argument;
    if (op === "delete") {
      this.emitDelete(arg);
      return;
    }
    if (op === "typeof" && arg.type === "Identifier") {
      // A missing numeric Map value is not a stable `undefined` discriminator
      // in the standalone compiler. Use the explicit fixed-register mirror;
      // active block bindings are EnvRec-backed even when they shadow a root
      // register. TypeofName also preserves lexical-TDZ throws.
      let fixedRegister = false;
      for (const name of this.boundNames) {
        if (name === arg.name) {
          fixedRegister = true;
          break;
        }
      }
      if (this.isActiveBlockLexical(arg.name) || !fixedRegister) {
        const m = this.mark();
        this.enc.emitConst(Op.LdaConst, this.enc.internConst(arg.name));
        const r = this.allocReg();
        this.enc.emitReg(Op.Star, r);
        this.enc.emitCallBuiltin(Builtin.TypeofName, r, 1);
        this.release(m);
        return;
      }
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

  /** Emit DeleteExpression while preserving reference evaluation order. */
  private emitDelete(arg: Node): void {
    if (arg.type === "MemberExpression") {
      if (arg.optional) throw new UnsupportedNodeError("optional delete", "UnaryExpression");
      const m = this.mark();
      if (arg.computed) {
        this.emitExpr(arg.object);
        const rObject = this.allocReg();
        this.enc.emitReg(Op.Star, rObject);
        this.emitExpr(arg.property);
        const rKey = this.allocReg();
        this.enc.emitReg(Op.Star, rKey);
        this.enc.emitReg(Op.Ldar, rObject);
        this.enc.emitReg(Op.DeleteElem, rKey);
      } else {
        this.emitExpr(arg.object);
        this.enc.emitConst(Op.DeleteProp, this.enc.internConst(arg.property.name));
      }
      this.release(m);
      return;
    }
    if (arg.type === "Identifier") {
      // PerformEval predeclares sloppy var/function bindings with D=true. The
      // environment record, not syntax alone, must decide whether this name is
      // an eval-created deletable binding or an established caller binding.
      if (this.isBoundName(arg.name) && !(this.isScript && this.scriptBindingsPredeclared)) {
        this.enc.emit0(Op.LdaFalse);
      } else {
        this.enc.emitConst(Op.DeleteName, this.enc.internConst(arg.name));
      }
      return;
    }
    // Deleting a non-reference evaluates its operand for side effects and
    // succeeds without attempting a property operation.
    this.emitExprStatementDiscard(arg);
    this.enc.emit0(Op.LdaTrue);
  }

  private emitConditional(node: Node): void {
    this.emitExpr(node.test);
    const toElse = this.enc.emitJump(Op.JumpIfFalse);
    this.emitExpr(node.consequent);
    const toEnd = this.enc.emitJump(Op.Jump);
    this.enc.patch(toElse, this.enc.here());
    this.emitExpr(node.alternate);
    this.enc.patch(toEnd, this.enc.here());
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

  /** Emit one strict class constructor/method closure. */
  private emitClassClosure(params: Node[], body: Node, name: string, classConstructor: boolean): void {
    const child = new FunctionEmitter(params, body, name, false, false, true, false, []);
    const meta = child.emit();
    if (classConstructor) meta.flags = meta.flags | FLAG_CLASS_CONSTRUCTOR;
    const m = this.mark();
    this.enc.emitConst(Op.LdaConst, this.enc.internConst(meta));
    const r = this.allocReg();
    this.enc.emitReg(Op.Star, r);
    this.enc.emitCallBuiltin(Builtin.MakeClosure, r, 1);
    this.release(m);
  }

  /** Build the bounded MVP class carrier on the ordinary interpreted closure
   * seam. Inheritance, fields, private names, accessors, and computed keys stay
   * explicit unsupported nodes until their runtime protocols land. */
  private emitClass(node: Node): void {
    if (node.superClass) throw new UnsupportedNodeError("class inheritance", "ClassDeclaration");
    const elements: Node[] = node.body.body;
    let constructorMethod: Node = null;
    for (const element of elements) {
      if (element.type !== "MethodDefinition") {
        throw new UnsupportedNodeError(`class element ${element.type}`, element.type);
      }
      if (element.computed) throw new UnsupportedNodeError("computed class method", "MethodDefinition");
      if (element.kind === "get" || element.kind === "set") {
        throw new UnsupportedNodeError(`class ${element.kind}`, "MethodDefinition");
      }
      if (element.kind === "constructor") constructorMethod = element;
    }

    const className = node.id && node.id.name ? node.id.name : "";
    const classMark = this.mark();
    if (constructorMethod !== null) {
      this.emitClassClosure(constructorMethod.value.params, constructorMethod.value.body, className, true);
    } else {
      const emptyBody: Node = {};
      emptyBody.body = [];
      this.emitClassClosure([], emptyBody, className, true);
    }
    const constructorReg = this.allocReg();
    this.enc.emitReg(Op.Star, constructorReg);
    const prototypeReg = this.allocReg();
    this.enc.emitCallBuiltin(Builtin.ObjectLiteral, prototypeReg, 0);
    this.enc.emitReg(Op.Star, prototypeReg);

    for (const element of elements) {
      if (element.kind === "constructor") continue;
      let methodName = "";
      if (element.key.type === "Identifier") methodName = element.key.name;
      else if (element.key.type === "Literal") methodName = String(element.key.value);
      else throw new UnsupportedNodeError(`class method key ${element.key.type}`, element.key.type);

      const base = this.regTop;
      for (let i = 0; i < 5; i += 1) this.allocReg();
      this.enc.emitReg(Op.Ldar, constructorReg);
      this.enc.emitReg(Op.Star, base);
      this.enc.emitReg(Op.Ldar, prototypeReg);
      this.enc.emitReg(Op.Star, base + 1);
      this.enc.emitConst(Op.LdaConst, this.enc.internConst(methodName));
      this.enc.emitReg(Op.Star, base + 2);
      this.emitClassClosure(element.value.params, element.value.body, methodName, false);
      this.enc.emitReg(Op.Star, base + 3);
      this.enc.emit0(element.static ? Op.LdaTrue : Op.LdaFalse);
      this.enc.emitReg(Op.Star, base + 4);
      this.enc.emitCallBuiltin(BUILTIN_DEFINE_CLASS_METHOD, base, 5);
      this.release(base);
    }

    this.enc.emitCallBuiltin(BUILTIN_FINALIZE_CLASS, constructorReg, 2);
    this.release(classMark);
  }

  /** Build a nested FuncMeta for a function/arrow node and leave a closure in acc. */
  private emitClosure(node: Node): void {
    const isArrow = node.type === "ArrowFunctionExpression";
    const isExprBody = isArrow && node.body.type !== "BlockStatement";
    const nm = node.id && node.id.name ? node.id.name : "";
    const child = new FunctionEmitter(node.params, node.body, nm, false, isExprBody, false, false, []);
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
export function emitProgram(
  ast: Node,
  forceStrict = false,
  scriptBindingsPredeclared = false,
  annexBCancelledNames: JSValue = [],
): FuncMeta {
  if (ast.type !== "Program") throw new UnsupportedNodeError(`top-level ${ast.type}`, ast.type);
  const emitter = new FunctionEmitter(
    [],
    ast,
    "",
    true,
    false,
    forceStrict,
    scriptBindingsPredeclared,
    annexBCancelledNames,
  );
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
  const emitter = new FunctionEmitter(node.params, node.body, name, false, isExpressionBody, false, false, []);
  return emitter.emit();
}
