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

## 4) 使用

### 基础
- `/help` 或 `hyw`：输出帮助文档（读取 `QQ_BOT_HELP.md`）
- `/reset`：重置当前 QQ 会话上下文

### Pixiv（命名空间统一）
- `/pixiv 5 Fate`
- `/pixiv 3-8 白发`
- `/p 5 Fate`（简写）
- `p 5 Fate`（简写）

可选参数：
- `--nohq`：不使用 10000/5000/1000users入り 分层质量标签
- `--nsfw`：显式允许 NSFW（仅在你实际策略允许时生效）

### 画师检索
- `/pixiv author ASK`
- `/pixiv author ASK 8`
- `/pixiv author ASK --years 3`（近 N 年随机，默认 3 年）
- `/pixiv author ASK --alltime`（全作品随机）

### 排行
- `/pixiv rank 5 daily`
- `/pixiv rank 5 weekly`
- `/pixiv rank 5 monthly`
- `/pixiv rank 5 all`

## 5) HTTP 接口

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

## 6) 其他设备迁移安装指南

### 迁移最小集
把以下内容拷到新设备：
- 本仓库代码（`openclaw-qq`）
- 目标设备可用的 NapCat（OneBot v11）
- 新设备的 `~/.openclaw/openclaw.json` 插件配置

### 新设备步骤
1. 安装 OpenClaw / NapCat
2. 克隆仓库
   ```bash
   git clone https://github.com/2317891476/openclaw-qq.git
   cd openclaw-qq
   ```
3. 安装插件
   ```bash
   openclaw plugins install .
   ```
4. 配置 `openclaw.json`（`napcatWs`、`botQQ`、白名单、port）
5. 重启 gateway
   ```bash
   ~/openclaw-gateway-scripts/restart.sh
   ```
6. QQ 中发送 `/help` 验证

### 建议同步的本地文件
- `QQ_BOT_HELP.md`（你自定义帮助）
- 白名单配置（`allowedUsers` / `allowedGroups`）
- 若有代理/隧道，记得同步 `gateway.trustedProxies`

## License

MIT
