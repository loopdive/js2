class Temperature {
  #celsius;
  constructor(celsius) {
    this.#celsius = celsius;
  }
  get fahrenheit() {
    return this.#celsius * 1.8 + 32;
  }
  set fahrenheit(f) {
    this.#celsius = (f - 32) / 1.8;
  }
  get celsius() {
    return this.#celsius;
  }
}
const t = new Temperature(0);
console.log(t.fahrenheit);
t.fahrenheit = 212;
console.log(t.celsius);
