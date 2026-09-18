
## 快速开始

### 从源码运行

项目只通过 GitHub 源码分享，不提供 DMG、安装包或自动更新服务。需要 Node.js 24.12+ 与 npm：

```bash
git clone https://github.com/Peppermeow29/openhanako.git
cd openhanako
npm install
npm start
```

### 首次运行

首次启动时，引导向导会带你完成配置：选择语言、输入你的名字、连接模型提供商（API key + base URL），并选择三个模型：**对话模型**（主对话）、**小工具模型**（轻量任务）、**大工具模型**（记忆编译和深度分析）。设置页还可以单独选择**视觉模型**，让文本模型通过 Vision Bridge 处理图片附件。HanaAgent 支持 OpenAI 兼容、Anthropic 风格、OAuth Provider 和 Ollama 本地模型等多类接入。
目前也添加了 OpenAI 的 OAuth 登录，鉴于 Anthropic 会有封号风险，所以暂时不提供。

### 使用 MiniCPM5 本地模型

MiniCPM5 权重不随仓库分发；使用前需要单独下载，且当前 MLX 启动器只支持 Apple Silicon macOS。

```bash
npm run minicpm:setup
```

先安装 Python 依赖。若未检测到模型，请在仓库旁放置 `MiniCPM5-2B-MLX-8-bit/`（或 4-bit）目录，或设置 `MINICPM5_MODEL_ROOT` 指向包含该目录的文件夹。权重可从 Hugging Face `openbmb` 的 MiniCPM5 MLX checkpoint 下载。也可以用 `MINICPM5_MODEL_PATH` 直接指向任意 checkpoint 目录。

启动应用并选择 **MiniCPM5-2B (MLX 本地)**；运行时会自动执行 `npm run minicpm:server`，在 `127.0.0.1:8080` 启动本地推理服务。16 GB 内存的 Apple Silicon 建议保留默认 `edge` 配置；其它机器可通过 `MINICPM5_MEMORY_PROFILE` 调整。Windows/Linux 用户请改用 Ollama 或 OpenAI-compatible 本地服务。

## 架构

```
core/           引擎编排层 + Manager（含 PluginManager）
lib/            核心库（记忆、工具、沙盒、Bridge 适配器）
server/         Hono HTTP + WebSocket 服务（独立 Node.js 进程）
hub/            调度器、事件总线
desktop/        Electron 应用 + React 前端
shared/         跨层共享工具（config schema、error bus、模型引用等）
plugins/        内置系统插件（随应用打包）
skills2set/     内置技能定义
scripts/        源码构建、启动与测试工具
tests/          Vitest 测试
```

引擎层协调多个 Manager（Agent、Session、Model、Preferences、Skill、BridgeSession、Plugin 等），通过统一的 facade 暴露。Hub 负责后台任务（心跳巡检、自动化 / 定时任务、Agent 间通信），独立于当前聊天会话运行。

Session 内的用户可见文件通过 `SessionFile` sidecar 统一登记，桌面端、Bridge、Mobile PWA 和其它远程前端按各自能力消费同一份文件身份。各 Bridge adapter 显式声明自己的媒体类型、投递方式与大小限制；插件文件贡献规则见 `PLUGINS.md`。

本机 staged 文件由飞书和微信 adapter 按各自接口上传；需要公网 URL 的场景仍可显式配置 `preferences.bridge.mediaPublicBaseUrl` / `HANA_BRIDGE_PUBLIC_BASE_URL`，Hana 不会自动开启公网 tunnel。

Server 以独立 Node.js 进程运行（由 Electron spawn 或独立启动），通过 Vite 打包，@vercel/nft 追踪依赖。与 Electron 渲染进程通过 WebSocket 通信。
用户数据目录由 `HANA_HOME` 决定（生产默认 `~/.hanako`，开发默认 `~/.hanako-dev`）。Hana 管理的 Pi SDK 运行时资源位于 `${HANA_HOME}/runtime/pi-sdk/`；Hana 不依赖 Pi 的全局 agent 目录或 `PI_CODING_AGENT_DIR`。旧版本遗留在 `${HANA_HOME}/.pi/agent/bin/` 的 `fd` / `rg` 只会在首次使用相应搜索工具时复制到新目录，旧文件会原样保留。

## 技术栈

| 层级 | 技术 |
|------|------|
| 桌面端 | Electron 42 |
| 前端 | React 19 + Zustand 5 + CSS Modules |
| 构建 | Vite 7 |
| 服务端 | Hono + @hono/node-server |
| Agent 运行时 | [Pi SDK](https://github.com/badlogic/pi-mono) |
| 数据库 | better-sqlite3（WAL 模式） |
| 测试 | Vitest |
| 国际化 | 5 语言（zh / en / ja / ko / zh-TW） |

## 平台支持

| 平台 | 状态 |
|------|------|
| macOS (Apple Silicon) | 源码开发支持 |
| macOS (Intel) | 已支持 |
| Windows | Beta |
| Linux | 源码开发支持 |
| 移动端 (PWA) | v0：同一 HanaAgent Server 的手机会话与工作台访问 |

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

## 致谢

- [tw93/kami](https://github.com/tw93/kami)：beautify 插件 HTML 美学规范的「路由器 + 平级章节按需获取」渐进披露结构受其启发。

## 许可证

[Apache License 2.0](LICENSE)

## 链接

- [官网](https://openhanako.com)
- [提交 Issue](https://github.com/Peppermeow29/openhanako/issues)
- [安全页](https://github.com/Peppermeow29/openhanako/security)
- [安全政策](SECURITY.md)
- [插件开发指南](PLUGINS.md)
- [贡献指南](CONTRIBUTING.md)
- [国内 AtomGit 托管](https://github.com/Peppermeow29/openhanako)
