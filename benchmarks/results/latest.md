# js2wasm Benchmark Results

Date: 2026-08-17
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.030ms | 0.045ms | 0.035ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.004ms | FAILED | gc-native |
| string/indexOf | 0.019ms | 0.063ms | 0.012ms | 0.016ms | gc-native |
| string/includes | 0.019ms | 0.132ms | 0.014ms | 0.015ms | gc-native |
| string/split | 0.428ms | 5.08ms | 0.449ms | FAILED | js |
| string/replace | 0.106ms | 0.314ms | 0.056ms | FAILED | gc-native |
| string/case-convert | 0.064ms | 0.240ms | 0.005ms | FAILED | gc-native |
| string/substring | 0.098ms | 0.037ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.170ms | 0.890ms | 0.186ms | FAILED | js |
| string/startsWith-endsWith | 0.404ms | 0.357ms | 0.295ms | 0.562ms | gc-native |
| array/push-pop | 1.39ms | 0.501ms | 0.500ms | FAILED | gc-native |
| array/sort-i32 | 0.787ms | 0.292ms | 0.298ms | FAILED | host-call |
| array/map-filter | 0.075ms | 0.069ms | 0.070ms | FAILED | host-call |
| array/reduce | 2.13ms | 0.507ms | 0.497ms | FAILED | gc-native |
| array/indexOf | 3.95ms | 2.63ms | 2.64ms | FAILED | host-call |
| array/slice | 0.024ms | 0.027ms | 0.027ms | FAILED | js |
| array/reverse | 7.84ms | 3.52ms | 3.52ms | FAILED | gc-native |
| array/forEach | 0.048ms | 0.028ms | 0.027ms | FAILED | gc-native |
| array/find | 0.253ms | 0.016ms | 0.015ms | 1.07ms | gc-native |
| dom/create-elements | 0.034ms | 0.159ms | — | — | js |
| dom/set-attributes | 0.102ms | 0.499ms | — | — | js |
| dom/read-attributes | 0.055ms | 0.122ms | — | — | js |
| dom/modify-text | 0.029ms | 0.105ms | — | — | js |
| mixed/csv-parse | 0.482ms | 7.30ms | 0.315ms | FAILED | gc-native |
| mixed/text-search | 0.481ms | 1.60ms | 0.265ms | 1.11ms | gc-native |
| mixed/fibonacci | 0.123ms | 0.292ms | 0.292ms | 0.290ms | js |
| mixed/matrix-multiply | 0.156ms | 0.209ms | 0.209ms | 0.716ms | js |
| mixed/sieve | 1.53ms | 1.38ms | 1.40ms | FAILED | host-call |

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
| string/concat-short | 10000 | 3.05 | 4.47 | 3.46 | — |
| string/concat-long | 1000 | 3.59 | 4.51 | 3.54 | — |
| string/indexOf | 1000 | 19.10 | 63.10 | 12.03 | 15.99 |
| string/includes | 1000 | 19.13 | 131.63 | 14.48 | 15.40 |
| string/split | 10000 | 42.75 | 508.14 | 44.94 | — |
| string/replace | 1000 | 106.47 | 314.20 | 56.38 | — |
| string/case-convert | 2000 | 32.11 | 120.14 | 2.51 | — |
| string/substring | 10000 | 9.83 | 3.74 | 3.07 | — |
| string/trim | 10000 | 17.00 | 88.99 | 18.63 | — |
| string/startsWith-endsWith | 20000 | 20.18 | 17.85 | 14.76 | 28.09 |
| array/map-filter | 30000 | 2.49 | 2.31 | 2.32 | — |
| array/indexOf | 1000 | 3953.19 | 2633.09 | 2637.33 | — |
| dom/create-elements | 2000 | 17.20 | 79.60 | — | — |
| dom/set-attributes | 6000 | 16.98 | 83.20 | — | — |
| dom/read-attributes | 3000 | 18.45 | 40.55 | — | — |
| dom/modify-text | 2000 | 14.26 | 52.63 | — | — |
| mixed/csv-parse | 11000 | 43.80 | 664.04 | 28.66 | — |
| mixed/text-search | 40000 | 12.03 | 39.95 | 6.63 | 27.63 |
| mixed/fibonacci | 10000 | 12.26 | 29.23 | 29.19 | 29.04 |
| mixed/matrix-multiply | 125000 | 1.25 | 1.67 | 1.67 | 5.73 |
| mixed/sieve | 200000 | 7.67 | 6.92 | 7.00 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.47x slower | 1.14x slower | — |
| string/concat-long | 1.26x slower | 1.01x faster | — |
| string/indexOf | 3.30x slower | 1.59x faster | 1.20x faster |
| string/includes | 6.88x slower | 1.32x faster | 1.24x faster |
| string/split | 11.89x slower | 1.05x slower | — |
| string/replace | 2.95x slower | 1.89x faster | — |
| string/case-convert | 3.74x slower | 12.81x faster | — |
| string/substring | 2.63x faster | 3.20x faster | — |
| string/trim | 5.24x slower | 1.10x slower | — |
| string/startsWith-endsWith | 1.13x faster | 1.37x faster | 1.39x slower |
| array/push-pop | 2.77x faster | 2.78x faster | — |
| array/sort-i32 | 2.70x faster | 2.64x faster | — |
| array/map-filter | 1.08x faster | 1.07x faster | — |
| array/reduce | 4.20x faster | 4.28x faster | — |
| array/indexOf | 1.50x faster | 1.50x faster | — |
| array/slice | 1.11x slower | 1.11x slower | — |
| array/reverse | 2.22x faster | 2.23x faster | — |
| array/forEach | 1.74x faster | 1.75x faster | — |
| array/find | 16.09x faster | 16.40x faster | 4.23x slower |
| dom/create-elements | 4.63x slower | — | — |
| dom/set-attributes | 4.90x slower | — | — |
| dom/read-attributes | 2.20x slower | — | — |
| dom/modify-text | 3.69x slower | — | — |
| mixed/csv-parse | 15.16x slower | 1.53x faster | — |
| mixed/text-search | 3.32x slower | 1.82x faster | 2.30x slower |
| mixed/fibonacci | 2.38x slower | 2.38x slower | 2.37x slower |
| mixed/matrix-multiply | 1.34x slower | 1.34x slower | 4.60x slower |
| mixed/sieve | 1.11x faster | 1.10x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.29x faster |
| string/concat-long | 1.27x faster |
| string/indexOf | 5.25x faster |
| string/includes | 9.09x faster |
| string/split | 11.31x faster |
| string/replace | 5.57x faster |
| string/case-convert | 47.93x faster |
| string/substring | 1.22x faster |
| string/trim | 4.78x faster |
| string/startsWith-endsWith | 1.21x faster |
| array/push-pop | 1.00x faster |
| array/sort-i32 | 1.02x slower |
| array/map-filter | 1.01x slower |
| array/reduce | 1.02x faster |
| array/indexOf | 1.00x slower |
| array/slice | 1.01x faster |
| array/reverse | 1.00x faster |
| array/forEach | 1.01x faster |
| array/find | 1.02x faster |
| mixed/csv-parse | 23.17x faster |
| mixed/text-search | 6.03x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.00x slower |
| mixed/sieve | 1.01x slower |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 197B | 731B | — |
| string/concat-long | 223B | 935B | — |
| string/indexOf | 254B | 1.1KB | 10.4KB |
| string/includes | 241B | 1.1KB | 10.4KB |
| string/split | 1.6KB | 3.1KB | — |
| string/replace | 1.6KB | 4.0KB | — |
| string/case-convert | 1.5KB | 2.2KB | — |
| string/substring | 202B | 279B | — |
| string/trim | 1.3KB | 2.7KB | — |
| string/startsWith-endsWith | 1.7KB | 3.6KB | 1.7KB |
| array/push-pop | 940B | 1.3KB | — |
| array/sort-i32 | 2.6KB | 2.9KB | — |
| array/map-filter | 3.3KB | 3.7KB | — |
| array/reduce | 2.3KB | 2.6KB | — |
| array/indexOf | 1.7KB | 2.0KB | — |
| array/slice | 1020B | 1.3KB | — |
| array/reverse | 998B | 1.3KB | — |
| array/forEach | 2.5KB | 2.9KB | — |
| array/find | 946B | 1.3KB | 635B |
| dom/create-elements | 271B | — | — |
| dom/set-attributes | 524B | — | — |
| dom/read-attributes | 389B | — | — |
| dom/modify-text | 264B | — | — |
| mixed/csv-parse | 2.3KB | 4.2KB | — |
| mixed/text-search | 1.9KB | 4.0KB | 1.9KB |
| mixed/fibonacci | 411B | 411B | 386B |
| mixed/matrix-multiply | 1.6KB | 2.0KB | 992B |
| mixed/sieve | 1.6KB | 2.0KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1306.1ms | 1077.5ms | — |
| string/concat-long | 676.1ms | 948.3ms | — |
| string/indexOf | 649.2ms | 997.9ms | 847.6ms |
| string/includes | 652.0ms | 931.0ms | 874.8ms |
| string/split | 771.4ms | 966.3ms | — |
| string/replace | 785.9ms | 1013.9ms | — |
| string/case-convert | 819.2ms | 864.4ms | — |
| string/substring | 628.1ms | 715.5ms | — |
| string/trim | 715.8ms | 945.7ms | — |
| string/startsWith-endsWith | 737.0ms | 964.9ms | 869.5ms |
| array/push-pop | 751.2ms | 800.3ms | — |
| array/sort-i32 | 875.5ms | 940.9ms | — |
| array/map-filter | 929.6ms | 988.3ms | — |
| array/reduce | 806.0ms | 889.8ms | — |
| array/indexOf | 836.4ms | 889.1ms | — |
| array/slice | 745.0ms | 843.2ms | — |
| array/reverse | 738.7ms | 811.9ms | — |
| array/forEach | 826.2ms | 936.8ms | — |
| array/find | 743.2ms | 842.3ms | 823.2ms |
| dom/create-elements | 611.8ms | — | — |
| dom/set-attributes | 706.8ms | — | — |
| dom/read-attributes | 674.9ms | — | — |
| dom/modify-text | 581.5ms | — | — |
| mixed/csv-parse | 779.4ms | 930.2ms | — |
| mixed/text-search | 748.9ms | 996.1ms | 899.0ms |
| mixed/fibonacci | 757.0ms | 800.4ms | 819.2ms |
| mixed/matrix-multiply | 848.6ms | 936.9ms | 778.0ms |
| mixed/sieve | 856.3ms | 889.1ms | — |
