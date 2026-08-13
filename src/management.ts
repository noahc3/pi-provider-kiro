// ABOUTME: Calls the authenticated Kiro management control plane.
// ABOUTME: Resolves profiles and discovers the current per-profile model catalog.

import { createHash } from "node:crypto";
import { redactSensitiveText } from "./debug.js";
import { getKiroEndpoints } from "./endpoints.js";

const LIST_PROFILES_PATH = "List-Available-Profiles";
const LIST_MODELS_PATH = "List-Available-Models";

export interface KiroManagementAuth {
  accessToken: string;
  region: string;
}

export interface KiroCatalogModel {
  modelId: string;
  tokenLimits?: {
    maxInputTokens?: number;
    maxOutputTokens?: number;
    [key: string]: unknown;
  };
  additionalModelRequestFieldsSchema?: Record<string, unknown> | null;
  [key: string]: unknown;
}

export interface KiroListAvailableModelsResponse {
  models: KiroCatalogModel[];
  [key: string]: unknown;
}

export interface KiroGetUsageLimitsRequest {
  profileArn?: string;
  origin: "KIRO_CLI";
  resourceType: "CREDIT";
  isEmailRequired: false;
}

interface KiroListAvailableProfilesResponse {
  profiles?: Array<{ arn?: string; [key: string]: unknown }>;
}

const profileArnCache = new Map<string, string>();
const pendingProfileRequests = new Map<string, Promise<string>>();

/**
 * Which Kiro plane produced an error.
 *
 * The distinction is load-bearing for a consumer deciding whether to re-
 * authenticate:
 *
 * - `management` resolves *who you are* — `ListAvailableProfiles`,
 *   `ListAvailableModels`, `GetUsageLimits`. There is no per-model entitlement
 *   layer here to deny, so a 401/403 is a credential problem.
 * - `runtime` is `generateAssistantResponse`. It can legitimately 403 a caller
 *   whose credential is perfectly valid but who lacks entitlement for the
 *   requested model — a config problem that re-authentication cannot fix.
 *
 * Collapsing the two makes a config error look re-authenticable and sends the
 * consumer into a pointless re-login loop.
 */
export type KiroErrorPlane = "management" | "runtime";

/**
 * `AssistantMessageDiagnostic.type` under which `streamKiro` reports the plane of
 * a failure.
 *
 * `streamKiro` flattens every thrown error into `AssistantMessage.errorMessage`,
 * a string, so a consumer of the stream never receives the error object itself.
 * This diagnostic is the machine-readable channel that survives that
 * flattening: its `details` carry `plane`, `status`, and `refreshAttempted`.
 *
 * Only management-plane failures are tagged. A runtime failure — and any local
 * precondition failure, such as absent credentials — emits no diagnostic of
 * this type, so a management error is identified by its presence and everything
 * else by its absence, without parsing `errorMessage`.
 */
export const KIRO_AUTH_PLANE_DIAGNOSTIC = "kiro_auth_plane";

/**
 * The data an `isKiroManagementHttpError()` caller may rely on.
 *
 * Deliberately narrower than `KiroManagementHttpError`: the guard also accepts a
 * structurally-identical error from a duplicate copy of this package, which is
 * not this class and therefore carries no methods. Narrowing to the class would
 * let `markRefreshAttempted()` typecheck on such a value and throw at runtime.
 *
 * `refreshAttempted` is optional because a foreign copy may predate that field.
 */
export interface KiroManagementErrorInfo extends Error {
  readonly plane: "management";
  readonly status: number;
  readonly refreshAttempted?: boolean;
}

/**
 * A Kiro management control-plane HTTP failure.
 *
 * `message` is deliberately byte-identical to the string this class has always
 * carried (`Kiro management <operation> failed in <region>: <status><statusText>`) —
 * downstream consumers string-match it, so the text is an API contract. The
 * typed fields are strictly additive: read them instead of parsing `message`.
 */
export class KiroManagementHttpError extends Error {
  /**
   * Discriminator so consumers need not parse `message` to tell the planes
   * apart. Typed as the literal rather than `KiroErrorPlane` so a consumer
   * comparing it against `"runtime"` is told that branch is unreachable.
   */
  readonly plane = "management" as const;

  #refreshAttempted = false;

  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "KiroManagementHttpError";
  }

  /**
   * True when this provider already tried to obtain a working credential before
   * the error escaped — either the refresh itself failed, or it produced a
   * credential the management plane then rejected too. A consumer seeing `true`
   * knows in-process re-auth was tried and lost, so prompting for another
   * automatic retry is wasted work — the state needs a human to
   * re-authenticate.
   *
   * Only `streamKiro` sets this, and it never rethrows to its caller — it
   * flattens the error into `AssistantMessage.errorMessage`. Read this field
   * from the `KIRO_AUTH_PLANE_DIAGNOSTIC` diagnostic on that message rather
   * than expecting to catch the error object. It is readable directly only when
   * calling the management helpers in this module yourself, and is always
   * `false` there, because nothing but `streamKiro` attempts a refresh.
   */
  get refreshAttempted(): boolean {
    return this.#refreshAttempted;
  }

  /**
   * Record that a credential refresh was attempted, and return `this`.
   *
   * Returns the same instance rather than a copy because `stream.ts`
   * deliberately rethrows the *original* error after a failed refresh; cloning
   * would discard its stack and break `instanceof` identity for anything that
   * captured the original.
   */
  markRefreshAttempted(): this {
    this.#refreshAttempted = true;
    return this;
  }
}

