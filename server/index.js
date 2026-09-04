import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { db } from './lib/db.js';
import { GameManager } from './lib/gameManager.js';
import { PushService } from './lib/pushService.js';
import { PushLevelService } from './lib/pushLevelService.js';
import { PushLevelBattleSimulator } from './lib/pushLevelBattleSimulator.js';
import { authMiddleware } from './lib/auth.js';
import { authRoutes } from './routes/auth.js';
import { tokenRoutes } from './routes/token.js';
import { taskRoutes } from './routes/task.js';
import { statusRoutes } from './routes/status.js';
import { settingsRoutes } from './routes/settings.js';
import { scheduledTaskRoutes } from './routes/scheduledTasks.js';
import { pushLevelRoutes } from './routes/pushLevel.js';
import { saltFieldRoutes } from './routes/saltField.js';
import { SaltFieldService } from './lib/legionWar/saltFieldService.js';
import { forceOnlineRoutes } from './routes/forceOnline.js';
import { ForceOnlineService } from './lib/forceOnlineService.js';
import { Cron } from 'croner';

const PORT = process.env.PORT || 3001;
const HOST = process.env.HOST || '127.0.0.1';
const allowedOrigins = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const app = express();
app.set('trust proxy', 'loopback');
app.use(cors(allowedOrigins.length > 0 ? {
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('CORS origin not allowed'));
  },
} : undefined));
app.use(express.json({ limit: '10mb' }));

const httpServer = createServer(app);

const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
const pushService = new PushService(wss);
const gameManager = new GameManager(db, pushService);
const pushLevelBattleSimulator = new PushLevelBattleSimulator();
const pushLevelService = new PushLevelService(gameManager, pushService, pushLevelBattleSimulator);
const saltFieldService = new SaltFieldService(gameManager, pushService, db);
const forceOnlineService = new ForceOnlineService(gameManager, pushService, db);
// 推关运行期间由推关服务执行用户设定的掉线等待策略，避免强制在线抢先重连。
forceOnlineService.shouldDeferReconnect = (tokenId) => pushLevelService.isRunning(tokenId);
// 断线钩子：被顶下线时，强制在线的号立即重连抢回
gameManager.onDisconnectHook = (tokenId) => forceOnlineService.onDisconnected(tokenId);

app.use('/api/auth', authRoutes(db));
app.use('/api/token', authMiddleware, tokenRoutes(db, gameManager));
app.use('/api/task', authMiddleware, taskRoutes(gameManager));
app.use('/api/status', authMiddleware, statusRoutes(gameManager));
app.use('/api/settings', authMiddleware, settingsRoutes(db));
app.use('/api/scheduled-tasks', authMiddleware, scheduledTaskRoutes(db, gameManager));
app.use('/api/push-level', authMiddleware, pushLevelRoutes(pushLevelService));
app.use('/api/salt-field', authMiddleware, saltFieldRoutes(saltFieldService));
app.use('/api/force-online', authMiddleware, forceOnlineRoutes(forceOnlineService));

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), ready: gameManager.ready });
});

async function start() {
  await gameManager.init();

  // 盐场创地定时：每周六 20:00 触发（北京时间），runner 内部跑到 20:30 自动停
  try {
    new Cron('0 20 * * 6', { timezone: 'Asia/Shanghai' }, () => {
      saltFieldService.runScheduled().catch((e) => console.error('[盐场定时] 失败:', e.message));
    });
    new Cron('30 17 * * 6', { timezone: 'Asia/Shanghai' }, () => {
      saltFieldService.runSignup().catch((e) => console.error('[盐场报名] 失败:', e.message));
    });
    console.log('[盐场] 定时已注册：报名周六17:30 / 刨地周六20:00');
  } catch (e) {
    console.error('[盐场] 定时注册失败:', e.message);
  }

  // 强制在线：启动兜底巡检（掉线自动重连抢回）
  try {
    forceOnlineService.startPatrol();
  } catch (e) {
    console.error('[强制在线] 巡检启动失败:', e.message);
  }

  httpServer.listen(PORT, HOST, () => {
    console.log(`[server] running on http://${HOST}:${PORT}`);
  });
}

start().catch((err) => {
  console.error('[server] 启动失败:', err);
  process.exit(1);
});
