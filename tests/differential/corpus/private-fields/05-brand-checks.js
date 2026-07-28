class Box {
  #v;
  constructor(v) {
    this.#v = v;
  }
  static isBox(obj) {
    return #v in obj;
  }
}
const b = new Box(1);
console.log(Box.isBox(b));
console.log(Box.isBox({}));
try {
  Box.isBox(null);
} catch (e) {
  console.log(e instanceof TypeError);
}
