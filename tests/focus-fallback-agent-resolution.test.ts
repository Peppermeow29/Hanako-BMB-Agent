import fs from "fs";
import path from "path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * resolveAgent answered "which agent is this request about?" by falling back to
 * whichever agent the server was currently focused on when the request did not
 * say. That is a guess, and with two clients open on two different agents it is
 * sometimes the wrong one — a read can describe the other client's agent, a
 * write can land on it. It has been removed; resolveAgentStrict is the version
 * that refuses to guess.
 *
 * This count is permanently zero. A route that needs an agent takes an explicit
 * agentId and uses resolveAgentStrict; a route whose agent is optional passes
 * null onward instead of substituting one.
 */
const ROUTES_STILL_GUESSING: string[] = [];

const serverDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "server");
const routesDir = path.join(serverDir, "routes");

const FOCUS_OK_MARKER = "@ui-focus-ok";

function serverSourceFiles(dir = serverDir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return serverSourceFiles(full);
    return entry.isFile() && entry.name.endsWith(".ts") ? [full] : [];
  });
}

/**
 * A real read of the focus pointer, in any shape it appears in: a property
 * access, or a destructure off the engine. Prose that merely mentions the name
 * is not a read, so comment-only lines do not count.
 */
function readsFocusPointer(line) {
  const withoutComment = line.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, "");
  const code = withoutComment.trimStart().startsWith("*") ? "" : withoutComment;
  return /(?:\.\s*currentAgentId\b)|(?:\{[^}]*\bcurrentAgentId\b[^}]*\}\s*=)/.test(code);
}

function routeFilesCallingFocusFallback() {
  return fs.readdirSync(routesDir)
    .filter((name) => name.endsWith(".ts"))
    .filter((name) => {
      const source = fs.readFileSync(path.join(routesDir, name), "utf-8");
      // resolveAgentStrict( also contains resolveAgent, so require the exact call.
      return /(?<![A-Za-z])resolveAgent\(/.test(source);
    })
    .sort();
}

describe("focus-fallback agent resolution", () => {
  it("is not used by any route outside the known, shrinking list", () => {
    expect(routeFilesCallingFocusFallback()).toEqual([...ROUTES_STILL_GUESSING].sort());
  });

  it("only reads the focus pointer where a comment says why that is allowed", () => {
    const offenders = [];
    for (const file of serverSourceFiles()) {
      const lines = fs.readFileSync(file, "utf-8").split("\n");
      lines.forEach((line, index) => {
        if (!readsFocusPointer(line)) return;
        // The reason may sit on the offending line or in the comment block
        // directly above it.
        const preceding = lines.slice(Math.max(0, index - 6), index + 1).join("\n");
        if (preceding.includes(FOCUS_OK_MARKER)) return;
        offenders.push(`${path.relative(serverDir, file)}:${index + 1}`);
      });
    }
    // Every legitimate use is an echo of the focus itself — telling a client
    // which agent the server is on, or asking whether a request is a switch.
    // Deriving who owns data from it is the bug this guards against, so a new
    // entry here means the reason has to be written down or the read removed.
    expect(offenders).toEqual([]);
  });

  it("is gone from the config route family", () => {
    const source = fs.readFileSync(path.join(routesDir, "config.ts"), "utf-8");
    expect(/(?<![A-Za-z])resolveAgent\(/.test(source)).toBe(false);
    // And nothing in that file reads the focus pointer to decide ownership.
    expect(source).not.toContain("currentAgentId");
  });
});
