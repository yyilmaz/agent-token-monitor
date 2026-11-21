#!/usr/bin/env node
// Standalone entry point: node dist/src/hosts/node/main.js [--config <path>] [--port <n>] [--status] [--help] (ADR 0013).
// Prints the dashboard URL (or JSON overview with --status); does not open a browser and writes nothing to disk.

import { realpathSync } from "node:fs";
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

const HELP_TEXT = `Usage: agent-token-monitor [options]

Options:
  --port <n>       Listen on port n on 127.0.0.1 (default: 0, OS-assigned free port)
  --config <path>  Path to user configuration JSON file
  --status         Print JSON overview to stdout and exit
  -h, --help       Show this help message and exit
`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP_TEXT);
    return;
  }
  const homeDir = homedir();
  const store = new AnalysisStore({
    defaultsPath: defaultConfigPath(),
    userConfigPath: resolveUserConfigPath({ argv, env: process.env, homeDir, cwd: process.cwd() }),
    homeDir,
    systemTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    platform: process.platform,
    env: process.env,
  });
  if (argv.includes("--status")) {
    const now = Date.now();
    await store.current(now);
    await store.idle();
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
  // Warm up active sessions immediately in the background (ADR 0024).
  void store.current(Date.now()).catch(() => {});
  console.log(`agent-token-monitor: http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
}

function isDirectExecution(): boolean {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isDirectExecution()) await main();
