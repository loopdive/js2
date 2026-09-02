# js2wasm Benchmark Results

Date: 2026-09-02
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.043ms | 0.041ms | 0.044ms | FAILED | host-call |
| string/concat-long | 0.004ms | 0.005ms | 0.007ms | FAILED | js |
| string/indexOf | 0.012ms | 0.037ms | 0.009ms | 0.013ms | gc-native |
| string/includes | 0.012ms | 0.066ms | 0.011ms | 0.010ms | linear-memory |
| string/split | 0.269ms | 5.25ms | 1.70ms | FAILED | js |
| string/replace | 0.063ms | 0.367ms | 0.210ms | FAILED | js |
| string/case-convert | 0.043ms | 0.331ms | 0.160ms | FAILED | js |
| string/substring | 0.130ms | 0.030ms | 0.024ms | FAILED | gc-native |
| string/trim | 0.237ms | 2.23ms | 1.68ms | FAILED | js |
| string/startsWith-endsWith | 0.368ms | 1.83ms | 2.02ms | 0.407ms | js |
| array/push-pop | 1.20ms | 0.406ms | 0.425ms | FAILED | host-call |
| array/sort-i32 | 0.496ms | 0.252ms | 0.253ms | FAILED | host-call |
| array/map-filter | 0.115ms | 0.073ms | 0.070ms | FAILED | gc-native |
| array/reduce | 1.74ms | 0.400ms | 0.397ms | FAILED | gc-native |
| array/indexOf | 4.01ms | 1.92ms | 1.88ms | FAILED | gc-native |
| array/slice | 0.043ms | 0.044ms | 0.043ms | FAILED | js |
| array/reverse | 5.11ms | 2.90ms | 2.79ms | FAILED | gc-native |
| array/forEach | 0.053ms | 0.021ms | 0.023ms | FAILED | host-call |
| array/find | 0.253ms | 0.015ms | 0.015ms | 0.727ms | host-call |
| dom/create-elements | 0.064ms | 0.126ms | — | — | js |
| dom/set-attributes | 0.110ms | 0.347ms | — | — | js |
| dom/read-attributes | 0.071ms | 0.092ms | — | — | js |
| dom/modify-text | 0.059ms | 0.090ms | — | — | js |
| mixed/csv-parse | 0.308ms | 4.79ms | 0.403ms | FAILED | js |
| mixed/text-search | 0.303ms | 2.83ms | 1.81ms | 0.827ms | js |
| mixed/fibonacci | 0.101ms | 0.160ms | 0.160ms | 0.160ms | js |
| mixed/matrix-multiply | 0.147ms | 43.81ms | 48.65ms | 0.598ms | js |
| mixed/sieve | 1.48ms | 2.04ms | 2.00ms | FAILED | js |

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
| string/concat-short | 10000 | 4.34 | 4.08 | 4.38 | — |
| string/concat-long | 1000 | 3.61 | 4.50 | 6.51 | — |
| string/indexOf | 1000 | 12.10 | 37.49 | 8.97 | 13.43 |
| string/includes | 1000 | 12.09 | 66.36 | 11.01 | 10.24 |
| string/split | 10000 | 26.90 | 525.11 | 170.14 | — |
| string/replace | 1000 | 62.73 | 366.56 | 209.79 | — |
| string/case-convert | 2000 | 21.29 | 165.33 | 80.18 | — |
| string/substring | 10000 | 13.02 | 3.03 | 2.36 | — |
| string/trim | 10000 | 23.65 | 223.36 | 167.88 | — |
| string/startsWith-endsWith | 20000 | 18.41 | 91.66 | 101.24 | 20.33 |
| array/map-filter | 30000 | 3.83 | 2.43 | 2.34 | — |
| array/indexOf | 1000 | 4007.70 | 1924.44 | 1883.53 | — |
| dom/create-elements | 2000 | 32.24 | 62.99 | — | — |
| dom/set-attributes | 6000 | 18.37 | 57.87 | — | — |
| dom/read-attributes | 3000 | 23.58 | 30.56 | — | — |
| dom/modify-text | 2000 | 29.60 | 45.24 | — | — |
| mixed/csv-parse | 11000 | 28.03 | 435.23 | 36.66 | — |
| mixed/text-search | 40000 | 7.58 | 70.87 | 45.29 | 20.68 |
| mixed/fibonacci | 10000 | 10.07 | 16.01 | 16.00 | 15.96 |
| mixed/matrix-multiply | 125000 | 1.17 | 350.45 | 389.17 | 4.78 |
| mixed/sieve | 200000 | 7.39 | 10.22 | 9.98 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.06x faster | 1.01x slower | — |
| string/concat-long | 1.25x slower | 1.80x slower | — |
| string/indexOf | 3.10x slower | 1.35x faster | 1.11x slower |
| string/includes | 5.49x slower | 1.10x faster | 1.18x faster |
| string/split | 19.52x slower | 6.33x slower | — |
| string/replace | 5.84x slower | 3.34x slower | — |
| string/case-convert | 7.77x slower | 3.77x slower | — |
| string/substring | 4.29x faster | 5.51x faster | — |
| string/trim | 9.44x slower | 7.10x slower | — |
| string/startsWith-endsWith | 4.98x slower | 5.50x slower | 1.10x slower |
| array/push-pop | 2.95x faster | 2.83x faster | — |
| array/sort-i32 | 1.96x faster | 1.96x faster | — |
| array/map-filter | 1.58x faster | 1.64x faster | — |
| array/reduce | 4.35x faster | 4.38x faster | — |
| array/indexOf | 2.08x faster | 2.13x faster | — |
| array/slice | 1.04x slower | 1.01x slower | — |
| array/reverse | 1.76x faster | 1.83x faster | — |
| array/forEach | 2.51x faster | 2.35x faster | — |
| array/find | 16.73x faster | 16.68x faster | 2.87x slower |
| dom/create-elements | 1.95x slower | — | — |
| dom/set-attributes | 3.15x slower | — | — |
| dom/read-attributes | 1.30x slower | — | — |
| dom/modify-text | 1.53x slower | — | — |
| mixed/csv-parse | 15.52x slower | 1.31x slower | — |
| mixed/text-search | 9.35x slower | 5.98x slower | 2.73x slower |
| mixed/fibonacci | 1.59x slower | 1.59x slower | 1.59x slower |
| mixed/matrix-multiply | 298.54x slower | 331.52x slower | 4.07x slower |
| mixed/sieve | 1.38x slower | 1.35x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.07x slower |
| string/concat-long | 1.45x slower |
| string/indexOf | 4.18x faster |
| string/includes | 6.03x faster |
| string/split | 3.09x faster |
| string/replace | 1.75x faster |
| string/case-convert | 2.06x faster |
| string/substring | 1.28x faster |
| string/trim | 1.33x faster |
| string/startsWith-endsWith | 1.10x slower |
| array/push-pop | 1.05x slower |
| array/sort-i32 | 1.00x slower |
| array/map-filter | 1.04x faster |
| array/reduce | 1.01x faster |
| array/indexOf | 1.02x faster |
| array/slice | 1.03x faster |
| array/reverse | 1.04x faster |
| array/forEach | 1.07x slower |
| array/find | 1.00x slower |
| mixed/csv-parse | 11.87x faster |
| mixed/text-search | 1.56x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.11x slower |
| mixed/sieve | 1.02x faster |

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
| array/slice | 1020B | 1.3KB | — |
| array/reverse | 998B | 1.3KB | — |
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
| string/concat-short | 1246.8ms | 799.4ms | — |
| string/concat-long | 598.5ms | 763.4ms | — |
| string/indexOf | 518.2ms | 748.6ms | 642.3ms |
| string/includes | 523.2ms | 730.8ms | 632.0ms |
| string/split | 584.8ms | 778.2ms | — |
| string/replace | 592.2ms | 802.1ms | — |
| string/case-convert | 621.8ms | 649.5ms | — |
| string/substring | 528.2ms | 630.9ms | — |
| string/trim | 586.0ms | 721.6ms | — |
| string/startsWith-endsWith | 583.7ms | 730.7ms | 740.2ms |
| array/push-pop | 618.9ms | 696.5ms | — |
| array/sort-i32 | 724.7ms | 739.3ms | — |
| array/map-filter | 695.3ms | 804.0ms | — |
| array/reduce | 648.0ms | 694.3ms | — |
| array/indexOf | 641.9ms | 714.2ms | — |
| array/slice | 599.8ms | 660.9ms | — |
| array/reverse | 596.5ms | 669.1ms | — |
| array/forEach | 652.9ms | 720.1ms | — |
| array/find | 584.6ms | 729.5ms | 619.5ms |
| dom/create-elements | 547.2ms | — | — |
| dom/set-attributes | 533.2ms | — | — |
| dom/read-attributes | 546.0ms | — | — |
| dom/modify-text | 514.5ms | — | — |
| mixed/csv-parse | 612.0ms | 699.4ms | — |
| mixed/text-search | 566.2ms | 718.5ms | 658.3ms |
| mixed/fibonacci | 540.5ms | 608.2ms | 569.6ms |
| mixed/matrix-multiply | 662.4ms | 764.0ms | 641.9ms |
| mixed/sieve | 681.9ms | 729.9ms | — |
