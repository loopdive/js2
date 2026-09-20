# js2wasm Benchmark Results

Date: 2026-09-20
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.034ms | 0.052ms | 0.051ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.003ms | FAILED | gc-native |
| string/indexOf | 0.019ms | 0.060ms | 0.012ms | 0.017ms | gc-native |
| string/includes | 0.019ms | 0.132ms | 0.014ms | 0.017ms | gc-native |
| string/split | 0.435ms | 7.99ms | 2.63ms | FAILED | js |
| string/replace | 0.096ms | 0.602ms | 0.277ms | FAILED | js |
| string/case-convert | 0.061ms | 0.550ms | 0.240ms | FAILED | js |
| string/substring | 0.104ms | 0.040ms | 0.034ms | FAILED | gc-native |
| string/trim | 0.173ms | 3.38ms | 2.38ms | FAILED | js |
| string/startsWith-endsWith | 0.413ms | 2.51ms | 2.54ms | 0.566ms | js |
| array/push-pop | 1.63ms | 0.605ms | 0.599ms | FAILED | gc-native |
| array/sort-i32 | 0.842ms | 0.293ms | 0.302ms | FAILED | host-call |
| array/map-filter | 0.134ms | 0.065ms | 0.066ms | FAILED | host-call |
| array/reduce | 2.39ms | 0.597ms | 0.599ms | FAILED | host-call |
| array/indexOf | 4.46ms | 2.86ms | 2.86ms | FAILED | gc-native |
| array/slice | 0.034ms | 0.017ms | 0.017ms | FAILED | host-call |
| array/reverse | 8.84ms | 3.97ms | 3.97ms | FAILED | host-call |
| array/forEach | 0.093ms | 0.029ms | 0.029ms | FAILED | gc-native |
| array/find | 0.273ms | 0.015ms | 0.015ms | 1.21ms | gc-native |
| dom/create-elements | 0.038ms | 0.101ms | — | — | js |
| dom/set-attributes | 0.108ms | 0.237ms | — | — | js |
| dom/read-attributes | 0.063ms | 0.149ms | — | — | js |
| dom/modify-text | 0.029ms | 0.114ms | — | — | js |
| mixed/csv-parse | 1.28ms | 8.18ms | 0.548ms | FAILED | gc-native |
| mixed/text-search | 0.403ms | 4.23ms | 2.45ms | 1.13ms | js |
| mixed/fibonacci | 0.125ms | 0.327ms | 0.328ms | 0.325ms | js |
| mixed/matrix-multiply | 0.184ms | 68.75ms | 70.94ms | 0.719ms | js |
| mixed/sieve | 1.76ms | 2.30ms | 2.30ms | FAILED | js |

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
| string/concat-short | 10000 | 3.39 | 5.21 | 5.06 | — |
| string/concat-long | 1000 | 3.98 | 5.05 | 3.42 | — |
| string/indexOf | 1000 | 19.00 | 59.96 | 12.20 | 17.13 |
| string/includes | 1000 | 18.70 | 132.24 | 13.75 | 16.66 |
| string/split | 10000 | 43.47 | 799.40 | 263.38 | — |
| string/replace | 1000 | 96.36 | 601.89 | 276.65 | — |
| string/case-convert | 2000 | 30.41 | 275.25 | 120.05 | — |
| string/substring | 10000 | 10.41 | 4.02 | 3.44 | — |
| string/trim | 10000 | 17.29 | 337.69 | 238.31 | — |
| string/startsWith-endsWith | 20000 | 20.64 | 125.31 | 126.95 | 28.28 |
| array/map-filter | 30000 | 4.48 | 2.18 | 2.19 | — |
| array/indexOf | 1000 | 4456.17 | 2862.08 | 2859.64 | — |
| dom/create-elements | 2000 | 18.84 | 50.71 | — | — |
| dom/set-attributes | 6000 | 18.02 | 39.43 | — | — |
| dom/read-attributes | 3000 | 20.84 | 49.69 | — | — |
| dom/modify-text | 2000 | 14.61 | 57.05 | — | — |
| mixed/csv-parse | 11000 | 116.60 | 743.89 | 49.86 | — |
| mixed/text-search | 40000 | 10.08 | 105.73 | 61.21 | 28.26 |
| mixed/fibonacci | 10000 | 12.53 | 32.73 | 32.75 | 32.50 |
| mixed/matrix-multiply | 125000 | 1.47 | 549.97 | 567.54 | 5.75 |
| mixed/sieve | 200000 | 8.80 | 11.50 | 11.52 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.54x slower | 1.49x slower | — |
| string/concat-long | 1.27x slower | 1.16x faster | — |
| string/indexOf | 3.16x slower | 1.56x faster | 1.11x faster |
| string/includes | 7.07x slower | 1.36x faster | 1.12x faster |
| string/split | 18.39x slower | 6.06x slower | — |
| string/replace | 6.25x slower | 2.87x slower | — |
| string/case-convert | 9.05x slower | 3.95x slower | — |
| string/substring | 2.59x faster | 3.03x faster | — |
| string/trim | 19.53x slower | 13.79x slower | — |
| string/startsWith-endsWith | 6.07x slower | 6.15x slower | 1.37x slower |
| array/push-pop | 2.70x faster | 2.73x faster | — |
| array/sort-i32 | 2.88x faster | 2.79x faster | — |
| array/map-filter | 2.05x faster | 2.05x faster | — |
| array/reduce | 4.00x faster | 3.99x faster | — |
| array/indexOf | 1.56x faster | 1.56x faster | — |
| array/slice | 2.06x faster | 2.05x faster | — |
| array/reverse | 2.23x faster | 2.23x faster | — |
| array/forEach | 3.20x faster | 3.24x faster | — |
| array/find | 18.17x faster | 18.43x faster | 4.43x slower |
| dom/create-elements | 2.69x slower | — | — |
| dom/set-attributes | 2.19x slower | — | — |
| dom/read-attributes | 2.38x slower | — | — |
| dom/modify-text | 3.90x slower | — | — |
| mixed/csv-parse | 6.38x slower | 2.34x faster | — |
| mixed/text-search | 10.49x slower | 6.07x slower | 2.80x slower |
| mixed/fibonacci | 2.61x slower | 2.61x slower | 2.59x slower |
| mixed/matrix-multiply | 373.12x slower | 385.04x slower | 3.90x slower |
| mixed/sieve | 1.31x slower | 1.31x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.03x faster |
| string/concat-long | 1.48x faster |
| string/indexOf | 4.91x faster |
| string/includes | 9.62x faster |
| string/split | 3.04x faster |
| string/replace | 2.18x faster |
| string/case-convert | 2.29x faster |
| string/substring | 1.17x faster |
| string/trim | 1.42x faster |
| string/startsWith-endsWith | 1.01x slower |
| array/push-pop | 1.01x faster |
| array/sort-i32 | 1.03x slower |
| array/map-filter | 1.00x slower |
| array/reduce | 1.00x slower |
| array/indexOf | 1.00x faster |
| array/slice | 1.00x slower |
| array/reverse | 1.00x slower |
| array/forEach | 1.01x faster |
| array/find | 1.01x faster |
| mixed/csv-parse | 14.92x faster |
| mixed/text-search | 1.73x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.03x slower |
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
| array/sort-i32 | 3.3KB | 3.9KB | — |
| array/map-filter | 4.5KB | 5.0KB | — |
| array/reduce | 3.1KB | 3.6KB | — |
| array/indexOf | 2.1KB | 2.5KB | — |
| array/slice | 1.3KB | 1.7KB | — |
| array/reverse | 1.2KB | 1.7KB | — |
| array/forEach | 3.5KB | 4.1KB | — |
| array/find | 1.2KB | 1.6KB | 634B |
| dom/create-elements | 271B | — | — |
| dom/set-attributes | 524B | — | — |
| dom/read-attributes | 389B | — | — |
| dom/modify-text | 264B | — | — |
| mixed/csv-parse | 2.5KB | 4.5KB | — |
| mixed/text-search | 2.2KB | 4.3KB | 1.9KB |
| mixed/fibonacci | 438B | 438B | 411B |
| mixed/matrix-multiply | 3.0KB | 3.6KB | 991B |
| mixed/sieve | 2.0KB | 2.4KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1083.1ms | 612.8ms | — |
| string/concat-long | 442.6ms | 630.6ms | — |
| string/indexOf | 367.3ms | 633.2ms | 543.7ms |
| string/includes | 363.5ms | 635.1ms | 553.4ms |
| string/split | 514.0ms | 666.1ms | — |
| string/replace | 480.5ms | 742.0ms | — |
| string/case-convert | 497.5ms | 604.7ms | — |
| string/substring | 375.7ms | 504.5ms | — |
| string/trim | 461.1ms | 675.6ms | — |
| string/startsWith-endsWith | 486.2ms | 660.3ms | 586.7ms |
| array/push-pop | 491.2ms | 566.5ms | — |
| array/sort-i32 | 646.4ms | 701.6ms | — |
| array/map-filter | 655.9ms | 725.2ms | — |
| array/reduce | 604.0ms | 693.5ms | — |
| array/indexOf | 578.9ms | 652.6ms | — |
| array/slice | 501.8ms | 594.1ms | — |
| array/reverse | 499.6ms | 593.2ms | — |
| array/forEach | 645.9ms | 735.8ms | — |
| array/find | 488.8ms | 583.3ms | 535.5ms |
| dom/create-elements | 417.0ms | — | — |
| dom/set-attributes | 387.5ms | — | — |
| dom/read-attributes | 373.3ms | — | — |
| dom/modify-text | 369.4ms | — | — |
| mixed/csv-parse | 513.5ms | 695.3ms | — |
| mixed/text-search | 500.2ms | 702.5ms | 598.2ms |
| mixed/fibonacci | 436.9ms | 502.3ms | 480.6ms |
| mixed/matrix-multiply | 635.8ms | 691.9ms | 507.9ms |
| mixed/sieve | 590.6ms | 672.7ms | — |
