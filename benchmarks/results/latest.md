# js2wasm Benchmark Results

Date: 2026-08-22
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.031ms | 0.044ms | 0.038ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.004ms | FAILED | gc-native |
| string/indexOf | 0.019ms | 0.066ms | 0.012ms | 0.015ms | gc-native |
| string/includes | 0.019ms | 0.139ms | 0.014ms | 0.015ms | gc-native |
| string/split | 0.412ms | 4.95ms | 0.449ms | FAILED | js |
| string/replace | 0.104ms | 0.318ms | 0.056ms | FAILED | gc-native |
| string/case-convert | 0.056ms | 0.244ms | 0.005ms | FAILED | gc-native |
| string/substring | 0.098ms | 0.038ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.170ms | 0.949ms | 0.186ms | FAILED | js |
| string/startsWith-endsWith | 0.402ms | 0.357ms | 0.295ms | 0.561ms | gc-native |
| array/push-pop | 1.39ms | 0.506ms | 0.501ms | FAILED | gc-native |
| array/sort-i32 | 0.790ms | 0.294ms | 0.294ms | FAILED | host-call |
| array/map-filter | 0.126ms | 0.070ms | 0.070ms | FAILED | gc-native |
| array/reduce | 2.12ms | 0.495ms | 0.494ms | FAILED | gc-native |
| array/indexOf | 3.95ms | 2.63ms | 2.63ms | FAILED | host-call |
| array/slice | 0.025ms | 0.028ms | 0.027ms | FAILED | js |
| array/reverse | 7.83ms | 3.52ms | 3.52ms | FAILED | gc-native |
| array/forEach | 0.049ms | 0.028ms | 0.028ms | FAILED | host-call |
| array/find | 0.254ms | 0.016ms | 0.016ms | 1.07ms | host-call |
| dom/create-elements | 0.034ms | 0.165ms | — | — | js |
| dom/set-attributes | 0.103ms | 0.485ms | — | — | js |
| dom/read-attributes | 0.054ms | 0.122ms | — | — | js |
| dom/modify-text | 0.029ms | 0.109ms | — | — | js |
| mixed/csv-parse | 0.485ms | 7.13ms | 0.316ms | FAILED | gc-native |
| mixed/text-search | 0.388ms | 1.59ms | 0.266ms | 1.09ms | gc-native |
| mixed/fibonacci | 0.122ms | 0.292ms | 0.292ms | 0.287ms | js |
| mixed/matrix-multiply | 0.158ms | 0.210ms | 0.210ms | 0.715ms | js |
| mixed/sieve | 1.53ms | 1.38ms | 1.38ms | FAILED | gc-native |

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
| string/concat-short | 10000 | 3.08 | 4.41 | 3.78 | — |
| string/concat-long | 1000 | 3.58 | 4.53 | 3.56 | — |
| string/indexOf | 1000 | 19.15 | 65.57 | 12.11 | 15.11 |
| string/includes | 1000 | 19.19 | 138.86 | 14.43 | 15.40 |
| string/split | 10000 | 41.19 | 495.32 | 44.88 | — |
| string/replace | 1000 | 103.77 | 318.42 | 56.27 | — |
| string/case-convert | 2000 | 27.78 | 122.03 | 2.52 | — |
| string/substring | 10000 | 9.84 | 3.75 | 3.08 | — |
| string/trim | 10000 | 16.97 | 94.95 | 18.64 | — |
| string/startsWith-endsWith | 20000 | 20.10 | 17.84 | 14.77 | 28.07 |
| array/map-filter | 30000 | 4.21 | 2.34 | 2.34 | — |
| array/indexOf | 1000 | 3947.61 | 2632.84 | 2634.43 | — |
| dom/create-elements | 2000 | 17.22 | 82.35 | — | — |
| dom/set-attributes | 6000 | 17.12 | 80.78 | — | — |
| dom/read-attributes | 3000 | 18.10 | 40.65 | — | — |
| dom/modify-text | 2000 | 14.51 | 54.30 | — | — |
| mixed/csv-parse | 11000 | 44.10 | 648.37 | 28.70 | — |
| mixed/text-search | 40000 | 9.71 | 39.66 | 6.66 | 27.18 |
| mixed/fibonacci | 10000 | 12.17 | 29.22 | 29.16 | 28.65 |
| mixed/matrix-multiply | 125000 | 1.26 | 1.68 | 1.68 | 5.72 |
| mixed/sieve | 200000 | 7.67 | 6.91 | 6.89 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.43x slower | 1.23x slower | — |
| string/concat-long | 1.27x slower | 1.00x faster | — |
| string/indexOf | 3.42x slower | 1.58x faster | 1.27x faster |
| string/includes | 7.24x slower | 1.33x faster | 1.25x faster |
| string/split | 12.02x slower | 1.09x slower | — |
| string/replace | 3.07x slower | 1.84x faster | — |
| string/case-convert | 4.39x slower | 11.04x faster | — |
| string/substring | 2.62x faster | 3.20x faster | — |
| string/trim | 5.60x slower | 1.10x slower | — |
| string/startsWith-endsWith | 1.13x faster | 1.36x faster | 1.40x slower |
| array/push-pop | 2.74x faster | 2.77x faster | — |
| array/sort-i32 | 2.69x faster | 2.68x faster | — |
| array/map-filter | 1.79x faster | 1.79x faster | — |
| array/reduce | 4.29x faster | 4.30x faster | — |
| array/indexOf | 1.50x faster | 1.50x faster | — |
| array/slice | 1.12x slower | 1.08x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.75x faster | 1.75x faster | — |
| array/find | 16.15x faster | 15.90x faster | 4.23x slower |
| dom/create-elements | 4.78x slower | — | — |
| dom/set-attributes | 4.72x slower | — | — |
| dom/read-attributes | 2.25x slower | — | — |
| dom/modify-text | 3.74x slower | — | — |
| mixed/csv-parse | 14.70x slower | 1.54x faster | — |
| mixed/text-search | 4.08x slower | 1.46x faster | 2.80x slower |
| mixed/fibonacci | 2.40x slower | 2.40x slower | 2.35x slower |
| mixed/matrix-multiply | 1.34x slower | 1.33x slower | 4.54x slower |
| mixed/sieve | 1.11x faster | 1.11x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.17x faster |
| string/concat-long | 1.27x faster |
| string/indexOf | 5.41x faster |
| string/includes | 9.63x faster |
| string/split | 11.04x faster |
| string/replace | 5.66x faster |
| string/case-convert | 48.51x faster |
| string/substring | 1.22x faster |
| string/trim | 5.09x faster |
| string/startsWith-endsWith | 1.21x faster |
| array/push-pop | 1.01x faster |
| array/sort-i32 | 1.00x slower |
| array/map-filter | 1.00x faster |
| array/reduce | 1.00x faster |
| array/indexOf | 1.00x slower |
| array/slice | 1.03x faster |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x slower |
| array/find | 1.02x slower |
| mixed/csv-parse | 22.59x faster |
| mixed/text-search | 5.96x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.00x faster |
| mixed/sieve | 1.00x faster |

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
| array/sort-i32 | 2.6KB | 3.1KB | — |
| array/map-filter | 3.3KB | 3.8KB | — |
| array/reduce | 2.3KB | 2.8KB | — |
| array/indexOf | 1.7KB | 2.0KB | — |
| array/slice | 1020B | 1.3KB | — |
| array/reverse | 998B | 1.3KB | — |
| array/forEach | 2.5KB | 3.1KB | — |
| array/find | 946B | 1.3KB | 635B |
| dom/create-elements | 271B | — | — |
| dom/set-attributes | 524B | — | — |
| dom/read-attributes | 389B | — | — |
| dom/modify-text | 264B | — | — |
| mixed/csv-parse | 2.3KB | 4.2KB | — |
| mixed/text-search | 1.9KB | 4.0KB | 1.9KB |
| mixed/fibonacci | 411B | 411B | 386B |
| mixed/matrix-multiply | 1.7KB | 2.0KB | 992B |
| mixed/sieve | 1.6KB | 2.0KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1306.7ms | 1140.8ms | — |
| string/concat-long | 645.6ms | 951.9ms | — |
| string/indexOf | 649.4ms | 947.7ms | 858.7ms |
| string/includes | 638.4ms | 952.4ms | 840.3ms |
| string/split | 778.6ms | 969.9ms | — |
| string/replace | 767.5ms | 1082.8ms | — |
| string/case-convert | 779.9ms | 856.9ms | — |
| string/substring | 685.8ms | 734.8ms | — |
| string/trim | 744.4ms | 991.9ms | — |
| string/startsWith-endsWith | 767.7ms | 988.6ms | 910.9ms |
| array/push-pop | 756.3ms | 857.6ms | — |
| array/sort-i32 | 913.4ms | 950.9ms | — |
| array/map-filter | 905.7ms | 990.7ms | — |
| array/reduce | 828.0ms | 910.3ms | — |
| array/indexOf | 833.1ms | 932.3ms | — |
| array/slice | 757.8ms | 847.7ms | — |
| array/reverse | 743.0ms | 806.2ms | — |
| array/forEach | 860.8ms | 964.6ms | — |
| array/find | 732.6ms | 814.0ms | 847.3ms |
| dom/create-elements | 625.5ms | — | — |
| dom/set-attributes | 736.2ms | — | — |
| dom/read-attributes | 668.1ms | — | — |
| dom/modify-text | 585.6ms | — | — |
| mixed/csv-parse | 794.2ms | 914.7ms | — |
| mixed/text-search | 753.4ms | 1018.7ms | 917.9ms |
| mixed/fibonacci | 771.2ms | 812.7ms | 788.8ms |
| mixed/matrix-multiply | 885.3ms | 918.1ms | 817.2ms |
| mixed/sieve | 847.1ms | 933.5ms | — |
