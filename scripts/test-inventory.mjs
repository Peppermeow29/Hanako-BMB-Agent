#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const TESTS_DIR = path.join(ROOT, "tests");
const TEST_FILE_RE = /\.test\.(?:ts|tsx|js)$/;

const FORMAT = process.argv.includes("--format=triage-md") ? "triage-md" : "json";

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(fullPath));
      continue;
    }
    if (entry.isFile() && TEST_FILE_RE.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

function countMatches(text, re) {
  return (text.match(re) || []).length;
}

function collectMatches(text, re) {
  return [...text.matchAll(re)].map((match) => match[1] ?? match[0]);
}

function collectIssueRefs(text) {
  const refs = [];
  const issueContextRe = /issue|regression|root[- ]?cause|回归|复现|覆盖|修复|真实|code review|discipline|方案|迁移|migration|I\d|阶段/i;
  for (const line of text.split(/\r?\n/)) {
    for (const match of line.matchAll(/\bissue\s*#?\s*(\d+)/gi)) {
      refs.push(`#${match[1]}`);
    }
    for (const match of line.matchAll(/#(\d+)(?![0-9A-Fa-f])/g)) {
      const ref = `#${match[1]}`;
      const tableCellRef = new RegExp(`\\|\\s*${ref}\\s*\\|`).test(line);
      if (tableCellRef || issueContextRe.test(line)) {
        refs.push(ref);
      }
    }
  }
  return uniq(refs);
}

function uniq(values) {
  return [...new Set(values.filter(Boolean))];
}

function relativeFromRoot(file) {
  return path.relative(ROOT, file).split(path.sep).join("/");
}

function analyzeFile(file) {
  const rel = relativeFromRoot(file);
  const text = fs.readFileSync(file, "utf8");
  const haystack = `${rel}\n${text}`;
  const lowerHaystack = haystack.toLowerCase();
  const imports = uniq([
    ...collectMatches(text, /\bfrom\s+["']([^"']+)["']/g),
    ...collectMatches(text, /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g),
  ]);
  const issueRefs = collectIssueRefs(text);
  const isIssueNamed = /(?:^|\/)(?:acceptance|.*issue[-_]\d+|.*regression).*\.test\.(?:ts|tsx|js)$/i.test(rel);
  const hasAcceptanceLanguage = /验收测试|acceptance test|issue-specific|临时验收|Provider 兼容层架构统一 plan 收尾/i.test(text);
  const flags = {
    hasSnapshot: text.includes("toMatchSnapshot") || text.includes("toMatchInlineSnapshot"),
    hasFsTmp: /\bmkdtemp(?:Sync)?\b|\btmpdir\b|\bHANA_HOME\b|\.hanako(?:-dev)?/.test(haystack),
    hasRoute: /\bHono\b|\bfetch\s*\(|route\b|server\/routes|\bHTTP\b/i.test(haystack),
    hasSecurity: /security|auth|capability|permission|credential|secret|route-security|access|principal|grant|cors|sandbox/i.test(haystack),
    hasBuild: /build|bundle|pack|runtime|native|electron|preload|server|installer|asar|nft/i.test(rel),
    hasBridge: /bridge|telegram|feishu|wechat|qq|media|streaming|adapter/i.test(haystack),
    hasResource: /resource|session[-_ ]?file|mediaitem|sidecar|artifact-tool|managed_cache/i.test(haystack),
    hasProvider: /provider|model payload|reasoning_content|thinking|deepseek|openai|qwen|mimo|zhipu|llm-client/i.test(haystack),
    hasPlatform: /win32|windows|linux|macos|darwin|cross[-_ ]?platform|path separator|shell|seatbelt|bwrap|appcontainer|sandbox/i.test(haystack),
    hasPersistence: /migration|persist|store|registry|sidecar|sqlite|jsonl|yaml|atomic|write|read|cache|HANA_HOME|mkdtemp/i.test(haystack),
    hasUiState: /desktop\/src\/react|zustand|selector|slice|store|app-events|window\.dispatchEvent|localStorage|sessionStorage/i.test(haystack),
    hasIssueRef: issueRefs.length > 0,
    isIssueNamed,
    isAcceptance: isIssueNamed || hasAcceptanceLanguage,
    touchesPrivateMock: /as any|@ts-ignore|_engine|_agentMgr|_sessionCoord|currentSessionPath|currentAgentId/.test(haystack),
    hardcodesHanaHome: /\.hanako(?:-dev)?/.test(haystack),
  };
  const category = categorize(rel, lowerHaystack, flags);
  const decision = decide(flags, category);
  return {
    file: rel,
    describeCount: countMatches(text, /\bdescribe\s*\(/g),
    itCount: countMatches(text, /\bit\s*\(/g),
    testCount: countMatches(text, /\btest\s*\(/g),
    issueRefs,
    category,
    decision,
    ownerArea: ownerArea(rel, flags),
    keepReason: keepReason(flags, category),
    deleteOrMergeCandidate: deleteOrMergeCandidate(flags, category, decision),
    flags,
    imports: imports.slice(0, 12),
  };
}

function categorize(rel, lowerHaystack, flags) {
  if (flags.isAcceptance && flags.hasProvider) return "regression / adapter";
  if (flags.isAcceptance && flags.hasBridge) return "regression / adapter";
  if (flags.isAcceptance && flags.hasResource) return "regression / persistence";
  if (flags.isAcceptance) return "regression";
  if (flags.hasSecurity) return "security";
  if (flags.hasBuild) return "build";
  if (flags.hasResource) return "persistence";
  if (flags.hasBridge) return "adapter";
  if (flags.hasProvider) return "adapter";
  if (flags.hasPlatform) return "platform";
  if (/architecture|engine-|manager|coordinator|execution-boundary|non-focus|decoupling|scope|ownership/.test(lowerHaystack)) {
    return "architecture";
  }
  if (flags.hasUiState) return "ui-state";
  if (flags.hasPersistence) return "persistence";
  if (/fixture|scaffold|env-check|setup/.test(rel)) return "scaffold";
  return "implementation";
}

function decide(flags, category) {
  if (category.startsWith("regression")) return "MERGE";
  if (category === "security" || category === "build" || category === "platform") return "KEEP";
  if (category === "persistence" || category === "adapter" || category === "architecture" || category === "ui-state") {
    return flags.touchesPrivateMock || flags.hardcodesHanaHome ? "SHRINK" : "KEEP";
  }
  if (category === "scaffold") return "QUARANTINE";
  if (flags.touchesPrivateMock || flags.hardcodesHanaHome) return "SHRINK";
  return "QUARANTINE";
}

function ownerArea(rel, flags) {
  const stem = rel
    .replace(/^tests\//, "")
    .replace(/\.test\.(?:ts|tsx|js)$/, "");
  if (stem.includes("/")) return stem.split("/")[0];
  if (flags.hasBridge) return "bridge";
  if (flags.hasProvider) return "provider-compat";
  if (flags.hasResource) return "resource/session-file";
  if (flags.hasBuild) return "build/package";
  if (flags.hasSecurity) return "security/access";
  if (flags.hasPlatform) return "platform/sandbox";
  if (flags.hasUiState) return "frontend-state";
  return stem.split("-")[0] || "tests";
}

function keepReason(flags, category) {
  const reasons = [];
  if (flags.hasSecurity) reasons.push("protects security/permission boundary");
  if (flags.hasBuild) reasons.push("protects build/package/runtime boundary");
  if (flags.hasResource) reasons.push("protects Resource/SessionFile/media persistence");
  if (flags.hasBridge) reasons.push("protects external adapter or Bridge media contract");
  if (flags.hasProvider) reasons.push("protects provider/model payload contract");
  if (flags.hasPlatform) reasons.push("protects cross-platform path/shell/sandbox behavior");
  if (flags.hasUiState) reasons.push("protects keyed frontend/session state");
  if (category === "architecture") reasons.push("protects architecture boundary");
  if (category.startsWith("regression")) reasons.push("preserves historical bug signal until absorbed into contract");
  if (!reasons.length) reasons.push("needs manual review before deletion");
  return reasons.join("; ");
}

function deleteOrMergeCandidate(flags, category, decision) {
  const candidates = [];
  if (category.startsWith("regression")) candidates.push("merge into permanent behavior-named contract if coverage is still unique");
  if (decision === "QUARANTINE") candidates.push("review for implementation detail, duplicate coverage, or obsolete scaffold value");
  if (flags.touchesPrivateMock) candidates.push("rewrite away from private-field/mock coupling if kept");
  if (flags.hardcodesHanaHome) candidates.push("replace hardcoded Hana data directory with injected temp HANA_HOME");
  if (!candidates.length) candidates.push("none in first-pass inventory");
  return candidates.join("; ");
}

function markdownEscape(value) {
  return String(value).replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function issueReferenceDecision(row) {
  if (row.file === "tests/provider-compat/deepseek.test.ts") return "KEEP";
  if (row.category === "implementation" || row.decision === "QUARANTINE") return "REVIEW";
  if (row.decision === "SHRINK") return "SHRINK";
  return "KEEP";
}

function issueReferenceFollowUp(row) {
  if (row.file === "tests/provider-compat/deepseek.test.ts") {
    return "absorbed #468 from deleted acceptance test; keep short regression comment";
  }
  if (row.file === "tests/migrations.test.ts") {
    return "migration numbers are durable data-version contract labels, not GitHub issue cleanup";
  }
  if (row.decision === "SHRINK") {
    return "keep behavior-named file; future pass may reduce private mocks or split bulky contract";
  }
  if (row.decision === "QUARANTINE") {
    return "manual review before deletion; do not remove by issue-reference heuristic alone";
  }
  return "behavior-named long-term contract; keep issue note as historical breadcrumb";
}

function renderTriage(rows) {
  const issueRows = rows.filter((row) => row.issueRefs.length > 0);
  const lines = [
    "# Test Triage 2026-06-07",
    "",
    "First-pass inventory generated by `node scripts/test-inventory.mjs --format=triage-md`.",
    "Decisions are conservative: high-risk architecture, security, build, provider, Bridge, Resource, persistence, and platform tests default to KEEP or MERGE.",
    "",
    "## Cleanup Actions In This Pass",
    "",
    "| action | file | reason | absorbing contract |",
    "|---|---|---|---|",
    "| DELETE after MERGE | `tests/acceptance-issue-468.test.ts` | Issue-specific DeepSeek acceptance coverage mostly duplicated the permanent DeepSeek provider compatibility contract. The unique full-chain Pi SDK `convertMessages` shape was moved before deletion. | `tests/provider-compat/deepseek.test.ts` |",
    "",
    "## Issue Reference Review",
    "",
    "Issue references are kept when the file is already behavior-named and protects a long-term contract. They are cleanup candidates only when the test is still named after an incident, duplicates a stronger contract, or locks unstable copywriting.",
    "",
    "| file | refs | owner area | decision | follow-up |",
    "|---|---|---|---|---|",
  ];
  for (const row of issueRows) {
    lines.push([
      row.file,
      row.issueRefs.join(", "),
      row.ownerArea,
      issueReferenceDecision(row),
      issueReferenceFollowUp(row),
    ].map(markdownEscape).join(" | ").replace(/^/, "| ").replace(/$/, " |"));
  }
  lines.push(
    "",
    "| file | category | keep reason | delete/merge candidate | owner area | decision |",
    "|---|---|---|---|---|---|",
  );
  for (const row of rows) {
    lines.push([
      row.file,
      row.category,
      row.keepReason,
      row.deleteOrMergeCandidate,
      row.ownerArea,
      row.decision,
    ].map(markdownEscape).join(" | ").replace(/^/, "| ").replace(/$/, " |"));
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

const rows = walk(TESTS_DIR)
  .sort((a, b) => relativeFromRoot(a).localeCompare(relativeFromRoot(b)))
  .map(analyzeFile);

if (FORMAT === "triage-md") {
  process.stdout.write(renderTriage(rows));
} else {
  process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
}
