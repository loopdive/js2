// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6979 S7-d) The `randomness` platform capability's Web Crypto imports
 * (#1503, #6749): `crypto.randomUUID()` and `crypto.getRandomValues()`. Split
 * out of `src/runtime.ts`'s `resolveImport`.
 */
import { getNodeRequire } from "./node-require.js";

interface CallbackState {
  getExports: () => Record<string, Function> | undefined;
}

/** The provider for one Web Crypto import, or `undefined` when `name` is not one. */
export function resolveCryptoCapabilityImport(
  name: string,
  callbackState: CallbackState | undefined,
  isWasmVec: (value: any, exports: Record<string, Function> | undefined) => boolean,
): Function | undefined {
  // (#1503) Web Crypto host imports — crypto.randomUUID() and
  // crypto.getRandomValues(typedArray). Prefer globalThis.crypto
  // (Web Crypto API; available in browsers + Node 19+); fall back to
  // `require('node:crypto')` for older Node. Pure-standalone hosts
  // (no crypto, no `require`) throw rather than silently degrading to
  // `Math.random()` — see issue notes on the security trap that
  // creates.
  if (name === "__crypto_random_uuid")
    return () => {
      const gc: any = (globalThis as any).crypto;
      if (gc && typeof gc.randomUUID === "function") {
        return gc.randomUUID();
      }
      const req = getNodeRequire();
      if (req) {
        try {
          return req("node:crypto").randomUUID();
        } catch {
          /* fall through */
        }
      }
      throw new Error("crypto.randomUUID is not available in this host");
    };
  if (name === "__crypto_get_random_values")
    return (vec: any) => {
      const exports = callbackState?.getExports();
      // Prefer __vec_set_byte (handles all writable vec element types —
      // f64-backed Uint8Array etc., plus i32_byte ArrayBuffer). Fall
      // back to __dv_byte_set for i32_byte-only modules.
      const vecLen = exports?.__vec_len as ((v: any) => number) | undefined;
      const vecSet = exports?.__vec_set_byte as ((v: any, i: number, b: number) => void) | undefined;
      const dvLen = exports?.__dv_byte_len as ((v: any) => number) | undefined;
      const dvSet = exports?.__dv_byte_set as ((v: any, i: number, b: number) => void) | undefined;
      let n: number;
      let setByte: (v: any, i: number, b: number) => void;
      // (#3637) POSITIVE discriminator: `__vec_len` answers 0 for a non-vec,
      // so a DataView / i32_byte buffer in a module that ALSO exports
      // `__vec_len` took this branch with n = 0 and was filled with zero
      // random bytes instead of falling through to the `__dv_byte_*` path.
      if (typeof vecLen === "function" && typeof vecSet === "function" && isWasmVec(vec, exports)) {
        n = vecLen(vec);
        setByte = vecSet;
      } else if (typeof dvLen === "function" && typeof dvSet === "function") {
        const m = dvLen(vec);
        if (m < 0) {
          throw new TypeError("crypto.getRandomValues: argument is not a Uint8Array / ArrayBufferView");
        }
        n = m;
        setByte = dvSet;
      } else {
        throw new TypeError("crypto.getRandomValues: argument is not a typed-array (Uint8Array required)");
      }
      if (n < 0 || !Number.isFinite(n)) {
        throw new TypeError("crypto.getRandomValues: argument is not a Uint8Array / ArrayBufferView");
      }
      const tmp = new Uint8Array(n);
      const gc: any = (globalThis as any).crypto;
      if (gc && typeof gc.getRandomValues === "function") {
        gc.getRandomValues(tmp);
      } else {
        const req = getNodeRequire();
        let filled = false;
        if (req) {
          try {
            req("node:crypto").randomFillSync(tmp);
            filled = true;
          } catch {
            /* fall through to throw below */
          }
        }
        if (!filled) {
          throw new Error("crypto.getRandomValues: no secure RNG available in this host");
        }
      }
      for (let i = 0; i < n; i++) setByte(vec, i, tmp[i]!);
      return vec;
    };
  return undefined;
}
