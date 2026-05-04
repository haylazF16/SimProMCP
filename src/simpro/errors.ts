import { maskToken } from "../logger.js";

export class SimproApiError extends Error {
  public readonly status: number;
  public readonly endpoint: string;
  public readonly method: string;
  public readonly body: unknown;

  constructor(opts: { status: number; method: string; endpoint: string; body: unknown; message?: string }) {
    super(opts.message ?? `Simpro API ${opts.method} ${opts.endpoint} failed with HTTP ${opts.status}`);
    this.name = "SimproApiError";
    this.status = opts.status;
    this.method = opts.method;
    this.endpoint = opts.endpoint;
    this.body = opts.body;
  }

  /** Short user-facing remediation hint, never includes credentials. */
  get hint(): string {
    switch (this.status) {
      case 401:
        return "Unauthorized — check that SIMPRO_API_KEY is correct and active.";
      case 403:
        return "Forbidden — your API key does not have permission for this resource. Check Simpro role/permission settings.";
      case 404:
        return "Not found — verify the record ID and SIMPRO_COMPANY_ID. The endpoint path may differ for your tenant (see src/simpro/endpoints.ts).";
      case 429:
        return "Rate limited by Simpro — wait a moment and try again.";
      default:
        if (this.status >= 500) return "Simpro server error — try again shortly.";
        return "Request rejected by Simpro — see body for details.";
    }
  }

  toUserMessage(): string {
    const bodyStr = this.body === undefined ? "" : `\nDetails: ${maskToken(this.body)}`;
    return `Simpro API error (${this.status}) on ${this.method} ${this.endpoint}\n${this.hint}${bodyStr}`;
  }
}

export class SimproNetworkError extends Error {
  public override readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "SimproNetworkError";
    this.cause = cause;
  }
}

export class SimproConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SimproConfigError";
  }
}
