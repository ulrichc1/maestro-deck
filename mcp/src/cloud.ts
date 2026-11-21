import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";

/** Same contract as the desktop app (src/lib/cloudJobs.ts) and cloud.rs. */
export const CLOUD_ORIGIN = "https://dashboard.maestrodeck.cloud";

export type CloudPlatform = "android" | "android_physical" | "ios";
export type CloudMode = "sequential" | "parallel" | "ios_android";

export interface CloudClientConfig {
  /** Firebase ID token of the Maestro Deck account. Never logged or returned. */
  token: string | undefined;
  /** Override for tests. Production always uses CLOUD_ORIGIN. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface CloudPlanJob {
  platform: CloudPlatform;
  appPath: string;
  yamlPaths: string[];
}

/**
 * Splits flows into cloud jobs. Each accepted job spends one run once it starts.
 * - sequential: one job holding every flow
 * - parallel: one job per flow
 * - ios_android: one iOS job and one Android job per flow
 */
export function planCloudJobs(
  mode: CloudMode,
  flows: string[],
  platform: CloudPlatform,
  artifacts: { apk?: string; iosZip?: string },
): CloudPlanJob[] {
  if (flows.length === 0) throw new Error("No flow to run on the cloud.");
  if (mode === "ios_android") {
    if (!artifacts.iosZip) throw new Error("ios_android needs iosAppPath: a zipped .app simulator build.");
    if (!artifacts.apk) throw new Error("ios_android needs appPath: an .apk for the Android job.");
    return flows.flatMap((f) => [
      { platform: "ios" as const, appPath: artifacts.iosZip!, yamlPaths: [f] },
      { platform: "android" as const, appPath: artifacts.apk!, yamlPaths: [f] },
    ]);
  }
  const appPath = platform === "ios" ? artifacts.iosZip : artifacts.apk;
  if (!appPath) {
    throw new Error(platform === "ios" ? "Platform ios needs iosAppPath (zipped .app)." : "This platform needs appPath (.apk).");
  }
  if (mode === "sequential") return [{ platform, appPath, yamlPaths: flows }];
  return flows.map((f) => ({ platform, appPath, yamlPaths: [f] }));
}

export class CloudError extends Error {
  constructor(
    readonly code: "NO_TOKEN" | "UNAUTHENTICATED" | "QUOTA_EXCEEDED" | "JOBS_DISABLED" | "UPLOAD_FAILED" | "REQUEST_FAILED",
    message: string,
  ) {
    super(message);
    this.name = "CloudError";
  }
}

function origin(cfg: CloudClientConfig): string {
  return cfg.baseUrl ?? CLOUD_ORIGIN;
}

async function api<T>(cfg: CloudClientConfig, method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  if (!cfg.token) {
    throw new CloudError("NO_TOKEN", "No cloud token. Set MAESTRO_DECK_CLOUD_TOKEN to the Maestro Deck account token.");
  }
  if (!path.startsWith("/") || path.startsWith("//")) throw new CloudError("REQUEST_FAILED", `Invalid API path: ${path}`);
  const f = cfg.fetchImpl ?? fetch;
  const res = await f(`${origin(cfg)}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (res.status >= 200 && res.status < 300) return parsed as T;
  if (res.status === 401) throw new CloudError("UNAUTHENTICATED", "The cloud token was rejected or has expired. Generate a new one.");
  const err = parsed as { error?: string; message?: string } | null;
  const code = err?.error === "QUOTA_EXCEEDED" ? "QUOTA_EXCEEDED" : err?.error === "JOBS_DISABLED" ? "JOBS_DISABLED" : "REQUEST_FAILED";
  throw new CloudError(code, err?.message ?? `Cloud request failed (HTTP ${res.status}).`);
}

/** Only these hosts may receive an upload, as in cloud.rs: a bad API answer must not make this a general uploader. */
function uploadAllowed(url: string, cfg: CloudClientConfig): boolean {
  if (url.startsWith("https://storage.googleapis.com/")) return true;
  return cfg.baseUrl !== undefined && url.startsWith(cfg.baseUrl);
}

async function uploadFile(cfg: CloudClientConfig, url: string, path: string): Promise<void> {
  if (!uploadAllowed(url, cfg)) throw new CloudError("UPLOAD_FAILED", "Refusing to upload to an unexpected host.");
  const size = statSync(path).size;
  const data = readFileSync(path);
  const f = cfg.fetchImpl ?? fetch;
  const res = await f(url, { method: "PUT", headers: { "Content-Length": String(size) }, body: data });
  if (!res.ok) {
    throw new CloudError(
      "UPLOAD_FAILED",
      res.status === 403 ? `Uploading ${basename(path)} failed: the upload link expired. Run again.` : `Uploading ${basename(path)} failed (HTTP ${res.status}).`,
    );
  }
}

interface InitResponse {
  jobId: string;
  apk?: { uploadUrl: string; gsPath: string };
  yamls: { name: string; uploadUrl: string; gsPath: string }[];
}

/** Submits one cloud job: init, upload the app and flows, finalize. Spends one run once it starts. */
export async function submitCloudJob(cfg: CloudClientConfig, job: CloudPlanJob): Promise<{ jobId: string }> {
  const init = await api<InitResponse>(cfg, "POST", "/api/jobs/init", {
    platform: job.platform,
    apk: { name: basename(job.appPath) },
    yamls: job.yamlPaths.map((p) => ({ name: basename(p) })),
  });
  if (!init.apk) throw new CloudError("REQUEST_FAILED", "The cloud did not return an upload URL for the app.");

  const uploads: [string, string][] = [
    [init.apk.uploadUrl, job.appPath],
    ...init.yamls.map((y, i): [string, string] => [y.uploadUrl, job.yamlPaths[i]]),
  ];
  for (const [url, path] of uploads) await uploadFile(cfg, url, path);

  await api<unknown>(cfg, "POST", "/api/jobs/finalize", {
    jobId: init.jobId,
    platform: job.platform,
    apkPath: init.apk.gsPath,
    yamlPaths: init.yamls.map((y) => y.gsPath),
  });
  return { jobId: init.jobId };
}

export interface CloudJobStatus {
  jobId: string;
  /** pending | running | passed | failed | error (normalised by the API). */
  status: string;
  error?: string | null;
  reportUrl?: string;
}

const TERMINAL = new Set(["passed", "failed", "error"]);
export const isTerminalCloudStatus = (s: string) => TERMINAL.has(s);

export async function getCloudJobStatus(cfg: CloudClientConfig, jobId: string): Promise<CloudJobStatus> {
  if (!/^[\w-]{1,128}$/.test(jobId)) throw new CloudError("REQUEST_FAILED", "Invalid job id.");
  return api<CloudJobStatus>(cfg, "GET", `/api/jobs/${jobId}/status`);
}

/** Polls the given jobs until all are terminal or the wait elapses. */
export async function waitForCloudJobs(
  cfg: CloudClientConfig,
  jobIds: string[],
  waitMs: number,
  pollMs = 3000,
): Promise<CloudJobStatus[]> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const statuses = await Promise.all(jobIds.map((id) => getCloudJobStatus(cfg, id)));
    if (statuses.every((s) => isTerminalCloudStatus(s.status)) || Date.now() >= deadline) return statuses;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
