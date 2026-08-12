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
    return $262;
  },
  evalScript: function (sourceText) {
    return eval(sourceText);
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
