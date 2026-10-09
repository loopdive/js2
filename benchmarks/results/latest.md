# js2wasm Benchmark Results

Date: 2026-10-09
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.035ms | 0.053ms | 0.048ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.003ms | FAILED | gc-native |
| string/indexOf | 0.019ms | 0.061ms | 0.012ms | 0.041ms | gc-native |
| string/includes | 0.019ms | 0.124ms | 0.014ms | 0.025ms | gc-native |
| string/split | 0.436ms | 7.97ms | 2.70ms | FAILED | js |
| string/replace | 0.092ms | 0.583ms | 0.283ms | FAILED | js |
| string/case-convert | 0.061ms | 0.556ms | 0.244ms | FAILED | js |
| string/substring | 0.105ms | 0.040ms | 0.034ms | FAILED | gc-native |
| string/trim | 0.173ms | 3.33ms | 2.42ms | FAILED | js |
| string/startsWith-endsWith | 0.413ms | 2.58ms | 2.59ms | 0.553ms | js |
| array/push-pop | 1.65ms | 0.608ms | 0.608ms | FAILED | gc-native |
| array/sort-i32 | 0.847ms | 0.299ms | 0.301ms | FAILED | host-call |
| array/map-filter | 0.135ms | 0.066ms | 0.066ms | FAILED | host-call |
| array/reduce | 1.61ms | 0.603ms | 0.614ms | FAILED | host-call |
| array/indexOf | 4.46ms | 2.87ms | 2.87ms | FAILED | gc-native |
| array/slice | 0.037ms | 0.017ms | 0.017ms | FAILED | host-call |
| array/reverse | 8.85ms | 3.97ms | 3.97ms | FAILED | host-call |
| array/forEach | 0.053ms | 0.029ms | 0.029ms | FAILED | gc-native |
| array/find | 0.271ms | 0.015ms | 0.015ms | 1.20ms | host-call |
| dom/create-elements | 0.038ms | 0.100ms | — | — | js |
| dom/set-attributes | 0.109ms | 0.237ms | — | — | js |
| dom/read-attributes | 0.061ms | 0.137ms | — | — | js |
| dom/modify-text | 0.030ms | 0.114ms | — | — | js |
| mixed/csv-parse | 0.961ms | 8.53ms | 0.567ms | FAILED | gc-native |
| mixed/text-search | 0.403ms | 4.43ms | 2.56ms | 1.12ms | js |
| mixed/fibonacci | 0.125ms | 0.327ms | 0.327ms | 0.325ms | js |
| mixed/matrix-multiply | 0.186ms | 67.09ms | 71.21ms | 0.725ms | js |
| mixed/sieve | 1.80ms | 2.33ms | 2.33ms | FAILED | js |

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
| string/concat-short | 10000 | 3.55 | 5.26 | 4.79 | — |
| string/concat-long | 1000 | 3.98 | 5.33 | 3.43 | — |
| string/indexOf | 1000 | 19.00 | 60.53 | 12.27 | 40.70 |
| string/includes | 1000 | 18.71 | 123.92 | 13.95 | 25.24 |
| string/split | 10000 | 43.60 | 797.35 | 270.06 | — |
| string/replace | 1000 | 92.38 | 583.35 | 282.65 | — |
| string/case-convert | 2000 | 30.30 | 278.21 | 122.08 | — |
| string/substring | 10000 | 10.46 | 3.98 | 3.44 | — |
| string/trim | 10000 | 17.30 | 333.47 | 241.84 | — |
| string/startsWith-endsWith | 20000 | 20.66 | 129.19 | 129.67 | 27.65 |
| array/map-filter | 30000 | 4.49 | 2.19 | 2.20 | — |
| array/indexOf | 1000 | 4457.70 | 2874.62 | 2873.53 | — |
| dom/create-elements | 2000 | 18.92 | 50.12 | — | — |
| dom/set-attributes | 6000 | 18.23 | 39.51 | — | — |
| dom/read-attributes | 3000 | 20.25 | 45.54 | — | — |
| dom/modify-text | 2000 | 14.94 | 56.87 | — | — |
| mixed/csv-parse | 11000 | 87.34 | 775.57 | 51.54 | — |
| mixed/text-search | 40000 | 10.07 | 110.66 | 63.92 | 28.09 |
| mixed/fibonacci | 10000 | 12.53 | 32.75 | 32.74 | 32.50 |
| mixed/matrix-multiply | 125000 | 1.49 | 536.69 | 569.71 | 5.80 |
| mixed/sieve | 200000 | 9.01 | 11.65 | 11.66 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.48x slower | 1.35x slower | — |
| string/concat-long | 1.34x slower | 1.16x faster | — |
| string/indexOf | 3.19x slower | 1.55x faster | 2.14x slower |
| string/includes | 6.62x slower | 1.34x faster | 1.35x slower |
| string/split | 18.29x slower | 6.19x slower | — |
| string/replace | 6.31x slower | 3.06x slower | — |
| string/case-convert | 9.18x slower | 4.03x slower | — |
| string/substring | 2.62x faster | 3.04x faster | — |
| string/trim | 19.28x slower | 13.98x slower | — |
| string/startsWith-endsWith | 6.25x slower | 6.28x slower | 1.34x slower |
| array/push-pop | 2.71x faster | 2.72x faster | — |
| array/sort-i32 | 2.84x faster | 2.82x faster | — |
| array/map-filter | 2.05x faster | 2.04x faster | — |
| array/reduce | 2.66x faster | 2.62x faster | — |
| array/indexOf | 1.55x faster | 1.55x faster | — |
| array/slice | 2.21x faster | 2.19x faster | — |
| array/reverse | 2.23x faster | 2.23x faster | — |
| array/forEach | 1.83x faster | 1.84x faster | — |
| array/find | 18.43x faster | 18.21x faster | 4.44x slower |
| dom/create-elements | 2.65x slower | — | — |
| dom/set-attributes | 2.17x slower | — | — |
| dom/read-attributes | 2.25x slower | — | — |
| dom/modify-text | 3.81x slower | — | — |
| mixed/csv-parse | 8.88x slower | 1.69x faster | — |
| mixed/text-search | 10.99x slower | 6.34x slower | 2.79x slower |
| mixed/fibonacci | 2.61x slower | 2.61x slower | 2.59x slower |
| mixed/matrix-multiply | 360.94x slower | 383.15x slower | 3.90x slower |
| mixed/sieve | 1.29x slower | 1.29x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.10x faster |
| string/concat-long | 1.56x faster |
| string/indexOf | 4.93x faster |
| string/includes | 8.88x faster |
| string/split | 2.95x faster |
| string/replace | 2.06x faster |
| string/case-convert | 2.28x faster |
| string/substring | 1.16x faster |
| string/trim | 1.38x faster |
| string/startsWith-endsWith | 1.00x slower |
| array/push-pop | 1.00x faster |
| array/sort-i32 | 1.01x slower |
| array/map-filter | 1.00x slower |
| array/reduce | 1.02x slower |
| array/indexOf | 1.00x faster |
| array/slice | 1.01x slower |
| array/reverse | 1.00x slower |
| array/forEach | 1.01x faster |
| array/find | 1.01x slower |
| mixed/csv-parse | 15.05x faster |
| mixed/text-search | 1.73x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.06x slower |
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
| string/concat-short | 1149.8ms | 607.8ms | — |
| string/concat-long | 428.7ms | 638.1ms | — |
| string/indexOf | 386.9ms | 664.1ms | 544.8ms |
| string/includes | 381.4ms | 640.3ms | 529.7ms |
| string/split | 501.7ms | 667.1ms | — |
| string/replace | 499.0ms | 747.9ms | — |
| string/case-convert | 508.5ms | 641.7ms | — |
| string/substring | 392.2ms | 448.3ms | — |
| string/trim | 491.5ms | 681.8ms | — |
| string/startsWith-endsWith | 474.2ms | 668.3ms | 624.4ms |
| array/push-pop | 528.0ms | 580.2ms | — |
| array/sort-i32 | 669.6ms | 740.5ms | — |
| array/map-filter | 681.1ms | 736.5ms | — |
| array/reduce | 608.1ms | 669.9ms | — |
| array/indexOf | 566.3ms | 701.6ms | — |
| array/slice | 515.9ms | 585.5ms | — |
| array/reverse | 493.3ms | 575.4ms | — |
| array/forEach | 627.2ms | 681.9ms | — |
| array/find | 483.6ms | 580.5ms | 522.9ms |
| dom/create-elements | 414.8ms | — | — |
| dom/set-attributes | 394.5ms | — | — |
| dom/read-attributes | 387.3ms | — | — |
| dom/modify-text | 377.2ms | — | — |
| mixed/csv-parse | 516.5ms | 658.9ms | — |
| mixed/text-search | 487.6ms | 672.1ms | 608.3ms |
| mixed/fibonacci | 447.2ms | 501.8ms | 486.0ms |
| mixed/matrix-multiply | 630.7ms | 682.0ms | 511.9ms |
| mixed/sieve | 585.0ms | 681.1ms | — |
