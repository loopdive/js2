# js2wasm Benchmark Results

Date: 2026-10-30
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.024ms | 0.039ms | 0.038ms | FAILED | js |
| string/concat-long | 0.003ms | 0.002ms | 0.002ms | FAILED | gc-native |
| string/indexOf | 0.015ms | 0.013ms | 0.013ms | 0.013ms | host-call |
| string/includes | 0.015ms | 0.015ms | 0.015ms | 0.013ms | linear-memory |
| string/split | 0.333ms | 0.392ms | 0.392ms | FAILED | js |
| string/replace | 0.074ms | 0.042ms | 0.042ms | FAILED | gc-native |
| string/case-convert | 0.045ms | 0.006ms | 0.006ms | FAILED | host-call |
| string/substring | 0.081ms | 0.027ms | 0.027ms | FAILED | gc-native |
| string/trim | 0.134ms | 0.137ms | 0.136ms | FAILED | js |
| string/startsWith-endsWith | 0.320ms | 0.181ms | 0.181ms | 0.433ms | gc-native |
| array/push-pop | 1.34ms | 0.493ms | 0.495ms | FAILED | host-call |
| array/sort-i32 | 0.666ms | 0.337ms | 0.341ms | FAILED | host-call |
| array/map-filter | 0.114ms | 0.058ms | 0.062ms | FAILED | host-call |
| array/reduce | 1.34ms | 0.497ms | 0.496ms | FAILED | gc-native |
| array/indexOf | 3.46ms | 4.62ms | 4.62ms | FAILED | js |
| array/slice | 0.032ms | 0.014ms | 0.014ms | FAILED | host-call |
| array/reverse | 6.87ms | 2.79ms | 2.79ms | FAILED | host-call |
| array/forEach | 0.043ms | 0.041ms | 0.041ms | FAILED | host-call |
| array/find | 0.212ms | 0.009ms | 0.009ms | 0.945ms | gc-native |
| dom/create-elements | 0.030ms | 0.722ms | — | — | js |
| dom/set-attributes | 0.085ms | 4.98ms | — | — | js |
| dom/read-attributes | 0.050ms | FAILED | — | — | js |
| dom/modify-text | 0.023ms | 1.30ms | — | — | js |
| mixed/csv-parse | 0.366ms | 0.243ms | 0.241ms | FAILED | gc-native |
| mixed/text-search | 0.315ms | 0.226ms | 0.226ms | 0.871ms | gc-native |
| mixed/fibonacci | 0.097ms | 0.254ms | 0.254ms | 1.09ms | js |
| mixed/matrix-multiply | 0.146ms | 0.166ms | 0.165ms | 0.566ms | js |
| mixed/sieve | 1.47ms | 1.83ms | 1.82ms | FAILED | js |

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
| string/concat-short | 10000 | 2.37 | 3.94 | 3.82 | — |
| string/concat-long | 1000 | 3.06 | 2.45 | 2.43 | — |
| string/indexOf | 1000 | 14.77 | 12.67 | 12.71 | 12.94 |
| string/includes | 1000 | 14.53 | 15.42 | 15.44 | 13.04 |
| string/split | 10000 | 33.34 | 39.17 | 39.15 | — |
| string/replace | 1000 | 73.90 | 42.23 | 42.05 | — |
| string/case-convert | 2000 | 22.47 | 2.87 | 2.87 | — |
| string/substring | 10000 | 8.13 | 2.67 | 2.67 | — |
| string/trim | 10000 | 13.41 | 13.69 | 13.63 | — |
| string/startsWith-endsWith | 20000 | 16.00 | 9.05 | 9.04 | 21.64 |
| array/map-filter | 30000 | 3.82 | 1.95 | 2.07 | — |
| array/indexOf | 1000 | 3461.01 | 4617.10 | 4615.27 | — |
| dom/create-elements | 2000 | 15.02 | 361.12 | — | — |
| dom/set-attributes | 6000 | 14.23 | 829.18 | — | — |
| dom/read-attributes | 3000 | 16.63 | — | — | — |
| dom/modify-text | 2000 | 11.49 | 650.35 | — | — |
| mixed/csv-parse | 11000 | 33.24 | 22.12 | 21.93 | — |
| mixed/text-search | 40000 | 7.88 | 5.66 | 5.64 | 21.78 |
| mixed/fibonacci | 10000 | 9.71 | 25.41 | 25.40 | 109.14 |
| mixed/matrix-multiply | 125000 | 1.17 | 1.33 | 1.32 | 4.53 |
| mixed/sieve | 200000 | 7.34 | 9.14 | 9.12 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.66x slower | 1.61x slower | — |
| string/concat-long | 1.25x faster | 1.26x faster | — |
| string/indexOf | 1.17x faster | 1.16x faster | 1.14x faster |
| string/includes | 1.06x slower | 1.06x slower | 1.11x faster |
| string/split | 1.17x slower | 1.17x slower | — |
| string/replace | 1.75x faster | 1.76x faster | — |
| string/case-convert | 7.84x faster | 7.84x faster | — |
| string/substring | 3.05x faster | 3.05x faster | — |
| string/trim | 1.02x slower | 1.02x slower | — |
| string/startsWith-endsWith | 1.77x faster | 1.77x faster | 1.35x slower |
| array/push-pop | 2.71x faster | 2.70x faster | — |
| array/sort-i32 | 1.98x faster | 1.95x faster | — |
| array/map-filter | 1.96x faster | 1.84x faster | — |
| array/reduce | 2.70x faster | 2.70x faster | — |
| array/indexOf | 1.33x slower | 1.33x slower | — |
| array/slice | 2.24x faster | 2.21x faster | — |
| array/reverse | 2.46x faster | 2.46x faster | — |
| array/forEach | 1.04x faster | 1.04x faster | — |
| array/find | 23.83x faster | 23.95x faster | 4.46x slower |
| dom/create-elements | 24.04x slower | — | — |
| dom/set-attributes | 58.28x slower | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | 56.62x slower | — | — |
| mixed/csv-parse | 1.50x faster | 1.52x faster | — |
| mixed/text-search | 1.39x faster | 1.40x faster | 2.76x slower |
| mixed/fibonacci | 2.62x slower | 2.62x slower | 11.24x slower |
| mixed/matrix-multiply | 1.13x slower | 1.13x slower | 3.87x slower |
| mixed/sieve | 1.25x slower | 1.24x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.03x faster |
| string/concat-long | 1.01x faster |
| string/indexOf | 1.00x slower |
| string/includes | 1.00x slower |
| string/split | 1.00x faster |
| string/replace | 1.00x faster |
| string/case-convert | 1.00x slower |
| string/substring | 1.00x faster |
| string/trim | 1.00x faster |
| string/startsWith-endsWith | 1.00x faster |
| array/push-pop | 1.00x slower |
| array/sort-i32 | 1.01x slower |
| array/map-filter | 1.06x slower |
| array/reduce | 1.00x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.01x slower |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x slower |
| array/find | 1.00x faster |
| mixed/csv-parse | 1.01x faster |
| mixed/text-search | 1.00x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.00x faster |
| mixed/sieve | 1.00x faster |

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
| string/concat-short | 1104.4ms | 471.5ms | — |
| string/concat-long | 895.5ms | 763.4ms | — |
| string/indexOf | 763.0ms | 771.3ms | 462.5ms |
| string/includes | 788.2ms | 789.6ms | 474.7ms |
| string/split | 850.5ms | 851.8ms | — |
| string/replace | 883.8ms | 888.5ms | — |
| string/case-convert | 848.5ms | 850.7ms | — |
| string/substring | 409.0ms | 421.0ms | — |
| string/trim | 831.5ms | 831.9ms | — |
| string/startsWith-endsWith | 838.2ms | 860.2ms | 516.0ms |
| array/push-pop | 837.3ms | 850.2ms | — |
| array/sort-i32 | 903.7ms | 883.9ms | — |
| array/map-filter | 956.5ms | 946.5ms | — |
| array/reduce | 901.3ms | 885.0ms | — |
| array/indexOf | 844.0ms | 836.8ms | — |
| array/slice | 813.6ms | 836.4ms | — |
| array/reverse | 828.1ms | 836.9ms | — |
| array/forEach | 859.1ms | 877.3ms | — |
| array/find | 2424.7ms | 2369.2ms | 459.1ms |
| dom/create-elements | 536.5ms | — | — |
| dom/set-attributes | 498.5ms | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | 507.4ms | — | — |
| mixed/csv-parse | 850.9ms | 857.5ms | — |
| mixed/text-search | 849.5ms | 863.8ms | 513.0ms |
| mixed/fibonacci | 446.0ms | 433.1ms | 401.3ms |
| mixed/matrix-multiply | 863.4ms | 860.7ms | 433.7ms |
| mixed/sieve | 880.3ms | 851.1ms | — |
