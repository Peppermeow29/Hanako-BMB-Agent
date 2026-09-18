## 快速开始

### 从源码运行

项目通过 GitHub 源码分享，不提供 DMG、安装包或自动更新服务。需要 Node.js 24.12+ 与 npm：

```bash
git clone https://github.com/Peppermeow29/Hanako-BMB-Agent.git
cd Hanako-BMB-Agent
npm install
npm start
```

### 首次运行

首次启动时，引导向导会带你完成配置：选择语言、输入你的名字、连接模型提供商（API key + base URL），并选择三个模型：**对话模型**（主对话）、**小工具模型**（轻量任务）、**大工具模型**（记忆编译和深度分析）。设置页还可以单独选择**视觉模型**，让文本模型通过 Vision Bridge 处理图片附件。

项目支持 OpenAI 兼容、Anthropic 风格、OAuth Provider 和 Ollama 本地模型等多类接入，也提供 OpenAI OAuth 登录。

### 使用 MiniCPM5 本地模型

MiniCPM5 权重不随仓库分发；使用前需要单独下载，且当前 MLX 启动器只支持 Apple Silicon macOS。

```bash
npm run minicpm:setup
```

若未检测到模型，请在仓库旁放置 `MiniCPM5-2B-MLX-8-bit/`（或 4-bit）目录，或设置 `MINICPM5_MODEL_ROOT` 指向包含该目录的文件夹。权重可从 Hugging Face `openbmb` 的 MiniCPM5 MLX checkpoint 下载，也可以用 `MINICPM5_MODEL_PATH` 直接指向任意 checkpoint 目录。

启动应用并选择 **MiniCPM5-2B (MLX 本地)** 后，运行时会自动执行 `npm run minicpm:server`，在 `127.0.0.1:8080` 启动本地推理服务。16 GB 内存的 Apple Silicon 建议保留默认 `edge` 配置，其它机器可通过 `MINICPM5_MEMORY_PROFILE` 调整。Windows/Linux 用户请改用 Ollama 或 OpenAI-compatible 本地服务。

## 架构

```text
core/           引擎编排层 + Manager（含 PluginManager）
lib/            核心库（记忆、工具、沙盒、Bridge 适配器）
server/         Hono HTTP + WebSocket 服务（独立 Node.js 进程）
hub/            调度器、事件总线、Agent 通信
desktop/        Electron 应用 + React 前端
shared/         跨层共享工具（config schema、error bus、模型引用等）
plugins/        内置系统插件（随应用打包）
skills2set/     内置技能定义
scripts/        源码构建、启动与测试工具
tests/          Vitest 测试
```

引擎层协调 Agent、Session、Model、Preferences、Skill、BridgeSession、Plugin 等多个 Manager，并通过统一 facade 暴露。Hub 负责心跳巡检、自动化 / 定时任务和 Agent 间通信，独立于当前聊天会话运行。

Session 内的用户可见文件通过 `SessionFile` sidecar 统一登记，桌面端、Bridge、Mobile PWA 和其它远程前端按各自能力消费同一份文件身份。各 Bridge adapter 显式声明媒体类型、投递方式与大小限制。

本机 staged 文件由平台 adapter 按各自接口上传；需要公网 URL 的场景可显式配置 `preferences.bridge.mediaPublicBaseUrl` / `HANA_BRIDGE_PUBLIC_BASE_URL`，项目不会自动开启公网 tunnel。

Server 以独立 Node.js 进程运行（由 Electron spawn 或独立启动），通过 Vite 打包并由 `@vercel/nft` 追踪依赖，与 Electron 渲染进程通过 WebSocket 通信。

用户数据目录由 `HANA_HOME` 决定：生产默认 `~/.hanako`，开发默认 `~/.hanako-dev`。项目管理的 Pi SDK 运行时资源位于 `${HANA_HOME}/runtime/pi-sdk/`，不依赖 Pi 的全局 agent 目录。

## 技术栈

| 层级 | 技术 |
|------|------|
| 桌面端 | Electron 42 |
| 前端 | React 19 + Zustand 5 + CSS Modules |
| 构建 | Vite 7 |
| 服务端 | Hono + `@hono/node-server` |
| Agent 运行时 | [Pi SDK](https://github.com/badlogic/pi-mono) |
| 数据库 | better-sqlite3（WAL 模式） |
| 测试 | Vitest |
| 国际化 | 5 语言（zh / en / ja / ko / zh-TW） |

## 平台支持

| 平台 | 状态 |
|------|------|
| macOS（Apple Silicon） | 源码开发支持 |
| macOS（Intel） | 已支持 |
| Windows | Beta |
| Linux | 源码开发支持 |
| 移动端（PWA） | v0：同一本地 Server 的手机会话与工作台访问 |

## 开发

```bash
# 安装依赖
npm install

# Electron 启动（自动构建 renderer）
npm start

# Vite HMR 开发（需先运行 npm run dev:renderer）
npm run start:vite

# 仅启动 server
npm run server

# server-first CLI
npm run cli

# 运行测试
npm test

# 类型检查
npm run typecheck
```

## 许可证

[Apache License 2.0](LICENSE)

## 链接

- [飞书文档](https://lcndzi84kxcm.feishu.cn/wiki/LeoJws0eki2uSFkyCQmcKSvansb?from=from_copylink)
- [提交 Issue](https://github.com/Peppermeow29/Hanako-BMB-Agent/issues)
