// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Empty / growable / array object-shape pre-pass (#2584/#2837/#2372/#2944).
 * Runs before collectDeclarations so struct/vec types register with the right
 * fields. Extracted verbatim from codegen/declarations.ts (#3268).
 */
import { collectShapes } from "../../shape-inference.js";
import { forEachChild, ts } from "../../ts-api.js";
import { resolveWasmType } from "../index.js";
import { localGlobalIdx } from "../registry/imports.js";
import { getArrTypeIdxFromVec, getOrRegisterVecType, registerStructType } from "../registry/types.js";
import { widenedVarKeyFromDecl } from "../widened-var-key.js";
import type { FieldDef, ValType } from "../../ir/types.js";
import type { CodegenContext } from "../context/types.js";

/**
 * Pre-pass: detect empty object literals (`var obj = {}`) that later receive
 * property assignments (`obj.prop = val`) and record the extra properties so
 * that ensureStructForType creates a struct with the correct fields.
 *
 * This runs *before* collectDeclarations so the struct type is correct from
 * the start.
 */
export function collectEmptyObjectWidening(
  ctx: CodegenContext,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
): void {
  // Scan all statements (top-level and inside function bodies)
  function scanStatements(stmts: readonly ts.Statement[]): void {
    for (const stmt of stmts) {
      // Look for var/let/const declarations with empty object literal initializer
      if (ts.isVariableStatement(stmt)) {
        for (const decl of stmt.declarationList.declarations) {
          if (!ts.isIdentifier(decl.name)) continue;
          if (!decl.initializer || !ts.isObjectLiteralExpression(decl.initializer)) continue;
          if (decl.initializer.properties.length > 0) continue;

          // Found `var X = {}` — now scan siblings for `X.prop = val`
          const varName = decl.name.text;
          // (#3403) per-declaration key for `widenedDefinePropertyKeys`; matches
          // what `integrityVarKey` yields at the USE sites in object-ops.ts.
          const varKey = widenedVarKeyFromDecl(decl.name);
          const extraProps: { name: string; type: ValType }[] = [];
          const seenProps = new Set<string>();

          // Scan all following statements in the same block for property assignments
          collectPropsFromStatements(checker, ctx, stmts, varName, varKey, extraProps, seenProps);

          // (#2584/#2849/#2944) If this var is ALSO the subject of any
          // `$Object`-hash-only consumer (bracket read/write, `in`, Object.keys
          // / values / entries / GOPD / GOPN / assign, for-in), a widened closed
          // struct would be invisible to that consumer (`o.a=7; o["a"]` → 0).
          // Mark it poisoned so widening is suppressed below and the receiver
          // stays a `$Object`. Scan the whole enclosing statement list (the same
          // tree `collectPropsFromStatements` walks).
          //
          // History: originally `ctx.standalone`-gated (#2584) on the assumption
          // "host keeps the struct fast path via the live-mirror Proxy". #2849
          // dropped the gate (the Proxy does NOT bridge the for-in-write →
          // static-struct-read divergence, so host mis-read `getOptions`-shaped
          // objects). That extension alone REGRESSED compiled-acorn to a uniform
          // null-deref (#2937) because the poison was honored only at THIS
          // widening decision, while in JS-mode sources the checker's EVOLVED
          // type for the var still resolved to a colliding `__anon` struct at
          // the local/receiver/return/field positions — so it was reverted
          // (#2462). Re-landed here TOGETHER with the #2944 escape discipline:
          // the poison branch below records the var's evolved checker type in
          // `objectHashConsumerTypes`, and resolveWasmType / ensureStructForType
          // / resolveStructName refuse struct resolution for it, keeping the
          // value externref/host-MOP through every escape. Both constraints now
          // hold: the #2849 host arms pass AND compiled-acorn parses.
          for (const s of stmts) {
            markObjectHashConsumers(s, varName, ctx.objectHashConsumerVars);
          }

          // (#2992 S4, standalone) `delete varName.prop` / `delete varName[k]`
          // is an `$Object`-hash consumer too: a widened closed-struct FIELD
          // cannot represent a deleted property — the struct-delete arm
          // (typeof-delete.ts) writes a type-shaped SENTINEL (f64 → NaN,
          // ref → null) into the fixed slot, and a statically-f64 read makes
          // `o.k === undefined` CONST-FOLD to false, so the read can never
          // observe the deletion (the issue's headline nominal-struct repro;
          // also the pre-existing `delete-sentinel` string-field equivalence
          // failure). Poison the widening so the var stays a `$Object`, where
          // `__delete_property` tombstones give correct delete → read / `in` /
          // hasOwnProperty semantics. Standalone-gated: the host lane's
          // sidecar + live-mirror handles struct deletes (byte-inert).
          if (ctx.standalone && !ctx.objectHashConsumerVars.has(varName)) {
            for (const s of stmts) {
              markStandaloneDeleteTargets(s, varName, ctx.objectHashConsumerVars);
            }
          }

          // (#2992 S5, standalone) An ACCESSOR-descriptor
          // `Object.defineProperty(varName, k, {get/set…})` (or any
          // `defineProperties` member descriptor with a get/set key) is an
          // `$Object`-hash consumer too: a widened closed-struct FIELD can only
          // store a plain value, so the define either stores the getter closure
          // itself or null into the fixed slot — a later read (`obj[k]` through
          // an any-typed harness param, or `obj.k`) can never INVOKE the getter,
          // and gOPD can never observe accessor-ness (`hasOwnProperty("get")`).
          // Poison the widening so the var stays a `$Object`, where the slice-3
          // (#2893) accessor machinery (FLAG_ACCESSOR + live get/set halves +
          // §10.1.6.3 merge) serves define → read → gOPD correctly (measured:
          // the 15.2.3.6-4-75 / 4-82-* runner-wrapped family flips to pass).
          // Standalone-gated: the host lane applies accessor defines through the
          // live-mirror Proxy onto the real JS object (byte-inert there).
          if (ctx.standalone && !ctx.objectHashConsumerVars.has(varName)) {
            for (const s of stmts) {
              markStandaloneAccessorDefineTargets(s, varName, ctx.objectHashConsumerVars);
            }
          }

          // (#739 S1 — HOST-lane representation pinning, the store-unification)
          // Any `Object.defineProperty` / `Object.defineProperties` on this
          // receiver whose application lands in the RUNTIME STORE — the native
          // `$Object` open hash or the `_wasmPropDescs`/`_wasmStructProps`
          // sidecar — rather than a widened-struct `struct.set` fast path makes
          // a widened struct UNSOUND: every later dot-read `obj.p` lowers to
          // `struct.get` (a defined getter never fires; a runtime-store value
          // reads the struct default) and every dot-write `obj.p = X` to
          // `struct.set` (a defined setter is bypassed). The two stores never
          // see each other, and `_structFieldWriteback` mirrors only data
          // VALUES back into the field — accessors cannot be mirrored (a
          // `struct.get` can never invoke a getter). #3230 measured both bounded
          // point-fixes (read-reroute net −7; read-reroute + runtime fallback
          // still fails) and proved the field-vs-sidecar choice is
          // widening-sensitive — the only sound fix is to keep the receiver on
          // the ONE native store. Standalone already ships this via
          // `dynamicDescriptorWidenVars` (checked at :123) +
          // `markStandaloneAccessorDefineTargets` (above); the host lane was
          // exempted on the (disproved) assumption the live-mirror writeback
          // bridges the gap. Pin here by marking the var an
          // `objectHashConsumerVar` so the suppression branch below (a) skips
          // widening and (b) — load-bearing — records the var's EVOLVED checker
          // type in `objectHashConsumerTypes` (the #2944 escape discipline;
          // without it the checker re-registers a colliding `__anon` struct at
          // the var's escape positions and compiled-acorn null-derefs, #2937).
          // The now-pinned `$Object` rides the extern-lane MOP ops the
          // bracket-form (`obj["p"]`) already proves correct on main. Host-gated
          // so standalone stays byte-identical (also avoids colliding with
          // in-flight #2042); WASI is standalone (no host MOP).
          if (!ctx.standalone && !ctx.objectHashConsumerVars.has(varName)) {
            for (const s of stmts) {
              markRuntimeStoreDefineTargets(s, varName, ctx.objectHashConsumerVars);
            }
          }

          // (#2372) Standalone: if any `Object.defineProperty(varName, …)` on
          // this receiver used a *dynamic* (non-inline-literal) descriptor, the
          // struct-widening fast path is unsound — the dynamic define is applied
          // through the native `__obj_define_from_desc` `$Object` runtime, but a
          // widened struct would make the read-back `varName.key` lower to
          // `struct.get` against a different object (returns 0). Suppress
          // widening entirely for such receivers so they stay on the `$Object`
          // representation and writes + reads route through the native runtime
          // consistently. (`collectPropsFromStatements` sets the poison flag
          // above, before this decision point.) Host mode is unaffected — it
          // keeps the struct fast path via the live-mirror Proxy writeback.
          if (ctx.dynamicDescriptorWidenVars.has(varName)) {
            continue;
          }

          // (#2584) Suppress widening when a $Object-hash consumer was found
          // above — the var stays a `$Object` so bracket/`in`/keys/GOPD see the
          // same representation the dot-writes land in.
          if (ctx.objectHashConsumerVars.has(varName)) {
            // (#2937) Suppressing the widening pre-pass is NOT enough in a
            // JS-mode source file: the checker EVOLVES `var o = {}` through its
            // later static-named writes into an anonymous object type WITH
            // those props, and `resolveWasmType`/`ensureStructForType` would
            // independently register that evolved type as a closed `__anon_N`
            // struct — typing the local (and the var's every flow position:
            // returns, class fields, receivers) as `(ref null __anon_N)` while
            // the poisoned initializer builds a host plain object. The
            // declaration's guarded cast then stores ref.null and every static
            // read null-derefs (the compiled-acorn `getOptions` uniform throw).
            // Record the var's EVOLVED checker type so struct resolution
            // refuses it and the var stays externref / host-MOP end to end.
            //
            // Scope guards keep everything else byte-identical:
            //   - `!ctx.standalone`: standalone keeps its pre-existing codegen
            //     byte-identical (its matching read-back gap for this shape is
            //     tracked separately; see #2849's follow-up note).
            //   - skip `any` (singleton type object shared by all any-typed
            //     vars — same hazard as the anonTypeMap guard below).
            //   - a 0-props (TS-mode, non-evolved `{}`) type is added ONLY when
            //     its provenance is THIS var's own initializer literal
            //     (`symbol.declarations[0] === decl.initializer`). The widened
            //     literal type is a fresh per-var instance (measured — two `{}`
            //     vars get distinct instances), but the type of a `: {}`
            //     ANNOTATION is an interned instance SHARED by every var so
            //     annotated — poisoning it would demote unrelated vars. The
            //     provenance check admits the safe per-var case and rejects the
            //     shared one.
            //
            // (#2944 residual) The 0-props TS-mode case MUST be poisoned too —
            // "already resolves to externref" does NOT hold for it: the
            // signature pre-pass `ensureStructForType(returnType)` on a function
            // that RETURNS the poisoned var registers the SAME 0-props ts.Type
            // as an EMPTY anon struct ("empty objects get an empty struct"), so
            // the local/return/field slots type `(ref null $__anon_N)`, the `{}`
            // host `$Object` fails the decl-init cast, and the var is null from
            // the first instruction — the acorn `Parser`/`getOptions` escape
            // shape in TS-mode typing (tests/issue-2944.test.ts).
            if (!ctx.standalone) {
              const vt = checker.getTypeAtLocation(decl.name);
              if (
                !(vt.flags & ts.TypeFlags.Any) &&
                (vt.getProperties().length > 0 || vt.symbol?.declarations?.[0] === decl.initializer)
              ) {
                ctx.objectHashConsumerTypes.add(vt);
              }
            }
            continue;
          }

          if (extraProps.length > 0) {
            // (#3364) Key by the DECLARATION site, not the bare name — acorn
            // reuses generic local names (`node`) across many functions with
            // different shapes, and bare-name keying let the last widening
            // clobber every other same-named var (foreign struct → dropped
            // fields → null reads → runaway walk).
            const varKey = widenedVarKeyFromDecl(decl.name);
            ctx.widenedTypeProperties.set(varKey, extraProps);

            // Register the struct type now so that collectDeclarations
            // can resolve the variable type to a struct ref instead of externref
            const fields: FieldDef[] = extraProps.map((wp) => ({
              name: wp.name,
              type: wp.type,
              mutable: true,
            }));
            const structName = `__anon_${ctx.anonTypeCounter++}`;
            registerStructType(ctx, structName, fields);
            // Map variable declaration key to struct name for later lookup
            ctx.widenedVarStructMap.set(varKey, structName);
            // Also try to map TS types (may not match later due to type identity)
            // Skip `any` — it's a singleton type object shared by all any-typed vars,
            // so registering it would cause every any-typed var to resolve to this struct.
            const varType = checker.getTypeAtLocation(decl.name);
            if (!(varType.flags & ts.TypeFlags.Any)) {
              ctx.anonTypeMap.set(varType, structName);
            }
            const initType = checker.getTypeAtLocation(decl.initializer);
            if (!(initType.flags & ts.TypeFlags.Any)) {
              ctx.anonTypeMap.set(initType, structName);
            }
          }
        }
      }
      // Recurse into function bodies
      if (ts.isFunctionDeclaration(stmt) && stmt.body) {
        scanStatements(stmt.body.statements);
      }
      // Recurse into try/catch blocks (wrapTest wraps test bodies in try blocks)
      if (ts.isTryStatement(stmt)) {
        scanStatements(stmt.tryBlock.statements);
        if (stmt.catchClause) {
          scanStatements(stmt.catchClause.block.statements);
        }
        if (stmt.finallyBlock) {
          scanStatements(stmt.finallyBlock.statements);
        }
      }
    }
  }

  scanStatements(sourceFile.statements);
}

/**
 * (#2837) Detection pre-pass: mark variables initialized by a NON-EMPTY object
 * literal that later receive an OUT-OF-SHAPE property write, so `compileObjectLiteral`
 * (literals.ts) routes them through the recursive externref `$Object` builder
 * instead of a closed struct (whose unknown-field writes lower to `drop`).
 *
 * Two trigger rules (mirroring the issue's WAT-grounded isolation):
 *   - **Direct:**  `V.k = …` where `k` is NOT a property name in `V`'s literal shape.
 *   - **Nested (the acorn trigger):** any assignment whose LHS is a property-access
 *     chain rooted at `V` with depth ≥ 2 (`V.a.b… = …`) — e.g.
 *     `prototypeAccessors.inFunction.get = fn` onto the nested `{configurable:true}`
 *     descriptor. Conservative over-approximation: a depth-≥2 write to an
 *     already-in-shape nested field also marks `V` (it is being deep-mutated;
 *     growable is correct, only marginally slower).
 *
 * Consumer-safety guard (avoids the #1897 closed-struct-consumer regression):
 * a marked var becomes an externref `$Object`, so a consumer that requires the
 * closed-struct representation (a `struct.get` numeric read used in arithmetic, or
 * a pass into a CONCRETE nominal-struct-typed parameter / return / assignment)
 * would null-deref or mis-coerce. When such a consumer is detected, do NOT mark
 * (leave the pre-existing closed-struct lowering — the var keeps working for its
 * struct consumers; it just retains the dropped-write bug, which is acceptable —
 * it is not the acorn blocker). When in doubt, prefer NOT marking.
 *
 * Runs BEFORE collectDeclarations (alongside `collectEmptyObjectWidening`) so the
 * variable's representation decision is made before its type is resolved.
 */
export function collectGrowableObjectLiterals(
  ctx: CodegenContext,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
): void {
  // A literal property name we can build onto a $Object (data prop, statically-known key).
  function literalShapeNames(obj: ts.ObjectLiteralExpression): Set<string> | null {
    const names = new Set<string>();
    for (const p of obj.properties) {
      if (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) {
        const nm = p.name;
        if (ts.isIdentifier(nm) || ts.isStringLiteral(nm) || ts.isNumericLiteral(nm)) {
          names.add(nm.text);
        } else {
          return null; // computed / symbol key — externref builder may decline; skip marking
        }
      } else {
        return null; // spread / method / accessor — not a pure data literal
      }
    }
    return names;
  }

  // Resolve a property-access chain's root identifier + depth. Returns null if the
  // base is not ultimately a plain identifier (e.g. a call result).
  function chainRoot(pae: ts.PropertyAccessExpression): { root: string; depth: number } | null {
    let e: ts.Expression = pae;
    let depth = 0;
    while (ts.isPropertyAccessExpression(e)) {
      depth++;
      e = e.expression;
    }
    if (ts.isIdentifier(e)) return { root: e.text, depth };
    return null;
  }

  // Does a contextual type at a use site REQUIRE the closed-struct representation?
  // True only for a CONCRETE nominal struct (named own properties, not any/unknown/
  // `object`, not a pure string-index dictionary). any/object/index-sig consumers
  // (e.g. `Object.defineProperties`' PropertyDescriptorMap param) are SAFE.
  function typeRequiresStruct(t: ts.Type | undefined): boolean {
    if (!t) return false;
    if (t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.NonPrimitive)) return false;
    if (t.flags & (ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike)) return false;
    // A pure string-index dictionary (no named own props) is an open object → safe.
    const props = t.getProperties();
    const hasStringIndex = !!checker.getIndexInfoOfType(t, ts.IndexKind.String);
    if (props.length === 0 && hasStringIndex) return false;
    if (props.length === 0) return false; // empty/object-ish → safe
    return true; // concrete shape with named props → struct consumer
  }

  function scanStatements(stmts: readonly ts.Statement[]): void {
    for (const stmt of stmts) {
      if (ts.isVariableStatement(stmt)) {
        for (const decl of stmt.declarationList.declarations) {
          if (!ts.isIdentifier(decl.name)) continue;
          if (!decl.initializer || !ts.isObjectLiteralExpression(decl.initializer)) continue;
          if (decl.initializer.properties.length === 0) continue; // empty handled by widening
          const varName = decl.name.text;
          const shape = literalShapeNames(decl.initializer);
          if (!shape) continue; // not a pure data literal → skip (externref builder would decline)

          // (#2992 S6, standalone) `delete varName.k` / `delete varName[e]` or
          // an ACCESSOR-descriptor define on a NON-EMPTY pure-data literal var:
          // the closed-struct representation cannot observe the deletion (the
          // delete arm writes a type-shaped SENTINEL — NaN/null — into the
          // fixed slot, so `o.k !== undefined` / `"k" in o` / hasOwnProperty /
          // typeof / for-in all lie) nor accessor-ness (a struct field stores a
          // plain value; reads never invoke the getter). This is the same
          // defect slices 4/5 fixed for the empty-`{}`-widening shape — here
          // the receiver is a non-empty literal, so instead of suppressing a
          // widening we (a) route the literal to the recursive externref
          // `$Object` builder (`growableObjectLiteralVars`) and (b) refuse
          // struct resolution for the var's checker type
          // (`objectHashConsumerTypes`, the #2944 escape discipline) so the
          // local/receiver/return positions stay externref and EVERY consumer
          // (delete, bracket, `in`, for-in, dot reads, defines) rides the
          // dynamic `$Object` arms slices 1/3/4/5 proved correct. The #2837
          // consumer-poison below (delete/bracket/for-in → "leave on the
          // struct path") is a HOST-lane discipline — in standalone the struct
          // path is precisely what cannot serve these consumers, so this arm
          // runs first. Host lane is untouched (byte-inert).
          if (ctx.standalone) {
            const mopSet = new Set<string>();
            for (const s of stmts) {
              markStandaloneDeleteTargets(s, varName, mopSet);
              markStandaloneAccessorDefineTargets(s, varName, mopSet);
            }
            // Consumer-safety (#1897/#2837): when the var ALSO flows into a
            // CONCRETE nominal-struct-typed position (call/new arg, return,
            // assignment), the externref `$Object` rep would fail that
            // consumer's cast. Leave such vars on the struct path (their
            // delete/accessor gap stays — documented residual), same
            // when-in-doubt-don't-mark discipline as the growable pre-pass.
            if (mopSet.has(varName)) {
              let structConsumer = false;
              const guardVisit = (node: ts.Node): void => {
                if (
                  ts.isIdentifier(node) &&
                  node.text === varName &&
                  isValueUseOfIdentifier(node) &&
                  // An `Object.<mop>(varName, …)` argument is NOT a struct
                  // consumer — TS's generic `defineProperty<T>(o: T, …)` binds
                  // T to the literal type, so the contextual type LOOKS
                  // concrete, but the MOP call is exactly what the `$Object`
                  // rep serves. Only genuine user-typed positions count.
                  !isObjectMopCallArg(node) &&
                  typeRequiresStruct(checker.getContextualType(node))
                ) {
                  structConsumer = true;
                }
                forEachChild(node, guardVisit);
              };
              for (const s of stmts) guardVisit(s);
              if (structConsumer) mopSet.delete(varName);
            }
            if (mopSet.has(varName)) {
              ctx.growableObjectLiteralVars.add(varName);
              // Type-refusal with the #2944 provenance guard: only poison a
              // checker type whose provenance is THIS var's own initializer
              // literal (fresh per-literal instance). An annotation type is a
              // shared/interned instance — poisoning it would demote unrelated
              // vars.
              const vt = checker.getTypeAtLocation(decl.name);
              if (!(vt.flags & ts.TypeFlags.Any) && vt.symbol?.declarations?.[0] === decl.initializer) {
                ctx.objectHashConsumerTypes.add(vt);
              }
              const it = checker.getTypeAtLocation(decl.initializer);
              if (!(it.flags & ts.TypeFlags.Any) && it.symbol?.declarations?.[0] === decl.initializer) {
                ctx.objectHashConsumerTypes.add(it);
              }
              continue;
            }
          }

          let grows = false;
          let poisoned = false;

          const visit = (node: ts.Node): void => {
            // Out-of-shape write rooted at varName.
            if (
              ts.isBinaryExpression(node) &&
              node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
              ts.isPropertyAccessExpression(node.left)
            ) {
              const info = chainRoot(node.left);
              if (info && info.root === varName) {
                if (info.depth >= 2) {
                  grows = true; // nested deep-mutation (the acorn descriptor case)
                } else if (info.depth === 1 && !shape.has(node.left.name.text)) {
                  grows = true; // direct out-of-shape field add
                }
              }
            }
            // Consumer-safety: a numeric/arithmetic read of a field off varName needs
            // the struct `struct.get` f64 contract (#1897) → poison.
            if (
              ts.isBinaryExpression(node) &&
              isArithmeticOperator(node.operatorToken.kind) &&
              (isFieldReadOf(node.left, varName) || isFieldReadOf(node.right, varName))
            ) {
              poisoned = true;
            }
            if (
              ts.isPrefixUnaryExpression(node) &&
              (node.operator === ts.SyntaxKind.MinusToken || node.operator === ts.SyntaxKind.PlusToken) &&
              isFieldReadOf(node.operand, varName)
            ) {
              poisoned = true;
            }
            // Consumer-safety: varName flows into a CONCRETE-struct-typed position
            // (call/new argument, return, or assignment target) → poison.
            if (ts.isIdentifier(node) && node.text === varName && isValueUseOfIdentifier(node)) {
              if (typeRequiresStruct(checker.getContextualType(node))) {
                poisoned = true;
              }
            }
            // (#2837 regression fix) Consumer-safety: `delete V.k`, element/bracket
            // access `V[expr]`, and `for (k in V)` lower against V's STATIC struct
            // type (`ref.cast` to the inferred struct + `struct.set`/enumerate).
            // Routing V to externref `$Object` would make those casts `illegal cast`
            // (the consumers don't consult `externrefAccessorVars`). Such objects are
            // ALREADY handled correctly by the existing dynamic-consumer machinery
            // (they passed pre-fix), so do NOT mark them growable — leave them on the
            // struct path, byte-identical. acorn's `prototypeAccessors` has none of
            // these (consumed only by `Object.defineProperties`), so it stays marked.
            if (
              ts.isDeleteExpression(node) &&
              ts.isPropertyAccessExpression(node.expression) &&
              ts.isIdentifier(node.expression.expression) &&
              node.expression.expression.text === varName
            ) {
              poisoned = true;
            }
            if (
              ts.isElementAccessExpression(node) &&
              ts.isIdentifier(node.expression) &&
              node.expression.text === varName
            ) {
              poisoned = true;
            }
            if (ts.isForInStatement(node) && ts.isIdentifier(node.expression) && node.expression.text === varName) {
              poisoned = true;
            }
            forEachChild(node, visit);
          };
          for (const s of stmts) visit(s);
          if (grows && !poisoned) {
            ctx.growableObjectLiteralVars.add(varName);
          }
        }
      }
      if (ts.isFunctionDeclaration(stmt) && stmt.body) {
        scanStatements(stmt.body.statements);
      }
      if (ts.isTryStatement(stmt)) {
        scanStatements(stmt.tryBlock.statements);
        if (stmt.catchClause) scanStatements(stmt.catchClause.block.statements);
        if (stmt.finallyBlock) scanStatements(stmt.finallyBlock.statements);
      }
    }
  }

  scanStatements(sourceFile.statements);
}

