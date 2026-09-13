class Box {
  constructor(public value: number) {}
  read(): number {
    const get = () => this.value;
    return get();
  }
}
export function calculate(x: number): number {
  return new Box(x + 7).read();
}
