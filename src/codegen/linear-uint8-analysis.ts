// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1886 — Linear-safe `Uint8Array` escape/usage analysis.
 *
 * A compile-time pre-pass (WASI / standalone only) that classifies each
 * `Uint8Array` *binding* — a `const`/`let`/`var` initialised from
 * `new Uint8Array(...)`, or a function **parameter** typed `Uint8Array` — as
 * **linear-safe** or not.
 *
 * A binding is linear-safe iff it is a pure byte-I/O buffer: it never escapes
 * to a context that needs the WasmGC heap (stored in a struct/array/global,
 * captured by a closure, returned, compared by identity, iterated, copied via
 * `.subarray`/`.slice`/`.set`, JSON-stringified, …) and its *only* uses are:
 *   - element load/store `b[i]` / `b[i] = v`
 *   - `b.length`
 *   - `process.stdout.write(b)` / `process.stderr.write(b)`
 *   - `readSync(fd, b, …)` / `writeSync(fd, b, …)` (node:fs fd-based primitives)
 *   - being passed as a call argument to a function whose corresponding
 *     parameter is *itself* linear-safe (interprocedural threading).
 *
 * For such bindings #1886 backs them by **linear memory** (a `(ptr, len)`
 * pair) instead of a GC vec, so `fd_read`/`fd_write` touch them with zero
 * GC↔linear copies. When the predicate cannot prove safety, the binding stays
 * a GC array — today's behaviour, byte-for-byte. The analysis is therefore
 * deliberately **conservative**: any use it does not explicitly recognise as
 * safe demotes the binding (and, transitively, any parameter it flows into).
 *
 * Output ({@link LinearUint8Result}) is consumed by codegen:
 *   - `safeBindings` — the locals + params backed by linear memory.
 *   - `linearParams` — per-function, which parameter indices are linear (so
 *     the function's wasm signature can be rewritten `Uint8Array → (ptr,len)`
 *     and every call site lowered consistently).
 *
 * This module performs **no** codegen and has no side effects on the module;
 * it is safe to run unconditionally behind the `--target wasi` gate (see
 * {@link analyzeLinearUint8} caller in `index.ts`). The codegen consumers are
 * additive (`if (isLinearSafe(sym)) {…linear…} else {…existing GC…}`), so when
 * the result set is empty the emitted module is identical to today.
 */
import { ts } from "../ts-api.js";

/** Result of the linear-safe `Uint8Array` analysis (frozen before codegen). */
export interface LinearUint8Result {
  /**
   * Symbols of every binding (local variable or parameter) proven linear-safe.
   * Codegen consults this by `checker.getSymbolAtLocation(idNode)`.
   */
  safeBindings: Set<ts.Symbol>;
  /**
   * For each function whose signature is linear-rewritten, the set of
   * parameter indices that are linear-backed. Keyed by the function's own
   * symbol. Callers use this to lower call arguments to `(ptr, len)` pairs and
   * to rewrite the callee's wasm param list.
   */
  linearParams: Map<ts.Symbol, Set<number>>;
  /**
   * The **Slice-B-eligible** subset of {@link safeBindings}: a `new
   * Uint8Array(...)` *local* whose every use stays inside its declaring
   * function — element load/store, `.length`, and `process.std*.{read,write}`
   * I/O only — and which is **never** passed as an argument to a user function
   * (nor is itself a parameter). These can be backed by linear memory
   * intraprocedurally with no call-site or signature changes.
   *
   * A buffer that flows through a user-function parameter is in `safeBindings`
   * + `linearParams` (the Slice-C interprocedural signature-rewrite targets)
   * but is deliberately **excluded** here: backing it linearly without the
   * C-phase signature rewrite would hand a `(ptr,len)` local to a callee that
   * still expects a GC array, an invalid-Wasm type mismatch. Slice B consumes
   * this set; Slice C will widen consumption to all of `safeBindings`.
   */
  localOnlyBindings: Set<ts.Symbol>;
}

