# js2wasm Benchmark Results

Date: 2026-08-01
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.055ms | 0.054ms | 0.066ms | FAILED | host-call |
| string/concat-long | 0.005ms | 0.010ms | 0.011ms | FAILED | js |
| string/indexOf | 0.017ms | 0.069ms | 0.023ms | FAILED | js |
| string/includes | 0.016ms | 0.114ms | 0.022ms | FAILED | js |
| string/split | 0.344ms | 5.25ms | 1.51ms | FAILED | js |
| string/replace | 0.044ms | 0.243ms | 0.099ms | FAILED | js |
| string/case-convert | 0.051ms | 0.205ms | 0.107ms | FAILED | js |
| string/substring | 0.113ms | 1.82ms | 0.950ms | FAILED | js |
| string/trim | 0.170ms | 1.27ms | 0.787ms | FAILED | js |
| string/startsWith-endsWith | 0.474ms | 2.11ms | 0.528ms | FAILED | js |
| array/push-pop | 1.46ms | 2.40ms | 2.42ms | FAILED | js |
| array/sort-i32 | 0.651ms | 0.405ms | 0.393ms | FAILED | gc-native |
| array/map-filter | 0.142ms | 0.708ms | 0.703ms | FAILED | js |
| array/reduce | 1.42ms | 2.40ms | 2.40ms | FAILED | js |
| array/indexOf | 5.38ms | 4.61ms | 4.60ms | FAILED | gc-native |
| array/slice | 0.044ms | 0.049ms | 0.051ms | FAILED | js |
| array/reverse | 8.47ms | 3.92ms | 3.91ms | FAILED | gc-native |
| array/forEach | 0.061ms | 0.127ms | 0.127ms | FAILED | js |
| array/find | 0.294ms | 0.572ms | 0.571ms | 4.04ms | js |
| dom/create-elements | 0.077ms | 0.289ms | — | — | js |
| dom/set-attributes | 0.128ms | 0.339ms | — | — | js |
| dom/read-attributes | 0.071ms | 0.176ms | — | — | js |
| dom/modify-text | 0.081ms | 0.156ms | — | — | js |
| mixed/csv-parse | 0.400ms | 6.20ms | 0.868ms | FAILED | js |
| mixed/text-search | 0.440ms | 4.44ms | 1.18ms | FAILED | js |
| mixed/fibonacci | 0.134ms | 0.178ms | 0.178ms | 0.177ms | js |
| mixed/matrix-multiply | 0.189ms | 0.908ms | 0.913ms | 1.69ms | js |
| mixed/sieve | 1.65ms | 1.62ms | 1.62ms | FAILED | gc-native |

## Failed strategies

| Benchmark | Strategy | Phase | Error |
|-----------|----------|-------|-------|
| string/concat-short | linear-memory | warmup | memory access out of bounds |
| string/concat-long | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/indexOf | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/includes | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/split | linear-memory | warmup | memory access out of bounds |
| string/replace | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/case-convert | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/substring | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/trim | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/startsWith-endsWith | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/push-pop | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/sort-i32 | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/map-filter | linear-memory | mid-loop | memory access out of bounds |
| array/reduce | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/indexOf | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/slice | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/reverse | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/forEach | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| mixed/csv-parse | linear-memory | mid-loop | memory access out of bounds |
| mixed/text-search | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| mixed/sieve | linear-memory | mid-loop | memory access out of bounds |

## Cost per operation (ns)

