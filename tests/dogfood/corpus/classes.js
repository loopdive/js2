class Animal {
  static species = "generic";
  #secret = 42;
  legs;
  constructor(name) { this.name = name; }
  get label() { return this.name; }
  set label(v) { this.name = v; }
  #privateMethod() { return this.#secret; }
  static make(n) { return new Animal(n); }
}
class Dog extends Animal {
  constructor(name) { super(name); this.legs = 4; }
  speak() { return super.label + " barks"; }
}
