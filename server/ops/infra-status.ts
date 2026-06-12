import { prisma } from "@/server/db";
import { probe as probeNeo4j, getConfigSummary } from "@/server/em/clients/neo4j";
import { getInngestUrl } from "@/lib/inngest-url";
import { listApps, type InngestApp } from "@/lib/inngest-admin-client";
import type { CaptureInput } from "@/server/notifications/derive";
import { applyRuntimeConfigToEnv } from "@/server/ops/runtime-config";

export type InfraSubsystemId = "inngest" | "raas" | "neo4j" | "deployment";
export type InfraState = "healthy" | "degraded" | "down" | "unknown";

export type InfraIssue = {
  key: string;
  level: "warn" | "critical";
  title: string;
  detail: string;
};

export type InfraSubsystemStatus = {
  id: InfraSubsystemId;
  label: string;
  state: InfraState;
  detail: string | null;
  metrics: Array<{ label: string; value: string }>;
  issue: InfraIssue | null;
};

export type InfraStatusSnapshot = {
  subsystems: InfraSubsystemStatus[];
  inngest: {
    url: string;
    apps: InngestApp[];
    appErrors: Array<{ name: string; url: string | null; error: string }>;
    serveEndpointUrl: string;
    healthy: boolean;
  };
  raas: {
    apiUrl: string | null;
    reachable: boolean | null;
    httpStatus: number | null;
  };
  neo4j: {
    configured: boolean;
    reachable: boolean;
    lastSyncAt: string | null;
    lastError: string | null;
    staleSeconds: number | null;
  };
  deployment: {
    serveEndpointUrl: string;
    mainAppUrl: string | null;
    env: {
      nodeEnv: string | null;
      inngestBaseUrl: string | null;
      inngestServeHost: string | null;
      inngestServePath: string;
      databaseConfigured: boolean;
    };
  };
  generatedAt: string;
};

const MAIN_APP_ID = "agentic-operator-main";
const DEFAULT_SERVE_PATH = "/api/inngest";

function neo4jStaleMs(): number {
  return Number(process.env.NEO4J_SYNC_STALE_MS) || 10 * 60_000;
}

function joinUrl(origin: string, path: string): string {
  const cleanOrigin = origin.replace(/\/+$/, "");
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  return `${cleanOrigin}${cleanPath}`;
}

export function resolveServeEndpointUrl(apps: InngestApp[] = []): string {
  const servePath = process.env.INNGEST_SERVE_PATH ?? DEFAULT_SERVE_PATH;
  const serveHost = process.env.INNGEST_SERVE_ORIGIN ?? process.env.INNGEST_SERVE_HOST;
  if (serveHost) return joinUrl(serveHost, servePath);

  const mainUrl = apps.find((a) => a.name === MAIN_APP_ID)?.url;
  if (mainUrl) return mainUrl;

  const host = process.env.AO_LAN_IP ?? "host.docker.internal";
  const port = process.env.AO_PORT ?? "3002";
  return joinUrl(`http://${host}:${port}`, servePath);
}

