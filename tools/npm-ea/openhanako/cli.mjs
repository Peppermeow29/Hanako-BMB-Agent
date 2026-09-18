#!/usr/bin/env node
// openhanako — companion distribution name for HanaAgent.
// From 1.0 this package aliases the primary `hanaagent` package and
// forwards its CLI; today both names carry the same early-access build.

const VERSION = "0.0.1";

const arg = process.argv[2] ?? "";

if (arg === "--version" || arg === "-v") {
  console.log(VERSION);
  process.exit(0);
}

console.log(`
  openhanako ${VERSION} (early access)

  HanaAgent — a personal AI agent with memory and soul.

  openhanako is the companion distribution name for HanaAgent; from
  the 1.0 release this package aliases the primary package and
  forwards its CLI. The full CLI — local agent server, chat, data
  tooling — arrives with 1.0. The primary package name is:

      npm install -g hanaagent

  Commands available today:

      openhanako --version    print the installed version
      openhanako              show this message
`);