/** A function-like declaration we model in the interprocedural fixpoint. */
type FnDecl = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration;

function isFnDecl(node: ts.Node): node is FnDecl {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node)
  );
}

/** True when a TS type is exactly `Uint8Array` (not a union, not a view alias). */
function isUint8ArrayType(checker: ts.TypeChecker, type: ts.Type): boolean {
  // A bare `Uint8Array` has the `Uint8Array` symbol. Reject unions / `any` /
  // `unknown` / `ArrayBuffer`-typed and `Uint8Array | ArrayBuffer` (the host
  // boundary shape) — those are not provably plain byte buffers.
  if (type.isUnion()) return false;
  const sym = type.getSymbol() ?? type.aliasSymbol;
  return sym?.name === "Uint8Array";
}

function isUint8ArrayNode(checker: ts.TypeChecker, node: ts.Expression): boolean {
  return isUint8ArrayType(checker, checker.getTypeAtLocation(node));
}

/** `new Uint8Array(...)` (the constructor target resolves to `Uint8Array`). */
function isNewUint8Array(expr: ts.Node): expr is ts.NewExpression {
  return ts.isNewExpression(expr) && ts.isIdentifier(expr.expression) && expr.expression.text === "Uint8Array";
}

/**
 * #2045 B.3 — true iff this is a `new Uint8Array(...)` that allocates a FRESH
 * linear arena: the length ctor `new Uint8Array(n)`, the array-literal ctor
 * `new Uint8Array([a,b,…])`, or the zero-arg ctor `new Uint8Array()`. It is
 * **false** for the *view* ctors — `new Uint8Array(arrayBuffer)`,
 * `new Uint8Array(arrayBuffer, offset, len)`, `new Uint8Array(otherTypedArray)`
 * — which alias an existing buffer rather than allocating one, so they are NOT
 * linear-backable (the linear-new lowering only arena-allocates a length; a
 * view's bytes live elsewhere). Seeding a view as a linear local made it look
 * threadable, then codegen hit the "not backed by linear memory" reportError
 * (probe B.3b).
 *
 * The discriminator is **fail-OPEN, exclusion-based**: a single arg is a length
 * unless we can PROVE it is a buffer/typed-array view source. This keeps the
 * permissive default (a length ctor whose arg type doesn't fully resolve — e.g.
 * `new Uint8Array(msg.length)` under the analysis's `noLib` unit-test program —
 * stays a fresh arena, as before #2045). Only a provable view-source type, or a
 * multi-arg `(buffer, offset, len)` shape, is excluded.
 */
function isLengthCtorUint8Array(checker: ts.TypeChecker, expr: ts.NewExpression): boolean {
  const args = expr.arguments;
  if (!args || args.length === 0) return true; // `new Uint8Array()` ⇒ empty arena
  const first = args[0]!;
  // `new Uint8Array([a, b, c])` — element-count arena.
  if (args.length === 1 && ts.isArrayLiteralExpression(first)) return true;
  // `new Uint8Array(buffer, offset[, len])` — only the view ctor takes >1 arg.
  if (args.length > 1) return false;
  // Single arg: a length UNLESS its type is provably a view source
  // (ArrayBuffer / SharedArrayBuffer / a TypedArray such as Uint8Array). The
  // length form's arg is a `number`; anything that resolves to a buffer/typed
  // -array type is a view. Fail open (treat as length) when the type is `any` /
  // unresolved so the permissive pre-#2045 default is preserved.
  const t = checker.getTypeAtLocation(first);
  const name = t.getSymbol()?.name ?? t.aliasSymbol?.name;
  if (name === "ArrayBuffer" || name === "SharedArrayBuffer" || name === "ArrayBufferLike") return false;
  // A typed-array view source (Uint8Array, Int8Array, …, Uint8ClampedArray).
  if (name && /^(Uint|Int|Float|BigUint|BigInt)\w*Array$/.test(name)) return false;
  return true;
}

