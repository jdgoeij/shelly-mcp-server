import type { ShellyDevice } from "./config.js";

export type RpcRequestStyle = "query" | "json";

export interface RpcCallOptions {
  timeoutMs: number;
  requestStyle?: RpcRequestStyle;
}

function buildBasicAuthHeader(device: ShellyDevice): string | undefined {
  if (!device.username || !device.password) {
    return undefined;
  }

  const token = Buffer.from(`${device.username}:${device.password}`).toString(
    "base64"
  );
  return `Basic ${token}`;
}

function asQueryParams(params: Record<string, unknown>): URLSearchParams {
  const query = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) {
      continue;
    }

    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      query.append(key, String(value));
      continue;
    }

    query.append(key, JSON.stringify(value));
  }

  return query;
}

export async function callShellyRpc(
  device: ShellyDevice,
  method: string,
  params: Record<string, unknown> = {},
  options: RpcCallOptions
): Promise<unknown> {
  const requestStyle = options.requestStyle ?? "query";
  const url = new URL(`/rpc/${method}`, device.baseUrl);
  const authHeader = buildBasicAuthHeader(device);

  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (authHeader) {
    headers.Authorization = authHeader;
  }

  let response: Response;

  if (requestStyle === "json") {
    headers["Content-Type"] = "application/json";
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  } else {
    url.search = asQueryParams(params).toString();
    response = await fetch(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  }

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `Shelly RPC failed (${response.status} ${response.statusText}): ${text}`
    );
  }

  if (!text) {
    return { ok: true };
  }

  try {
    const payload = JSON.parse(text);
    if (payload && typeof payload === "object" && "code" in payload && "message" in payload) {
      throw new Error(`Shelly error ${String(payload.code)}: ${String(payload.message)}`);
    }
    return payload;
  } catch (e) {
    if (e instanceof SyntaxError) {
      return { raw: text };
    }
    throw e;
  }
}
