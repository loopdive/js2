# js2wasm Benchmark Results

Date: 2026-08-17
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.033ms | 0.049ms | 0.042ms | FAILED | js |
| string/concat-long | 0.005ms | 0.005ms | 0.003ms | FAILED | gc-native |
| string/indexOf | 0.019ms | 0.062ms | 0.012ms | 0.061ms | gc-native |
| string/includes | 0.019ms | 0.042ms | 0.014ms | 0.065ms | gc-native |
| string/split | 0.415ms | 4.73ms | 0.504ms | FAILED | js |
| string/replace | 0.097ms | 0.227ms | 0.059ms | FAILED | gc-native |
| string/case-convert | 0.058ms | 0.225ms | 0.005ms | FAILED | gc-native |
| string/substring | 0.104ms | 0.040ms | 0.034ms | FAILED | gc-native |
| string/trim | 0.173ms | 0.961ms | 0.197ms | FAILED | js |
| string/startsWith-endsWith | 0.413ms | 0.340ms | 0.308ms | 0.553ms | gc-native |
| array/push-pop | 1.64ms | 0.591ms | 0.599ms | FAILED | host-call |
| array/sort-i32 | 0.844ms | 0.443ms | 0.297ms | FAILED | gc-native |
| array/map-filter | 0.139ms | 0.066ms | 0.066ms | FAILED | host-call |
| array/reduce | 2.38ms | 0.608ms | 0.602ms | FAILED | gc-native |
| array/indexOf | 4.46ms | 2.86ms | 2.86ms | FAILED | gc-native |
| array/slice | 0.034ms | 0.017ms | 0.016ms | FAILED | gc-native |
| array/reverse | 8.86ms | 3.97ms | 3.97ms | FAILED | gc-native |
| array/forEach | 0.053ms | 0.029ms | 0.029ms | FAILED | host-call |
| array/find | 0.272ms | 0.015ms | 0.015ms | 1.21ms | gc-native |
| dom/create-elements | 0.038ms | 0.147ms | — | — | js |
| dom/set-attributes | 0.107ms | 0.568ms | — | — | js |
| dom/read-attributes | 0.058ms | 0.138ms | — | — | js |
| dom/modify-text | 0.029ms | 0.115ms | — | — | js |
| mixed/csv-parse | 0.510ms | 6.86ms | 0.307ms | FAILED | gc-native |
| mixed/text-search | 0.403ms | 1.31ms | 0.292ms | 1.11ms | gc-native |
| mixed/fibonacci | 0.126ms | 0.306ms | 0.306ms | 0.310ms | js |
| mixed/matrix-multiply | 0.185ms | 0.210ms | 0.210ms | 0.718ms | js |
| mixed/sieve | 1.75ms | 1.47ms | 1.51ms | FAILED | host-call |

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
| string/concat-short | 10000 | 3.32 | 4.90 | 4.25 | — |
| string/concat-long | 1000 | 5.25 | 5.38 | 3.39 | — |
| string/indexOf | 1000 | 18.99 | 62.18 | 12.24 | 61.28 |
| string/includes | 1000 | 18.72 | 41.86 | 13.80 | 64.82 |
| string/split | 10000 | 41.50 | 473.44 | 50.40 | — |
| string/replace | 1000 | 96.67 | 226.82 | 59.43 | — |
| string/case-convert | 2000 | 29.01 | 112.42 | 2.62 | — |
| string/substring | 10000 | 10.43 | 3.99 | 3.44 | — |
| string/trim | 10000 | 17.28 | 96.07 | 19.66 | — |
| string/startsWith-endsWith | 20000 | 20.65 | 17.00 | 15.41 | 27.64 |
| array/map-filter | 30000 | 4.64 | 2.19 | 2.19 | — |
| array/indexOf | 1000 | 4458.74 | 2861.95 | 2860.19 | — |
| dom/create-elements | 2000 | 18.85 | 73.53 | — | — |
| dom/set-attributes | 6000 | 17.87 | 94.69 | — | — |
| dom/read-attributes | 3000 | 19.42 | 45.98 | — | — |
| dom/modify-text | 2000 | 14.74 | 57.47 | — | — |
| mixed/csv-parse | 11000 | 46.36 | 623.77 | 27.90 | — |
| mixed/text-search | 40000 | 10.07 | 32.64 | 7.31 | 27.74 |
| mixed/fibonacci | 10000 | 12.56 | 30.58 | 30.61 | 30.98 |
| mixed/matrix-multiply | 125000 | 1.48 | 1.68 | 1.68 | 5.74 |
| mixed/sieve | 200000 | 8.75 | 7.34 | 7.54 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.48x slower | 1.28x slower | — |
| string/concat-long | 1.02x slower | 1.55x faster | — |
| string/indexOf | 3.27x slower | 1.55x faster | 3.23x slower |
| string/includes | 2.24x slower | 1.36x faster | 3.46x slower |
| string/split | 11.41x slower | 1.21x slower | — |
| string/replace | 2.35x slower | 1.63x faster | — |
| string/case-convert | 3.87x slower | 11.09x faster | — |
| string/substring | 2.61x faster | 3.03x faster | — |
| string/trim | 5.56x slower | 1.14x slower | — |
| string/startsWith-endsWith | 1.21x faster | 1.34x faster | 1.34x slower |
| array/push-pop | 2.77x faster | 2.73x faster | — |
| array/sort-i32 | 1.90x faster | 2.84x faster | — |
| array/map-filter | 2.12x faster | 2.12x faster | — |
| array/reduce | 3.92x faster | 3.95x faster | — |
| array/indexOf | 1.56x faster | 1.56x faster | — |
| array/slice | 2.05x faster | 2.13x faster | — |
| array/reverse | 2.23x faster | 2.23x faster | — |
| array/forEach | 1.85x faster | 1.85x faster | — |
| array/find | 18.38x faster | 18.40x faster | 4.45x slower |
| dom/create-elements | 3.90x slower | — | — |
| dom/set-attributes | 5.30x slower | — | — |
| dom/read-attributes | 2.37x slower | — | — |
| dom/modify-text | 3.90x slower | — | — |
| mixed/csv-parse | 13.45x slower | 1.66x faster | — |
| mixed/text-search | 3.24x slower | 1.38x faster | 2.76x slower |
| mixed/fibonacci | 2.44x slower | 2.44x slower | 2.47x slower |
| mixed/matrix-multiply | 1.14x slower | 1.14x slower | 3.88x slower |
| mixed/sieve | 1.19x faster | 1.16x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.15x faster |
| string/concat-long | 1.59x faster |
| string/indexOf | 5.08x faster |
| string/includes | 3.03x faster |
| string/split | 9.39x faster |
| string/replace | 3.82x faster |
| string/case-convert | 42.98x faster |
| string/substring | 1.16x faster |
| string/trim | 4.89x faster |
| string/startsWith-endsWith | 1.10x faster |
| array/push-pop | 1.01x slower |
| array/sort-i32 | 1.49x faster |
| array/map-filter | 1.00x slower |
| array/reduce | 1.01x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.04x faster |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x slower |
| array/find | 1.00x faster |
| mixed/csv-parse | 22.35x faster |
| mixed/text-search | 4.47x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.00x slower |
| mixed/sieve | 1.03x slower |

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
| string/concat-short | 1281.2ms | 1062.6ms | — |
| string/concat-long | 612.5ms | 922.6ms | — |
| string/indexOf | 644.2ms | 949.3ms | 832.1ms |
| string/includes | 677.1ms | 976.4ms | 839.7ms |
| string/split | 781.9ms | 955.3ms | — |
| string/replace | 758.6ms | 993.1ms | — |
| string/case-convert | 821.9ms | 857.1ms | — |
| string/substring | 658.6ms | 731.4ms | — |
| string/trim | 727.9ms | 925.4ms | — |
| string/startsWith-endsWith | 750.3ms | 948.7ms | 899.8ms |
| array/push-pop | 762.1ms | 815.4ms | — |
| array/sort-i32 | 890.8ms | 963.9ms | — |
| array/map-filter | 908.4ms | 959.5ms | — |
| array/reduce | 857.1ms | 936.8ms | — |
| array/indexOf | 831.4ms | 883.5ms | — |
| array/slice | 764.1ms | 826.8ms | — |
| array/reverse | 743.7ms | 820.8ms | — |
| array/forEach | 849.1ms | 928.9ms | — |
| array/find | 742.5ms | 865.9ms | 837.1ms |
| dom/create-elements | 638.8ms | — | — |
| dom/set-attributes | 719.0ms | — | — |
| dom/read-attributes | 677.9ms | — | — |
| dom/modify-text | 596.8ms | — | — |
| mixed/csv-parse | 780.2ms | 908.0ms | — |
| mixed/text-search | 729.0ms | 995.6ms | 872.9ms |
| mixed/fibonacci | 771.1ms | 778.7ms | 811.6ms |
| mixed/matrix-multiply | 860.9ms | 901.1ms | 775.0ms |
| mixed/sieve | 857.6ms | 914.2ms | — |
