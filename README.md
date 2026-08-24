# XYZW 助手（前后端版）

一个把原纯前端 `xyzw_web_helper` 改造成 **前端 + 后端** 架构的游戏辅助管理器。后端常驻运行，关掉浏览器后定时任务仍继续执行，支持多用户隔离。

> 仅供学习交流使用。请勿用于任何商业或违反游戏服务条款的用途。

## 架构

```
浏览器(Vue3 前端) ──HTTP API + JWT──> Node.js 后端(Express) ──WebSocket──> 游戏服务器
     :3000                                  :3001
     只管 UI 展示                            所有游戏逻辑 + SQLite 存储(按 user_id 隔离)
                                            systemd 守护 / WebSocket 推送日志
```

- **前端**：Vue 3 + Vite + Naive UI + Pinia
- **后端**：Node.js + Express + 原生 WebSocket(ws) + better-sqlite3
- **认证**：JWT（密码 PBKDF2 哈希存储，注册需 admin 审核）
- **进程管理**：systemd + Nginx

## 目录结构

| 路径 | 说明 |
|------|------|
| `src/` | 前端源码（Vue 组件、store、API 客户端） |
| `server/` | 后端源码（Express 入口、路由、游戏连接管理、SQLite） |
| `server/lib/gameManager.js` | 核心：管理所有账号的游戏 WebSocket 连接 |
| `server/lib/xyzwWebSocket.js` | Node 适配版游戏 WebSocket 客户端 |
| `server/lib/batch/` | 各类批量/定时任务逻辑 |
| `server/routes/` | REST API 路由 |

## 本地开发

```bash
# 安装依赖
pnpm install          # 前端
cd server && npm install   # 后端

# 启动后端（端口 3001）
cd server && node index.js

# 启动前端（端口默认 5173，已配置代理到后端 3001）
pnpm dev
```

## 生产部署

前端构建产物是纯静态文件，后端用 systemd 常驻并由 Nginx 反向代理。服务器路径、环境变量和运维命令见 [`deploy/README.md`](./deploy/README.md)。

```bash
# 构建前端
pnpm build

# 后端依赖
cd server && npm ci --omit=dev
```

## 环境变量

后端支持以下环境变量：

| 变量 | 说明 | 默认 |
|------|------|------|
| `NODE_ENV` | 运行环境；生产使用 `production` | 未设置 |
| `JWT_SECRET` | JWT 签名密钥；生产环境必须设置 | 开发环境随机生成 |
| `HOST` | 后端监听地址 | `127.0.0.1` |
| `PORT` | 后端端口 | 3001 |
| `DATA_DIR` | SQLite 数据目录 | `server/data` |
| `DB_PATH` | SQLite 文件路径，优先级高于 `DATA_DIR` | 未设置 |
| `CORS_ORIGIN` | 允许的前端来源，多个值用逗号分隔 | 未限制 |

> `NODE_ENV=production` 时未设置 `JWT_SECRET`，后端会拒绝启动，避免重启后登录状态失效。

## 账户与推关

- 访客可以提交注册申请，但账号只有在 `admin` 审核通过后才会创建。
- `admin` 登录后可从“注册审核”页面批准或拒绝申请。
- 推关支持设置掉线后的重连等待分钟数：`0` 表示掉线即停止；大于 `0` 时先倒计时，结束后只尝试重连一次。

## 安全说明

- 数据库、登录凭证（`.bin`）、抓包文件等已在 `.gitignore` 中忽略，不会进入版本库。
- 首次运行会在 `server/data/` 下自动创建 SQLite 数据库。
- 请勿把 `server/data/`、`*.bin`、`server/config.json` 提交到公开仓库。

## License

CC-BY-NC-SA-4.0（署名 - 非商业性使用 - 相同方式共享）
