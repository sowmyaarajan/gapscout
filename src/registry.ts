import type { Gap, RegistrySignal, RegistryPackage } from "./types.js";
import { calcWorthBuilding } from "./analyzer.js";

const TIMEOUT_MS = 4000;

function registryForLanguage(lang: string): RegistrySignal["registry"] {
  const l = lang.toLowerCase();
  if (l === "javascript" || l === "typescript") return "npm";
  if (l === "python") return "pypi";
  if (l === "rust") return "crates.io";
  return "none";
}

function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(0) + "k";
  return String(n);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return promise.finally(() => clearTimeout(timer));
}

async function fetchJson(url: string, headers?: Record<string, string>): Promise<any> {
  const res = await fetch(url, {
    headers: { "Accept": "application/json", ...headers },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchNpm(keyword: string): Promise<RegistrySignal> {
  const searchData = await fetchJson(
    `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(keyword)}&size=3`
  );
  const names: string[] = (searchData.objects ?? []).map((o: any) => o.package?.name).filter(Boolean);

  const dlResults = await Promise.allSettled(
    names.map((name) =>
      fetchJson(`https://api.npmjs.org/downloads/point/last-month/${encodeURIComponent(name)}`)
    )
  );

  const packages: RegistryPackage[] = names.map((name, i) => {
    const result = dlResults[i];
    const dl = result.status === "fulfilled" ? (result.value?.downloads ?? 0) : 0;
    return { name, monthlyDownloads: dl, url: `https://www.npmjs.com/package/${name}` };
  });

  return {
    registry: "npm",
    topPackages: packages,
    totalMonthlyDownloads: packages.reduce((s, p) => s + p.monthlyDownloads, 0),
  };
}

async function fetchCrates(keyword: string): Promise<RegistrySignal> {
  const data = await fetchJson(
    `https://crates.io/api/v1/crates?q=${encodeURIComponent(keyword)}&per_page=3&sort=downloads`,
    { "User-Agent": "GapScout/0.3.0 (github.com/sowmyaarajan/gapscout)" }
  );

  const packages: RegistryPackage[] = (data.crates ?? []).slice(0, 3).map((c: any) => ({
    name: c.name,
    monthlyDownloads: Math.round((c.recent_downloads ?? 0) / 3),
    url: `https://crates.io/crates/${c.name}`,
  }));

  return {
    registry: "crates.io",
    topPackages: packages,
    totalMonthlyDownloads: packages.reduce((s, p) => s + p.monthlyDownloads, 0),
  };
}

async function fetchPypi(keyword: string): Promise<RegistrySignal> {
  // PyPI has no search API — try keyword as package name and two variants
  const candidates = [
    keyword.replace(/\s+/g, "-"),
    keyword.replace(/\s+/g, ""),
    "py-" + keyword.replace(/\s+/g, "-"),
  ];

  const packages: RegistryPackage[] = [];

  for (const name of candidates) {
    try {
      const data = await fetchJson(`https://pypistats.org/api/packages/${encodeURIComponent(name)}/recent`);
      const dl = data.data?.last_month ?? 0;
      if (dl > 0) {
        packages.push({ name, monthlyDownloads: dl, url: `https://pypi.org/project/${name}` });
      }
    } catch {
      // not found — continue
    }
    if (packages.length >= 3) break;
  }

  return {
    registry: "pypi",
    topPackages: packages,
    totalMonthlyDownloads: packages.reduce((s, p) => s + p.monthlyDownloads, 0),
  };
}

async function fetchSignalForGap(theme: string, registry: RegistrySignal["registry"]): Promise<RegistrySignal> {
  try {
    if (registry === "npm") return await fetchNpm(theme);
    if (registry === "crates.io") return await fetchCrates(theme);
    if (registry === "pypi") return await fetchPypi(theme);
  } catch {
    // fall through to empty signal
  }
  return { registry, topPackages: [], totalMonthlyDownloads: 0 };
}

export async function enrichGapsWithRegistry(gaps: Gap[], language: string): Promise<Gap[]> {
  const registry = registryForLanguage(language);
  if (registry === "none") {
    return gaps.map((g) => ({ ...g, worthBuilding: calcWorthBuilding(g, undefined) }));
  }

  const toEnrich = gaps.slice(0, 10);
  const rest = gaps.slice(10);

  const signals = await Promise.all(
    toEnrich.map((g) =>
      withTimeout(fetchSignalForGap(g.theme, registry), TIMEOUT_MS).catch(() => ({
        registry,
        topPackages: [],
        totalMonthlyDownloads: 0,
      } as RegistrySignal))
    )
  );

  const enriched = toEnrich.map((g, i) => {
    const signal = signals[i];
    return {
      ...g,
      registrySignal: signal,
      worthBuilding: calcWorthBuilding(g, signal),
    };
  });

  return [
    ...enriched,
    ...rest.map((g) => ({ ...g, worthBuilding: calcWorthBuilding(g, undefined) })),
  ];
}

export { fmt };
