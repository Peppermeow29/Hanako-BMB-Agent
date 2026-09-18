#!/usr/bin/env node

import path from "path";
import { fileURLToPath } from "url";
import { parseCliArgs, helpText } from "./args.ts";
import { resolveConnection } from "./local-server.ts";
import { HanaCliClient } from "./client.ts";
import { printSessions, printStatus, startChat } from "./chat.ts";
import { spawnServerForeground, startLocalServerAndWait } from "./server-runner.ts";
import { runDataDiagnose, runDataCheckpoints, runDataRestore } from "./data.ts";
import { ansi } from "./terminal-theme.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");

export async function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseCliArgs(argv);
  } catch (err) {
    console.error(`${ansi.red}${err.message}${ansi.reset}`);
    console.log(helpText());
    return 1;
  }

  if (args.command === "help") {
    if (args.error) console.error(`${ansi.yellow}${args.error}${ansi.reset}\n`);
    console.log(helpText());
    return args.error ? 1 : 0;
  }

  if (args.command === "serve") {
    await spawnServerForeground({
      projectRoot: PROJECT_ROOT,
      extraArgs: args.passthrough,
      allowDataDowngrade: args.allowDataDowngrade,
    });
    return 0;
  }

  if (args.command === "data") {
    // Local filesystem maintenance surface for the data-epoch safety chain
    // — never talks to a running server, so it also skips resolveConnection.
    if (args.subcommand === "diagnose") {
      return await runDataDiagnose();
    }
    if (args.subcommand === "checkpoints") {
      return await runDataCheckpoints();
    }
    return await runDataRestore({ transitionId: args.target, confirmToken: args.confirmToken });
  }

  let connection: any = resolveConnection({ url: args.url, token: args.token });
  if (!connection.ok && shouldAutoStartServer(args)) {
    console.error(`${ansi.dim}Starting local HanaAgent Server...${ansi.reset}`);
    connection = await startLocalServerAndWait({ projectRoot: PROJECT_ROOT });
  }
  if (!connection.ok) {
    console.error(`${ansi.red}${connection.message}${ansi.reset}`);
    console.error(`${ansi.dim}Start one with: hana serve${ansi.reset}`);
    return 1;
  }

  const client = new HanaCliClient(connection);
  if (args.command === "status") {
    await printStatus(client, connection);
    return 0;
  }
  if (args.command === "sessions") {
    await printSessions(client);
    return 0;
  }
  if (args.command === "continue") {
    await startChat(client, connection, { target: args.target, plain: args.plain });
    return 0;
  }
  if (args.command === "chat") {
    await startChat(client, connection, { session: args.session, plain: args.plain });
    return 0;
  }

  console.log(helpText());
  return 0;
}

function shouldAutoStartServer(args) {
  if (args.url) return false;
  return args.command === "chat" || args.command === "continue";
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const code = await main();
  if (code) process.exit(code);
}