/** (#2837) `V.field` (depth-1 property read) where the chain root is `varName`. */
function isFieldReadOf(expr: ts.Expression, varName: string): boolean {
  if (!ts.isPropertyAccessExpression(expr)) return false;
  return ts.isIdentifier(expr.expression) && expr.expression.text === varName;
}

/** (#2837) Arithmetic binary operators whose operands need the f64 struct contract. */
function isArithmeticOperator(kind: ts.SyntaxKind): boolean {
  return (
    kind === ts.SyntaxKind.MinusToken ||
    kind === ts.SyntaxKind.AsteriskToken ||
    kind === ts.SyntaxKind.SlashToken ||
    kind === ts.SyntaxKind.PercentToken ||
    kind === ts.SyntaxKind.AsteriskAsteriskToken
  );
}

/** (#2992 S6) Is this identifier an argument of an `Object.<method>(...)`
 * call (defineProperty / defineProperties / keys / gOPD / ...)? Those MOP
 * receivers must not count as struct consumers in the S6 guard. */
function isObjectMopCallArg(id: ts.Identifier): boolean {
  const p = id.parent;
  if (!ts.isCallExpression(p) || !p.arguments.includes(id)) return false;
  const callee = p.expression;
  return (
    ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === "Object"
  );
}

/** (#2837) The identifier is used as a value (arg / return / RHS), not as an
 * assignment target or the base of its own property-write. */
