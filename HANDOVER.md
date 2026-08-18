# XYZW 前后端改造 — 项目交接文档

## 一、项目背景

原项目 `xyzw_web_helper` 是纯前端项目（Vue 3 + Vite），浏览器直连游戏 WebSocket 服务器。
本次改造目标：拆成前端 + 后端架构，部署到云服务器，关掉浏览器后任务继续跑，支持多用户隔离。

## 二、已完成的工作

### 2.1 后端代码（全部完成）

| 文件 | 作用 |
|------|------|
| `server/index.js` | 入口，Express + WebSocket 服务，端口 3001，挂载 auth 中间件 |
| `server/package.json` | 后端依赖清单 |
| `server/lib/db.js` | SQLite 存储层，users 表 + 所有数据表加 user_id 隔离 |
| `server/lib/auth.js` | JWT 认证：签发/验证 token + authMiddleware |
| `server/lib/gameManager.js` | 核心管理器，管理所有账号的游戏 WebSocket 连接 |
| `server/lib/xyzwWebSocket.js` | Node.js 适配版 WebSocket 客户端（ws 库） |
| `server/lib/commandRegistryBase.js` | CommandRegistry 基类 |
| `server/lib/commandRegistry.js` | 游戏命令注册表 |
| `server/lib/pushService.js` | 实时推送服务 |
| `server/lib/cache.js` | 内存缓存 |
| `server/lib/logger.js` | Node.js 日志系统 |
| `server/lib/bonProtocol.js` | bonProtocol 加载器 |
| `server/routes/auth.js` | 注册/登录 API |
| `server/routes/token.js` | Token CRUD + 连接/断开 + 分组管理（按 userId 隔离） |
| `server/routes/task.js` | 批量连接、批量发送、日常任务（按 userId 隔离） |
| `server/routes/status.js` | 状态查询（按 userId 隔离） |

### 2.2 前端改造（全部完成）

| 文件 | 作用 |
|------|------|
| `src/api/serverApi.js` | API 客户端，自动附加 JWT token，401 自动跳登录页 |
| `src/stores/serverTokenStore.js` | 新 store，完全兼容旧 tokenStore 接口 |
| `src/stores/auth.js` | 认证 store，调真实后端 API（注册/登录/登出） |
| `src/router/index.js` | 路由守卫：未登录跳 /login，已登录跳 /admin/dashboard |
| `src/views/Login.vue` | 登录页（已有，改为调后端 API） |
| `src/views/Register.vue` | 注册页（已有，改为调后端 API，注册后自动登录） |
| `vite.config.js` | 后端 API 代理 |

### 2.3 用户隔离（全部完成）

- 数据库 users 表：id, username, password_hash(PBKDF2), salt
- tokens/token_groups/kv/bin_data 表全部加了 user_id 字段和索引
- 所有 API 路由加了 authMiddleware，从 JWT 中提取 userId
- 所有 db 方法加了 userId 参数，SQL 查询按 user_id 过滤
- 旧数据 user_id 默认为空字符串，不影响迁移

### 2.4 前端组件对接（全部完成）

所有 57+ 个 Vue 组件的 import 已从 `useTokenStore` 替换为 `useServerTokenStore as useTokenStore`。
`serverTokenStore` 完全兼容旧 `tokenStore` 的所有接口（sendMessageWithPromise, getWebSocketStatus, createWebSocketConnection, closeWebSocketConnection, gameData, gameTokens, tokenGroups 等）。

### 2.5 服务器部署（部分完成）

- 腾讯云轻量服务器：Ubuntu 22.04, 2核2G, IP YOUR_SERVER_IP
- Node.js 20.x, pm2 已安装
- 项目文件在 /root/xyzw
- 后端服务运行中：pm2 xyzw-server，端口 3001

## 三、未完成的工作

### 3.1 上传最新代码到服务器

本地代码已全部改完，需要重新上传到服务器 /root/xyzw。

### 3.2 前端构建（OOM 问题）

上次 `npm run build` 报 `JavaScript heap out of memory`。解决方案：

```bash
# 先创建 swap（2G 内存不够 Vite 构建）
fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab

# 然后构建
cd /root/xyzw
chmod +x node_modules/.bin/*
NODE_OPTIONS="--max-old-space-size=1536" npm run build
```

### 3.3 重启服务

```bash
# 重启后端（加载新的 auth 路由和 user_id 隔离）
cd /root/xyzw/server
pm2 restart xyzw-server

# 启动前端静态服务
npm install -g serve
pm2 start serve --name xyzw-web -- -s /root/xyzw/dist -l 3000
```

### 3.4 防火墙

腾讯云控制台 → 防火墙 → 添加规则：
- 协议 TCP，端口 3000,3001，策略 允许

### 3.5 pm2 开机自启

```bash
pm2 save
pm2 startup
```

## 四、服务器当前状态

| 项目 | 状态 |
|------|------|
| 服务器 IP | YOUR_SERVER_IP |
| 系统 | Ubuntu 22.04 |
| Node.js | v20.x |
| 后端服务 (pm2 xyzw-server) | 运行中，端口 3001（需重启加载新代码） |
| 前端服务 (pm2 xyzw-web) | 未启动（需 build） |
| 防火墙 3000/3001 | 未开放 |
| 项目路径 | /root/xyzw |

## 五、数据流架构

```
浏览器 ──登录──> /api/auth/login ──> JWT token
   ↓
浏览器(Vue前端) ──HTTP API + JWT──> Node.js后端(Express, 端口3001) ──WebSocket──> 游戏服务器
   :3000                              ↑
   只管UI展示                          所有游戏逻辑在这里
                                      SQLite 存数据（按 user_id 隔离）
                                      pm2 守护进程
                                      /ws 推送日志给前端
```

## 六、下一步操作（按顺序）

1. 把本地最新代码上传到服务器 /root/xyzw
2. 创建 swap + 执行 npm run build
3. 重启后端 pm2 restart xyzw-server
4. 启动前端 pm2 start serve
5. 开放防火墙 3000, 3001
6. 访问 http://YOUR_SERVER_IP:3000 注册账号测试

## 七、风格约定

- 用户不懂 Linux，所有命令完整给出
- 用户不写代码，AI 主导
- 中文回复
- 直接给最优解
- 只改需要改的
