// Host globals supplied to the unmodified test262 harness by the js2wasm lane.
// Keep this file plain JavaScript: test262-fyi/data prepends it verbatim before
// harness/assert.js, harness/sta.js, optional includes, and the raw test body.
var print = function (value) {
  console.log(value);
};

var $262 = {
  global: globalThis,
  // Host-provided identity sentinel used by IsHTMLDDA feature tests. This
  // object preserves the non-undefined identity required by destructuring and
  // nullish tests; compiler support for the full falsy/typeof/equality
  // [[IsHTMLDDA]] semantics remains a separate language-feature concern.
  IsHTMLDDA: function () {},
  createRealm: function () {
    // (#4634) A realm must expose error constructors with DISTINCT function
    // identity so the same-realm harness tests (assert-throws-same-realm,
    // asyncHelpers-throwsAsync-same-realm) can observe that a foreign
    // instance does not satisfy `assert.throws(TypeError, ...)`. The ctors
    // are minted via an anonymous factory ON PURPOSE: a function expression
    // literally named `TypeError` in this prelude shadows the builtin in the
    // compiler's name-keyed fnctor machinery for EVERY test module (the
    // 2026-08-23 merge_group park, 367 js-host regressions) — never name
    // these after builtins.
    var mkerr = function () {
      return function (msg) {
        this.message = msg;
      };
    };
    // The realm's global forwards the builtins the cross-realm corpus reads
    // (`.global.Array` / `.global.Proxy` / `.global.eval`) from the real
    // global, and overrides ONLY the error constructors with distinct
    // identities. Copied via `globalThis.<name>` member reads — the same
    // read path `global: globalThis` used to serve — never bare-identifier
    // value reads, whose standalone lowering differs per builtin.
    var realmGlobal = {
      Array: globalThis.Array,
      ArrayBuffer: globalThis.ArrayBuffer,
      Boolean: globalThis.Boolean,
      DataView: globalThis.DataView,
      Date: globalThis.Date,
      Function: globalThis.Function,
      Iterator: globalThis.Iterator,
      Map: globalThis.Map,
      Math: globalThis.Math,
      Number: globalThis.Number,
      // (#6651 U1) The `Object` forward was held back after the 2026-08-23
      // PR #4794 merge_group park (js-host `dynamic-import/assignment-
      // expression/import-meta.js` lost its TypeError). Lane S1 re-measured
      // 2026-09-26: that row passes WITH the forward on current main, and the
      // 196-row cross-realm bucket changed 0 host statuses. U1 re-checked the
      // row on both lanes before re-adding it.
      Object: globalThis.Object,
      Promise: globalThis.Promise,
      Proxy: globalThis.Proxy,
      RegExp: globalThis.RegExp,
      Set: globalThis.Set,
      String: globalThis.String,
      Symbol: globalThis.Symbol,
      WeakMap: globalThis.WeakMap,
      WeakSet: globalThis.WeakSet,
      eval: globalThis.eval,
      parseInt: globalThis.parseInt,
      Error: mkerr(),
      TypeError: mkerr(),
      RangeError: mkerr(),
      SyntaxError: mkerr(),
      ReferenceError: mkerr(),
      EvalError: mkerr(),
      URIError: mkerr(),
    };
    var realm = {
      global: realmGlobal,
      IsHTMLDDA: $262.IsHTMLDDA,
      createRealm: $262.createRealm,
      evalScript: $262.evalScript,
      gc: $262.gc,
      detachArrayBuffer: $262.detachArrayBuffer,
    };
    return realm;
  },
  evalScript: function (sourceText) {
    try {
      return __js2wasm_global_script_eval(sourceText);
    } catch (error) {
      // The standalone compiler recognizes the private host entry above. The
      // ordinary host lane has no such import, so preserve its native-eval
      // fallback without swallowing a ReferenceError thrown by the script.
      if (
        error instanceof ReferenceError &&
        typeof error.message === "string" &&
        error.message.indexOf("__js2wasm_global_script_eval") !== -1
      ) {
        return eval(sourceText);
      }
      throw error;
    }
  },
  gc: function () {},
  detachArrayBuffer: function (buffer) {
    if (typeof structuredClone !== "function") {
      // Standalone/WASI have no host `structuredClone`. Their native
      // ArrayBuffer representation observes this marker as a detached backing
      // store (`tryCompileStandaloneDetachedWrite`), so the literal Test262
      // harness can exercise detached-buffer semantics without a JS host.
      buffer.__detached__ = true;
      return;
    }
    structuredClone(buffer, { transfer: [buffer] });
  },
};
