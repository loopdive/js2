# js2wasm Benchmark Results

Date: 2026-09-20
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.035ms | 0.041ms | 0.043ms | FAILED | js |
| string/concat-long | 0.003ms | 0.003ms | 0.004ms | FAILED | js |
| string/indexOf | 0.014ms | 0.044ms | 0.010ms | 0.019ms | gc-native |
| string/includes | 0.014ms | 0.085ms | 0.012ms | 0.014ms | gc-native |
| string/split | 0.329ms | 5.94ms | 2.11ms | FAILED | js |
| string/replace | 0.112ms | 0.450ms | 0.256ms | FAILED | js |
| string/case-convert | 0.042ms | 0.415ms | 0.207ms | FAILED | js |
| string/substring | 0.090ms | 0.032ms | 0.027ms | FAILED | gc-native |
| string/trim | 0.139ms | 2.77ms | 2.11ms | FAILED | js |
| string/startsWith-endsWith | 0.402ms | 2.25ms | 2.29ms | 0.473ms | js |
| array/push-pop | 1.22ms | 0.374ms | 0.415ms | FAILED | host-call |
| array/sort-i32 | 0.550ms | 0.286ms | 0.288ms | FAILED | host-call |
| array/map-filter | 0.110ms | 0.069ms | 0.070ms | FAILED | host-call |
| array/reduce | 1.19ms | 0.399ms | 0.390ms | FAILED | gc-native |
| array/indexOf | 4.51ms | 2.23ms | 2.23ms | FAILED | host-call |
| array/slice | 0.016ms | 0.016ms | 0.016ms | FAILED | host-call |
| array/reverse | 7.06ms | 3.17ms | 3.17ms | FAILED | gc-native |
| array/forEach | 0.075ms | 0.020ms | 0.020ms | FAILED | gc-native |
| array/find | 0.244ms | 0.013ms | 0.014ms | 0.831ms | host-call |
| dom/create-elements | 0.035ms | 0.092ms | — | — | js |
| dom/set-attributes | 0.096ms | 0.164ms | — | — | js |
| dom/read-attributes | 0.045ms | 0.092ms | — | — | js |
| dom/modify-text | 0.031ms | 0.078ms | — | — | js |
| mixed/csv-parse | 0.344ms | 6.00ms | 0.511ms | FAILED | js |
| mixed/text-search | 0.368ms | 3.49ms | 2.50ms | 0.985ms | js |
| mixed/fibonacci | 0.113ms | 0.181ms | 0.180ms | 0.202ms | js |
| mixed/matrix-multiply | 0.163ms | 54.14ms | 55.20ms | 0.611ms | js |
| mixed/sieve | 1.40ms | 2.09ms | 2.10ms | FAILED | js |

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
| string/concat-short | 10000 | 3.47 | 4.06 | 4.30 | — |
| string/concat-long | 1000 | 2.97 | 3.34 | 3.84 | — |
| string/indexOf | 1000 | 13.97 | 44.07 | 9.60 | 18.78 |
| string/includes | 1000 | 13.85 | 85.43 | 12.10 | 13.59 |
| string/split | 10000 | 32.90 | 593.74 | 211.42 | — |
| string/replace | 1000 | 112.34 | 450.41 | 256.15 | — |
| string/case-convert | 2000 | 21.21 | 207.33 | 103.29 | — |
| string/substring | 10000 | 8.99 | 3.17 | 2.71 | — |
| string/trim | 10000 | 13.90 | 276.78 | 211.45 | — |
| string/startsWith-endsWith | 20000 | 20.12 | 112.49 | 114.26 | 23.63 |
| array/map-filter | 30000 | 3.65 | 2.29 | 2.35 | — |
| array/indexOf | 1000 | 4511.91 | 2227.54 | 2231.97 | — |
| dom/create-elements | 2000 | 17.46 | 46.11 | — | — |
| dom/set-attributes | 6000 | 15.98 | 27.32 | — | — |
| dom/read-attributes | 3000 | 15.04 | 30.53 | — | — |
| dom/modify-text | 2000 | 15.64 | 38.97 | — | — |
| mixed/csv-parse | 11000 | 31.28 | 545.52 | 46.43 | — |
| mixed/text-search | 40000 | 9.20 | 87.16 | 62.60 | 24.64 |
| mixed/fibonacci | 10000 | 11.32 | 18.05 | 18.04 | 20.22 |
| mixed/matrix-multiply | 125000 | 1.30 | 433.14 | 441.61 | 4.89 |
| mixed/sieve | 200000 | 7.02 | 10.46 | 10.49 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.17x slower | 1.24x slower | — |
| string/concat-long | 1.13x slower | 1.29x slower | — |
| string/indexOf | 3.16x slower | 1.46x faster | 1.34x slower |
| string/includes | 6.17x slower | 1.14x faster | 1.02x faster |
| string/split | 18.05x slower | 6.43x slower | — |
| string/replace | 4.01x slower | 2.28x slower | — |
| string/case-convert | 9.78x slower | 4.87x slower | — |
| string/substring | 2.83x faster | 3.31x faster | — |
| string/trim | 19.91x slower | 15.21x slower | — |
| string/startsWith-endsWith | 5.59x slower | 5.68x slower | 1.17x slower |
| array/push-pop | 3.27x faster | 2.94x faster | — |
| array/sort-i32 | 1.92x faster | 1.91x faster | — |
| array/map-filter | 1.59x faster | 1.56x faster | — |
| array/reduce | 2.99x faster | 3.06x faster | — |
| array/indexOf | 2.03x faster | 2.02x faster | — |
| array/slice | 1.05x faster | 1.02x faster | — |
| array/reverse | 2.22x faster | 2.23x faster | — |
| array/forEach | 3.70x faster | 3.70x faster | — |
| array/find | 18.52x faster | 17.06x faster | 3.41x slower |
| dom/create-elements | 2.64x slower | — | — |
| dom/set-attributes | 1.71x slower | — | — |
| dom/read-attributes | 2.03x slower | — | — |
| dom/modify-text | 2.49x slower | — | — |
| mixed/csv-parse | 17.44x slower | 1.48x slower | — |
| mixed/text-search | 9.47x slower | 6.80x slower | 2.68x slower |
| mixed/fibonacci | 1.60x slower | 1.59x slower | 1.79x slower |
| mixed/matrix-multiply | 331.91x slower | 338.40x slower | 3.75x slower |
| mixed/sieve | 1.49x slower | 1.49x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.06x slower |
| string/concat-long | 1.15x slower |
| string/indexOf | 4.59x faster |
| string/includes | 7.06x faster |
| string/split | 2.81x faster |
| string/replace | 1.76x faster |
| string/case-convert | 2.01x faster |
| string/substring | 1.17x faster |
| string/trim | 1.31x faster |
| string/startsWith-endsWith | 1.02x slower |
| array/push-pop | 1.11x slower |
| array/sort-i32 | 1.01x slower |
| array/map-filter | 1.02x slower |
| array/reduce | 1.02x faster |
| array/indexOf | 1.00x slower |
| array/slice | 1.03x slower |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x faster |
| array/find | 1.09x slower |
| mixed/csv-parse | 11.75x faster |
| mixed/text-search | 1.39x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.02x slower |
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
| string/concat-short | 1027.9ms | 533.0ms | — |
| string/concat-long | 371.4ms | 560.3ms | — |
| string/indexOf | 316.1ms | 570.4ms | 476.0ms |
| string/includes | 331.2ms | 569.4ms | 467.3ms |
| string/split | 425.1ms | 607.5ms | — |
| string/replace | 432.5ms | 620.6ms | — |
| string/case-convert | 441.7ms | 525.7ms | — |
| string/substring | 336.7ms | 406.9ms | — |
| string/trim | 415.0ms | 597.4ms | — |
| string/startsWith-endsWith | 421.8ms | 592.1ms | 514.4ms |
| array/push-pop | 424.5ms | 497.1ms | — |
| array/sort-i32 | 567.5ms | 628.3ms | — |
| array/map-filter | 565.6ms | 630.3ms | — |
| array/reduce | 542.7ms | 582.9ms | — |
| array/indexOf | 525.5ms | 581.1ms | — |
| array/slice | 452.6ms | 526.4ms | — |
| array/reverse | 439.4ms | 535.2ms | — |
| array/forEach | 570.1ms | 618.6ms | — |
| array/find | 414.1ms | 503.5ms | 480.8ms |
| dom/create-elements | 370.2ms | — | — |
| dom/set-attributes | 328.7ms | — | — |
| dom/read-attributes | 318.5ms | — | — |
| dom/modify-text | 339.6ms | — | — |
| mixed/csv-parse | 455.2ms | 593.1ms | — |
| mixed/text-search | 431.9ms | 601.1ms | 546.2ms |
| mixed/fibonacci | 399.9ms | 434.1ms | 412.6ms |
| mixed/matrix-multiply | 555.5ms | 607.1ms | 451.2ms |
| mixed/sieve | 523.0ms | 582.3ms | — |