| Benchmark | ops/call | JS | Host-call | GC-native | Linear |
|-----------|----------|-----|-----------|-----------|--------|
| string/concat-short | 10000 | 5.51 | 5.41 | 6.58 | — |
| string/concat-long | 1000 | 5.30 | 9.76 | 10.69 | — |
| string/indexOf | 1000 | 16.63 | 68.85 | 22.73 | — |
| string/includes | 1000 | 16.42 | 113.85 | 22.02 | — |
| string/split | 10000 | 34.42 | 525.01 | 151.18 | — |
| string/replace | 1000 | 43.78 | 243.45 | 99.24 | — |
| string/case-convert | 2000 | 25.43 | 102.47 | 53.47 | — |
| string/substring | 10000 | 11.34 | 181.99 | 94.99 | — |
| string/trim | 10000 | 17.03 | 127.50 | 78.67 | — |
| string/startsWith-endsWith | 20000 | 23.68 | 105.45 | 26.38 | — |
| mixed/csv-parse | 11000 | 36.37 | 563.92 | 78.95 | — |
| mixed/text-search | 40000 | 11.01 | 110.88 | 29.42 | — |
| mixed/fibonacci | 10000 | 13.44 | 17.85 | 17.83 | 17.73 |
| mixed/matrix-multiply | 125000 | 1.51 | 7.27 | 7.31 | 13.54 |
| mixed/sieve | 200000 | 8.23 | 8.11 | 8.09 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.02x faster | 1.19x slower | — |
| string/concat-long | 1.84x slower | 2.02x slower | — |
| string/indexOf | 4.14x slower | 1.37x slower | — |
| string/includes | 6.94x slower | 1.34x slower | — |
| string/split | 15.25x slower | 4.39x slower | — |
| string/replace | 5.56x slower | 2.27x slower | — |
| string/case-convert | 4.03x slower | 2.10x slower | — |
| string/substring | 16.05x slower | 8.38x slower | — |
| string/trim | 7.49x slower | 4.62x slower | — |
| string/startsWith-endsWith | 4.45x slower | 1.11x slower | — |
| array/push-pop | 1.64x slower | 1.65x slower | — |
| array/sort-i32 | 1.61x faster | 1.66x faster | — |
| array/map-filter | 4.99x slower | 4.95x slower | — |
| array/reduce | 1.70x slower | 1.69x slower | — |
| array/indexOf | 1.17x faster | 1.17x faster | — |
| array/slice | 1.13x slower | 1.17x slower | — |
| array/reverse | 2.16x faster | 2.16x faster | — |
| array/forEach | 2.10x slower | 2.09x slower | — |
| array/find | 1.95x slower | 1.94x slower | 13.76x slower |
| dom/create-elements | 3.75x slower | — | — |
| dom/set-attributes | 2.64x slower | — | — |
| dom/read-attributes | 2.49x slower | — | — |
| dom/modify-text | 1.93x slower | — | — |
| mixed/csv-parse | 15.50x slower | 2.17x slower | — |
| mixed/text-search | 10.07x slower | 2.67x slower | — |
| mixed/fibonacci | 1.33x slower | 1.33x slower | 1.32x slower |
| mixed/matrix-multiply | 4.80x slower | 4.83x slower | 8.95x slower |
| mixed/sieve | 1.02x faster | 1.02x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.22x slower |
| string/concat-long | 1.10x slower |
| string/indexOf | 3.03x faster |
| string/includes | 5.17x faster |
| string/split | 3.47x faster |
| string/replace | 2.45x faster |
| string/case-convert | 1.92x faster |
| string/substring | 1.92x faster |
| string/trim | 1.62x faster |
| string/startsWith-endsWith | 4.00x faster |
| array/push-pop | 1.01x slower |
| array/sort-i32 | 1.03x faster |
| array/map-filter | 1.01x faster |
| array/reduce | 1.00x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.03x slower |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x faster |
| array/find | 1.00x faster |
| mixed/csv-parse | 7.14x faster |
| mixed/text-search | 3.77x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.01x slower |
| mixed/sieve | 1.00x faster |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 197B | 1.7KB | — |
| string/concat-long | 233B | 1.9KB | — |
| string/indexOf | 412B | 2.3KB | — |
| string/includes | 398B | 2.3KB | — |
| string/split | 1.7KB | 3.4KB | — |
| string/replace | 1.6KB | 4.0KB | — |
| string/case-convert | 1.4KB | 13.1KB | — |
| string/substring | 556B | 2.0KB | — |
| string/trim | 1.4KB | 2.8KB | — |
| string/startsWith-endsWith | 1.8KB | 3.7KB | — |
| array/push-pop | 956B | 1.2KB | — |
| array/sort-i32 | 2.7KB | 3.0KB | — |
| array/map-filter | 3.3KB | 3.6KB | — |
| array/reduce | 2.3KB | 2.6KB | — |
| array/indexOf | 1.0KB | 1.3KB | — |
| array/slice | 1.0KB | 1.3KB | — |
| array/reverse | 1020B | 1.3KB | — |
| array/forEach | 2.6KB | 2.9KB | — |
| array/find | 2.7KB | 3.0KB | 623B |
| dom/create-elements | 240B | — | — |
| dom/set-attributes | 507B | — | — |
| dom/read-attributes | 357B | — | — |
| dom/modify-text | 247B | — | — |
| mixed/csv-parse | 2.2KB | 4.4KB | — |
| mixed/text-search | 2.0KB | 4.4KB | — |
| mixed/fibonacci | 297B | 1.3KB | 313B |
| mixed/matrix-multiply | 1.6KB | 1.9KB | 950B |
| mixed/sieve | 1.4KB | 1.8KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1158.7ms | 1138.6ms | — |
| string/concat-long | 610.6ms | 987.7ms | — |
| string/indexOf | 750.1ms | 1041.6ms | — |
| string/includes | 711.5ms | 1001.6ms | — |
| string/split | 798.6ms | 1002.4ms | — |
| string/replace | 795.3ms | 1053.6ms | — |
| string/case-convert | 782.7ms | 1130.6ms | — |
| string/substring | 696.0ms | 978.3ms | — |
| string/trim | 767.7ms | 1003.5ms | — |
| string/startsWith-endsWith | 799.9ms | 982.6ms | — |
| array/push-pop | 745.6ms | 803.4ms | — |
| array/sort-i32 | 927.6ms | 975.3ms | — |
| array/map-filter | 902.3ms | 1012.4ms | — |
| array/reduce | 824.9ms | 887.6ms | — |
| array/indexOf | 781.5ms | 786.4ms | — |
| array/slice | 737.0ms | 814.9ms | — |
| array/reverse | 726.5ms | 798.1ms | — |
| array/forEach | 833.8ms | 913.5ms | — |
| array/find | 870.5ms | 922.9ms | 792.9ms |
| dom/create-elements | 616.8ms | — | — |
| dom/set-attributes | 695.8ms | — | — |
| dom/read-attributes | 728.5ms | — | — |
| dom/modify-text | 662.2ms | — | — |
| mixed/csv-parse | 826.9ms | 984.7ms | — |
| mixed/text-search | 792.4ms | 958.0ms | — |
| mixed/fibonacci | 735.9ms | 875.6ms | 769.8ms |
| mixed/matrix-multiply | 855.5ms | 918.4ms | 745.3ms |
| mixed/sieve | 800.5ms | 845.8ms | — |
