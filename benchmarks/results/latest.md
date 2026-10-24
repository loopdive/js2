# js2wasm Benchmark Results

Date: 2026-10-22
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.029ms | 0.049ms | 0.049ms | FAILED | js |
| string/concat-long | 0.004ms | 0.003ms | 0.003ms | FAILED | gc-native |
| string/indexOf | 0.019ms | 0.016ms | 0.016ms | 0.016ms | host-call |
| string/includes | 0.019ms | 0.020ms | 0.020ms | 0.024ms | js |
| string/split | 0.430ms | 0.504ms | 0.505ms | FAILED | js |
| string/replace | 0.094ms | 0.054ms | 0.055ms | FAILED | host-call |
| string/case-convert | 0.058ms | 0.007ms | 0.007ms | FAILED | gc-native |
| string/substring | 0.104ms | 0.034ms | 0.034ms | FAILED | host-call |
| string/trim | 0.172ms | 0.176ms | 0.176ms | FAILED | js |
| string/startsWith-endsWith | 0.413ms | 0.233ms | 0.233ms | 0.559ms | gc-native |
| array/push-pop | 1.61ms | 0.593ms | 0.593ms | FAILED | host-call |
| array/sort-i32 | 0.848ms | 0.413ms | 0.422ms | FAILED | host-call |
| array/map-filter | 0.139ms | 0.071ms | 0.077ms | FAILED | host-call |
| array/reduce | 1.59ms | 0.607ms | 0.595ms | FAILED | gc-native |
| array/indexOf | 4.47ms | 5.95ms | 5.94ms | FAILED | js |
| array/slice | 0.032ms | 0.016ms | 0.016ms | FAILED | host-call |
| array/reverse | 8.84ms | 3.61ms | 3.62ms | FAILED | host-call |
| array/forEach | 0.051ms | 0.053ms | 0.052ms | FAILED | js |
| array/find | 0.271ms | 0.011ms | 0.011ms | 1.21ms | gc-native |
| dom/create-elements | 0.046ms | 0.939ms | — | — | js |
| dom/set-attributes | 0.109ms | 6.56ms | — | — | js |
| dom/read-attributes | 0.059ms | FAILED | — | — | js |
| dom/modify-text | 0.030ms | 1.64ms | — | — | js |
| mixed/csv-parse | 0.470ms | 0.307ms | 0.305ms | FAILED | gc-native |
| mixed/text-search | 0.403ms | 0.293ms | 0.291ms | 1.13ms | gc-native |
| mixed/fibonacci | 0.125ms | 0.328ms | 0.328ms | 0.325ms | js |
| mixed/matrix-multiply | 0.184ms | 0.213ms | 0.214ms | 0.719ms | js |
| mixed/sieve | 1.79ms | 2.29ms | 2.32ms | FAILED | js |

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
| dom/read-attributes | host-call | warmup | dereferencing a null pointer |
| mixed/csv-parse | linear-memory | mid-loop | memory access out of bounds |
| mixed/sieve | linear-memory | mid-loop | memory access out of bounds |

## Cost per operation (ns)