/**
 * Recognise a byte-I/O intrinsic call that takes a `Uint8Array` buffer and
 * return the argument index that carries the buffer, or `-1` if this is not one.
 *
 * Two shapes are recognised (both lowered by `node-fs-api.ts`):
 *   - `process.std{out.write,err.write}(buf, …)` — buffer at arg 0. We only
 *     match the global `process` shape the WASI lowering supports; a local
 *     `process` shadow makes this not match (the conservative path). (#2633 —
 *     `process.stdin.read` is no longer a recognised surface: it was a
 *     hallucinated API; synchronous stdin is `node:fs` `readSync(0, …)`.)
 *   - #2631: `readSync(fd, buf, …)` / `writeSync(fd, buf, …)` (the node:fs
 *     fd-based primitives) — buffer at arg 1. Like `process.std*`, these are
 *     non-escaping byte-I/O sinks. **BUT** `readSync`/`writeSync` are plain
 *     identifiers that collide with ordinary user/test code (e.g. a test262
 *     harness helper named `writeSync`), so we ONLY treat them as sinks when the
 *     program actually imported them from `node:fs` (the `nodeFsBindings` set,
 *     scoped to the binding SYMBOL so a local shadow can't masquerade). Without
 *     this gate the recognition rewrites codegen for unrelated Uint8Array
 *     programs — a wasm-byte regression caught in the #2631 merge_group
 *     (17 TypedArray/byte-IO assertion_fail). Keeping the gate makes the change
 *     byte-neutral for every program that does NOT import node:fs readSync/writeSync.
 */
function ioBufferArgIndex(call: ts.CallExpression, nodeFsBindings: Set<string>): number {
  const callee = call.expression;
  // node:fs fd-based readSync(fd, buf, …) / writeSync(fd, buf, …): buffer at 1 —
  // ONLY when the callee is a LOCAL BINDING NAME imported from node:fs (the
  // `nodeFsBindings` set is empty unless the program imports readSync/writeSync
  // from node:fs, so this is a no-op — byte-neutral — for unrelated programs).
  // Name-based (not symbol-based) so it stays robust when the `node:fs` module
  // doesn't resolve (e.g. the #1886 unit-test program built with `noLib: true`).
  if (
    nodeFsBindings.size > 0 &&
    ts.isIdentifier(callee) &&
    nodeFsBindings.has(callee.text) &&
    call.arguments.length >= 2
  ) {
    return 1;
  }
  if (!ts.isPropertyAccessExpression(callee)) return -1;
  const method = callee.name.text;
  const stream = callee.expression;
  if (!ts.isPropertyAccessExpression(stream)) return -1;
  const streamName = stream.name.text;
  const root = stream.expression;
  if (!(ts.isIdentifier(root) && root.text === "process")) return -1;
  if ((streamName === "stdout" || streamName === "stderr") && method === "write") return 0;
  return -1;
}

/**
 * #2631 — collect the LOCAL BINDING NAMES of `readSync`/`writeSync` imported
 * from `node:fs` (named imports, honoring an `as` alias — the local name is what
 * appears at the call site). Returns an EMPTY set for any program that doesn't
 * import them, so the byte-IO sink recognition is a no-op (byte-identical to
 * origin/main) for unrelated Uint8Array programs. Name-based rather than
 * symbol-based so it works even when the `node:fs` module type doesn't resolve
 * (e.g. a unit-test program built with `noLib: true`); the per-call shadow guard
 * in the lowering (`fctx.localMap.has`) still protects against a local override.
 */
