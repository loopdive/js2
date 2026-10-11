# js2wasm Benchmark Results

Date: 2026-10-11
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.027ms | 0.040ms | 0.039ms | FAILED | js |
| string/concat-long | 0.003ms | 0.004ms | 0.003ms | FAILED | gc-native |
| string/indexOf | 0.015ms | 0.047ms | 0.010ms | 0.014ms | gc-native |
| string/includes | 0.015ms | 0.094ms | 0.011ms | 0.013ms | gc-native |
| string/split | 0.331ms | 5.88ms | 2.07ms | FAILED | js |
| string/replace | 0.076ms | 0.479ms | 0.216ms | FAILED | js |
| string/case-convert | 0.045ms | 0.427ms | 0.189ms | FAILED | js |
| string/substring | 0.081ms | 0.031ms | 0.027ms | FAILED | gc-native |
| string/trim | 0.137ms | 2.62ms | 1.85ms | FAILED | js |
| string/startsWith-endsWith | 0.320ms | 1.98ms | 1.96ms | 0.433ms | js |
| array/push-pop | 1.31ms | 0.477ms | 0.478ms | FAILED | host-call |
| array/sort-i32 | 0.663ms | 0.238ms | 0.237ms | FAILED | gc-native |
| array/map-filter | 0.111ms | 0.053ms | 0.053ms | FAILED | host-call |
| array/reduce | 1.27ms | 0.475ms | 0.471ms | FAILED | gc-native |
| array/indexOf | 3.46ms | 2.23ms | 2.23ms | FAILED | gc-native |
| array/slice | 0.034ms | 0.015ms | 0.014ms | FAILED | gc-native |
| array/reverse | 6.86ms | 3.08ms | 3.08ms | FAILED | host-call |
| array/forEach | 0.043ms | 0.023ms | 0.023ms | FAILED | gc-native |
| array/find | 0.213ms | 0.012ms | 0.013ms | 0.940ms | host-call |
| dom/create-elements | 0.030ms | 0.120ms | — | — | js |
| dom/set-attributes | 0.086ms | 0.185ms | — | — | js |
| dom/read-attributes | 0.049ms | 0.103ms | — | — | js |
| dom/modify-text | 0.023ms | 0.088ms | — | — | js |
| mixed/csv-parse | 0.366ms | 6.40ms | 0.431ms | FAILED | js |
| mixed/text-search | 0.312ms | 3.21ms | 1.93ms | 0.878ms | js |
| mixed/fibonacci | 0.097ms | 0.254ms | 0.254ms | 0.253ms | js |
| mixed/matrix-multiply | 0.147ms | 53.19ms | 54.27ms | 0.565ms | js |
| mixed/sieve | 1.42ms | 1.83ms | 1.81ms | FAILED | js |

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
| string/concat-short | 10000 | 2.74 | 4.02 | 3.86 | — |
| string/concat-long | 1000 | 3.37 | 4.46 | 2.94 | — |
| string/indexOf | 1000 | 14.78 | 46.68 | 9.81 | 14.43 |
| string/includes | 1000 | 14.54 | 94.11 | 11.13 | 13.07 |
| string/split | 10000 | 33.12 | 587.58 | 207.25 | — |
| string/replace | 1000 | 76.23 | 479.39 | 216.49 | — |
| string/case-convert | 2000 | 22.48 | 213.64 | 94.40 | — |
| string/substring | 10000 | 8.11 | 3.09 | 2.67 | — |
| string/trim | 10000 | 13.67 | 261.90 | 185.49 | — |
| string/startsWith-endsWith | 20000 | 16.02 | 99.06 | 97.82 | 21.63 |
| array/map-filter | 30000 | 3.69 | 1.76 | 1.76 | — |
| array/indexOf | 1000 | 3460.10 | 2228.23 | 2226.74 | — |
| dom/create-elements | 2000 | 15.18 | 60.19 | — | — |
| dom/set-attributes | 6000 | 14.29 | 30.91 | — | — |
| dom/read-attributes | 3000 | 16.29 | 34.45 | — | — |
| dom/modify-text | 2000 | 11.45 | 43.97 | — | — |
| mixed/csv-parse | 11000 | 33.30 | 581.81 | 39.18 | — |
| mixed/text-search | 40000 | 7.81 | 80.33 | 48.18 | 21.95 |
| mixed/fibonacci | 10000 | 9.72 | 25.40 | 25.40 | 25.25 |
| mixed/matrix-multiply | 125000 | 1.17 | 425.55 | 434.13 | 4.52 |
| mixed/sieve | 200000 | 7.11 | 9.15 | 9.04 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.47x slower | 1.41x slower | — |
| string/concat-long | 1.33x slower | 1.14x faster | — |
| string/indexOf | 3.16x slower | 1.51x faster | 1.02x faster |
| string/includes | 6.47x slower | 1.31x faster | 1.11x faster |
| string/split | 17.74x slower | 6.26x slower | — |
| string/replace | 6.29x slower | 2.84x slower | — |
| string/case-convert | 9.50x slower | 4.20x slower | — |
| string/substring | 2.62x faster | 3.04x faster | — |
| string/trim | 19.16x slower | 13.57x slower | — |
| string/startsWith-endsWith | 6.18x slower | 6.11x slower | 1.35x slower |
| array/push-pop | 2.75x faster | 2.75x faster | — |
| array/sort-i32 | 2.78x faster | 2.80x faster | — |
| array/map-filter | 2.09x faster | 2.09x faster | — |
| array/reduce | 2.68x faster | 2.69x faster | — |
| array/indexOf | 1.55x faster | 1.55x faster | — |
| array/slice | 2.30x faster | 2.32x faster | — |
| array/reverse | 2.23x faster | 2.23x faster | — |
| array/forEach | 1.90x faster | 1.91x faster | — |
| array/find | 17.83x faster | 17.03x faster | 4.41x slower |
| dom/create-elements | 3.97x slower | — | — |
| dom/set-attributes | 2.16x slower | — | — |
| dom/read-attributes | 2.11x slower | — | — |
| dom/modify-text | 3.84x slower | — | — |
| mixed/csv-parse | 17.47x slower | 1.18x slower | — |
| mixed/text-search | 10.28x slower | 6.17x slower | 2.81x slower |
| mixed/fibonacci | 2.61x slower | 2.61x slower | 2.60x slower |
| mixed/matrix-multiply | 362.94x slower | 370.26x slower | 3.85x slower |
| mixed/sieve | 1.29x slower | 1.27x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.04x faster |
| string/concat-long | 1.52x faster |
| string/indexOf | 4.76x faster |
| string/includes | 8.45x faster |
| string/split | 2.84x faster |
| string/replace | 2.21x faster |
| string/case-convert | 2.26x faster |
| string/substring | 1.16x faster |
| string/trim | 1.41x faster |
| string/startsWith-endsWith | 1.01x faster |
| array/push-pop | 1.00x slower |
| array/sort-i32 | 1.00x faster |
| array/map-filter | 1.00x slower |
| array/reduce | 1.01x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.01x faster |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x faster |
| array/find | 1.05x slower |
| mixed/csv-parse | 14.85x faster |
| mixed/text-search | 1.67x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.02x slower |
| mixed/sieve | 1.01x faster |

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
| string/concat-short | 904.8ms | 455.9ms | — |
| string/concat-long | 351.8ms | 513.2ms | — |
| string/indexOf | 294.4ms | 526.8ms | 421.2ms |
| string/includes | 280.1ms | 532.4ms | 443.0ms |
| string/split | 388.3ms | 532.6ms | — |
| string/replace | 383.4ms | 581.3ms | — |
| string/case-convert | 403.6ms | 464.5ms | — |
| string/substring | 290.6ms | 345.4ms | — |
| string/trim | 361.4ms | 521.3ms | — |
| string/startsWith-endsWith | 544.1ms | 520.3ms | 484.1ms |
| array/push-pop | 398.9ms | 436.9ms | — |
| array/sort-i32 | 521.4ms | 553.3ms | — |
| array/map-filter | 538.6ms | 585.8ms | — |
| array/reduce | 466.0ms | 527.6ms | — |
| array/indexOf | 459.9ms | 510.4ms | — |
| array/slice | 404.1ms | 489.6ms | — |
| array/reverse | 381.3ms | 439.1ms | — |
| array/forEach | 478.4ms | 547.3ms | — |
| array/find | 388.2ms | 433.4ms | 417.7ms |
| dom/create-elements | 331.8ms | — | — |
| dom/set-attributes | 300.7ms | — | — |
| dom/read-attributes | 307.8ms | — | — |
| dom/modify-text | 292.1ms | — | — |
| mixed/csv-parse | 405.7ms | 508.2ms | — |
| mixed/text-search | 384.9ms | 543.3ms | 465.8ms |
| mixed/fibonacci | 355.3ms | 384.4ms | 390.0ms |
| mixed/matrix-multiply | 500.9ms | 539.2ms | 411.0ms |
| mixed/sieve | 519.8ms | 510.5ms | — |
