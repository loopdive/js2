# js2wasm Benchmark Results

Date: 2026-09-13
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.050ms | 0.055ms | 0.066ms | FAILED | js |
| string/concat-long | 0.006ms | 0.005ms | 0.007ms | FAILED | host-call |
| string/indexOf | 0.015ms | 0.050ms | 0.010ms | 0.020ms | gc-native |
| string/includes | 0.015ms | 0.103ms | 0.013ms | 0.035ms | gc-native |
| string/split | 0.300ms | 6.17ms | 2.32ms | FAILED | js |
| string/replace | 0.096ms | 0.500ms | 0.274ms | FAILED | js |
| string/case-convert | 0.049ms | 0.448ms | 0.226ms | FAILED | js |
| string/substring | 0.112ms | 0.035ms | 0.030ms | FAILED | gc-native |
| string/trim | 0.155ms | 2.96ms | 2.14ms | FAILED | js |
| string/startsWith-endsWith | 0.429ms | 2.48ms | 2.51ms | 0.530ms | js |
| array/push-pop | 1.37ms | 0.452ms | 0.453ms | FAILED | host-call |
| array/sort-i32 | 0.601ms | 0.308ms | 0.318ms | FAILED | host-call |
| array/map-filter | 0.135ms | 0.078ms | 0.074ms | FAILED | gc-native |
| array/reduce | 1.31ms | 0.456ms | 0.454ms | FAILED | gc-native |
| array/indexOf | 4.78ms | 2.35ms | 2.33ms | FAILED | gc-native |
| array/slice | 0.042ms | 0.039ms | 0.042ms | FAILED | host-call |
| array/reverse | 7.92ms | 3.47ms | 3.35ms | FAILED | gc-native |
| array/forEach | 0.087ms | 0.024ms | 0.024ms | FAILED | host-call |
| array/find | 0.271ms | 0.016ms | 0.016ms | 0.933ms | host-call |
| dom/create-elements | 0.064ms | 0.091ms | — | — | js |
| dom/set-attributes | 0.122ms | 0.475ms | — | — | js |
| dom/read-attributes | 0.071ms | 0.112ms | — | — | js |
| dom/modify-text | 0.055ms | 0.109ms | — | — | js |
| mixed/csv-parse | 0.446ms | 6.07ms | 0.500ms | FAILED | js |
| mixed/text-search | 0.399ms | 3.52ms | 2.33ms | 1.08ms | js |
| mixed/fibonacci | 0.124ms | 0.203ms | 0.203ms | 0.202ms | js |
| mixed/matrix-multiply | 0.179ms | 56.96ms | 57.90ms | 0.679ms | js |
| mixed/sieve | 1.55ms | 2.24ms | 2.31ms | FAILED | js |

## Failed strategies

| Benchmark | Strategy | Phase | Error |
|-----------|----------|-------|-------|
| string/concat-short | linear-memory | warmup | memory access out of bounds |
| string/concat-long | linear-memory | warmup | memory access out of bounds |
| string/split | linear-memory | mid-loop | memory access out of bounds |
| string/replace | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/case-convert | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/substring | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/trim | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/push-pop | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/sort-i32 | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/map-filter | linear-memory | mid-loop | memory access out of bounds |
| array/reduce | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/indexOf | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/slice | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/reverse | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/forEach | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| mixed/csv-parse | linear-memory | mid-loop | memory access out of bounds |
| mixed/sieve | linear-memory | mid-loop | memory access out of bounds |

## Cost per operation (ns)