function collectNodeFsSyncBindings(sourceFile: ts.SourceFile): Set<string> {
  const out = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      (node.moduleSpecifier.text === "node:fs" || node.moduleSpecifier.text === "fs")
    ) {
      const named = node.importClause?.namedBindings;
      if (named && ts.isNamedImports(named)) {
        for (const el of named.elements) {
          // `propertyName` is the imported name (readSync/writeSync); `name` is
          // the LOCAL binding (possibly aliased). Gate on the imported name,
          // record the local name (used at the call site).
          const importedName = (el.propertyName ?? el.name).text;
          if (importedName === "readSync" || importedName === "writeSync") {
            out.add(el.name.text);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return out;
}

/**
 * Resolve the callee `FnDecl` + symbol of a direct call `f(args)` where `f` is
 * a plain identifier bound to a user function. Returns `null` for any indirect /
 * method / unresolved callee (which is conservatively treated as an escape).
 */
function resolveDirectCallee(
  checker: ts.TypeChecker,
  call: ts.CallExpression,
): { sym: ts.Symbol; decl: FnDecl } | null {
  const callee = call.expression;
  if (!ts.isIdentifier(callee)) return null;
  const sym = checker.getSymbolAtLocation(callee);
  if (!sym) return null;
  const decls = sym.getDeclarations() ?? [];
  for (const d of decls) {
    if (isFnDecl(d)) return { sym, decl: d };
    // `const f = (…) => …` / `const f = function(){}` — the symbol's decl is
    // the variable; unwrap its initializer.
    if (ts.isVariableDeclaration(d) && d.initializer && isFnDecl(d.initializer)) {
      return { sym, decl: d.initializer };
    }
  }
  return null;
}

/**
 * Build the linear-safe analysis for a WASI source file.
 *
 * Algorithm (monotone, terminates — classifications only ever demote):
 *  1. Collect every candidate binding: `new Uint8Array(...)` variable inits and
 *     `Uint8Array` parameters of non-exported user functions. Exported
 *     functions' params are NOT candidates (their ABI is observable).
 *  2. Seed every candidate as linear-safe.
 *  3. Fixpoint: walk each function body. A candidate binding/param is demoted
 *     if it has any disqualifying use, OR is passed to a callee parameter that
 *     is currently demoted. Repeat until no demotions occur in a full pass.
 *  4. Freeze: the survivors are the linear-safe set.
 */
export function analyzeLinearUint8(
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  nodeFsSyncNames?: ReadonlySet<string>,
): LinearUint8Result {
  // #2631 — the LOCAL NAMES of node:fs readSync/writeSync imports (empty unless
  // the program imports them). Gates the byte-IO sink recognition so it stays a
  // no-op (byte-neutral) for unrelated Uint8Array programs.
  //
  // The real compile path strips the `node:fs` import BEFORE this analysis runs
  // (import preprocessing), so the import declaration is gone from `sourceFile`.
  // The caller therefore passes the names detected from the ORIGINAL source
  // (`ctx.wasiNodeFsFuncs`, via `detectNodeFsImports`). When that's not supplied
  // (e.g. the #1886 unit tests, which analyze the raw source with the import
  // intact), fall back to scanning the AST.
  const nodeFsBindings = nodeFsSyncNames ? new Set(nodeFsSyncNames) : collectNodeFsSyncBindings(sourceFile);
  // candidate bindings (locals + params), seeded safe; demote on disqualifying use.
  const safe = new Set<ts.Symbol>();
  // Symbols introduced by a `new Uint8Array(...)` LOCAL init (not parameters).
  // Only these can be backed linearly intraprocedurally (Slice B); a parameter
  // needs the Slice-C signature rewrite before its (ptr,len) form is valid.
  const newLocalSyms = new Set<ts.Symbol>();
  // function symbol → its FnDecl (for param-index lookup) + whether exported.
  const fnDecls = new Map<ts.Symbol, FnDecl>();
  // function symbol → param symbols (index-aligned) that are Uint8Array candidates.
  const fnParamSyms = new Map<ts.Symbol, (ts.Symbol | undefined)[]>();

  // ---- Pass 1: collect candidates -----------------------------------------
  const collect = (node: ts.Node): void => {
    if (isNewUint8Array(node)) {
      // the binding this `new Uint8Array` initialises (if any) — handled at
      // the VariableDeclaration so we know the declared symbol.
    }
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.name)) {
      if (isNewUint8Array(node.initializer) || isUint8ArrayNode(checker, node.initializer)) {
        const sym = checker.getSymbolAtLocation(node.name);
        // only a FRESH-arena `new Uint8Array(...)` init is a linear-candidate:
        // the length / array-literal / zero-arg ctor. A *view* ctor
        // (`new Uint8Array(arrayBuffer)`, `new Uint8Array(otherTypedArray)`)
        // aliases an existing buffer that is NOT linear-backed (#2045 B.3b), and
        // an init from any other expression (a returned/aliased array) is left
        // to the escape checks. Either way it stays on the GC path.
        // #2840 — only a FUNCTION-LOCAL `new Uint8Array(...)` is linear-backable.
        // The codegen lowering (`tryEmitLinearU8New`) allocates the `(ptr,len)`
        // pair as locals of the function it appears in and registers them in that
        // function's per-function `fctx.linearU8Buffers`. A MODULE-SCOPE binding
        // (a top-level `const win = new Uint8Array(...)`) is compiled in the
        // module-init frame: its `(ptr,len)` locals would be trapped in module-init
        // and unreachable from every other function that references the binding
        // (e.g. the nm_node_process state machine's `onData`/`emitFrame` helpers),
        // AND the module-global GC storage is skipped — so the binding becomes
        // wholly inaccessible. Seeding it linear-safe then makes a helper arg
        // thread to a `(ptr,len)` the call site cannot supply, hitting the "not
        // backed by linear memory" reportError (#1886). Module-scope bindings stay
        // on the GC path (a wasm global), exactly as the `.js`/dynamic path does.
        if (
          sym &&
          isNewUint8Array(node.initializer) &&
          isLengthCtorUint8Array(checker, node.initializer) &&
          isInsideFunction(node)
        ) {
          safe.add(sym);
          newLocalSyms.add(sym);
        }
      }
    }
    if (isFnDecl(node)) {
      const fnSym = fnSymbolOf(checker, node);
      if (fnSym) {
        fnDecls.set(fnSym, node);
        const exported = isExportedFn(node);
        const rewriteParams = canRewriteLinearParams(node, exported);
        const paramSyms: (ts.Symbol | undefined)[] = [];
        for (const p of node.parameters) {
          let pSym: ts.Symbol | undefined;
          if (ts.isIdentifier(p.name) && isUint8ArrayNode(checker, p.name)) {
            pSym = checker.getSymbolAtLocation(p.name);
            // Exported or otherwise unsupported signatures keep the observable
            // GC ABI. Only simple top-level helper params enter Slice C.
            if (pSym && rewriteParams) safe.add(pSym);
          }
          paramSyms.push(pSym);
        }
        fnParamSyms.set(fnSym, paramSyms);
      }
    }
    ts.forEachChild(node, collect);
  };
  collect(sourceFile);

  // ---- Pass 1b: demote helpers that escape as a function value (#2045 B.4) ---
  // Only a *direct* call `f(args)` threads the rewritten `(ptr,len)` ABI to a
  // linear helper (the call-site lowering in `calls.ts` keys off a direct
  // identifier callee). ANY other reference to a tracked helper's name reaches
  // the function value through its *source-level* GC signature, while the body
  // was rewritten to expect linear `(ptr,len)` params — `const g = fill`,
  // `fill.call(...)`, `arr.map(fill)`, `[fill]`, `return fill`, `typeof fill`,
  // an argument to another call. That mismatch hands a GC array into the linear
  // slot at runtime (a null-pointer deref). So if a helper's name appears in any
  // non-direct-call position, demote ALL of its params back to the GC ABI by
  // removing them from `safe`. This runs BEFORE the fixpoint so a buffer that
  // flowed into the helper via a direct call is then re-examined (its target
  // param is no longer linear-safe) and itself demoted.
  const demoteEscapedHelpers = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && !isBindingSite(node) && !isDirectCalleePosition(node)) {
      const sym = checker.getSymbolAtLocation(node);
      if (sym && fnParamSyms.has(sym)) {
        const paramSyms = fnParamSyms.get(sym);
        if (paramSyms) for (const pSym of paramSyms) if (pSym) safe.delete(pSym);
      }
    }
    ts.forEachChild(node, demoteEscapedHelpers);
  };
  demoteEscapedHelpers(sourceFile);

  // ---- Pass 2..N: fixpoint demotion ----------------------------------------
  // For each candidate symbol, scan all references; a reference in a
  // disqualifying position demotes it. Iterate until stable (a demotion can
  // cascade: demoting a param means args flowing into it are re-examined).
  let changed = true;
  while (changed) {
    changed = false;
    // Walk the whole file once; at every identifier that refers to a candidate
    // symbol, classify the use. We re-walk on each iteration because parameter
    // demotions change the safety of call-argument uses.
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node)) {
        const sym = checker.getSymbolAtLocation(node);
        if (sym && safe.has(sym) && !isBindingSite(node)) {
          if (!isAllowedUse(checker, node, safe, fnDecls, fnParamSyms, nodeFsBindings)) {
            safe.delete(sym);
            changed = true;
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    // #2045 B.3 — demote a callee param that receives a NON-linear-backed arg.
    // Walk every direct user call; for each arg index the callee still lists as
    // linear-safe, the argument must itself be a provably linear-backed buffer —
    // a `ts.Identifier` whose symbol is currently in `safe`. Anything else (a
    // call result `make()`, a `new Uint8Array(buffer)` view, a conditional
    // `c ? a : b`, an element/property access, a literal) cannot be threaded as
    // `(ptr,len)` and would hit the `calls.ts` "not backed by linear memory"
    // reportError — so demote that callee param. This shares the fixpoint, so a
    // demotion cascades to deeper helpers on the next pass (monotone: only ever
    // demotes → terminates).
    const demoteUntrackedArgs = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const resolved = resolveDirectCallee(checker, node);
        if (resolved) {
          const paramSyms = fnParamSyms.get(resolved.sym);
          if (paramSyms) {
            node.arguments.forEach((arg, argIdx) => {
              const calleeParamSym = paramSyms[argIdx];
              if (!calleeParamSym || !safe.has(calleeParamSym)) return;
              // The callee param is currently linear-safe; verify the arg is a
              // tracked linear-backed identifier. Otherwise demote the param.
              const argSym = ts.isIdentifier(arg) ? checker.getSymbolAtLocation(arg) : undefined;
              if (!argSym || !safe.has(argSym)) {
                safe.delete(calleeParamSym);
                changed = true;
              }
            });
          }
        }
      }
      ts.forEachChild(node, demoteUntrackedArgs);
    };
    demoteUntrackedArgs(sourceFile);
  }

  // ---- Freeze: derive per-function linear param sets -----------------------
  const linearParams = new Map<ts.Symbol, Set<number>>();
  for (const [fnSym, paramSyms] of fnParamSyms) {
    const idxs = new Set<number>();
    paramSyms.forEach((pSym, i) => {
      if (pSym && safe.has(pSym)) idxs.add(i);
    });
    if (idxs.size > 0) linearParams.set(fnSym, idxs);
  }

  // ---- Freeze: derive the Slice-B (intraprocedural-only) eligible subset ----
  // A surviving `new Uint8Array` local is Slice-B-eligible only if it never
  // flows into a USER function as an argument — i.e. its sole call-argument
  // uses are the `process.std*.{read,write}` I/O intrinsics (which Slice B
  // lowers in place). A buffer passed to a user function needs the Slice-C
  // signature rewrite first; backing it linearly now would hand a `(ptr,len)`
  // local to a callee still typed for a GC array (invalid Wasm). Parameters
  // are excluded by construction (only `newLocalSyms` are seeded here).
  const localOnly = new Set<ts.Symbol>(newLocalSyms);
  const dropParamThreaded = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const ioIdx = ioBufferArgIndex(node, nodeFsBindings);
      node.arguments.forEach((arg, argIdx) => {
        if (!ts.isIdentifier(arg)) return;
        const sym = checker.getSymbolAtLocation(arg);
        if (!sym || !localOnly.has(sym)) return;
        // I/O-intrinsic argument is fine; any other call-arg position means the
        // buffer is threaded into a user function → not Slice-B-eligible.
        if (argIdx !== ioIdx) localOnly.delete(sym);
      });
    }
    ts.forEachChild(node, dropParamThreaded);
  };
  dropParamThreaded(sourceFile);
  // Intersect with survivors (a `new`-local could have been demoted in Pass 2).
  const localOnlyBindings = new Set<ts.Symbol>();
  for (const sym of localOnly) if (safe.has(sym)) localOnlyBindings.add(sym);

  return { safeBindings: safe, linearParams, localOnlyBindings };
}

