import { normalizeBaseUrl } from "../settings";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: "UNAUTHORIZED" | "NETWORK" | "CONFIG" | "UNKNOWN" = "UNKNOWN",
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export class OpenProjectClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  static fromConnection(baseUrl: string, token: string): OpenProjectClient {
    return new OpenProjectClient(normalizeBaseUrl(baseUrl), token.trim());
  }

  async getJson<T = unknown>(pathOrUrl: string): Promise<T> {
    const url = pathOrUrl.startsWith("http")
      ? pathOrUrl
      : `${this.baseUrl}${pathOrUrl.startsWith("/") ? "" : "/"}${pathOrUrl}`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/hal+json, application/json",
        },
      });
    } catch (error) {
      throw new ApiError(
        error instanceof Error ? error.message : "Network error",
        0,
        "NETWORK",
      );
    }

    if (response.status === 401 || response.status === 403) {
      throw new ApiError("Unauthorized — check API token", response.status, "UNAUTHORIZED");
    }

    if (!response.ok) {
      throw new ApiError(`OpenProject API ${response.status}: ${response.statusText}`, response.status);
    }

    return (await response.json()) as T;
  }

  async postJson<T = unknown>(pathOrUrl: string, body: unknown = {}): Promise<T | null> {
    return this.writeJson<T>("POST", pathOrUrl, body);
  }

  async patchJson<T = unknown>(pathOrUrl: string, body: unknown = {}): Promise<T | null> {
    return this.writeJson<T>("PATCH", pathOrUrl, body);
  }

  private async writeJson<T = unknown>(
    method: "POST" | "PATCH",
    pathOrUrl: string,
    body: unknown = {},
  ): Promise<T | null> {
    const url = pathOrUrl.startsWith("http")
      ? pathOrUrl
      : `${this.baseUrl}${pathOrUrl.startsWith("/") ? "" : "/"}${pathOrUrl}`;

    let response: Response;
    try {
      // OpenProject requires Content-Type on write requests (406 without it), even for empty bodies
      response = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/hal+json, application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body ?? {}),
      });
    } catch (error) {
      throw new ApiError(
        error instanceof Error ? error.message : "Network error",
        0,
        "NETWORK",
      );
    }

    if (response.status === 401 || response.status === 403) {
      throw new ApiError("Unauthorized — check API token", response.status, "UNAUTHORIZED");
    }

    if (response.status === 204) {
      return null;
    }

    if (!response.ok) {
      let detail = response.statusText;
      try {
        const errBody = (await response.json()) as { message?: unknown };
        if (typeof errBody.message === "string") detail = errBody.message;
        else if (Array.isArray(errBody.message)) detail = errBody.message.map(String).join("; ");
      } catch {
        // keep statusText
      }
      throw new ApiError(`OpenProject API ${response.status}: ${detail}`, response.status);
    }

    const text = await response.text();
    if (!text) return null;
    return JSON.parse(text) as T;
  }

  async getCollection<T = Record<string, unknown>>(path: string): Promise<T[]> {
    const elements: T[] = [];
    let offset = 1;
    const pageSize = 100;

    for (;;) {
      const separator = path.includes("?") ? "&" : "?";
      const page = await this.getJson<{
        _embedded?: { elements?: T[] };
        total?: number;
        count?: number;
      }>(`${path}${separator}offset=${offset}&pageSize=${pageSize}`);

      const batch = page._embedded?.elements ?? [];
      elements.push(...batch);

      const total = page.total ?? elements.length;
      if (elements.length >= total || batch.length === 0) {
        break;
      }
      offset += pageSize;
    }

    return elements;
  }
}

export function linkTitle(entity: Record<string, unknown>, key: string): string {
  const links = entity._links;
  if (!isRecord(links)) return "";
  const link = links[key];
  if (!isRecord(link)) return "";
  return typeof link.title === "string" ? link.title : "";
}

export function linkHref(entity: Record<string, unknown>, key: string): string {
  const links = entity._links;
  if (!isRecord(links)) return "";
  const link = links[key];
  if (!isRecord(link)) return "";
  return typeof link.href === "string" ? link.href : "";
}

export function linkId(entity: Record<string, unknown>, key: string): number | null {
  const href = linkHref(entity, key);
  if (!href) return null;
  const id = Number(href.replace(/\/+$/, "").split("/").pop());
  return Number.isFinite(id) ? id : null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
