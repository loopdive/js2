# js2wasm Benchmark Results

Date: 2026-10-01
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.028ms | 0.038ms | 0.038ms | FAILED | js |
| string/concat-long | 0.003ms | 0.004ms | 0.003ms | FAILED | gc-native |
| string/indexOf | 0.015ms | 0.047ms | 0.010ms | 0.032ms | gc-native |
| string/includes | 0.015ms | 0.080ms | 0.011ms | 0.021ms | gc-native |
| string/split | 0.328ms | 5.97ms | 2.08ms | FAILED | js |
| string/replace | 0.074ms | 0.452ms | 0.224ms | FAILED | js |
| string/case-convert | 0.045ms | 0.435ms | 0.194ms | FAILED | js |
| string/substring | 0.081ms | 0.031ms | 0.027ms | FAILED | gc-native |
| string/trim | 0.134ms | 2.59ms | 1.94ms | FAILED | js |
| string/startsWith-endsWith | 0.320ms | 2.07ms | 2.02ms | 0.432ms | js |
| array/push-pop | 1.34ms | 0.484ms | 0.488ms | FAILED | host-call |
| array/sort-i32 | 0.660ms | 0.233ms | 0.236ms | FAILED | host-call |
| array/map-filter | 0.109ms | 0.053ms | 0.053ms | FAILED | host-call |
| array/reduce | 1.29ms | 0.475ms | 0.482ms | FAILED | host-call |
| array/indexOf | 3.46ms | 2.22ms | 2.22ms | FAILED | gc-native |
| array/slice | 0.034ms | 0.015ms | 0.015ms | FAILED | gc-native |
| array/reverse | 6.86ms | 3.08ms | 3.08ms | FAILED | gc-native |
| array/forEach | 0.044ms | 0.023ms | 0.023ms | FAILED | gc-native |
| array/find | 0.214ms | 0.013ms | 0.012ms | 0.943ms | gc-native |
| dom/create-elements | 0.030ms | 0.079ms | — | — | js |
| dom/set-attributes | 0.087ms | 0.188ms | — | — | js |
| dom/read-attributes | 0.049ms | 0.104ms | — | — | js |
| dom/modify-text | 0.023ms | 0.088ms | — | — | js |
| mixed/csv-parse | 0.893ms | 6.42ms | 0.432ms | FAILED | gc-native |
| mixed/text-search | 0.312ms | 3.39ms | 1.93ms | 0.861ms | js |
| mixed/fibonacci | 0.097ms | 0.254ms | 0.254ms | 0.252ms | js |
| mixed/matrix-multiply | 0.147ms | 52.63ms | 55.28ms | 0.561ms | js |
| mixed/sieve | 1.44ms | 1.81ms | 1.81ms | FAILED | js |

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
| string/concat-short | 10000 | 2.76 | 3.76 | 3.82 | — |
| string/concat-long | 1000 | 3.36 | 4.46 | 3.03 | — |
| string/indexOf | 1000 | 14.79 | 47.08 | 9.88 | 31.50 |
| string/includes | 1000 | 14.56 | 79.66 | 11.12 | 21.09 |
| string/split | 10000 | 32.79 | 597.26 | 208.29 | — |
| string/replace | 1000 | 74.15 | 452.22 | 224.11 | — |
| string/case-convert | 2000 | 22.50 | 217.47 | 96.81 | — |
| string/substring | 10000 | 8.15 | 3.09 | 2.66 | — |
| string/trim | 10000 | 13.40 | 258.60 | 193.74 | — |
| string/startsWith-endsWith | 20000 | 16.00 | 103.63 | 101.14 | 21.60 |
| array/map-filter | 30000 | 3.65 | 1.76 | 1.76 | — |
| array/indexOf | 1000 | 3460.92 | 2224.30 | 2220.45 | — |
| dom/create-elements | 2000 | 15.25 | 39.63 | — | — |
| dom/set-attributes | 6000 | 14.49 | 31.35 | — | — |
| dom/read-attributes | 3000 | 16.43 | 34.56 | — | — |
| dom/modify-text | 2000 | 11.47 | 43.82 | — | — |
| mixed/csv-parse | 11000 | 81.15 | 583.87 | 39.29 | — |
| mixed/text-search | 40000 | 7.81 | 84.86 | 48.18 | 21.54 |
| mixed/fibonacci | 10000 | 9.71 | 25.42 | 25.40 | 25.24 |
| mixed/matrix-multiply | 125000 | 1.18 | 421.08 | 442.25 | 4.49 |
| mixed/sieve | 200000 | 7.22 | 9.03 | 9.07 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.36x slower | 1.38x slower | — |
| string/concat-long | 1.33x slower | 1.11x faster | — |
| string/indexOf | 3.18x slower | 1.50x faster | 2.13x slower |
| string/includes | 5.47x slower | 1.31x faster | 1.45x slower |
| string/split | 18.22x slower | 6.35x slower | — |
| string/replace | 6.10x slower | 3.02x slower | — |
| string/case-convert | 9.67x slower | 4.30x slower | — |
| string/substring | 2.64x faster | 3.06x faster | — |
| string/trim | 19.30x slower | 14.46x slower | — |
| string/startsWith-endsWith | 6.48x slower | 6.32x slower | 1.35x slower |
| array/push-pop | 2.77x faster | 2.75x faster | — |
| array/sort-i32 | 2.84x faster | 2.80x faster | — |
| array/map-filter | 2.08x faster | 2.07x faster | — |
| array/reduce | 2.71x faster | 2.67x faster | — |
| array/indexOf | 1.56x faster | 1.56x faster | — |
| array/slice | 2.28x faster | 2.30x faster | — |
| array/reverse | 2.22x faster | 2.23x faster | — |
| array/forEach | 1.92x faster | 1.93x faster | — |
| array/find | 17.01x faster | 17.64x faster | 4.41x slower |
| dom/create-elements | 2.60x slower | — | — |
| dom/set-attributes | 2.16x slower | — | — |
| dom/read-attributes | 2.10x slower | — | — |
| dom/modify-text | 3.82x slower | — | — |
| mixed/csv-parse | 7.19x slower | 2.07x faster | — |
| mixed/text-search | 10.87x slower | 6.17x slower | 2.76x slower |
| mixed/fibonacci | 2.62x slower | 2.62x slower | 2.60x slower |
| mixed/matrix-multiply | 357.75x slower | 375.73x slower | 3.81x slower |
| mixed/sieve | 1.25x slower | 1.26x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.02x slower |
| string/concat-long | 1.47x faster |
| string/indexOf | 4.77x faster |
| string/includes | 7.17x faster |
| string/split | 2.87x faster |
| string/replace | 2.02x faster |
| string/case-convert | 2.25x faster |
| string/substring | 1.16x faster |
| string/trim | 1.33x faster |
| string/startsWith-endsWith | 1.02x faster |
| array/push-pop | 1.01x slower |
| array/sort-i32 | 1.01x slower |
| array/map-filter | 1.00x slower |
| array/reduce | 1.01x slower |
| array/indexOf | 1.00x faster |
| array/slice | 1.01x faster |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x faster |
| array/find | 1.04x faster |
| mixed/csv-parse | 14.86x faster |
| mixed/text-search | 1.76x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.05x slower |
| mixed/sieve | 1.00x slower |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 209B | 745B | — |
| string/concat-long | 223B | 932B | — |
| string/indexOf | 254B | 1.1KB | 10.4KB |
| string/includes | 241B | 1.1KB | 10.4KB |
| string/split | 1.8KB | 3.5KB | — |
| string/replace | 1.9KB | 4.4KB | — |
| string/case-convert | 1.8KB | 2.5KB | — |
| string/substring | 202B | 279B | — |
| string/trim | 1.5KB | 3.1KB | — |
| string/startsWith-endsWith | 2.0KB | 4.0KB | 1.7KB |
| array/push-pop | 1.2KB | 1.6KB | — |
| array/sort-i32 | 3.3KB | 3.8KB | — |
| array/map-filter | 4.3KB | 4.8KB | — |
| array/reduce | 3.0KB | 3.5KB | — |
| array/indexOf | 2.1KB | 2.5KB | — |
| array/slice | 1.3KB | 1.7KB | — |
| array/reverse | 1.2KB | 1.7KB | — |
| array/forEach | 3.4KB | 4.0KB | — |
| array/find | 1.2KB | 1.6KB | 634B |
| dom/create-elements | 271B | — | — |
| dom/set-attributes | 524B | — | — |
| dom/read-attributes | 389B | — | — |
| dom/modify-text | 264B | — | — |
| mixed/csv-parse | 2.5KB | 4.5KB | — |
| mixed/text-search | 2.2KB | 4.3KB | 1.9KB |
| mixed/fibonacci | 438B | 438B | 411B |
| mixed/matrix-multiply | 3.5KB | 4.0KB | 991B |
| mixed/sieve | 2.5KB | 2.7KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 912.8ms | 480.2ms | — |
| string/concat-long | 337.7ms | 502.9ms | — |
| string/indexOf | 295.8ms | 522.3ms | 435.5ms |
| string/includes | 290.5ms | 512.4ms | 435.7ms |
| string/split | 383.9ms | 521.7ms | — |
| string/replace | 393.7ms | 558.1ms | — |
| string/case-convert | 417.5ms | 461.2ms | — |
| string/substring | 306.7ms | 360.3ms | — |
| string/trim | 393.8ms | 522.4ms | — |
| string/startsWith-endsWith | 380.2ms | 561.2ms | 486.7ms |
| array/push-pop | 391.7ms | 452.2ms | — |
| array/sort-i32 | 529.8ms | 544.0ms | — |
| array/map-filter | 536.0ms | 581.7ms | — |
| array/reduce | 484.4ms | 478.6ms | — |
| array/indexOf | 456.2ms | 503.3ms | — |
| array/slice | 392.8ms | 460.9ms | — |
| array/reverse | 380.6ms | 443.9ms | — |
| array/forEach | 496.4ms | 542.2ms | — |
| array/find | 382.1ms | 452.1ms | 422.7ms |
| dom/create-elements | 335.8ms | — | — |
| dom/set-attributes | 301.4ms | — | — |
| dom/read-attributes | 303.5ms | — | — |
| dom/modify-text | 297.6ms | — | — |
| mixed/csv-parse | 406.7ms | 520.2ms | — |
| mixed/text-search | 399.7ms | 536.7ms | 478.7ms |
| mixed/fibonacci | 344.5ms | 399.0ms | 369.4ms |
| mixed/matrix-multiply | 501.5ms | 545.9ms | 399.5ms |
| mixed/sieve | 495.9ms | 451.6ms | — |