/** The function's own symbol (for declarations and `const f = …` forms). */
function fnSymbolOf(checker: ts.TypeChecker, node: FnDecl): ts.Symbol | undefined {
  if (ts.isFunctionDeclaration(node) && node.name) return checker.getSymbolAtLocation(node.name);
  if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) return checker.getSymbolAtLocation(node.name);
  // function/arrow expression assigned to a variable: the variable's symbol.
  const parent = node.parent;
  if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return checker.getSymbolAtLocation(parent.name);
  }
  // named function expression
  if (ts.isFunctionExpression(node) && node.name) return checker.getSymbolAtLocation(node.name);
  return undefined;
}

function isExportedFn(node: FnDecl): boolean {
  const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  if (mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) return true;
  // `export const f = …`
  let p: ts.Node | undefined = node.parent;
  while (p && (ts.isVariableDeclaration(p) || ts.isVariableDeclarationList(p))) p = p.parent;
  if (p && ts.isVariableStatement(p)) {
    const sMods = ts.getModifiers(p);
    if (sMods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) return true;
  }
  return false;
}

function bodyUsesArguments(node: FnDecl): boolean {
  const body = "body" in node ? node.body : undefined;
  if (!body) return false;
  let found = false;
  const visit = (child: ts.Node): void => {
    if (found) return;
    if (child !== body && isFnDecl(child)) return;
    if (ts.isIdentifier(child) && child.text === "arguments") {
      found = true;
      return;
    }
    ts.forEachChild(child, visit);
  };
  ts.forEachChild(body, visit);
  return found;
}

