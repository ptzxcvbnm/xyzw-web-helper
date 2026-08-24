# XYZW 项目交接说明

当前项目已经完成前后端拆分并部署为长期运行服务：Vue 3 前端由 Nginx 提供静态文件，Node.js 后端由 systemd 管理，SQLite 数据按用户隔离。

## 当前能力

- JWT 登录和 PBKDF2 密码哈希。
- 公开提交注册申请，只有 `admin` 审核通过后才创建账号。
- Token、分组、设置和定时任务按用户隔离。
- 后端常驻执行游戏任务，浏览器关闭后任务仍可继续。
- 推关掉线策略可配置：`0` 分钟立即停止；大于 `0` 时倒计时结束后重连一次。
- 桌面端、移动端和 Token 页面均提供退出登录入口。

## 生产结构

```text
浏览器
  └─ HTTPS / WebSocket
      └─ Nginx
          ├─ / -> /var/www/xyzw-web-helper
          ├─ /api/ -> 127.0.0.1:3001
          └─ /ws -> 127.0.0.1:3001
                       └─ xyzw.service
                           └─ /var/lib/xyzw/xyzw.db
```

完整路径、配置文件和运维命令见 [`deploy/README.md`](./deploy/README.md)。

## 发布前检查

```bash
pnpm build
node --check server/index.js
node --check server/routes/auth.js
node --check server/lib/pushLevelService.js
git diff --check
```

生产发布前应备份 `/var/lib/xyzw/xyzw.db`、后端源码和当前静态前端。重启 `xyzw.service` 会结束内存中的推关及其他即时任务，发布后需按需重新启动。
