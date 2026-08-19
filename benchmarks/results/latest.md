# js2wasm Benchmark Results

Date: 2026-08-19
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.031ms | 0.044ms | 0.038ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.004ms | FAILED | js |
| string/indexOf | 0.019ms | 0.063ms | 0.013ms | 0.015ms | gc-native |
| string/includes | 0.019ms | 0.110ms | 0.015ms | 0.071ms | gc-native |
| string/split | 0.411ms | 4.88ms | 0.449ms | FAILED | js |
| string/replace | 0.105ms | 0.314ms | 0.057ms | FAILED | gc-native |
| string/case-convert | 0.056ms | 0.284ms | 0.005ms | FAILED | gc-native |
| string/substring | 0.099ms | 0.038ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.170ms | 0.974ms | 0.187ms | FAILED | js |
| string/startsWith-endsWith | 0.401ms | 0.358ms | 0.295ms | 0.559ms | gc-native |
| array/push-pop | 1.42ms | 0.506ms | 0.508ms | FAILED | host-call |
| array/sort-i32 | 0.793ms | 0.295ms | 0.294ms | FAILED | gc-native |
| array/map-filter | 0.130ms | 0.070ms | 0.070ms | FAILED | host-call |
| array/reduce | 2.14ms | 0.503ms | 0.503ms | FAILED | gc-native |
| array/indexOf | 3.95ms | 2.63ms | 2.63ms | FAILED | host-call |
| array/slice | 0.025ms | 0.028ms | 0.027ms | FAILED | js |
| array/reverse | 7.83ms | 3.52ms | 3.52ms | FAILED | host-call |
| array/forEach | 0.048ms | 0.028ms | 0.028ms | FAILED | host-call |
| array/find | 0.253ms | 0.016ms | 0.016ms | 1.08ms | gc-native |
| dom/create-elements | 0.035ms | 0.167ms | — | — | js |
| dom/set-attributes | 0.104ms | 0.498ms | — | — | js |
| dom/read-attributes | 0.056ms | 0.121ms | — | — | js |
| dom/modify-text | 0.029ms | 0.109ms | — | — | js |
| mixed/csv-parse | 0.474ms | 7.27ms | 0.315ms | FAILED | gc-native |
| mixed/text-search | 0.388ms | 1.52ms | 0.269ms | 1.10ms | gc-native |
| mixed/fibonacci | 0.122ms | 0.293ms | 0.292ms | 0.285ms | js |
| mixed/matrix-multiply | 0.157ms | 0.210ms | 0.210ms | 0.716ms | js |
| mixed/sieve | 1.62ms | 1.40ms | 1.41ms | FAILED | host-call |

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
| string/concat-short | 10000 | 3.13 | 4.44 | 3.83 | — |
| string/concat-long | 1000 | 3.53 | 4.54 | 3.68 | — |
| string/indexOf | 1000 | 19.16 | 62.56 | 12.58 | 14.60 |
| string/includes | 1000 | 19.21 | 110.41 | 15.08 | 70.80 |
| string/split | 10000 | 41.12 | 487.85 | 44.92 | — |
| string/replace | 1000 | 105.30 | 314.38 | 56.93 | — |
| string/case-convert | 2000 | 27.95 | 141.78 | 2.50 | — |
| string/substring | 10000 | 9.89 | 3.76 | 3.07 | — |
| string/trim | 10000 | 17.02 | 97.37 | 18.67 | — |
| string/startsWith-endsWith | 20000 | 20.06 | 17.88 | 14.77 | 27.93 |
| array/map-filter | 30000 | 4.34 | 2.34 | 2.34 | — |
| array/indexOf | 1000 | 3952.88 | 2631.98 | 2632.39 | — |
| dom/create-elements | 2000 | 17.40 | 83.52 | — | — |
| dom/set-attributes | 6000 | 17.30 | 82.97 | — | — |
| dom/read-attributes | 3000 | 18.51 | 40.33 | — | — |
| dom/modify-text | 2000 | 14.46 | 54.28 | — | — |
| mixed/csv-parse | 11000 | 43.08 | 661.14 | 28.67 | — |
| mixed/text-search | 40000 | 9.71 | 38.00 | 6.73 | 27.48 |
| mixed/fibonacci | 10000 | 12.17 | 29.30 | 29.22 | 28.55 |
| mixed/matrix-multiply | 125000 | 1.25 | 1.68 | 1.68 | 5.73 |
| mixed/sieve | 200000 | 8.11 | 6.99 | 7.03 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.42x slower | 1.23x slower | — |
| string/concat-long | 1.29x slower | 1.04x slower | — |
| string/indexOf | 3.27x slower | 1.52x faster | 1.31x faster |
| string/includes | 5.75x slower | 1.27x faster | 3.69x slower |
| string/split | 11.86x slower | 1.09x slower | — |
| string/replace | 2.99x slower | 1.85x faster | — |
| string/case-convert | 5.07x slower | 11.17x faster | — |
| string/substring | 2.63x faster | 3.22x faster | — |
| string/trim | 5.72x slower | 1.10x slower | — |
| string/startsWith-endsWith | 1.12x faster | 1.36x faster | 1.39x slower |
| array/push-pop | 2.80x faster | 2.79x faster | — |
| array/sort-i32 | 2.69x faster | 2.69x faster | — |
| array/map-filter | 1.85x faster | 1.85x faster | — |
| array/reduce | 4.25x faster | 4.25x faster | — |
| array/indexOf | 1.50x faster | 1.50x faster | — |
| array/slice | 1.09x slower | 1.07x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.72x faster | 1.72x faster | — |
| array/find | 15.60x faster | 15.90x faster | 4.26x slower |
| dom/create-elements | 4.80x slower | — | — |
| dom/set-attributes | 4.80x slower | — | — |
| dom/read-attributes | 2.18x slower | — | — |
| dom/modify-text | 3.75x slower | — | — |
| mixed/csv-parse | 15.35x slower | 1.50x faster | — |
| mixed/text-search | 3.91x slower | 1.44x faster | 2.83x slower |
| mixed/fibonacci | 2.41x slower | 2.40x slower | 2.35x slower |
| mixed/matrix-multiply | 1.34x slower | 1.34x slower | 4.57x slower |
| mixed/sieve | 1.16x faster | 1.15x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.16x faster |
| string/concat-long | 1.24x faster |
| string/indexOf | 4.97x faster |
| string/includes | 7.32x faster |
| string/split | 10.86x faster |
| string/replace | 5.52x faster |
| string/case-convert | 56.65x faster |
| string/substring | 1.22x faster |
| string/trim | 5.21x faster |
| string/startsWith-endsWith | 1.21x faster |
| array/push-pop | 1.01x slower |
| array/sort-i32 | 1.00x faster |
| array/map-filter | 1.00x slower |
| array/reduce | 1.00x faster |
| array/indexOf | 1.00x slower |
| array/slice | 1.01x faster |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x slower |
| array/find | 1.02x faster |
| mixed/csv-parse | 23.06x faster |
| mixed/text-search | 5.65x faster |
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
| string/concat-short | 1321.6ms | 1080.6ms | — |
| string/concat-long | 635.8ms | 959.1ms | — |
| string/indexOf | 657.8ms | 970.8ms | 836.0ms |
| string/includes | 659.2ms | 990.8ms | 830.7ms |
| string/split | 801.5ms | 954.8ms | — |
| string/replace | 795.3ms | 1053.0ms | — |
| string/case-convert | 778.9ms | 863.2ms | — |
| string/substring | 665.9ms | 776.6ms | — |
| string/trim | 766.4ms | 954.4ms | — |
| string/startsWith-endsWith | 754.2ms | 982.3ms | 926.6ms |
| array/push-pop | 800.2ms | 862.9ms | — |
| array/sort-i32 | 906.8ms | 1001.0ms | — |
| array/map-filter | 914.4ms | 1006.9ms | — |
| array/reduce | 831.3ms | 913.4ms | — |
| array/indexOf | 839.6ms | 903.5ms | — |
| array/slice | 765.2ms | 841.4ms | — |
| array/reverse | 756.8ms | 841.7ms | — |
| array/forEach | 872.2ms | 939.9ms | — |
| array/find | 761.7ms | 864.4ms | 876.5ms |
| dom/create-elements | 622.7ms | — | — |
| dom/set-attributes | 724.0ms | — | — |
| dom/read-attributes | 698.5ms | — | — |
| dom/modify-text | 608.3ms | — | — |
| mixed/csv-parse | 808.1ms | 931.6ms | — |
| mixed/text-search | 788.6ms | 1014.6ms | 961.9ms |
| mixed/fibonacci | 780.0ms | 832.5ms | 811.1ms |
| mixed/matrix-multiply | 848.3ms | 947.7ms | 818.8ms |
| mixed/sieve | 838.4ms | 927.9ms | — |