function canRewriteLinearParams(node: FnDecl, exported: boolean): boolean {
  // Slice C wires top-level helper FunctionDeclarations. Nested functions,
  // methods, arrows, async/generator/generic functions, optional/default
  // params, rest params, and functions that read `arguments` keep the GC ABI so
  // existing call/default/arguments paths remain unchanged.
  if (!ts.isFunctionDeclaration(node) || !node.name) return false;
  if (!node.parent || !ts.isSourceFile(node.parent)) return false;
  if (exported) return false;
  if (node.asteriskToken) return false;
  if (node.typeParameters && node.typeParameters.length > 0) return false;
  const mods = ts.getModifiers(node);
  if (mods?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) return false;
  if (bodyUsesArguments(node)) return false;
  return node.parameters.every(
    (p) => ts.isIdentifier(p.name) && !p.dotDotDotToken && !p.questionToken && !p.initializer,
  );
}

/**
 * True iff this identifier sits in the **callee** position of a direct call —
 * `f(...)`. Only this position threads the rewritten `(ptr,len)` ABI to a linear
 * helper (`calls.ts` keys the thread off a direct identifier callee). A
 * `.call`/`.apply`/`.bind`/`.map(f)` reaches the function value as a
 * property-access object or a call *argument*, not the callee, so it binds the
 * source-level GC signature and is an escape (returns false here). Self-recursion
 * `f(...)` inside `f`'s own body is a direct-callee position, so it is correctly
 * NOT treated as an escape. (#2045 B.4)
 */
