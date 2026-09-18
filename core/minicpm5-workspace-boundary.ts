import path from "node:path";

const PATH_TOOLS = new Set(["read", "write", "edit", "grep", "find", "ls"]);
const ABSOLUTE_COMMAND_PATH = /\/(?:Users|Volumes|private|tmp|var|etc|opt|Applications|Library|System)\/[^\s"'`;&|<>()]+/g;

function isWithinWorkspace(root: string, candidate: string) {
  const relative = path.relative(root, path.resolve(candidate));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function resolveWorkspacePath(root: string, raw: unknown) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const value = raw.trim();
  if (value === "~" || value.startsWith("~/")) return path.resolve(process.env.HOME || "/", value.slice(2));
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(root, value);
}

function blockedResult(root: string, target: string) {
  return {
    isError: true,
    content: [{
      type: "text",
      text: `MiniCPM5 workspace boundary blocked access outside CodeLife: ${target}. Allowed root: ${root}`,
    }],
    details: {
      errorCode: "MINICPM5_WORKSPACE_BOUNDARY",
      allowedRoot: root,
      requestedPath: target,
    },
  };
}

function commandOutsideWorkspace(root: string, command: string) {
  const absolutePaths = command.match(ABSOLUTE_COMMAND_PATH) || [];
  for (const raw of absolutePaths) {
    const target = resolveWorkspacePath(root, raw.replace(/[),.:]+$/, ""));
    if (target && !isWithinWorkspace(root, target)) return target;
  }
  // Do not let a command escape through a parent-relative directory change.
  if (/(?:^|[;&|\n]\s*)(?:cd|pushd)\s+\.\.(?=\s|[\\/]|$|[;&|])/.test(command)) {
    return "..";
  }
  if (/(?:^|[\s"'`])\.\.\//.test(command)) return "../";
  return null;
}

/**
 * Add a stricter primary-workspace boundary to the already sandboxed MiniCPM5
 * tool surface. Other providers retain Hana's normal external-read policy.
 */
export function wrapMiniCPM5WorkspaceTools(tools: any[], workspaceRoot: string) {
  const root = path.resolve(workspaceRoot);
  return (Array.isArray(tools) ? tools : []).map((tool) => {
    if (!tool || typeof tool.execute !== "function") return tool;
    if (!PATH_TOOLS.has(tool.name) && tool.name !== "exec_command") return tool;
    return {
      ...tool,
      execute: async (toolCallId: any, params: any = {}, ...rest: any[]) => {
        if (PATH_TOOLS.has(tool.name)) {
          const rawPath = params?.path ?? params?.file_path ?? params?.filePath;
          const target = resolveWorkspacePath(root, rawPath);
          if (target && !isWithinWorkspace(root, target)) return blockedResult(root, target);
        }
        if (tool.name === "exec_command") {
          const workdir = resolveWorkspacePath(root, params?.workdir);
          if (workdir && !isWithinWorkspace(root, workdir)) return blockedResult(root, workdir);
          const command = typeof params?.cmd === "string"
            ? params.cmd
            : (typeof params?.command === "string" ? params.command : "");
          const target = commandOutsideWorkspace(root, command);
          if (target) return blockedResult(root, target);
        }
        return tool.execute(toolCallId, params, ...rest);
      },
    };
  });
}