function isValueUseOfIdentifier(id: ts.Identifier): boolean {
  const p = id.parent;
  if (ts.isCallExpression(p) || ts.isNewExpression(p)) {
    return (p.arguments?.indexOf(id) ?? -1) >= 0;
  }
  if (ts.isReturnStatement(p)) return true;
  if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken && p.right === id) {
    return true;
  }
  return false;
}

/**
 * (#2584) Recursively walk `node` and poison `varName` in `poisonSet` if it
 * appears as the subject of any `$Object`-hash-only operation — i.e. an access
 * form that, in standalone, reads or enumerates the native `$Object` open hash
 * rather than a widened WasmGC struct field:
 *
 *   - `varName[<expr>]` — ElementAccessExpression with the var as receiver
 *     (covers both `o["a"]` read and `o[k]` write).
 *   - `<key> in varName` — `in` BinaryExpression with the var on the right.
 *   - `Object.keys/values/entries/getOwnPropertyDescriptor/getOwnPropertyNames(varName)`
 *     and `Object.assign(varName, …)` / `Object.assign(…, varName)` — the var as
 *     any relevant argument.
 *   - `for (… in varName)` — ForInStatement enumerating the var.
 *
 * A single match is enough; the receiver then stays a `$Object` so every access
 * form (including the dot-writes) targets the same representation. Name-based,
 * matching the existing widening pre-pass (aliasing is a shared, documented
 * limitation — see the issue's `## Deferred`).
 */
