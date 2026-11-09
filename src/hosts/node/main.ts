// Standalone entry point: node dist/src/hosts/node/main.js [--config <path>] [--port <n>] [--status] (ADR 0013).
// Prints the dashboard URL (or JSON overview with --status); does not open a browser and writes nothing to disk.

import { homedir } from "node:os";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

import * as api from "../../core/api/index.js";
import { stableStringify } from "../../core/config/config.js";
import { defaultConfigPath, resolveUserConfigPath } from "./config.js";
import { startServer } from "./server.js";
import { AnalysisStore } from "./store.js";

/** `--port <n>` or `--port=<n>`; 0 asks the operating system for a free port (ADR 0005). */
export function portArgument(argv: readonly string[]): number | null {
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] as string;
    const value = arg === "--port" ? argv[index + 1] : arg.startsWith("--port=") ? arg.slice("--port=".length) : undefined;
    if (value === undefined) continue;
    const port = Number(value);
    return Number.isInteger(port) && port >= 0 && port <= 65535 ? port : null;
  }
  return 0;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const homeDir = homedir();
  const store = new AnalysisStore({
    defaultsPath: defaultConfigPath(),
    userConfigPath: resolveUserConfigPath({ argv, env: process.env, homeDir, cwd: process.cwd() }),
    homeDir,
    systemTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
  if (argv.includes("--status")) {
    const now = Date.now();
    const state = await store.current(now);
    if (!state.ok) {
      process.stderr.write(stableStringify({ error: "invalidConfiguration", errors: state.errors }) + "\n");
      process.exitCode = 2;
      return;
    }
    process.stdout.write(stableStringify(api.overview(state.analysis, now)) + "\n");
    return;
  }
  const port = portArgument(argv);
  if (port === null) {
    console.error("--port must be a whole number from 0 to 65535");
    process.exitCode = 2;
    return;
  }
  const server = await startServer(
    {
      store,
      staticDir: fileURLToPath(new URL("../../../../web/static", import.meta.url)),
      scriptDir: fileURLToPath(new URL("../../../web/src", import.meta.url)),
      vendorDir: fileURLToPath(new URL("../../../../web/vendor", import.meta.url)),
      now: () => Date.now(),
    },
    port,
  );
  console.log(`agent-token-monitor: http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) await main();
