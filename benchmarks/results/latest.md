# js2wasm Benchmark Results

Date: 2026-09-06
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.046ms | 0.050ms | 0.040ms | FAILED | gc-native |
| string/concat-long | 0.004ms | 0.004ms | 0.006ms | FAILED | js |
| string/indexOf | 0.012ms | 0.042ms | 0.009ms | 0.011ms | gc-native |
| string/includes | 0.013ms | 0.067ms | 0.011ms | 0.010ms | linear-memory |
| string/split | 0.281ms | 4.61ms | 2.02ms | FAILED | js |
| string/replace | 0.061ms | 0.399ms | 0.205ms | FAILED | js |
| string/case-convert | 0.040ms | 0.324ms | 0.177ms | FAILED | js |
| string/substring | 0.133ms | 0.028ms | 0.023ms | FAILED | gc-native |
| string/trim | 0.228ms | 2.49ms | 1.71ms | FAILED | js |
| string/startsWith-endsWith | 0.360ms | 1.84ms | 1.87ms | 0.391ms | js |
| array/push-pop | 1.15ms | 0.398ms | 0.386ms | FAILED | gc-native |
| array/sort-i32 | 0.464ms | 0.249ms | 0.253ms | FAILED | host-call |
| array/map-filter | 0.113ms | 0.066ms | 0.065ms | FAILED | gc-native |
| array/reduce | 1.69ms | 0.384ms | 0.384ms | FAILED | gc-native |
| array/indexOf | 3.91ms | 1.88ms | 1.90ms | FAILED | host-call |
| array/slice | 0.042ms | 0.039ms | 0.032ms | FAILED | gc-native |
| array/reverse | 4.99ms | 2.72ms | 2.72ms | FAILED | host-call |
| array/forEach | 0.051ms | 0.021ms | 0.021ms | FAILED | host-call |
| array/find | 0.220ms | 0.015ms | 0.015ms | 0.714ms | gc-native |
| dom/create-elements | 0.060ms | 0.123ms | — | — | js |
| dom/set-attributes | 0.108ms | 0.332ms | — | — | js |
| dom/read-attributes | 0.069ms | 0.090ms | — | — | js |
| dom/modify-text | 0.057ms | 0.087ms | — | — | js |
| mixed/csv-parse | 0.285ms | 4.66ms | 0.426ms | FAILED | js |
| mixed/text-search | 0.305ms | 2.68ms | 1.74ms | 0.820ms | js |
| mixed/fibonacci | 0.099ms | 0.157ms | 0.165ms | 0.213ms | js |
| mixed/matrix-multiply | 0.157ms | 43.78ms | 43.40ms | 0.531ms | js |
| mixed/sieve | 1.57ms | 1.82ms | 1.82ms | FAILED | js |

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
| string/concat-short | 10000 | 4.57 | 5.02 | 4.04 | — |
| string/concat-long | 1000 | 3.93 | 4.49 | 6.16 | — |
| string/indexOf | 1000 | 12.41 | 42.29 | 8.91 | 10.99 |
| string/includes | 1000 | 13.05 | 67.31 | 11.15 | 10.19 |
| string/split | 10000 | 28.13 | 460.84 | 201.54 | — |
| string/replace | 1000 | 60.81 | 399.08 | 205.10 | — |
| string/case-convert | 2000 | 20.16 | 161.90 | 88.65 | — |
| string/substring | 10000 | 13.29 | 2.82 | 2.30 | — |
| string/trim | 10000 | 22.83 | 248.60 | 170.52 | — |
| string/startsWith-endsWith | 20000 | 18.01 | 91.84 | 93.60 | 19.54 |
| array/map-filter | 30000 | 3.76 | 2.19 | 2.18 | — |
| array/indexOf | 1000 | 3906.11 | 1879.73 | 1904.81 | — |
| dom/create-elements | 2000 | 29.98 | 61.48 | — | — |
| dom/set-attributes | 6000 | 18.05 | 55.38 | — | — |
| dom/read-attributes | 3000 | 22.99 | 29.84 | — | — |
| dom/modify-text | 2000 | 28.36 | 43.65 | — | — |
| mixed/csv-parse | 11000 | 25.91 | 423.71 | 38.70 | — |
| mixed/text-search | 40000 | 7.63 | 67.11 | 43.50 | 20.50 |
| mixed/fibonacci | 10000 | 9.87 | 15.65 | 16.54 | 21.28 |
| mixed/matrix-multiply | 125000 | 1.25 | 350.27 | 347.16 | 4.25 |
| mixed/sieve | 200000 | 7.83 | 9.09 | 9.11 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.10x slower | 1.13x faster | — |
| string/concat-long | 1.14x slower | 1.57x slower | — |
| string/indexOf | 3.41x slower | 1.39x faster | 1.13x faster |
| string/includes | 5.16x slower | 1.17x faster | 1.28x faster |
| string/split | 16.38x slower | 7.17x slower | — |
| string/replace | 6.56x slower | 3.37x slower | — |
| string/case-convert | 8.03x slower | 4.40x slower | — |
| string/substring | 4.71x faster | 5.77x faster | — |
| string/trim | 10.89x slower | 7.47x slower | — |
| string/startsWith-endsWith | 5.10x slower | 5.20x slower | 1.09x slower |
| array/push-pop | 2.89x faster | 2.98x faster | — |
| array/sort-i32 | 1.87x faster | 1.84x faster | — |
| array/map-filter | 1.71x faster | 1.72x faster | — |
| array/reduce | 4.39x faster | 4.40x faster | — |
| array/indexOf | 2.08x faster | 2.05x faster | — |
| array/slice | 1.06x faster | 1.30x faster | — |
| array/reverse | 1.83x faster | 1.83x faster | — |
| array/forEach | 2.44x faster | 2.43x faster | — |
| array/find | 14.74x faster | 14.79x faster | 3.25x slower |
| dom/create-elements | 2.05x slower | — | — |
| dom/set-attributes | 3.07x slower | — | — |
| dom/read-attributes | 1.30x slower | — | — |
| dom/modify-text | 1.54x slower | — | — |
| mixed/csv-parse | 16.35x slower | 1.49x slower | — |
| mixed/text-search | 8.79x slower | 5.70x slower | 2.69x slower |
| mixed/fibonacci | 1.59x slower | 1.68x slower | 2.16x slower |
| mixed/matrix-multiply | 279.41x slower | 276.93x slower | 3.39x slower |
| mixed/sieve | 1.16x slower | 1.16x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.24x faster |
| string/concat-long | 1.37x slower |
| string/indexOf | 4.75x faster |
| string/includes | 6.04x faster |
| string/split | 2.29x faster |
| string/replace | 1.95x faster |
| string/case-convert | 1.83x faster |
| string/substring | 1.22x faster |
| string/trim | 1.46x faster |
| string/startsWith-endsWith | 1.02x slower |
| array/push-pop | 1.03x faster |
| array/sort-i32 | 1.02x slower |
| array/map-filter | 1.01x faster |
| array/reduce | 1.00x faster |
| array/indexOf | 1.01x slower |
| array/slice | 1.23x faster |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x slower |
| array/find | 1.00x faster |
| mixed/csv-parse | 10.95x faster |
| mixed/text-search | 1.54x faster |
| mixed/fibonacci | 1.06x slower |
| mixed/matrix-multiply | 1.01x faster |
| mixed/sieve | 1.00x slower |

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
| string/concat-short | 1175.1ms | 753.8ms | — |
| string/concat-long | 559.6ms | 729.7ms | — |
| string/indexOf | 514.3ms | 695.7ms | 652.2ms |
| string/includes | 505.4ms | 688.5ms | 634.0ms |
| string/split | 553.6ms | 735.4ms | — |
| string/replace | 566.0ms | 752.0ms | — |
| string/case-convert | 560.0ms | 644.3ms | — |
| string/substring | 527.6ms | 583.7ms | — |
| string/trim | 543.4ms | 719.2ms | — |
| string/startsWith-endsWith | 583.7ms | 696.4ms | 639.7ms |
| array/push-pop | 561.9ms | 645.1ms | — |
| array/sort-i32 | 697.4ms | 705.8ms | — |
| array/map-filter | 683.2ms | 736.8ms | — |
| array/reduce | 610.5ms | 679.9ms | — |
| array/indexOf | 606.4ms | 718.1ms | — |
| array/slice | 573.9ms | 603.2ms | — |
| array/reverse | 547.4ms | 612.8ms | — |
| array/forEach | 635.1ms | 698.5ms | — |
| array/find | 552.3ms | 625.7ms | 621.1ms |
| dom/create-elements | 511.6ms | — | — |
| dom/set-attributes | 535.3ms | — | — |
| dom/read-attributes | 558.6ms | — | — |
| dom/modify-text | 510.7ms | — | — |
| mixed/csv-parse | 593.1ms | 689.4ms | — |
| mixed/text-search | 551.7ms | 693.7ms | 635.8ms |
| mixed/fibonacci | 542.2ms | 619.2ms | 577.0ms |
| mixed/matrix-multiply | 673.2ms | 746.2ms | 565.9ms |
| mixed/sieve | 632.9ms | 684.3ms | — |