function isDirectCalleePosition(id: ts.Identifier): boolean {
  return ts.isCallExpression(id.parent) && id.parent.expression === id;
}

/**
 * #2840 — true iff `node` lives inside a function body (its `(ptr,len)` linear
 * backing would be function-locals). A binding whose nearest enclosing scope is
 * the module (no function-like ancestor) becomes a wasm global and CANNOT be
 * linear-backed by the current per-function codegen, so it must stay on the GC
 * path. We treat any function-like ancestor (declaration / expression / arrow /
 * method / accessor / constructor) as "inside a function".
 */
function isInsideFunction(node: ts.Node): boolean {
  let p: ts.Node | undefined = node.parent;
  while (p) {
    if (ts.isFunctionDeclaration(p) || ts.isFunctionExpression(p) || ts.isArrowFunction(p)) return true;
    if (ts.isMethodDeclaration(p) || ts.isConstructorDeclaration(p)) return true;
    if (ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p)) return true;
    if (ts.isSourceFile(p)) return false;
    p = p.parent;
  }
  return false;
}

/** True if this identifier is its own declaration name (not a use). */
function isBindingSite(id: ts.Identifier): boolean {
  const p = id.parent;
  return (
    (ts.isVariableDeclaration(p) && p.name === id) ||
    (ts.isParameter(p) && p.name === id) ||
    (ts.isFunctionDeclaration(p) && p.name === id) ||
    (ts.isBindingElement(p) && p.name === id)
  );
}