/**
 * (#2992 S4, standalone-only caller) Poison `varName` when it is the receiver
 * of any `delete varName.prop` / `delete varName[<expr>]` in the scanned
 * statements. A widened closed struct cannot drop a field, so the delete arm's
 * sentinel write (NaN / null) lies to every later read (`o.k === undefined`
 * const-folds false on an f64 field). Keeping the var a `$Object` routes the
 * delete through the `__delete_property` tombstone machinery, which slice 1
 * (#2872) already proved correct in every lane. Parenthesized targets
 * (`delete (o.k)`) are unwrapped like the module-init collector does.
 */
function markStandaloneDeleteTargets(node: ts.Node, varName: string, poisonSet: Set<string>): void {
  const visit = (n: ts.Node): void => {
    if (ts.isDeleteExpression(n)) {
      let target: ts.Expression = n.expression;
      while (ts.isParenthesizedExpression(target)) target = target.expression;
      if (
        (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) &&
        ts.isIdentifier(target.expression) &&
        target.expression.text === varName
      ) {
        poisonSet.add(varName);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
}

/**
 * (#2992 S5, standalone-only caller) Poison `varName` when it is the receiver
 * of an accessor-descriptor `Object.defineProperty(varName, k, {get/set…})` or
 * of an `Object.defineProperties(varName, {…})` whose any member descriptor
 * literal carries a `get`/`set` key. A widened closed-struct field cannot hold
 * an accessor (reads never invoke the getter; gOPD cannot see accessor-ness),
 * so the receiver must stay a `$Object` for the #2893 accessor machinery.
 *
 * A PRESENT `get`/`set` key counts even when its value is `undefined` — the
 * §10.1.6.3 semantics (and gOPD `hasOwnProperty("get")`) must still observe an
 * accessor property, which the slice-3 explicit-undefined-half routing handles
 * on the `$Object` path.
 */
function markStandaloneAccessorDefineTargets(node: ts.Node, varName: string, poisonSet: Set<string>): void {
  const visit = (n: ts.Node): void => {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      ts.isIdentifier(n.expression.expression) &&
      n.expression.expression.text === "Object" &&
      ts.isIdentifier(n.expression.name)
    ) {
      const method = n.expression.name.text;
      const recv = n.arguments[0];
      if (recv && ts.isIdentifier(recv) && recv.text === varName) {
        if (method === "defineProperty" && n.arguments.length >= 3) {
          if (descriptorHasAccessorKey(n.arguments[2]!)) poisonSet.add(varName);
        } else if (method === "defineProperties" && n.arguments.length >= 2) {
          const props = n.arguments[1]!;
          if (ts.isObjectLiteralExpression(props)) {
            for (const p of props.properties) {
              if (ts.isPropertyAssignment(p) && descriptorHasAccessorKey(p.initializer)) {
                poisonSet.add(varName);
                break;
              }
            }
          }
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
}

/** (#2992 S5) Does a descriptor object literal carry a `get` or `set` key (any
 * form: property assignment — including `get: undefined` —, method shorthand,
 * or string-named)? Presence of the key is what makes the define an accessor
 * define per §10.1.6.3, independent of the value. */
function descriptorHasAccessorKey(descArg: ts.Expression): boolean {
  if (!ts.isObjectLiteralExpression(descArg)) return false;
  for (const prop of descArg.properties) {
    if (
      (ts.isPropertyAssignment(prop) || ts.isMethodDeclaration(prop)) &&
      prop.name &&
      (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) &&
      (prop.name.text === "get" || prop.name.text === "set")
    ) {
      return true;
    }
  }
  return false;
}

/**
 * (#739 S1, HOST-lane caller) Poison `varName` when it is the receiver of any
 * `Object.defineProperty` / `Object.defineProperties` call whose application
 * lands in the RUNTIME STORE (native `$Object` open hash or the
 * `_wasmPropDescs`/`_wasmStructProps` sidecar) rather than a widened-struct
 * `struct.set` fast path. Such receivers must stay a `$Object` so define →
 * read → write → delete → for-in → hasOwnProperty → gOPD all target the ONE
 * native store — see the block comment at the call site. This is the host-lane
 * generalization of `markStandaloneAccessorDefineTargets` (which only covers
 * accessor descriptors, standalone-gated); the host lane must additionally pin
 * for dynamic descriptors, explicit-undefined / no-value literals, dynamic
 * keys, and every `defineProperties` shape.
 *
 * Name-based, matching the widening pre-pass (aliasing is a shared documented
 * limitation — see the issue's "Edge cases").
 */
function markRuntimeStoreDefineTargets(node: ts.Node, varName: string, poisonSet: Set<string>): void {
  const visit = (n: ts.Node): void => {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      ts.isIdentifier(n.expression.expression) &&
      n.expression.expression.text === "Object" &&
      ts.isIdentifier(n.expression.name)
    ) {
      const method = n.expression.name.text;
      const recv = n.arguments[0];
      if (recv && ts.isIdentifier(recv) && recv.text === varName) {
        if (method === "defineProperty" && n.arguments.length >= 3) {
          if (definePropertyRoutesToRuntimeStore(n.arguments[1]!, n.arguments[2]!)) {
            poisonSet.add(varName);
          }
        } else if (method === "defineProperties" && n.arguments.length >= 2) {
          // Every `Object.defineProperties(varName, …)` shape lands in the
          // runtime store: the static per-entry expansion still routes each
          // inner define through the runtime applier, and the dynamic route
          // (`__defineProperties`) is entirely native. A widened struct is
          // unsound for all of them.
          poisonSet.add(varName);
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
}

/**
 * (#739 S1) Does a single `Object.defineProperty(varName, key, desc)` route its
 * APPLICATION to the runtime store (native `$Object` / `_wasmPropDescs`
 * sidecar) rather than the widened-struct `struct.set` fast path? True for
 * every shape EXCEPT a pure data-descriptor object literal (`value` key
 * present, no `get`/`set`, no explicit-`undefined` field) on a string/numeric
 * literal key. Mirrors the routing in `object-ops.ts`: dynamic descriptor
 * (`:1580` → `__defineProperty_desc`), explicit-`undefined` fields (`:1608`),
 * the accessor path (`emitExternDefinePropertyNoValue` → `__defineProperty_accessor`),
 * and the no-`value` path (also `emitExternDefinePropertyNoValue`). The pure
 * data-literal family is deliberately KEPT on the struct fast path + flag
 * side-channel — it already passes (`15.2.3.6-4-*` static rows) and must not be
 * disturbed in S1.
 */
function definePropertyRoutesToRuntimeStore(keyArg: ts.Expression, descArg: ts.Expression): boolean {
  // Dynamic key (not a string/numeric literal) can never be a widened field.
  if (!ts.isStringLiteral(keyArg) && !ts.isNumericLiteral(keyArg)) return true;
  // Non-inline-literal descriptor → runtime `__defineProperty_desc` (:1580).
  if (!ts.isObjectLiteralExpression(descArg)) return true;
  // Accessor descriptor (`get`/`set` key present, any value incl. `undefined`)
  // → runtime accessor path.
  if (descriptorHasAccessorKey(descArg)) return true;
  // Explicit-`undefined` descriptor field (`{ value: undefined }`,
  // `{ writable: undefined }`, …) → runtime path so the presence bit is
  // recorded per ToPropertyDescriptor (:1608, host-only).
  if (descriptorHasExplicitUndefinedField(descArg)) return true;
  // No `value` key → `emitExternDefinePropertyNoValue` → runtime sidecar.
  if (!descriptorHasValueKey(descArg)) return true;
  return false;
}

/** (#739 S1) Recognized descriptor field names, per §6.2.5 ToPropertyDescriptor. */
const S1_DESCRIPTOR_FIELD_NAMES = new Set(["value", "writable", "enumerable", "configurable", "get", "set"]);

/** (#739 S1) Is `expr` `undefined` / `void <x>` (an explicit-undefined field
 * value)? Mirrors `object-ops.ts`'s `isUndefinedLikeExpression`, unwrapping
 * transparent `as` / `!` / parenthesized wrappers. */
function isS1UndefinedLikeExpression(expr: ts.Expression): boolean {
  let inner: ts.Expression = expr;
  while (
    ts.isAsExpression(inner) ||
    ts.isTypeAssertionExpression(inner) ||
    ts.isNonNullExpression(inner) ||
    ts.isParenthesizedExpression(inner) ||
    ts.isSatisfiesExpression(inner)
  ) {
    inner = inner.expression;
  }
  return (
    inner.kind === ts.SyntaxKind.UndefinedKeyword ||
    (ts.isIdentifier(inner) && inner.text === "undefined") ||
    ts.isVoidExpression(inner)
  );
}

/** (#739 S1) Does the descriptor literal carry a recognized field explicitly
 * set to `undefined` (`{ value: undefined }`, `{ configurable: void 0 }`, …)?
 * Mirrors `object-ops.ts`'s `descriptorUndefinedFields(...).length > 0`. */
function descriptorHasExplicitUndefinedField(descArg: ts.ObjectLiteralExpression): boolean {
  for (const prop of descArg.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    const name = prop.name;
    if (!ts.isIdentifier(name) && !ts.isStringLiteral(name)) continue;
    if (S1_DESCRIPTOR_FIELD_NAMES.has(name.text) && isS1UndefinedLikeExpression(prop.initializer)) {
      return true;
    }
  }
  return false;
}

/** (#739 S1) Does the descriptor literal have a (non-undefined-guaranteed)
 * `value` key present? A property-assignment or shorthand `value` counts; an
 * explicit-`undefined` `value` is caught earlier by
 * {@link descriptorHasExplicitUndefinedField}. */
function descriptorHasValueKey(descArg: ts.ObjectLiteralExpression): boolean {
  for (const prop of descArg.properties) {
    if (!ts.isPropertyAssignment(prop) && !ts.isShorthandPropertyAssignment(prop)) continue;
    const name = prop.name;
    if ((ts.isIdentifier(name) || ts.isStringLiteral(name)) && name.text === "value") {
      return true;
    }
  }
  return false;
}

function markObjectHashConsumers(node: ts.Node, varName: string, poisonSet: Set<string>): void {
  const isVarRef = (n: ts.Node): boolean => ts.isIdentifier(n) && n.text === varName;

  const OBJECT_HASH_METHODS = new Set([
    "keys",
    "values",
    "entries",
    "getOwnPropertyDescriptor",
    "getOwnPropertyDescriptors",
    "getOwnPropertyNames",
    "assign",
  ]);

  const visit = (n: ts.Node): void => {
    // varName[<expr>]  (bracket read or write)
    if (ts.isElementAccessExpression(n) && isVarRef(n.expression)) {
      poisonSet.add(varName);
    }
    // <key> in varName
    else if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.InKeyword && isVarRef(n.right)) {
      poisonSet.add(varName);
    }
    // Object.<hashMethod>(… varName …)
    else if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      ts.isIdentifier(n.expression.expression) &&
      n.expression.expression.text === "Object" &&
      ts.isIdentifier(n.expression.name) &&
      OBJECT_HASH_METHODS.has(n.expression.name.text) &&
      n.arguments.some((a) => isVarRef(a))
    ) {
      poisonSet.add(varName);
    }
    // for (… in varName)
    else if (ts.isForInStatement(n) && isVarRef(n.expression)) {
      poisonSet.add(varName);
    }
    // (#3366 follow-up) A destructuring member target such as
    // `[obj.value = fallback()] = source` is an open-property write. The
    // extracted value is not bounded by the default initializer's checker
    // type, so widening an empty `{}` receiver to a closed struct can select a
    // colliding anonymous shape and leave the runtime receiver null. Keep this
    // receiver on the same `$Object`/externref representation used by the
    // dynamic member setter and subsequent sidecar read.
    else if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      (ts.isArrayLiteralExpression(n.left) || ts.isObjectLiteralExpression(n.left))
    ) {
      const visitTarget = (target: ts.Node): void => {
        if (ts.isBinaryExpression(target) && target.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
          visitTarget(target.left);
          return;
        }
        if (
          ts.isPropertyAccessExpression(target) &&
          ts.isIdentifier(target.expression) &&
          target.expression.text === varName
        ) {
          poisonSet.add(varName);
          return;
        }
        ts.forEachChild(target, visitTarget);
      };
      visitTarget(n.left);
    }
    ts.forEachChild(n, visit);
  };

  visit(node);
}

/**
 * (#3268) Extract the `value` type from an `Object.defineProperty` descriptor
 * object literal (defaulting to externref) and record the widened property plus
 * its `${varName}:${propName}` key. Shared by the ExpressionStatement and
 * VariableStatement `Object.defineProperty(...)` branches of
 * {@link collectPropsFromStatements}.
 */
function recordDefinePropertyWiden(
  ctx: CodegenContext,
  checker: ts.TypeChecker,
  // (#3403) the per-declaration key (`name@declStart`), NOT the bare name, so a
  // same-named `{}` var in another function does not share this entry.
  varKey: string,
  propName: string,
  descArg: ts.Expression,
  extraProps: { name: string; type: ValType }[],
  seenProps: Set<string>,
): void {
  if (!seenProps.has(propName)) {
    seenProps.add(propName);
    // Try to get value type from descriptor.value
    let wasmType: ValType = { kind: "externref" };
    if (ts.isObjectLiteralExpression(descArg)) {
      for (const prop of descArg.properties) {
        if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === "value") {
          const rhsType = checker.getTypeAtLocation(prop.initializer);
          wasmType = resolveWasmType(ctx, rhsType);
          break;
        }
      }
    }
    extraProps.push({ name: propName, type: wasmType });
    ctx.widenedDefinePropertyKeys.add(`${varKey}:${propName}`);
  }
}

export function collectPropsFromStatements(
  checker: ts.TypeChecker,
  ctx: CodegenContext,
  stmts: readonly ts.Statement[],
  varName: string,
  // (#3403) per-declaration key for `widenedDefinePropertyKeys` (threaded to
  // `recordDefinePropertyWiden`); `varName` stays bare for the `objArg.text ===
  // varName` receiver match below.
  varKey: string,
  extraProps: { name: string; type: ValType }[],
  seenProps: Set<string>,
): void {
  for (const s of stmts) {
    // ExpressionStatement: obj.prop = value
    if (ts.isExpressionStatement(s) && ts.isBinaryExpression(s.expression)) {
      const bin = s.expression;
      if (
        bin.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(bin.left) &&
        ts.isIdentifier(bin.left.expression) &&
        bin.left.expression.text === varName
      ) {
        const propName = bin.left.name.text;
        if (!seenProps.has(propName)) {
          seenProps.add(propName);
          // Infer wasm type from the RHS
          const rhsType = checker.getTypeAtLocation(bin.right);
          const wasmType = resolveWasmType(ctx, rhsType);
          extraProps.push({ name: propName, type: wasmType });
        }
      }
    }
    // Object.defineProperty(obj, "prop", { value: v }) — treat as obj.prop = v for widening
    if (ts.isExpressionStatement(s) && ts.isCallExpression(s.expression)) {
      const call = s.expression;
      if (
        ts.isPropertyAccessExpression(call.expression) &&
        ts.isIdentifier(call.expression.expression) &&
        call.expression.expression.text === "Object" &&
        ts.isIdentifier(call.expression.name) &&
        call.expression.name.text === "defineProperty" &&
        call.arguments.length >= 3
      ) {
        const objArg = call.arguments[0]!;
        const propArg = call.arguments[1]!;
        const descArg = call.arguments[2]!;
        if (ts.isIdentifier(objArg) && objArg.text === varName && ts.isStringLiteral(propArg)) {
          const propName = propArg.text;
          // (#2372) The struct-widening fast path only works when the
          // descriptor is a statically-resolvable inline object literal: the
          // define lowers to `struct.set` and the read-back to `struct.get` on
          // the SAME widened struct field. A *dynamic* descriptor (a variable /
          // call result) cannot be applied via `struct.set` — standalone routes
          // it to the native `__obj_define_from_desc` helper, which writes the
          // `$Object` open-hash runtime. If we widen the receiver to a struct
          // anyway, the read-back `o.x` lowers to `struct.get` against the
          // struct while the write landed in the `$Object` — different objects,
          // so the read returns 0. Mark this var as define-poisoned so the
          // widening is suppressed for it (below): the receiver then stays on
          // the `$Object` representation and BOTH the dynamic write and the
          // read route through the native runtime consistently. Host mode keeps
          // the struct fast path (the host `__defineProperty_desc` import
          // reflects back through the live-mirror Proxy onto the struct sidecar).
          if (ctx.standalone && !ts.isObjectLiteralExpression(descArg)) {
            ctx.dynamicDescriptorWidenVars.add(varName);
          }
          recordDefinePropertyWiden(ctx, checker, varKey, propName, descArg, extraProps, seenProps);
        }
      }
    }
    // Also handle: const result = Object.defineProperty(obj, ...)
    if (ts.isVariableStatement(s)) {
      for (const decl of s.declarationList.declarations) {
        if (decl.initializer && ts.isCallExpression(decl.initializer)) {
          const call = decl.initializer;
          if (
            ts.isPropertyAccessExpression(call.expression) &&
            ts.isIdentifier(call.expression.expression) &&
            call.expression.expression.text === "Object" &&
            ts.isIdentifier(call.expression.name) &&
            call.expression.name.text === "defineProperty" &&
            call.arguments.length >= 3
          ) {
            const objArg = call.arguments[0]!;
            const propArg = call.arguments[1]!;
            const descArg = call.arguments[2]!;
            if (ts.isIdentifier(objArg) && objArg.text === varName && ts.isStringLiteral(propArg)) {
              const propName = propArg.text;
              recordDefinePropertyWiden(ctx, checker, varKey, propName, descArg, extraProps, seenProps);
            }
          }
        }
      }
    }
    // Recurse into compound statement bodies to find property assignments
    if (ts.isBlock(s)) {
      collectPropsFromStatements(checker, ctx, s.statements, varName, varKey, extraProps, seenProps);
    }
    if (ts.isIfStatement(s)) {
      if (ts.isBlock(s.thenStatement)) {
        collectPropsFromStatements(checker, ctx, s.thenStatement.statements, varName, varKey, extraProps, seenProps);
      }
      if (s.elseStatement && ts.isBlock(s.elseStatement)) {
        collectPropsFromStatements(checker, ctx, s.elseStatement.statements, varName, varKey, extraProps, seenProps);
      }
    }
    // Recurse into try/catch/finally blocks (wrapTest wraps test bodies in try blocks)
    if (ts.isTryStatement(s)) {
      collectPropsFromStatements(checker, ctx, s.tryBlock.statements, varName, varKey, extraProps, seenProps);
      if (s.catchClause) {
        collectPropsFromStatements(
          checker,
          ctx,
          s.catchClause.block.statements,
          varName,
          varKey,
          extraProps,
          seenProps,
        );
      }
      if (s.finallyBlock) {
        collectPropsFromStatements(checker, ctx, s.finallyBlock.statements, varName, varKey, extraProps, seenProps);
      }
    }
    // Recurse into for/while/do-while/switch bodies
    if (
      ts.isForStatement(s) ||
      ts.isForInStatement(s) ||
      ts.isForOfStatement(s) ||
      ts.isWhileStatement(s) ||
      ts.isDoStatement(s)
    ) {
      if (ts.isBlock(s.statement)) {
        collectPropsFromStatements(checker, ctx, s.statement.statements, varName, varKey, extraProps, seenProps);
      }
    }
    if (ts.isSwitchStatement(s)) {
      for (const clause of s.caseBlock.clauses) {
        collectPropsFromStatements(checker, ctx, clause.statements, varName, varKey, extraProps, seenProps);
      }
    }
  }
}

/**
 * Apply shape inference: detect module-level variables used as array-like objects
 * and override their global types from externref/AnyValue to vec struct types.
 * Must be called after collectDeclarations (which registers module globals).
 */
export function applyShapeInference(ctx: CodegenContext, checker: ts.TypeChecker, sourceFile: ts.SourceFile): void {
  const shapes = collectShapes(checker, sourceFile);
  if (shapes.size === 0) return;

  for (const [varName, shape] of shapes) {
    const globalIdx = ctx.moduleGlobals.get(varName);
    if (globalIdx === undefined) continue;

    // Determine element type for the vec struct from the shape's numeric value type
    let elemType: ValType;
    let elemKey: string;
    if (shape.numericValueType === "number") {
      if (ctx.fast) {
        elemType = { kind: "i32" };
        elemKey = "i32";
      } else {
        elemType = { kind: "f64" };
        elemKey = "f64";
      }
    } else if (shape.numericValueType === "string") {
      elemType = { kind: "externref" };
      elemKey = "externref";
    } else {
      // Default to f64 for unknown numeric types
      if (ctx.fast) {
        elemType = { kind: "i32" };
        elemKey = "i32";
      } else {
        elemType = { kind: "f64" };
        elemKey = "f64";
      }
    }

    // Register or reuse the vec struct type
    const vecTypeIdx = getOrRegisterVecType(ctx, elemKey, elemType);
    const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);

    // Override the module global's type to ref_null of the vec struct
    const localIdx = localGlobalIdx(ctx, globalIdx);
    const globalDef = ctx.mod.globals[localIdx];
    if (globalDef) {
      const newType: ValType = { kind: "ref_null", typeIdx: vecTypeIdx };
      globalDef.type = newType;
      // Update initializer to ref.null of the vec type
      globalDef.init = [{ op: "ref.null", typeIdx: vecTypeIdx }];
    }

    // Record in shapeMap for use during compilation
    ctx.shapeMap.set(varName, { vecTypeIdx, arrTypeIdx, elemType });
  }
}