| Benchmark | ops/call | JS | Host-call | GC-native | Linear |
|-----------|----------|-----|-----------|-----------|--------|
| string/concat-short | 10000 | 5.01 | 5.53 | 6.59 | — |
| string/concat-long | 1000 | 5.83 | 5.42 | 6.56 | — |
| string/indexOf | 1000 | 14.78 | 49.71 | 10.22 | 19.56 |
| string/includes | 1000 | 15.33 | 103.33 | 12.76 | 34.80 |
| string/split | 10000 | 30.03 | 617.39 | 232.37 | — |
| string/replace | 1000 | 96.04 | 500.36 | 273.83 | — |
| string/case-convert | 2000 | 24.60 | 224.12 | 112.92 | — |
| string/substring | 10000 | 11.16 | 3.47 | 2.96 | — |
| string/trim | 10000 | 15.54 | 296.10 | 214.32 | — |
| string/startsWith-endsWith | 20000 | 21.43 | 124.10 | 125.50 | 26.48 |
| array/map-filter | 30000 | 4.49 | 2.60 | 2.47 | — |
| array/indexOf | 1000 | 4779.99 | 2351.34 | 2333.45 | — |
| dom/create-elements | 2000 | 32.15 | 45.29 | — | — |
| dom/set-attributes | 6000 | 20.31 | 79.24 | — | — |
| dom/read-attributes | 3000 | 23.53 | 37.40 | — | — |
| dom/modify-text | 2000 | 27.38 | 54.71 | — | — |
| mixed/csv-parse | 11000 | 40.57 | 552.21 | 45.47 | — |
| mixed/text-search | 40000 | 9.97 | 87.88 | 58.27 | 27.07 |
| mixed/fibonacci | 10000 | 12.36 | 20.35 | 20.31 | 20.21 |
| mixed/matrix-multiply | 125000 | 1.43 | 455.68 | 463.17 | 5.43 |
| mixed/sieve | 200000 | 7.77 | 11.19 | 11.53 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.10x slower | 1.32x slower | — |
| string/concat-long | 1.07x faster | 1.13x slower | — |
| string/indexOf | 3.36x slower | 1.45x faster | 1.32x slower |
| string/includes | 6.74x slower | 1.20x faster | 2.27x slower |
| string/split | 20.56x slower | 7.74x slower | — |
| string/replace | 5.21x slower | 2.85x slower | — |
| string/case-convert | 9.11x slower | 4.59x slower | — |
| string/substring | 3.21x faster | 3.77x faster | — |
| string/trim | 19.05x slower | 13.79x slower | — |
| string/startsWith-endsWith | 5.79x slower | 5.86x slower | 1.24x slower |
| array/push-pop | 3.04x faster | 3.03x faster | — |
| array/sort-i32 | 1.95x faster | 1.89x faster | — |
| array/map-filter | 1.73x faster | 1.82x faster | — |
| array/reduce | 2.87x faster | 2.89x faster | — |
| array/indexOf | 2.03x faster | 2.05x faster | — |
| array/slice | 1.06x faster | 1.02x slower | — |
| array/reverse | 2.28x faster | 2.36x faster | — |
| array/forEach | 3.66x faster | 3.62x faster | — |
| array/find | 16.71x faster | 16.47x faster | 3.45x slower |
| dom/create-elements | 1.41x slower | — | — |
| dom/set-attributes | 3.90x slower | — | — |
| dom/read-attributes | 1.59x slower | — | — |
| dom/modify-text | 2.00x slower | — | — |
| mixed/csv-parse | 13.61x slower | 1.12x slower | — |
| mixed/text-search | 8.81x slower | 5.84x slower | 2.71x slower |
| mixed/fibonacci | 1.65x slower | 1.64x slower | 1.64x slower |
| mixed/matrix-multiply | 317.74x slower | 322.96x slower | 3.79x slower |
| mixed/sieve | 1.44x slower | 1.48x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.19x slower |
| string/concat-long | 1.21x slower |
| string/indexOf | 4.86x faster |
| string/includes | 8.10x faster |
| string/split | 2.66x faster |
| string/replace | 1.83x faster |
| string/case-convert | 1.98x faster |
| string/substring | 1.17x faster |
| string/trim | 1.38x faster |
| string/startsWith-endsWith | 1.01x slower |
| array/push-pop | 1.00x slower |
| array/sort-i32 | 1.03x slower |
| array/map-filter | 1.05x faster |
| array/reduce | 1.01x faster |
| array/indexOf | 1.01x faster |
| array/slice | 1.08x slower |
| array/reverse | 1.04x faster |
| array/forEach | 1.01x slower |
| array/find | 1.01x slower |
| mixed/csv-parse | 12.15x faster |
| mixed/text-search | 1.51x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.02x slower |
| mixed/sieve | 1.03x slower |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 209B | 745B | — |
| string/concat-long | 223B | 932B | — |
| string/indexOf | 254B | 1.1KB | 10.4KB |
| string/includes | 241B | 1.1KB | 10.4KB |
| string/split | 1.6KB | 3.1KB | — |
| string/replace | 1.6KB | 4.1KB | — |
| string/case-convert | 1.5KB | 2.2KB | — |
| string/substring | 202B | 279B | — |
| string/trim | 1.2KB | 2.7KB | — |
| string/startsWith-endsWith | 1.7KB | 3.6KB | 1.7KB |
| array/push-pop | 940B | 1.3KB | — |
| array/sort-i32 | 2.8KB | 3.3KB | — |
| array/map-filter | 3.6KB | 4.1KB | — |
| array/reduce | 2.5KB | 3.0KB | — |
| array/indexOf | 1.8KB | 2.1KB | — |
| array/slice | 999B | 1.3KB | — |
| array/reverse | 977B | 1.3KB | — |
| array/forEach | 2.8KB | 3.4KB | — |
| array/find | 946B | 1.3KB | 634B |
| dom/create-elements | 271B | — | — |
| dom/set-attributes | 524B | — | — |
| dom/read-attributes | 389B | — | — |
| dom/modify-text | 264B | — | — |
| mixed/csv-parse | 2.2KB | 4.2KB | — |
| mixed/text-search | 1.9KB | 4.0KB | 1.9KB |
| mixed/fibonacci | 438B | 438B | 411B |
| mixed/matrix-multiply | 2.6KB | 3.2KB | 991B |
| mixed/sieve | 1.7KB | 2.0KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 990.1ms | 569.6ms | — |
| string/concat-long | 398.7ms | 618.9ms | — |
| string/indexOf | 355.2ms | 617.7ms | 494.7ms |
| string/includes | 356.7ms | 614.2ms | 499.9ms |
| string/split | 468.0ms | 636.5ms | — |
| string/replace | 467.4ms | 682.1ms | — |
| string/case-convert | 472.3ms | 534.8ms | — |
| string/substring | 365.5ms | 456.4ms | — |
| string/trim | 431.6ms | 682.0ms | — |
| string/startsWith-endsWith | 460.9ms | 640.6ms | 587.1ms |
| array/push-pop | 470.7ms | 507.9ms | — |
| array/sort-i32 | 634.7ms | 663.8ms | — |
| array/map-filter | 627.5ms | 654.5ms | — |
| array/reduce | 554.4ms | 648.9ms | — |
| array/indexOf | 505.7ms | 611.4ms | — |
| array/slice | 470.3ms | 570.2ms | — |
| array/reverse | 454.6ms | 516.8ms | — |
| array/forEach | 604.6ms | 646.2ms | — |
| array/find | 441.5ms | 528.0ms | 502.9ms |
| dom/create-elements | 377.4ms | — | — |
| dom/set-attributes | 362.8ms | — | — |
| dom/read-attributes | 366.5ms | — | — |
| dom/modify-text | 359.2ms | — | — |
| mixed/csv-parse | 467.2ms | 628.3ms | — |
| mixed/text-search | 453.1ms | 622.2ms | 589.6ms |
| mixed/fibonacci | 431.5ms | 478.3ms | 443.4ms |
| mixed/matrix-multiply | 613.3ms | 621.3ms | 488.4ms |
| mixed/sieve | 553.2ms | 591.5ms | — |
