#!/usr/bin/env node
// HanaAgent CLI — early access build.
// The full CLI (serve / chat / data tooling) ships with the 1.0 release
// on this same package name; `npm update -g hanaagent` will pick it up.

const VERSION = "0.0.1";

const arg = process.argv[2] ?? "";

if (arg === "--version" || arg === "-v") {
  console.log(VERSION);
  process.exit(0);
}

console.log(`
  HanaAgent ${VERSION} (early access)

  A personal AI agent with memory and soul.

  This is an early-access build published ahead of the 1.0 launch.
  The full CLI — local agent server, chat, data tooling — arrives on
  this package name with the 1.0 release. Update then with:

      npm update -g hanaagent

  Commands available today:

      hana --version    print the installed version
      hana              show this message
`);