/**
 * True when `error` is a management-plane HTTP failure.
 *
 * For consumers of this package. Checks shape before `instanceof` so it still
 * holds across duplicate copies of this package — a bundled consumer plus a
 * `node_modules` copy produce two distinct classes, and `instanceof` alone
 * would report `false` for a genuine management error from the other copy.
 *
 * Narrows to `KiroManagementErrorInfo`, not to this class: a foreign copy's
 * error carries the data fields but no methods, so the narrowed type omits
 * `markRefreshAttempted()` rather than letting a call on it typecheck and throw.
 */
export function isKiroManagementHttpError(error: unknown): error is KiroManagementErrorInfo {
  if (!(error instanceof Error)) return false;
  const candidate = error as Partial<KiroManagementErrorInfo>;
  return (
    (candidate.plane === "management" && typeof candidate.status === "number") ||
    error instanceof KiroManagementHttpError
  );
}

async function requestManagement<TResponse>(
  auth: KiroManagementAuth,
  operation: string,
  path: string,
  method: "GET" | "POST",
  body: Record<string, unknown>,
): Promise<TResponse> {
  const url = new URL(path, getKiroEndpoints(auth.region).management);
  const request: RequestInit = {
    method,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${auth.accessToken}`,
    },
  };
  if (method === "GET") {
    for (const [name, value] of Object.entries(body)) {
      if (value !== undefined) url.searchParams.set(name, String(value));
    }
  } else {
    request.headers = { ...request.headers, "Content-Type": "application/json" };
    request.body = JSON.stringify(body);
  }

  let response: Response;
  try {
    response = await fetch(url.toString(), request);
  } catch (error) {
    throw new Error(`Kiro management ${operation} request failed in ${auth.region}`, { cause: error });
  }

  return parseManagementResponse<TResponse>(response, operation, auth.region);
}

function profileCacheKey(auth: KiroManagementAuth): string {
  const tokenHash = createHash("sha256").update(auth.accessToken).digest("base64url");
  return `${auth.region}:${tokenHash}`;
}

async function parseManagementResponse<TResponse>(
  response: Response,
  operation: string,
  region: string,
): Promise<TResponse> {
  if (!response.ok) {
    const statusText = response.statusText ? ` ${redactSensitiveText(response.statusText)}` : "";
    throw new KiroManagementHttpError(
      `Kiro management ${operation} failed in ${region}: ${response.status}${statusText}`,
      response.status,
    );
  }

  try {
    return (await response.json()) as TResponse;
  } catch (error) {
    throw new Error(`Kiro management ${operation} returned invalid JSON in ${region}`, { cause: error });
  }
}
export function resetKiroProfileArnCache(): void {
  profileArnCache.clear();
  pendingProfileRequests.clear();
}

export function invalidateKiroProfileArn(auth: KiroManagementAuth): void {
  const key = profileCacheKey(auth);
  profileArnCache.delete(key);
  pendingProfileRequests.delete(key);
}

export async function resolveKiroProfileArn(auth: KiroManagementAuth, providedArn?: string): Promise<string> {
  if (providedArn) return providedArn;

  const key = profileCacheKey(auth);
  const cachedArn = profileArnCache.get(key);
  if (cachedArn) return cachedArn;

  const pending = pendingProfileRequests.get(key);
  if (pending) return pending;

  const request = (async () => {
    const response = await requestManagement<KiroListAvailableProfilesResponse>(
      auth,
      "ListAvailableProfiles",
      LIST_PROFILES_PATH,
      "POST",
      {},
    );
    const arn = response.profiles?.find((profile) => profile.arn)?.arn;
    if (!arn) {
      throw new Error(`Kiro management ListAvailableProfiles returned no profile in ${auth.region}`);
    }
    profileArnCache.set(key, arn);
    return arn;
  })();
  pendingProfileRequests.set(key, request);

  try {
    return await request;
  } finally {
    if (pendingProfileRequests.get(key) === request) pendingProfileRequests.delete(key);
  }
}

export async function listAvailableModels(
  auth: KiroManagementAuth,
  profileArn: string,
): Promise<KiroListAvailableModelsResponse> {
  const response = await requestManagement<KiroListAvailableModelsResponse>(
    auth,
    "ListAvailableModels",
    LIST_MODELS_PATH,
    "GET",
    {
      origin: "KIRO_CLI",
      profileArn,
    },
  );

  if (!Array.isArray(response.models) || response.models.length === 0) {
    throw new Error(`Kiro management ListAvailableModels returned no models in ${auth.region}`);
  }
  if (response.models.some((model) => !model || typeof model.modelId !== "string" || !model.modelId)) {
    throw new Error(`Kiro management ListAvailableModels returned an invalid catalog in ${auth.region}`);
  }

  return response;
}

export async function fetchKiroModelCatalog(
  auth: KiroManagementAuth,
  providedProfileArn?: string,
): Promise<KiroListAvailableModelsResponse> {
  const profileArn = await resolveKiroProfileArn(auth, providedProfileArn);
  return listAvailableModels(auth, profileArn);
}

export async function getUsageLimits<TResponse>(
  auth: KiroManagementAuth,
  request: KiroGetUsageLimitsRequest,
): Promise<TResponse> {
  const operation = "GetUsageLimits";
  const url = new URL("Get-Usage-Limits", getKiroEndpoints(auth.region).management);
  for (const [name, value] of Object.entries(request)) {
    if (value !== undefined) url.searchParams.set(name, String(value));
  }

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${auth.accessToken}`,
        "User-Agent": "pi-provider-kiro",
      },
    });
  } catch (error) {
    throw new Error(`Kiro management ${operation} request failed in ${auth.region}`, { cause: error });
  }

  return parseManagementResponse<TResponse>(response, operation, auth.region);
}