/**
 * Classify a single *use* (identifier reference) of a candidate buffer.
 * Returns true iff the use is one of the allowed linear-safe forms given the
 * CURRENT classification of parameters (so a demoted callee param makes a
 * call-arg use unsafe on the next iteration).
 */
function isAllowedUse(
  checker: ts.TypeChecker,
  id: ts.Identifier,
  safe: Set<ts.Symbol>,
  fnDecls: Map<ts.Symbol, FnDecl>,
  fnParamSyms: Map<ts.Symbol, (ts.Symbol | undefined)[]>,
  nodeFsBindings: Set<string>,
): boolean {
  const p = id.parent;

  // (#7435) `b?.length` / `b?.[i]`: the optional-chain lowering reads `b` as a value, which a `(ptr, len)` binding
  // does not have.
  if ((ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p)) && p.questionDotToken) return false;

  // b[i]  /  b[i] = v   (element access — the buffer is the object, not index)
  if (ts.isElementAccessExpression(p) && p.expression === id) return true;
  // (b)[i] grouped — TS folds parens; handle defensively below via parent walk.

  // b.length  (the only allowed property)
  if (ts.isPropertyAccessExpression(p) && p.expression === id) {
    return p.name.text === "length";
  }

  // call argument: either an I/O intrinsic, or a linear-safe callee param.
  if (ts.isCallExpression(p) && p.expression !== id) {
    const argIdx = p.arguments.indexOf(id);
    if (argIdx < 0) return false; // appears in callee position somehow → unsafe
    // process.std*.{read,write}(buf …) / node:fs readSync/writeSync(fd, buf …)
    const ioIdx = ioBufferArgIndex(p, nodeFsBindings);
    if (ioIdx === argIdx) return true;
    // direct user call → corresponding param must be currently linear-safe.
    const resolved = resolveDirectCallee(checker, p);
    if (!resolved) return false;
    const paramSyms = fnParamSyms.get(resolved.sym);
    if (!paramSyms) return false;
    const calleeParamSym = paramSyms[argIdx];
    return !!(calleeParamSym && safe.has(calleeParamSym));
  }

  // Parenthesised buffer: `(b)[i]`, `(b).length` — unwrap one paren level.
  if (ts.isParenthesizedExpression(p)) {
    // Re-classify the paren as if it were the buffer reference.
    return isAllowedUse(checker, p as unknown as ts.Identifier, safe, fnDecls, fnParamSyms, nodeFsBindings);
  }

  // Everything else is a potential escape:
  //   return b / yield b / b as T / [b] / {x:b} / f.call(b) / obj.m(b) /
  //   const c = b / b === x / typeof b / spread / for..of / template / etc.
  return false;
}