| Benchmark | ops/call | JS | Host-call | GC-native | Linear |
|-----------|----------|-----|-----------|-----------|--------|
| string/concat-short | 10000 | 2.91 | 4.94 | 4.86 | — |
| string/concat-long | 1000 | 4.17 | 2.88 | 2.79 | — |
| string/indexOf | 1000 | 18.95 | 16.00 | 16.01 | 16.24 |
| string/includes | 1000 | 18.66 | 19.53 | 19.54 | 23.66 |
| string/split | 10000 | 43.01 | 50.38 | 50.52 | — |
| string/replace | 1000 | 94.47 | 54.10 | 54.60 | — |
| string/case-convert | 2000 | 29.12 | 3.69 | 3.69 | — |
| string/substring | 10000 | 10.39 | 3.43 | 3.43 | — |
| string/trim | 10000 | 17.24 | 17.64 | 17.63 | — |
| string/startsWith-endsWith | 20000 | 20.65 | 11.67 | 11.64 | 27.96 |
| array/map-filter | 30000 | 4.63 | 2.37 | 2.57 | — |
| array/indexOf | 1000 | 4467.18 | 5949.63 | 5943.80 | — |
| dom/create-elements | 2000 | 22.90 | 469.58 | — | — |
| dom/set-attributes | 6000 | 18.16 | 1092.96 | — | — |
| dom/read-attributes | 3000 | 19.58 | — | — | — |
| dom/modify-text | 2000 | 15.10 | 822.02 | — | — |
| mixed/csv-parse | 11000 | 42.76 | 27.94 | 27.75 | — |
| mixed/text-search | 40000 | 10.07 | 7.32 | 7.29 | 28.16 |
| mixed/fibonacci | 10000 | 12.54 | 32.76 | 32.75 | 32.54 |
| mixed/matrix-multiply | 125000 | 1.47 | 1.71 | 1.71 | 5.75 |
| mixed/sieve | 200000 | 8.96 | 11.47 | 11.58 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.70x slower | 1.67x slower | — |
| string/concat-long | 1.45x faster | 1.50x faster | — |
| string/indexOf | 1.18x faster | 1.18x faster | 1.17x faster |
| string/includes | 1.05x slower | 1.05x slower | 1.27x slower |
| string/split | 1.17x slower | 1.17x slower | — |
| string/replace | 1.75x faster | 1.73x faster | — |
| string/case-convert | 7.88x faster | 7.88x faster | — |
| string/substring | 3.03x faster | 3.03x faster | — |
| string/trim | 1.02x slower | 1.02x slower | — |
| string/startsWith-endsWith | 1.77x faster | 1.77x faster | 1.35x slower |
| array/push-pop | 2.71x faster | 2.71x faster | — |
| array/sort-i32 | 2.05x faster | 2.01x faster | — |
| array/map-filter | 1.95x faster | 1.80x faster | — |
| array/reduce | 2.62x faster | 2.68x faster | — |
| array/indexOf | 1.33x slower | 1.33x slower | — |
| array/slice | 1.98x faster | 1.97x faster | — |
| array/reverse | 2.45x faster | 2.45x faster | — |
| array/forEach | 1.02x slower | 1.02x slower | — |
| array/find | 25.00x faster | 25.37x faster | 4.45x slower |
| dom/create-elements | 20.51x slower | — | — |
| dom/set-attributes | 60.19x slower | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | 54.45x slower | — | — |
| mixed/csv-parse | 1.53x faster | 1.54x faster | — |
| mixed/text-search | 1.38x faster | 1.38x faster | 2.80x slower |
| mixed/fibonacci | 2.61x slower | 2.61x slower | 2.60x slower |
| mixed/matrix-multiply | 1.16x slower | 1.16x slower | 3.91x slower |
| mixed/sieve | 1.28x slower | 1.29x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.02x faster |
| string/concat-long | 1.04x faster |
| string/indexOf | 1.00x slower |
| string/includes | 1.00x slower |
| string/split | 1.00x slower |
| string/replace | 1.01x slower |
| string/case-convert | 1.00x faster |
| string/substring | 1.00x slower |
| string/trim | 1.00x faster |
| string/startsWith-endsWith | 1.00x faster |
| array/push-pop | 1.00x slower |
| array/sort-i32 | 1.02x slower |
| array/map-filter | 1.08x slower |
| array/reduce | 1.02x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.01x slower |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x faster |
| array/find | 1.01x faster |
| mixed/csv-parse | 1.01x faster |
| mixed/text-search | 1.00x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.00x slower |
| mixed/sieve | 1.01x slower |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.5KB | 1.5KB | — |
| string/concat-long | 18.8KB | 18.8KB | — |
| string/indexOf | 18.9KB | 18.9KB | 10.4KB |
| string/includes | 19.0KB | 19.0KB | 10.4KB |
| string/split | 26.7KB | 26.7KB | — |
| string/replace | 27.5KB | 27.5KB | — |
| string/case-convert | 26.3KB | 26.3KB | — |
| string/substring | 1.0KB | 1.0KB | — |
| string/trim | 26.3KB | 26.3KB | — |
| string/startsWith-endsWith | 27.3KB | 27.3KB | 1.7KB |
| array/push-pop | 25.3KB | 25.3KB | — |
| array/sort-i32 | 28.0KB | 28.0KB | — |
| array/map-filter | 29.1KB | 29.1KB | — |
| array/reduce | 27.6KB | 27.6KB | — |
| array/indexOf | 25.5KB | 25.5KB | — |
| array/slice | 25.4KB | 25.4KB | — |
| array/reverse | 25.4KB | 25.4KB | — |
| array/forEach | 27.8KB | 27.8KB | — |
| array/find | 61.8KB | 61.8KB | 634B |
| dom/create-elements | 1.9KB | — | — |
| dom/set-attributes | 2.3KB | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | 1.9KB | — | — |
| mixed/csv-parse | 27.8KB | 27.8KB | — |
| mixed/text-search | 27.7KB | 27.7KB | 1.9KB |
| mixed/fibonacci | 1.2KB | 1.2KB | 411B |
| mixed/matrix-multiply | 26.6KB | 26.6KB | 991B |
| mixed/sieve | 26.5KB | 26.5KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1276.3ms | 542.0ms | — |
| string/concat-long | 1020.5ms | 958.3ms | — |
| string/indexOf | 943.2ms | 934.9ms | 526.8ms |
| string/includes | 944.8ms | 917.0ms | 540.9ms |
| string/split | 1054.8ms | 1002.7ms | — |
| string/replace | 1093.5ms | 1122.6ms | — |
| string/case-convert | 1013.5ms | 1006.5ms | — |
| string/substring | 477.2ms | 483.1ms | — |
| string/trim | 1006.3ms | 1004.1ms | — |
| string/startsWith-endsWith | 1043.1ms | 1051.2ms | 582.6ms |
| array/push-pop | 990.0ms | 996.1ms | — |
| array/sort-i32 | 1098.0ms | 1060.0ms | — |
| array/map-filter | 1146.0ms | 1132.5ms | — |
| array/reduce | 1095.0ms | 1069.2ms | — |
| array/indexOf | 1029.4ms | 1006.4ms | — |
| array/slice | 1002.9ms | 1001.2ms | — |
| array/reverse | 1013.4ms | 1001.0ms | — |
| array/forEach | 1043.2ms | 1029.5ms | — |
| array/find | 2348.7ms | 2294.2ms | 530.3ms |
| dom/create-elements | 633.0ms | — | — |
| dom/set-attributes | 577.4ms | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | 563.2ms | — | — |
| mixed/csv-parse | 1041.0ms | 1008.7ms | — |
| mixed/text-search | 1047.9ms | 1041.6ms | 620.6ms |
| mixed/fibonacci | 527.5ms | 506.5ms | 449.4ms |
| mixed/matrix-multiply | 1062.9ms | 1031.1ms | 495.3ms |
| mixed/sieve | 1048.3ms | 1052.5ms | — |
