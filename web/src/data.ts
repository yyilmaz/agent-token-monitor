// The single data-access layer (ADR 0005). In the browser it uses fetch; a VS Code Webview will use postMessage
// with the same endpoint names and receive the same JSON (ADR 0013). No other module knows where data comes from.

import type { ConfigError } from "../../src/core/config/config.js";

export class ConfigErrors extends Error {
  constructor(readonly errors: readonly ConfigError[]) {
    super("configuration errors");
  }
}

export async function getJson<T>(endpoint: string): Promise<T> {
  const response = await fetch(endpoint, { headers: { Accept: "application/json" } });
  const body = (await response.json()) as T & { configErrors?: readonly ConfigError[]; error?: string };
  if (body.configErrors !== undefined) throw new ConfigErrors(body.configErrors);
  if (!response.ok) throw new Error(body.error ?? `request failed: ${response.status}`);
  return body;
}
