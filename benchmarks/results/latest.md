# js2wasm Benchmark Results

Date: 2026-08-21
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.031ms | 0.045ms | 0.037ms | FAILED | js |
| string/concat-long | 0.004ms | 0.004ms | 0.004ms | FAILED | gc-native |
| string/indexOf | 0.019ms | 0.063ms | 0.012ms | 0.016ms | gc-native |
| string/includes | 0.019ms | 0.047ms | 0.014ms | 0.016ms | gc-native |
| string/split | 0.412ms | 4.95ms | 0.449ms | FAILED | js |
| string/replace | 0.104ms | 0.308ms | 0.057ms | FAILED | gc-native |
| string/case-convert | 0.055ms | 0.228ms | 0.005ms | FAILED | gc-native |
| string/substring | 0.098ms | 0.037ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.170ms | 0.927ms | 0.189ms | FAILED | js |
| string/startsWith-endsWith | 0.401ms | 0.357ms | 0.295ms | 0.556ms | gc-native |
| array/push-pop | 1.40ms | 0.502ms | 0.500ms | FAILED | gc-native |
| array/sort-i32 | 0.790ms | 0.292ms | 0.292ms | FAILED | host-call |
| array/map-filter | 0.127ms | 0.070ms | 0.070ms | FAILED | gc-native |
| array/reduce | 2.14ms | 0.505ms | 0.501ms | FAILED | gc-native |
| array/indexOf | 3.95ms | 2.63ms | 2.63ms | FAILED | gc-native |
| array/slice | 0.024ms | 0.026ms | 0.026ms | FAILED | js |
| array/reverse | 7.83ms | 3.52ms | 3.52ms | FAILED | gc-native |
| array/forEach | 0.085ms | 0.028ms | 0.028ms | FAILED | host-call |
| array/find | 0.252ms | 0.015ms | 0.016ms | 1.08ms | host-call |
| dom/create-elements | 0.034ms | 0.152ms | — | — | js |
| dom/set-attributes | 0.102ms | 0.565ms | — | — | js |
| dom/read-attributes | 0.053ms | 0.135ms | — | — | js |
| dom/modify-text | 0.029ms | 0.108ms | — | — | js |
| mixed/csv-parse | 1.21ms | 7.50ms | 0.313ms | FAILED | gc-native |
| mixed/text-search | 0.391ms | 1.64ms | 0.266ms | 1.08ms | gc-native |
| mixed/fibonacci | 0.122ms | 0.292ms | 0.292ms | 0.287ms | js |
| mixed/matrix-multiply | 0.157ms | 0.209ms | 0.209ms | 0.717ms | js |
| mixed/sieve | 1.54ms | 1.40ms | 1.39ms | FAILED | gc-native |

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
| string/concat-short | 10000 | 3.06 | 4.53 | 3.72 | — |
| string/concat-long | 1000 | 3.74 | 4.49 | 3.51 | — |
| string/indexOf | 1000 | 19.14 | 62.62 | 12.25 | 15.65 |
| string/includes | 1000 | 19.18 | 46.82 | 14.45 | 15.93 |
| string/split | 10000 | 41.17 | 494.71 | 44.89 | — |
| string/replace | 1000 | 103.69 | 307.67 | 57.07 | — |
| string/case-convert | 2000 | 27.75 | 114.09 | 2.50 | — |
| string/substring | 10000 | 9.82 | 3.74 | 3.07 | — |
| string/trim | 10000 | 16.97 | 92.75 | 18.90 | — |
| string/startsWith-endsWith | 20000 | 20.06 | 17.87 | 14.77 | 27.78 |
| array/map-filter | 30000 | 4.24 | 2.33 | 2.32 | — |
| array/indexOf | 1000 | 3950.13 | 2633.08 | 2632.88 | — |
| dom/create-elements | 2000 | 17.08 | 75.87 | — | — |
| dom/set-attributes | 6000 | 17.03 | 94.15 | — | — |
| dom/read-attributes | 3000 | 17.66 | 44.87 | — | — |
| dom/modify-text | 2000 | 14.26 | 54.17 | — | — |
| mixed/csv-parse | 11000 | 110.19 | 681.39 | 28.48 | — |
| mixed/text-search | 40000 | 9.76 | 41.08 | 6.64 | 27.06 |
| mixed/fibonacci | 10000 | 12.17 | 29.22 | 29.19 | 28.69 |
| mixed/matrix-multiply | 125000 | 1.26 | 1.68 | 1.68 | 5.74 |
| mixed/sieve | 200000 | 7.69 | 6.98 | 6.93 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.48x slower | 1.22x slower | — |
| string/concat-long | 1.20x slower | 1.07x faster | — |
| string/indexOf | 3.27x slower | 1.56x faster | 1.22x faster |
| string/includes | 2.44x slower | 1.33x faster | 1.20x faster |
| string/split | 12.02x slower | 1.09x slower | — |
| string/replace | 2.97x slower | 1.82x faster | — |
| string/case-convert | 4.11x slower | 11.08x faster | — |
| string/substring | 2.63x faster | 3.20x faster | — |
| string/trim | 5.47x slower | 1.11x slower | — |
| string/startsWith-endsWith | 1.12x faster | 1.36x faster | 1.38x slower |
| array/push-pop | 2.79x faster | 2.80x faster | — |
| array/sort-i32 | 2.71x faster | 2.70x faster | — |
| array/map-filter | 1.82x faster | 1.83x faster | — |
| array/reduce | 4.23x faster | 4.26x faster | — |
| array/indexOf | 1.50x faster | 1.50x faster | — |
| array/slice | 1.08x slower | 1.10x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 3.07x faster | 3.04x faster | — |
| array/find | 16.33x faster | 16.11x faster | 4.27x slower |
| dom/create-elements | 4.44x slower | — | — |
| dom/set-attributes | 5.53x slower | — | — |
| dom/read-attributes | 2.54x slower | — | — |
| dom/modify-text | 3.80x slower | — | — |
| mixed/csv-parse | 6.18x slower | 3.87x faster | — |
| mixed/text-search | 4.21x slower | 1.47x faster | 2.77x slower |
| mixed/fibonacci | 2.40x slower | 2.40x slower | 2.36x slower |
| mixed/matrix-multiply | 1.33x slower | 1.33x slower | 4.57x slower |
| mixed/sieve | 1.10x faster | 1.11x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.22x faster |
| string/concat-long | 1.28x faster |
| string/indexOf | 5.11x faster |
| string/includes | 3.24x faster |
| string/split | 11.02x faster |
| string/replace | 5.39x faster |
| string/case-convert | 45.55x faster |
| string/substring | 1.22x faster |
| string/trim | 4.91x faster |
| string/startsWith-endsWith | 1.21x faster |
| array/push-pop | 1.00x faster |
| array/sort-i32 | 1.00x slower |
| array/map-filter | 1.00x faster |
| array/reduce | 1.01x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.02x slower |
| array/reverse | 1.00x faster |
| array/forEach | 1.01x slower |
| array/find | 1.01x slower |
| mixed/csv-parse | 23.92x faster |
| mixed/text-search | 6.19x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.00x faster |
| mixed/sieve | 1.01x faster |

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
| array/forEach | 2.5KB | 3.0KB | — |
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
| string/concat-short | 1305.1ms | 1080.4ms | — |
| string/concat-long | 630.9ms | 944.0ms | — |
| string/indexOf | 671.8ms | 945.7ms | 854.9ms |
| string/includes | 649.5ms | 978.0ms | 831.4ms |
| string/split | 772.8ms | 979.9ms | — |
| string/replace | 779.8ms | 1000.0ms | — |
| string/case-convert | 772.9ms | 840.7ms | — |
| string/substring | 635.1ms | 734.5ms | — |
| string/trim | 742.3ms | 940.0ms | — |
| string/startsWith-endsWith | 752.6ms | 986.4ms | 926.9ms |
| array/push-pop | 774.9ms | 831.1ms | — |
| array/sort-i32 | 877.0ms | 970.6ms | — |
| array/map-filter | 890.4ms | 1019.8ms | — |
| array/reduce | 833.4ms | 942.0ms | — |
| array/indexOf | 843.9ms | 909.5ms | — |
| array/slice | 739.1ms | 876.6ms | — |
| array/reverse | 762.6ms | 829.1ms | — |
| array/forEach | 850.9ms | 930.8ms | — |
| array/find | 744.4ms | 827.1ms | 833.7ms |
| dom/create-elements | 621.3ms | — | — |
| dom/set-attributes | 685.9ms | — | — |
| dom/read-attributes | 686.9ms | — | — |
| dom/modify-text | 603.0ms | — | — |
| mixed/csv-parse | 776.4ms | 943.2ms | — |
| mixed/text-search | 805.3ms | 989.0ms | 904.1ms |
| mixed/fibonacci | 756.2ms | 832.9ms | 775.1ms |
| mixed/matrix-multiply | 873.7ms | 913.1ms | 783.9ms |
| mixed/sieve | 850.8ms | 905.2ms | — |
