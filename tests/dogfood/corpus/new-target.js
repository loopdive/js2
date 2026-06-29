function Ctor() {
  if (!new.target) throw new Error("must use new");
  this.created = true;
}
const inst = new Ctor();
const obj = new Foo(1, 2);
const noArgs = new Bar;
const computed = new namespace.Class();
