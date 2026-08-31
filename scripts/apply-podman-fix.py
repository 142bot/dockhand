#!/usr/bin/env python3
"""Apply the Podman precpu_stats fix to src/lib/server/docker.ts.

Podman's Docker-compatible API zeroes precpu_stats on one-shot (stream=false)
stat requests and omits precpu_stats.system_cpu_usage entirely. DockHand's
calculateCpuPercent() then sees a NaN system delta and reports 0.0% CPU for
every container (Finsys/dockhand#335).

This script replaces getContainerStats() with a version that remembers the
previous cpu_stats sample per container and splices it into precpu_stats
only when the runtime did not provide a usable baseline. Docker populates
precpu_stats natively and is left untouched.

Run from the repository root. Exits non-zero if the expected source block
is not found exactly once (never produces a broken tree silently).
"""

import sys
from pathlib import Path

TARGET = Path("src/lib/server/docker.ts")

OLD = "\n".join(
    [
        "export async function getContainerStats(id: string, envId?: number | null) {",
        "\treturn dockerJsonRequest(`/containers/${id}/stats?stream=false`, {}, envId);",
        "}",
    ]
)

NEW = "\n".join(
    [
        "// --- Podman stats compatibility -----------------------------------------------------",
        "// Podman's Docker-compatible API zeroes precpu_stats (and omits",
        "// precpu_stats.system_cpu_usage) on stream=false one-shot stats requests,",
        "// so delta-based CPU percentages are always 0 (Finsys/dockhand#335).",
        "// Docker populates precpu_stats natively. Remember the previous cpu_stats",
        "// sample per container+environment and, only when the runtime provided no",
        "// usable baseline, splice the remembered sample into precpu_stats so the",
        "// existing calculateCpuPercent() implementations compute a real delta",
        "// between successive polls.",
        "",
        "interface CpuSampleCacheEntry {",
        "\ttotalUsage: number;",
        "\tsystemUsage: number;",
        "\treadMs: number;",
        "\tcachedAtMs: number;",
        "}",
        "",
        "const cpuSampleCache = new Map<string, CpuSampleCacheEntry>();",
        "const CPU_SAMPLE_TTL_MS = 10 * 60 * 1000;",
        "const CPU_SAMPLE_MIN_INTERVAL_MS = 500;",
        "",
        "function parseStatsReadMs(stats: any): number {",
        "\tconst t = Date.parse(stats?.read);",
        "\treturn Number.isFinite(t) ? t : Date.now();",
        "}",
        "",
        "function rememberCpuSample(key: string, totalUsage: number, systemUsage: number, readMs: number, now: number): void {",
        "\tcpuSampleCache.set(key, { totalUsage, systemUsage, readMs, cachedAtMs: now });",
        "\tif (cpuSampleCache.size > 64) {",
        "\t\tfor (const [k, v] of cpuSampleCache) {",
        "\t\t\tif (now - v.cachedAtMs > CPU_SAMPLE_TTL_MS) cpuSampleCache.delete(k);",
        "\t\t}",
        "\t}",
        "}",
        "",
        "function withSynthesizedPrecpu<T>(stats: T, key: string): T {",
        "\tconst cpuUsage = (stats as any)?.cpu_stats?.cpu_usage;",
        "\tconst systemUsage = (stats as any)?.cpu_stats?.system_cpu_usage;",
        "\tconst preTotal = (stats as any)?.precpu_stats?.cpu_usage?.total_usage;",
        "\tconst preSystem = (stats as any)?.precpu_stats?.system_cpu_usage;",
        "",
        "\t// Runtime already provides a usable baseline (Docker): pass through.",
        "\tif ((preTotal ?? 0) > 0 && (preSystem ?? 0) > 0) return stats;",
        "",
        "\t// Nothing usable to remember or synthesize.",
        "\tif (!cpuUsage || typeof systemUsage !== 'number') return stats;",
        "",
        "\tconst now = Date.now();",
        "\tconst readMs = parseStatsReadMs(stats);",
        "\tconst cached = cpuSampleCache.get(key);",
        "",
        "\tif (cached) {",
        "\t\t// Advance the baseline only when the sample is far enough from the",
        "\t\t// cached read time; callers within the same polling round share one",
        "\t\t// baseline instead of chaining micro-deltas onto each other.",
        "\t\tif (readMs - cached.readMs >= CPU_SAMPLE_MIN_INTERVAL_MS) {",
        "\t\t\trememberCpuSample(key, cpuUsage.total_usage, systemUsage, readMs, now);",
        "\t\t}",
        "\t\treturn {",
        "\t\t\t...(stats as any),",
        "\t\t\tprecpu_stats: {",
        "\t\t\t\tcpu_usage: {",
        "\t\t\t\t\ttotal_usage: cached.totalUsage,",
        "\t\t\t\t\t\tusage_in_kernelmode: 0,",
        "\t\t\t\t\t\tusage_in_usermode: 0",
        "\t\t\t\t},",
        "\t\t\tsystem_cpu_usage: cached.systemUsage,",
        "\t\t\tthrottling_data: { periods: 0, throttled_periods: 0, throttled_time: 0 }",
        "\t\t\t}",
        "\t\t} as T;",
        "\t}",
        "",
        "\t// First poll for this container (e.g. after DockHand restart): remember",
        "\t// the sample and return unchanged - CPU reads 0.0% for one interval,",
        "\t// mirroring the podman CLI's first stats line.",
        "\trememberCpuSample(key, cpuUsage.total_usage, systemUsage, readMs, now);",
        "\treturn stats;",
        "}",
        "",
        "export async function getContainerStats(id: string, envId?: number | null) {",
        "\tconst stats = await dockerJsonRequest<any>(`/containers/${id}/stats?stream=false`, {}, envId);",
        "\treturn withSynthesizedPrecpu(stats, `${envId ?? 'local'}:${id}`);",
        "}",
    ]
)


def main() -> int:
    src = TARGET.read_text()
    if OLD not in src and NEW in src:
        print("fix already applied")
        return 0
    count = src.count(OLD)
    if count != 1:
        print(
            f"expected the original getContainerStats block exactly once, found {count}",
            file=sys.stderr,
        )
        return 1
    TARGET.write_text(src.replace(OLD, NEW))
    print("applied Podman precpu_stats fix to", TARGET)
    return 0


if __name__ == "__main__":
    sys.exit(main())
