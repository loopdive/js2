class Registry {
  static #count = 0;
  static #nextId() {
    Registry.#count += 1;
    return Registry.#count;
  }
  constructor() {
    this.id = Registry.#nextId();
  }
  static get total() {
    return Registry.#count;
  }
}
const items = [new Registry(), new Registry(), new Registry()];
console.log(items.map((i) => i.id).join(","));
console.log(Registry.total);
