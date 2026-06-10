import { Agent } from "undici";
import { Config } from "../config.js";
import { log } from "../logger.js";
import { SimproApiError, SimproNetworkError } from "./errors.js";
import { companyPath, rootPath } from "./endpoints.js";

export type Query = Record<string, string | number | boolean | undefined | null>;

export interface RequestOptions {
  query?: Query;
  body?: unknown;
  /** Skip retry for non-idempotent calls. Defaults: GET retries, others do not. */
  retry?: boolean;
  /** Override per-request timeout. */
  timeoutMs?: number;
  /** Extra headers, merged on top of defaults. */
  headers?: Record<string, string>;
}

const DEFAULT_RETRYABLE_METHODS = new Set(["GET", "HEAD"]);
const MAX_ATTEMPTS = 3;

// Reuse TLS connections to Simpro instead of a fresh handshake per call.
// Simpro is in Australia; the TLS handshake dominated per-request latency.
const keepAliveAgent = new Agent({
  keepAliveTimeout: 30_000,
  keepAliveMaxTimeout: 60_000,
  connections: 16,
});

export class SimproClient {
  constructor(private readonly cfg: Config) {}

  // ---- public path helpers ----------------------------------------------

  /** Build a company-scoped path using the configured SIMPRO_COMPANY_ID. */
  companyPath(suffix: string): string {
    return companyPath(this.cfg.SIMPRO_COMPANY_ID, suffix);
  }

  rootPath(suffix: string): string {
    return rootPath(suffix);
  }

  // ---- HTTP verbs --------------------------------------------------------

  get<T = unknown>(path: string, query?: Query): Promise<T> {
    return this.request<T>("GET", path, { query });
  }
  post<T = unknown>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", path, { body });
  }
  patch<T = unknown>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("PATCH", path, { body });
  }
  put<T = unknown>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("PUT", path, { body });
  }

  // ---- core request ------------------------------------------------------

  async request<T = unknown>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const url = this.buildUrl(path, opts.query);
    const retryable = opts.retry ?? DEFAULT_RETRYABLE_METHODS.has(method.toUpperCase());

    let lastErr: unknown;
    for (let attempt = 1; attempt <= (retryable ? MAX_ATTEMPTS : 1); attempt++) {
      try {
        return await this.doFetch<T>(method, url, path, opts);
      } catch (err) {
        lastErr = err;
        if (!retryable) throw err;
        if (!shouldRetry(err)) throw err;
        if (attempt >= MAX_ATTEMPTS) break;
        const backoff = 250 * Math.pow(2, attempt - 1);
        log.warn(`Simpro ${method} ${path} attempt ${attempt} failed; retrying in ${backoff}ms`);
        await sleep(backoff);
      }
    }
    throw lastErr;
  }

  // ---- internals ---------------------------------------------------------

  private buildUrl(path: string, query?: Query): string {
    const base = this.cfg.SIMPRO_BASE_URL;
    const cleanPath = path.startsWith("/") ? path : `/${path}`;
    let url = `${base}${cleanPath}`;
    if (query) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null || v === "") continue;
        params.append(k, String(v));
      }
      const qs = params.toString();
      if (qs) url += (url.includes("?") ? "&" : "?") + qs;
    }
    return url;
  }

  /**
   * Build the auth header(s) for Simpro.
   *
   * Simpro's API key workflow uses the access token as a Bearer token.
   * If your Simpro tenant requires a different header shape, adjust ONLY this
   * function and every tool will pick up the change.
   *
   * Alternatives some tenants use:
   *   { Authorization: this.cfg.SIMPRO_API_KEY }   // raw token, no "Bearer "
   *   { "X-API-Key": this.cfg.SIMPRO_API_KEY }    // custom header
   */
  private buildAuthHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.cfg.SIMPRO_API_KEY}` };
  }

  private async doFetch<T>(method: string, url: string, path: string, opts: RequestOptions): Promise<T> {
    const controller = new AbortController();
    const timeoutMs = opts.timeoutMs ?? this.cfg.SIMPRO_REQUEST_TIMEOUT_MS;
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const headers: Record<string, string> = {
      Accept: "application/json",
      ...this.buildAuthHeaders(),
      ...(opts.headers ?? {}),
    };

    let bodyStr: string | undefined;
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      bodyStr = JSON.stringify(opts.body);
    }

    log.debug(`-> ${method} ${path}`);
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: bodyStr,
        signal: controller.signal,
        dispatcher: keepAliveAgent,
      });
    } catch (err: unknown) {
      clearTimeout(timer);
      if (isAbortError(err)) {
        throw new SimproNetworkError(
          `Simpro request timed out after ${timeoutMs}ms (${method} ${path}). Check SIMPRO_BASE_URL and network.`,
          err,
        );
      }
      throw new SimproNetworkError(
        `Could not reach Simpro at ${this.cfg.SIMPRO_BASE_URL} — check the URL and your network connection.`,
        err,
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    let parsed: unknown = undefined;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    if (!res.ok) {
      // Surface a class of bug we've hit before: Simpro rejects a columns=
      // selector naming a column the endpoint doesn't expose, with
      // "Invalid columns ..." in the body — observed as 400 (jobs:
      // "Invalid columns: JobNumber") AND 422 (sites: "Invalid columns
      // found", value "Customer"). Gate on 4xx, not a single status: any
      // client error can carry the message, but retried 5xx bodies (HTML
      // outage pages, scanned once per retry attempt) cannot meaningfully
      // contain it and would only add stringify cost and WARN noise.
      // ALSO require that the request actually carried a columns= selector:
      // Simpro uses the same "Invalid column." wording when rejecting a
      // PAYLOAD field on a POST (e.g. {"path":"/CostCentre"} on
      // /sections/{sid}/costCenters/ — observed 2026-06-09), and blaming a
      // nonexistent columns selector sent operators down the wrong path.
      if (res.status >= 400 && res.status < 500 && url.includes("columns=")) {
        const bodyStr = typeof parsed === "string" ? parsed : safeJsonStringify(parsed);
        if (/invalid\s+columns?/i.test(bodyStr.slice(0, 2000))) {
          log.warn(
            `Simpro rejected columns selector on ${method} ${path} (status ${res.status}): ${bodyStr.slice(0, 300)}`,
          );
        }
      }
      throw new SimproApiError({
        status: res.status,
        method,
        endpoint: path,
        body: parsed,
      });
    }

    log.debug(`<- ${res.status} ${method} ${path}`);
    return parsed as T;
  }
}

function shouldRetry(err: unknown): boolean {
  if (err instanceof SimproApiError) {
    return err.status === 429 || (err.status >= 500 && err.status <= 599);
  }
  if (err instanceof SimproNetworkError) return true;
  return false;
}

function isAbortError(err: unknown): boolean {
  return !!err && typeof err === "object" && (err as { name?: string }).name === "AbortError";
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function safeJsonStringify(v: unknown): string {
  try {
    // JSON.stringify returns undefined for undefined/function/symbol inputs;
    // coerce so this always honours its `: string` return type (an empty 400
    // body leaves `parsed` undefined, which would otherwise yield undefined).
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}