async function buildRaas(): Promise<{
  status: InfraSubsystemStatus;
  apiUrl: string | null;
  reachable: boolean | null;
  httpStatus: number | null;
}> {
  const apiUrl = process.env.RAAS_API_BASE_URL?.trim() || null;
  const endpoint = apiUrl
    ? apiUrl.replace(/^https?:\/\//, "").replace(/\/+$/, "")
    : "—";

  if (!apiUrl) {
    return {
      apiUrl,
      reachable: null,
      httpStatus: null,
      status: {
        id: "raas",
        label: "RaaS API",
        state: "unknown",
        detail: "RAAS_API_BASE_URL not configured.",
        issue: null,
        metrics: [
          { label: "endpoint", value: endpoint },
          { label: "http status", value: "—" },
        ],
      },
    };
  }

  try {
    const res = await fetch(apiUrl, {
      method: "HEAD",
      cache: "no-store",
      signal: AbortSignal.timeout(2500),
    });
    return {
      apiUrl,
      reachable: true,
      httpStatus: res.status,
      status: {
        id: "raas",
        label: "RaaS API",
        state: "healthy",
        detail: "RAAS API Server reachability probe.",
        issue: null,
        metrics: [
          { label: "endpoint", value: endpoint },
          { label: "http status", value: String(res.status) },
        ],
      },
    };
  } catch (e) {
    const detail = `RAAS API Server unreachable: ${(e as Error).message}`;
    return {
      apiUrl,
      reachable: false,
      httpStatus: null,
      status: {
        id: "raas",
        label: "RaaS API",
        state: "down",
        detail,
        issue: {
          key: "infra.raas.api",
          level: "critical",
          title: "RaaS 合作方 API 不可达",
          detail,
        },
        metrics: [
          { label: "endpoint", value: endpoint },
          { label: "http status", value: "—" },
        ],
      },
    };
  }
}

async function probeInngestHealth(base: string): Promise<{ ok: boolean; error: string | null }> {
  try {
    const res = await fetch(`${base.replace(/\/+$/, "")}/health`, {
      cache: "no-store",
      signal: AbortSignal.timeout(2500),
    });
    return { ok: res.ok, error: res.ok ? null : `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

async function buildInngest(): Promise<{
  status: InfraSubsystemStatus;
  url: string;
  apps: InngestApp[];
  appErrors: Array<{ name: string; url: string | null; error: string }>;
  serveEndpointUrl: string;
  mainAppUrl: string | null;
}> {
  const url = getInngestUrl();
  const health = await probeInngestHealth(url);
  let apps: InngestApp[] = [];
  let appReadError: string | null = null;

  if (health.ok) {
    try {
      apps = await listApps();
    } catch (e) {
      appReadError = (e as Error).message;
    }
  }

  const appErrors = apps
    .filter((a) => typeof a.error === "string" && a.error.length > 0)
    .map((a) => ({ name: a.name, url: a.url ?? null, error: a.error! }));
  const mainApp = apps.find((a) => a.name === MAIN_APP_ID) ?? null;
  const serveEndpointUrl = resolveServeEndpointUrl(apps);

  let state: InfraState = "healthy";
  let issue: InfraIssue | null = null;
  let detail = "Inngest server and AO app sync are healthy.";

  if (!health.ok) {
    state = "down";
    detail = `Inngest server unreachable: ${health.error ?? "unknown"}`;
    issue = {
      key: "infra.inngest.server",
      level: "critical",
      title: "Inngest 事件引擎不可达",
      detail,
    };
  } else if (appReadError) {
    state = "degraded";
    detail = `Inngest app list read failed: ${appReadError}`;
    issue = {
      key: "infra.inngest.gql",
      level: "warn",
      title: "Inngest App 状态读取失败",
      detail,
    };
  } else if (!mainApp) {
    state = "down";
    detail = `${MAIN_APP_ID} is not registered in Inngest.`;
    issue = {
      key: "infra.inngest.main_app_missing",
      level: "critical",
      title: "Inngest 主 App 未注册",
      detail: `Inngest 找不到 ${MAIN_APP_ID}。请重新同步 ${serveEndpointUrl}。`,
    };
  } else if (appErrors.length > 0) {
    state = "down";
    detail = appErrors.map((e) => `${e.name}: ${e.error}`).join("; ");
    issue = {
      key: "infra.inngest.app_sync",
      level: "critical",
      title: "Inngest App 同步失败",
      detail,
    };
  }

  return {
    url,
    apps,
    appErrors,
    serveEndpointUrl,
    mainAppUrl: mainApp?.url ?? null,
    status: {
      id: "inngest",
      label: "Inngest",
      state,
      detail,
      issue,
      metrics: [
        { label: "server", value: url },
        { label: "callback", value: serveEndpointUrl },
        { label: "apps", value: String(apps.length) },
        { label: "functions", value: String(mainApp?.functionCount ?? 0) },
      ],
    },
  };
}

async function buildNeo4j(): Promise<{
  status: InfraSubsystemStatus;
  configured: boolean;
  reachable: boolean;
  lastSyncAt: string | null;
  lastError: string | null;
  staleSeconds: number | null;
}> {
  const cfg = getConfigSummary();
  const probe = await probeNeo4j().catch((e) => ({
    ok: false as const,
    error: `probe threw: ${(e as Error).message}`,
  }));
  const row = await prisma.emSystemStatus.findUnique({ where: { id: "singleton" } }).catch(() => null);
  const lastSyncAt = row?.neo4jLastSyncAt?.toISOString() ?? null;
  const lastSyncMs = lastSyncAt ? new Date(lastSyncAt).getTime() : null;
  const staleSeconds = lastSyncMs ? Math.max(0, Math.floor((Date.now() - lastSyncMs) / 1000)) : null;
  const stale = lastSyncMs ? Date.now() - lastSyncMs > neo4jStaleMs() : false;

  let state: InfraState = "healthy";
  let detail = "Neo4j/Allmeta sync is healthy.";
  let issue: InfraIssue | null = null;

  if (!cfg.configured) {
    state = "unknown";
    detail = "Neo4j is not configured.";
  } else if (!probe.ok) {
    state = "down";
    detail = probe.error;
    issue = {
      key: "infra.neo4j.unreachable",
      level: "critical",
      title: "图引擎 Neo4j 不可达",
      detail,
    };
  } else if (row?.neo4jLastError) {
    state = "degraded";
    detail = row.neo4jLastError;
    issue = {
      key: "infra.neo4j.sync_error",
      level: "warn",
      title: "Neo4j 事件目录同步失败",
      detail,
    };
  } else if (stale || !lastSyncAt) {
    state = "degraded";
    detail = lastSyncAt
      ? `Neo4j event catalog sync is stale (${staleSeconds}s since last sync).`
      : "Neo4j event catalog has never synced.";
    issue = {
      key: "infra.neo4j.stale",
      level: "warn",
      title: "Neo4j 事件目录同步过期",
      detail,
    };
  }

  return {
    configured: cfg.configured,
    reachable: probe.ok,
    lastSyncAt,
    lastError: row?.neo4jLastError ?? null,
    staleSeconds,
    status: {
      id: "neo4j",
      label: "Neo4j / Allmeta",
      state,
      detail,
      issue,
      metrics: [
        { label: "configured", value: cfg.configured ? "yes" : "no" },
        { label: "database", value: cfg.database ?? "—" },
        { label: "last sync", value: lastSyncAt ?? "—" },
        { label: "upserted", value: String(row?.neo4jUpsertedLast ?? 0) },
      ],
    },
  };
}

function buildDeployment(args: {
  serveEndpointUrl: string;
  mainAppUrl: string | null;
}): InfraSubsystemStatus {
  const env = {
    nodeEnv: process.env.NODE_ENV ?? null,
    inngestBaseUrl: process.env.INNGEST_BASE_URL ?? null,
    inngestServeHost: process.env.INNGEST_SERVE_ORIGIN ?? process.env.INNGEST_SERVE_HOST ?? null,
    inngestServePath: process.env.INNGEST_SERVE_PATH ?? DEFAULT_SERVE_PATH,
    databaseConfigured: Boolean(process.env.DATABASE_URL),
  };

  let state: InfraState = "healthy";
  let detail = "Deployment wiring is internally consistent.";
  let issue: InfraIssue | null = null;

  if (!env.inngestBaseUrl) {
    state = "degraded";
    detail = "INNGEST_BASE_URL is not configured; AO is using its default Inngest URL.";
    issue = {
      key: "infra.deployment.inngest_base_url",
      level: "warn",
      title: "部署配置缺少 INNGEST_BASE_URL",
      detail,
    };
  } else if (!env.inngestServeHost) {
    state = "degraded";
    detail = "INNGEST_SERVE_ORIGIN is not configured; callback URL is inferred and may be wrong after deployment.";
    issue = {
      key: "infra.deployment.serve_host",
      level: "warn",
      title: "部署配置缺少 INNGEST_SERVE_ORIGIN",
      detail,
    };
  } else if (args.mainAppUrl && args.mainAppUrl !== args.serveEndpointUrl) {
    state = "degraded";
    detail = `Inngest registered ${args.mainAppUrl}, but AO expects ${args.serveEndpointUrl}.`;
    issue = {
      key: "infra.deployment.callback_mismatch",
      level: "warn",
      title: "Inngest 回调地址与部署配置不一致",
      detail,
    };
  } else if (!env.databaseConfigured) {
    state = "down";
    detail = "DATABASE_URL is not configured.";
    issue = {
      key: "infra.deployment.database_url",
      level: "critical",
      title: "部署配置缺少 DATABASE_URL",
      detail,
    };
  }

  return {
    id: "deployment",
    label: "Deployment",
    state,
    detail,
    issue,
    metrics: [
      { label: "callback", value: args.serveEndpointUrl },
      { label: "registered", value: args.mainAppUrl ?? "—" },
      { label: "env", value: env.nodeEnv ?? "—" },
      { label: "database", value: env.databaseConfigured ? "configured" : "missing" },
    ],
  };
}

export async function getInfraStatus(): Promise<InfraStatusSnapshot> {
  await applyRuntimeConfigToEnv();
  const [inngest, raas, neo4j] = await Promise.all([buildInngest(), buildRaas(), buildNeo4j()]);
  const deployment = buildDeployment({
    serveEndpointUrl: inngest.serveEndpointUrl,
    mainAppUrl: inngest.mainAppUrl,
  });

  return {
    subsystems: [inngest.status, raas.status, neo4j.status, deployment],
    inngest: {
      url: inngest.url,
      apps: inngest.apps,
      appErrors: inngest.appErrors,
      serveEndpointUrl: inngest.serveEndpointUrl,
      healthy: inngest.status.state === "healthy",
    },
    raas: {
      apiUrl: raas.apiUrl,
      reachable: raas.reachable,
      httpStatus: raas.httpStatus,
    },
    neo4j: {
      configured: neo4j.configured,
      reachable: neo4j.reachable,
      lastSyncAt: neo4j.lastSyncAt,
      lastError: neo4j.lastError,
      staleSeconds: neo4j.staleSeconds,
    },
    deployment: {
      serveEndpointUrl: inngest.serveEndpointUrl,
      mainAppUrl: inngest.mainAppUrl,
      env: {
        nodeEnv: process.env.NODE_ENV ?? null,
        inngestBaseUrl: process.env.INNGEST_BASE_URL ?? null,
        inngestServeHost: process.env.INNGEST_SERVE_ORIGIN ?? process.env.INNGEST_SERVE_HOST ?? null,
        inngestServePath: process.env.INNGEST_SERVE_PATH ?? DEFAULT_SERVE_PATH,
        databaseConfigured: Boolean(process.env.DATABASE_URL),
      },
    },
    generatedAt: new Date().toISOString(),
  };
}

export const INFRA_ALERT_PREFIX = "infra.";

export function infraFindingsFromSnapshot(snapshot: InfraStatusSnapshot): CaptureInput[] {
  return snapshot.subsystems
    .filter((s) => s.issue !== null)
    .map((s) => ({
      level: s.issue!.level,
      category: "system",
      source:
        s.id === "inngest"
          ? "Inngest"
          : s.id === "raas"
            ? "RaaS"
          : s.id === "neo4j"
            ? "Allmeta"
            : "基础设施",
      message: `${s.issue!.title}: ${s.issue!.detail}`,
      dedupeHint: s.issue!.key,
      linkKind: "infra",
      linkId: s.id,
      managerAction: null,
      anchors: {
        subsystem: s.id,
        state: s.state,
      },
    }));
}
