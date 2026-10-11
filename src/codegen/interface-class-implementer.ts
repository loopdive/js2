// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6634) Leaf helper — no dependency on `index.ts` or `property-access.ts` —
 * so both can import it without an import cycle.
 *
 * A NAMED INTERFACE that also has at least one CLASS implementer cannot be
 * represented by a single struct type. `collectInterface`
 * (`declarations/struct-type-registration.ts`) synthesizes the interface's
 * own struct from an OBJECT-LITERAL-compatible shape (method members become
 * mutable externref "closure slot" fields) — a class instance never
 * physically matches that layout (it carries a real vtable-dispatched
 * method, not a per-instance closure field). So a value flowing through an
 * interface-typed slot (parameter/return/variable/`Record` value) that is
 * ACTUALLY a class instance fails the struct's own `ref.test`/`ref.cast`
 * guard and silently becomes null:
 *
 *  - #6634 repro13: `Record<string, Iface>` holding BOTH a literal and a
 *    class instance always answered the LITERAL, because the interface's
 *    own carrier — and the call-site devirtualization guess in
 *    `call-receiver-method.ts` — is the literal's struct; the class
 *    instance silently nulls out (its method never reads `this`, so the
 *    null receiver never traps, it just answers the wrong data).
 *  - #6634 repro9: a SOLE class implementer nulls out the same way, but its
 *    caller wraps the result in `ref.as_non_null` — the null-pointer trap.
 *
 * Every consumer of a named interface's Wasm carrier (`resolveWasmType`'s
 * two struct-name lookups, and `resolveStructName`'s call-site struct-name
 * guess) must agree: once ANY known class declares
 * `implements <interfaceName>`, that interface's carrier is externref, never
 * the object-literal-shaped struct — so runtime identity, not a compile-time
 * guess, decides which implementer answers a given call.
 */
import { ts } from "../ts-api.js";
import type { CodegenContext } from "./context/types.js";

/** Per-ctx memo — the class declaration set is stable once collection
 * finishes, so the answer for a given interface name never changes within
 * one compile. */
const interfaceClassImplementerMemo = new WeakMap<CodegenContext, Map<string, boolean>>();

/**
 * True when some KNOWN class declares `implements <interfaceName>` (matched
 * by the heritage clause's spelled-out name — the same identity signal
 * `resolveReceiverMethodClassName`'s callers use elsewhere in the codebase).
 * Named-textual matching intentionally, not `ts.Type` identity: it is the
 * same match a reader of the source would make, it is cheap (no
 * `getTypeFromTypeNode` per heritage entry), and a name COLLISION here can
 * only ever make the interface's carrier MORE conservative (externref
 * instead of a struct it would not otherwise have gotten) — never less safe.
 */
export function interfaceHasClassImplementer(ctx: CodegenContext, interfaceName: string): boolean {
  let memo = interfaceClassImplementerMemo.get(ctx);
  if (!memo) {
    memo = new Map();
    interfaceClassImplementerMemo.set(ctx, memo);
  }
  const cached = memo.get(interfaceName);
  if (cached !== undefined) return cached;
  let found = false;
  for (const decl of ctx.classDeclarationMap.values()) {
    for (const clause of decl.heritageClauses ?? []) {
      if (clause.token !== ts.SyntaxKind.ImplementsKeyword) continue;
      for (const type of clause.types) {
        if (ts.isIdentifier(type.expression) && type.expression.text === interfaceName) {
          found = true;
          break;
        }
      }
      if (found) break;
    }
    if (found) break;
  }
  memo.set(interfaceName, found);
  return found;
}
