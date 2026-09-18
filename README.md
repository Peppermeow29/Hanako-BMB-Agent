<p align="center">
  <img src=".github/assets/banner.jpg" width="100%" alt="Hanako-BMB-Agent Banner">
</p>

<p align="center">
  <img src=".github/assets/HanaAgent-280.png" width="80" alt="Hanako-BMB-Agent">
</p>

<h1 align="center">Hanako-BMB-Agent</h1>

<p align="center">一个有记忆、有灵魂的私人 AI 助理</p>

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey.svg)](#平台支持)

---

## 项目简介

Hanako-BMB-Agent 是一个基于 Electron 与 Node.js 的魔改 AI Agent 工作台：有记忆，有性格，会主动行动，还能让多个 Agent 在你的电脑上一同工作。

作为助手，Ta 是温柔的：不需要写复杂的配置，不需要理解晦涩的术语。项目不只面向 Coder，而是为每一个坐在电脑前工作的人设计。

作为工具，Ta 是强大的：记住你说过的每一件事，浏览网页，搜索信息，读写文件，执行代码，管理日程，还能自主学习新技能。

这个项目旨在弥合绝大多数人和 AI Agent 之间的缝隙，让强大的 Agent 能力不再局限于命令行。它一方面强化了 Agent「像人」的属性，让沟通更自然；另一方面针对日常办公场景提供了大量工具性和流程性优化。如果你用过 Claude Code、Codex、Manus 等 CLI 或图形化 Agent，会在其中找到熟悉又新奇的感觉。

## 功能特性

**记忆** — 结合主流记忆方案实现的记忆系统：近期事件保持牢固，重要记忆可持续沉淀；支持开关、预算、遗忘速度和命中加权等配置。

**人格** — 通过人格模板和自定义人格文件塑造独特性格。每个 Agent 都有自己的说话方式和行为逻辑，Agent 之间彼此隔离，备份方便。

**工具** — 读写文件、执行一次性命令或持续终端会话、浏览网页、通过浏览器或 API 搜索互联网、截图、长截图、检查网页、预览媒体。能力覆盖日常办公的绝大多数场景。

**SKILLS 支持** — 兼容社区 SKILLS 生态。Agent 可以安装社区技能，也可以在工作过程中编写并学会新技能。默认启用较严格的技能审核，必要时可自行调整。

**角色卡与技能包** — Agent 可以导入 / 导出为本地优先的角色卡 zip，按白名单携带人格、头像、可选记忆和 Skills。Skill Bundle 支持分组、拖拽、成组启用和单独导出。

**多 Agent** — 创建多个 Agent，各自拥有独立记忆、人格和定时任务，也可以互相委派任务或在频道中协作讨论。

**书桌** — 每个 Agent 都有自己的书桌，可以放文件、写笺，Agent 会主动读取并执行。支持拖拽操作、文件预览、工作台文件树和变更监听，是人与 Agent 之间的异步协作空间。

**全屏媒体查看器** — 图片、SVG、视频可进入暗色遮罩全屏预览：滚轮缩放、拖拽平移、键盘快捷键，以及同会话或同目录的相邻媒体切换。

**会话管理** — 支持聊天记录搜索、标题优先命中、旧会话归档与恢复。聊天正文选中文本会进入引用卡片，继续追问时保留原文语境。

**定时任务与心跳** — Agent 可以创建定时任务，也会定期巡检书桌上的文件变化。自动化执行器将「什么时候触发」和「做什么」拆开，轻量提醒可直接通知，复杂任务可后台执行。

**安全沙盒** — 应用层 PathGuard 四级访问控制与平台命令隔离（macOS Seatbelt / Linux Bubblewrap / Windows restricted token）。Agent 的写入和删除限制在工作目录与受控数据目录。

**插件系统** — 约定优先的可扩展插件架构。拖拽安装社区插件，插件可以贡献工具、技能、命令、Agent 模板、HTTP 路由、Pi SDK extension、LLM Provider、页面、侧栏 Widget、配置 schema 和后台任务。两级权限模型保障安全，高权限能力只在 full-access 插件里生效。

**多平台接入** — 同一个 Agent 可以接入 Telegram、飞书、QQ 和微信，在外部平台继续对话。Bridge 消息携带平台上下文，通知也可以回发到当前平台。

**移动端与 LAN 前端** — 本地 Server 可托管 `/mobile/` PWA，手机通过设备访问密钥或本地账号登录，查看会话、继续聊天和管理工作台文件。另一台桌面端也可通过 LAN URL + access key 连接已有 Server。

**国际化** — 界面支持中文、英文、日文、韩文、繁体中文 5 种语言。

## 截图

<p align="center">
  <img src=".github/assets/screenshot-main.jpg" width="100%" alt="项目主界面">
</p>

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
