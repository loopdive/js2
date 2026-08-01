# js2wasm Benchmark Results

Date: 2026-08-01
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.030ms | 0.051ms | 0.044ms | FAILED | js |
| string/concat-long | 0.004ms | 0.008ms | 0.009ms | FAILED | js |
| string/indexOf | 0.019ms | 0.082ms | 0.024ms | FAILED | js |
| string/includes | 0.019ms | 0.131ms | 0.023ms | FAILED | js |
| string/split | 0.421ms | 5.49ms | 1.40ms | FAILED | js |
| string/replace | 0.046ms | 0.220ms | 0.079ms | FAILED | js |
| string/case-convert | 0.062ms | 0.234ms | 0.113ms | FAILED | js |
| string/substring | 0.105ms | 1.94ms | 0.922ms | FAILED | js |
| string/trim | 0.177ms | 1.37ms | 0.730ms | FAILED | js |
| string/startsWith-endsWith | 0.428ms | 2.71ms | 0.526ms | FAILED | js |
| array/push-pop | 1.69ms | 2.61ms | 2.61ms | FAILED | js |
| array/sort-i32 | 0.848ms | 0.421ms | 0.408ms | FAILED | gc-native |
| array/map-filter | 0.139ms | 0.693ms | 0.697ms | FAILED | js |
| array/reduce | 2.46ms | 2.65ms | 2.61ms | FAILED | js |
| array/indexOf | 4.45ms | 3.85ms | 3.85ms | FAILED | gc-native |
| array/slice | 0.040ms | 0.026ms | 0.025ms | FAILED | gc-native |
| array/reverse | 8.85ms | 3.69ms | 3.69ms | FAILED | host-call |
| array/forEach | 0.055ms | 0.124ms | 0.123ms | FAILED | js |
| array/find | 0.285ms | 0.510ms | 0.511ms | 4.93ms | js |
| dom/create-elements | 0.041ms | 0.262ms | — | — | js |
| dom/set-attributes | 0.110ms | 0.372ms | — | — | js |
| dom/read-attributes | 0.060ms | 0.184ms | — | — | js |
| dom/modify-text | 0.053ms | 0.164ms | — | — | js |
| mixed/csv-parse | 0.459ms | 6.81ms | 0.895ms | FAILED | js |
| mixed/text-search | 0.411ms | 5.38ms | 1.17ms | FAILED | js |
| mixed/fibonacci | 0.125ms | 0.304ms | 0.304ms | 0.302ms | js |
| mixed/matrix-multiply | 0.188ms | 0.567ms | 0.568ms | 2.03ms | js |
| mixed/sieve | 1.82ms | 1.47ms | 1.47ms | FAILED | host-call |

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
| string/concat-short | 10000 | 3.02 | 5.10 | 4.37 | — |
| string/concat-long | 1000 | 4.02 | 8.47 | 9.23 | — |
| string/indexOf | 1000 | 18.99 | 81.54 | 23.56 | — |
| string/includes | 1000 | 18.76 | 131.37 | 22.53 | — |
| string/split | 10000 | 42.07 | 549.00 | 140.37 | — |
| string/replace | 1000 | 45.73 | 220.18 | 78.75 | — |
| string/case-convert | 2000 | 31.15 | 116.97 | 56.51 | — |
| string/substring | 10000 | 10.46 | 193.84 | 92.18 | — |
| string/trim | 10000 | 17.65 | 137.47 | 73.03 | — |
| string/startsWith-endsWith | 20000 | 21.42 | 135.40 | 26.29 | — |
| mixed/csv-parse | 11000 | 41.69 | 618.98 | 81.35 | — |
| mixed/text-search | 40000 | 10.28 | 134.40 | 29.17 | — |
| mixed/fibonacci | 10000 | 12.53 | 30.45 | 30.39 | 30.19 |
| mixed/matrix-multiply | 125000 | 1.51 | 4.54 | 4.54 | 16.22 |
| mixed/sieve | 200000 | 9.12 | 7.35 | 7.37 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.69x slower | 1.45x slower | — |
| string/concat-long | 2.10x slower | 2.30x slower | — |
| string/indexOf | 4.29x slower | 1.24x slower | — |
| string/includes | 7.00x slower | 1.20x slower | — |
| string/split | 13.05x slower | 3.34x slower | — |
| string/replace | 4.82x slower | 1.72x slower | — |
| string/case-convert | 3.76x slower | 1.81x slower | — |
| string/substring | 18.53x slower | 8.81x slower | — |
| string/trim | 7.79x slower | 4.14x slower | — |
| string/startsWith-endsWith | 6.32x slower | 1.23x slower | — |
| array/push-pop | 1.54x slower | 1.54x slower | — |
| array/sort-i32 | 2.01x faster | 2.08x faster | — |
| array/map-filter | 4.98x slower | 5.02x slower | — |
| array/reduce | 1.08x slower | 1.06x slower | — |
| array/indexOf | 1.16x faster | 1.16x faster | — |
| array/slice | 1.54x faster | 1.60x faster | — |
| array/reverse | 2.40x faster | 2.40x faster | — |
| array/forEach | 2.23x slower | 2.23x slower | — |
| array/find | 1.79x slower | 1.79x slower | 17.32x slower |
| dom/create-elements | 6.38x slower | — | — |
| dom/set-attributes | 3.38x slower | — | — |
| dom/read-attributes | 3.08x slower | — | — |
| dom/modify-text | 3.11x slower | — | — |
| mixed/csv-parse | 14.85x slower | 1.95x slower | — |
| mixed/text-search | 13.08x slower | 2.84x slower | — |
| mixed/fibonacci | 2.43x slower | 2.43x slower | 2.41x slower |
| mixed/matrix-multiply | 3.01x slower | 3.02x slower | 10.77x slower |
| mixed/sieve | 1.24x faster | 1.24x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.17x faster |
| string/concat-long | 1.09x slower |
| string/indexOf | 3.46x faster |
| string/includes | 5.83x faster |
| string/split | 3.91x faster |
| string/replace | 2.80x faster |
| string/case-convert | 2.07x faster |
| string/substring | 2.10x faster |
| string/trim | 1.88x faster |
| string/startsWith-endsWith | 5.15x faster |
| array/push-pop | 1.00x slower |
| array/sort-i32 | 1.03x faster |
| array/map-filter | 1.01x slower |
| array/reduce | 1.02x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.04x faster |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x faster |
| array/find | 1.00x slower |
| mixed/csv-parse | 7.61x faster |
| mixed/text-search | 4.61x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.00x slower |
| mixed/sieve | 1.00x slower |

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
| string/concat-short | 1276.7ms | 1166.3ms | — |
| string/concat-long | 616.9ms | 1025.0ms | — |
| string/indexOf | 760.5ms | 1013.9ms | — |
| string/includes | 777.4ms | 1056.5ms | — |
| string/split | 807.5ms | 1020.8ms | — |
| string/replace | 812.4ms | 1092.7ms | — |
| string/case-convert | 848.2ms | 1107.9ms | — |
| string/substring | 720.8ms | 945.8ms | — |
| string/trim | 829.9ms | 1038.2ms | — |
| string/startsWith-endsWith | 803.3ms | 1045.9ms | — |
| array/push-pop | 755.5ms | 852.1ms | — |
| array/sort-i32 | 966.4ms | 991.1ms | — |
| array/map-filter | 937.1ms | 1010.6ms | — |
| array/reduce | 846.8ms | 953.6ms | — |
| array/indexOf | 783.8ms | 820.0ms | — |
| array/slice | 796.9ms | 851.1ms | — |
| array/reverse | 793.6ms | 854.4ms | — |
| array/forEach | 893.0ms | 934.1ms | — |
| array/find | 912.3ms | 961.6ms | 853.1ms |
| dom/create-elements | 629.8ms | — | — |
| dom/set-attributes | 758.8ms | — | — |
| dom/read-attributes | 712.9ms | — | — |
| dom/modify-text | 699.6ms | — | — |
| mixed/csv-parse | 883.5ms | 1051.7ms | — |
| mixed/text-search | 817.4ms | 1067.6ms | — |
| mixed/fibonacci | 841.3ms | 949.8ms | 854.8ms |
| mixed/matrix-multiply | 919.7ms | 975.9ms | 850.2ms |
| mixed/sieve | 832.9ms | 902.9ms | — |
