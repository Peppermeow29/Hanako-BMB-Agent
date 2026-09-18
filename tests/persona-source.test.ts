import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { resolvePersonaLocale, resolvePersonaSource } from "../core/persona-source.ts";

const tempDirs: string[] = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-persona-source-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolvePersonaSource", () => {
  for (const kind of ["identity", "agents"] as const) {
    const templateDir = kind === "identity" ? "identity-templates" : "agents-templates";
    const exampleFile = kind === "identity" ? "identity.example.md" : "agents.example.md";
    const fileName = kind === "identity" ? "identity.md" : "AGENTS.md";

    describe(`kind: ${kind}`, () => {
      it("prefers the agentDir on-disk file over any template (level 1)", () => {
        const root = makeTempDir();
        const agentDir = path.join(root, "agent");
        const productDir = path.join(root, "product");
        fs.mkdirSync(agentDir, { recursive: true });
        fs.mkdirSync(path.join(productDir, templateDir, "en"), { recursive: true });
        fs.writeFileSync(path.join(agentDir, fileName), "user customized content", "utf-8");
        fs.writeFileSync(path.join(productDir, templateDir, "en", "hanako.md"), "en template", "utf-8");
        fs.writeFileSync(path.join(productDir, templateDir, "hanako.md"), "generic template", "utf-8");
        fs.writeFileSync(path.join(productDir, exampleFile), "example fallback", "utf-8");

        const result = resolvePersonaSource({ agentDir, productDir, yuanType: "hanako", locale: "en", kind });

        expect(result).toEqual({ content: "user customized content", fromTemplate: false });
      });

      it("falls back to the locale-specific yuan template when agentDir file is missing (level 2, en)", () => {
        const root = makeTempDir();
        const agentDir = path.join(root, "agent");
        const productDir = path.join(root, "product");
        fs.mkdirSync(agentDir, { recursive: true });
        fs.mkdirSync(path.join(productDir, templateDir, "en"), { recursive: true });
        fs.writeFileSync(path.join(productDir, templateDir, "en", "hanako.md"), "en template", "utf-8");
        fs.writeFileSync(path.join(productDir, templateDir, "hanako.md"), "generic template", "utf-8");
        fs.writeFileSync(path.join(productDir, exampleFile), "example fallback", "utf-8");

        const result = resolvePersonaSource({ agentDir, productDir, yuanType: "hanako", locale: "en", kind });

        expect(result).toEqual({ content: "en template", fromTemplate: true });
      });

      it("uses the zh (no langDir) template directly when locale starts with zh (level 2, zh)", () => {
        const root = makeTempDir();
        const agentDir = path.join(root, "agent");
        const productDir = path.join(root, "product");
        fs.mkdirSync(agentDir, { recursive: true });
        fs.mkdirSync(path.join(productDir, templateDir), { recursive: true });
        fs.writeFileSync(path.join(productDir, templateDir, "hanako.md"), "zh template (generic path)", "utf-8");
        fs.writeFileSync(path.join(productDir, exampleFile), "example fallback", "utf-8");

        const result = resolvePersonaSource({ agentDir, productDir, yuanType: "hanako", locale: "zh-CN", kind });

        expect(result).toEqual({ content: "zh template (generic path)", fromTemplate: true });
      });

      it("falls back to the generic (non-locale) yuan template when the locale-specific one is missing (level 3)", () => {
        const root = makeTempDir();
        const agentDir = path.join(root, "agent");
        const productDir = path.join(root, "product");
        fs.mkdirSync(agentDir, { recursive: true });
        fs.mkdirSync(path.join(productDir, templateDir), { recursive: true });
        fs.writeFileSync(path.join(productDir, templateDir, "hanako.md"), "generic yuan template", "utf-8");
        fs.writeFileSync(path.join(productDir, exampleFile), "example fallback", "utf-8");

        const result = resolvePersonaSource({ agentDir, productDir, yuanType: "hanako", locale: "en", kind });

        expect(result).toEqual({ content: "generic yuan template", fromTemplate: true });
      });

      it("falls back to the example file when no agentDir file or yuan template exists (level 4)", () => {
        const root = makeTempDir();
        const agentDir = path.join(root, "agent");
        const productDir = path.join(root, "product");
        fs.mkdirSync(agentDir, { recursive: true });
        fs.mkdirSync(productDir, { recursive: true });
        fs.writeFileSync(path.join(productDir, exampleFile), "example fallback", "utf-8");

        const result = resolvePersonaSource({ agentDir, productDir, yuanType: "hanako", locale: "en", kind });

        expect(result).toEqual({ content: "example fallback", fromTemplate: true });
      });

      it("returns an empty template content when nothing exists at any level", () => {
        const root = makeTempDir();
        const agentDir = path.join(root, "agent");
        const productDir = path.join(root, "product");
        fs.mkdirSync(agentDir, { recursive: true });
        fs.mkdirSync(productDir, { recursive: true });

        const result = resolvePersonaSource({ agentDir, productDir, yuanType: "hanako", locale: "en", kind });

        expect(result).toEqual({ content: "", fromTemplate: true });
      });
    });
  }
});

describe("resolvePersonaLocale", () => {
  it("prefers the explicit config locale over the global locale", () => {
    expect(resolvePersonaLocale("en", "zh-CN")).toBe("en");
  });

  it("falls back to the global locale when config locale is absent", () => {
    expect(resolvePersonaLocale(undefined, "zh-CN")).toBe("zh-CN");
    expect(resolvePersonaLocale("", "zh-CN")).toBe("zh-CN");
    expect(resolvePersonaLocale("   ", "zh-CN")).toBe("zh-CN");
  });

  it("falls back to en when neither config nor global locale is set", () => {
    expect(resolvePersonaLocale(undefined, undefined)).toBe("en");
    expect(resolvePersonaLocale("", "")).toBe("en");
  });
});
