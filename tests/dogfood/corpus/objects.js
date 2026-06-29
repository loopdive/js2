const o = {
  shorthand,
  computed: 1,
  [dynamicKey]: 2,
  method() { return 1; },
  get prop() { return this._p; },
  set prop(v) { this._p = v; },
  *gen() { yield 1; },
  async asyncMethod() { return await x; },
  ...spread,
  "string key": 3,
  42: "numeric",
};
