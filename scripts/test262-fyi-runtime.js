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
      Date: globalThis.Date,
      Function: globalThis.Function,
      Iterator: globalThis.Iterator,
      Math: globalThis.Math,
      // NO `Object: globalThis.Object` forward — measured 2026-08-23 (PR
      // #4794 merge_group park): ANY compiled read of `globalThis.Object` /
      // `globalThis["Object"]` in this prelude (which compiles into EVERY
      // test) changes how js-host dynamic `import()` rejections construct
      // their error — `error.constructor` degrades TypeError → Error,
      // regressing test/language/expressions/dynamic-import/
      // assignment-expression/import-meta.js from pass. Isolated by shim
      // bisection: dropping ONLY this entry restores the pass; every other
      // forward is inert. Re-add only together with a compiler-side fix and
      // that test in the validation list.
      Proxy: globalThis.Proxy,
      Symbol: globalThis.Symbol,
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
