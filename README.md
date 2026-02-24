<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/CreatorAris/CreatorAris/dist/github-snake-dark.svg" />
  <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/CreatorAris/CreatorAris/dist/github-snake.svg" />
  <img alt="github contribution snake animation" src="https://raw.githubusercontent.com/CreatorAris/CreatorAris/dist/github-snake.svg" />
</picture>

</div>

# openclaw-qq

[![npm version](https://img.shields.io/npm/v/@cs2317/openclaw-qq.svg)](https://www.npmjs.com/package/@cs2317/openclaw-qq)
[![npm downloads](https://img.shields.io/npm/dm/@cs2317/openclaw-qq.svg)](https://www.npmjs.com/package/@cs2317/openclaw-qq)

OpenClaw QQ plugin (NapCat / OneBot v11) with built-in Pixiv module.

> npm package: https://www.npmjs.com/package/@cs2317/openclaw-qq

## 1) 安装

```bash
openclaw plugins install @cs2317/openclaw-qq
```

本地开发安装（可选）：
```bash
openclaw plugins install /absolute/path/to/openclaw-qq
# 或在仓库目录：openclaw plugins install .
```

## 2) 配置（按当前代码流程）

编辑 `~/.openclaw/openclaw.json`，在 `plugins.entries` 下添加：

```json
{
  "plugins": {
    "entries": {
      "openclaw-qq": {
        "enabled": true,
        "config": {
          "napcatWs": "ws://172.27.144.1:3001",
          "napcatToken": "",
          "botQQ": "3890734993",
          "allowedUsers": ["2317891476"],
          "allowedGroups": ["587526665"],
          "adminUsers": ["2317891476"],
          "port": 3210,
          "downloadDir": "/tmp/openclaw-qq-images"
        }
      }
    }
  }
}
```

必填/强相关：
- `napcatWs`：NapCat OneBot ws 地址
- `botQQ`：群聊 @ 检测依赖
- `allowedUsers` / `allowedGroups`：白名单控制
- `port`：启用 HTTP 主动接口（`/send`、`/pixiv_search`、`/pixiv_rank`）

## 3) 启动 / 重启

如果你使用了 watchdog 脚本：

```bash
~/openclaw-gateway-scripts/restart.sh
```

## 4) 最新增强（近期已实现）

- 会话与路由
  - 群聊与私聊会话隔离（避免上下文串线）
  - 群聊仅在 `@bot` 或斜杠命令触发时响应（按配置可控）
- 稳定性与防重复
  - NapCat WS 心跳探活 + 超时自动重连
  - 入站消息去重（按 `message_id`）
  - Session Forwarder 去重（避免同步回复 + 异步转发双发）
- 发送可靠性
  - 分上下文发送队列（per-context queue）+ 全局并发控制
  - 自适应发送节奏（根据 timeout/error 动态调速）
  - 图片发送分批策略（降低 NapCat 超时概率）
- 可观测与运维
  - `/diag` 运行时诊断（连接状态、重连次数、发送统计）
  - `/config get|set`（管理员）可在线调整 `sendQueue.*` / `pixiv.*`
- 状态持久化（SQLite，第一阶段）
  - 持久化去重状态（inbound/forward/recent reply）
  - 持久化会话映射（context -> session）
  - 数据库路径：`<workspace>/.openclaw-qq/state.db`

## 5) 使用

### 基础
- `/help` 或 `hyw`：输出帮助文档（读取 `QQ_BOT_HELP.md`）
- `/reset`：重置当前 QQ 会话上下文

### Pixiv（命名空间统一）
- `/pixiv 5 Fate`
- `/pixiv 3-8 白发`
- `/p 5 Fate`（简写）
- `p 5 Fate`（简写）

搜索可选参数：
- `--nohq`：不使用 10000/5000/1000users入り 分层质量标签
- `--nsfw`：显式允许 NSFW（仅在你实际策略允许时生效）
- `--min_bookmark 1000` 或 `--min_bookmark=1000`
- `--ratio 9:16` 或 `--ratio=9:16`
- `--mode users|bookmark|hybrid`
- `--count-first` / `--quality-first`

### 画师检索
- `/pixiv author ASK`
- `/pixiv author ASK 8`
- `/pixiv author ASK --years 3`（近 N 年随机）
- `/pixiv author ASK --alltime`（全作品随机）
- `/pixiv author profile ASK`（画师信息）
- `/pixiv author pick 123456`（指定 uid 抽取）

### 排行
- `/pixiv rank 5 daily`
- `/pixiv rank 5 weekly`
- `/pixiv rank 5 monthly`
- `/pixiv rank 5 all`

### 最近记录与复跑
- `/pixiv last`（查看上次执行快照）
- `/pixiv rerun` 或 `/pixiv rerun 8`（按上次条件重跑）

### 收藏夹（fav）
- `/pixiv fav add`（把 last 中作品加入收藏）
- `/pixiv fav list`（收藏列表）
- `/pixiv fav list --tag 白发`
- `/pixiv fav send 5`（从收藏随机发图）
- `/pixiv fav send 5 --tag 白发`
- `/pixiv fav remove 12345678`
- `/pixiv fav tag 12345678 白发 高质量`

### 主题（topic）
- `/pixiv topic save 白发精选 5 白发 --min_bookmark 1000`
- `/pixiv topic add 白发精选 3 银发 --ratio 9:16`
- `/pixiv topic 白发精选 6`（运行主题）
- `/pixiv topic list` / `/pixiv topic list 白发精选`
- `/pixiv topic delete 白发精选`

### 预设（preset）
- `/pixiv preset save r18hot 5 巨乳 --nsfw`
- `/pixiv preset run r18hot 8`
- `/pixiv preset list`
- `/pixiv preset delete r18hot`

### 导出与调试
- `/pixiv export links`（导出链接）
- `/pixiv export json`（导出 JSON）
- `/pixiv verbose on|off`（详细日志开关）

## 6) HTTP 接口

当 `port > 0` 时可用：

### `/send`
```bash
curl -s http://127.0.0.1:3210/send \
  -H 'Content-Type: application/json' \
  -d '{"groupId":"587526665","text":"hello"}'
```

### `/pixiv_search`
```bash
curl -s http://127.0.0.1:3210/pixiv_search \
  -H 'Content-Type: application/json' \
  -d '{"groupId":"587526665","keyword":"白发","count":5,"safeOnly":true}'
```

### `/pixiv_rank`
```bash
curl -s http://127.0.0.1:3210/pixiv_rank \
  -H 'Content-Type: application/json' \
  -d '{"groupId":"587526665","mode":"monthly","count":5,"safeOnly":true}'
```

## 7) 其他设备迁移安装指南（含 Pixiv 状态与 SQLite）

### 迁移最小集
把以下内容拷到新设备：
- 本仓库代码（`openclaw-qq`）
- 目标设备可用的 NapCat（OneBot v11）
- 新设备的 `~/.openclaw/openclaw.json` 插件配置
- （可选）旧设备 workspace 中的运行态数据（见下方“状态数据迁移”）

### 新设备步骤
1. 安装 OpenClaw / NapCat
2. 二选一安装方式：

   **A. npm 安装（推荐，生产使用）**
   ```bash
   openclaw plugins install @cs2317/openclaw-qq
   ```
   > 这种方式不需要 `git clone`。

   **B. 本地源码安装（调试/二开）**
   ```bash
   git clone https://github.com/2317891476/openclaw-qq.git
   cd openclaw-qq
   openclaw plugins install .
   ```

3. 配置 `~/.openclaw/openclaw.json`
   - `napcatWs` / `napcatToken`
   - `botQQ`
   - `allowedUsers` / `allowedGroups`
   - `adminUsers`
   - `port`
5. 重启 gateway
   ```bash
   ~/openclaw-gateway-scripts/restart.sh
   ```
6. QQ 验证
   - `/help`
   - `/diag`（确认 napcat 连接、storage=sqlite）
   - `/pixiv 3 白发`

### 状态数据迁移（建议）
如需保留历史与偏好，可从旧设备同步以下文件到**新设备 workspace 根目录**：
- `QQ_BOT_HELP.md`
- `pixiv-favs.json`
- `pixiv-topics.json`
- `pixiv-presets.json`
- `pixiv-last.json`
- `pixiv-settings.json`
- `.openclaw-qq/state.db`（SQLite 去重/会话状态库）

> 若不迁移这些文件，插件也能正常运行，但会丢失收藏、主题、预设、最近记录和部分去重状态。

### 建议同步的网络/安全配置
- `gateway.trustedProxies`（有反向代理时）
- `plugins.allow`（建议显式白名单插件）
- `allowedUsers` / `allowedGroups` / `adminUsers`（权限边界）

## License

MIT
