import { Router } from 'express';
import { Cron } from 'croner';
import { executeScheduledTask } from '../lib/taskExecutor.js';
import { gameLogger } from '../lib/logger.js';

const cronJobs = new Map();
const activeRuns = new Map();
function isValidCron(expr) {
  try { new Cron(expr, { maxRuns: 0 }); return true; } catch { return false; }
}
function validateAccounts(task, userId, db) {
  if (!Array.isArray(task.tokenIds)) return '账号列表无效';
  const owned = new Set(db.getAllTokens(userId).map(token => token.id));
  if (task.tokenIds.some(id => !owned.has(id))) return '任务包含不存在或无权访问的账号';
  const settings = task.settings || {};
  if (settings.selectedTasks != null && !Array.isArray(settings.selectedTasks)) return '任务列表无效';
  if (settings.selectedTasks?.includes('batchApplyLegion') &&
      (!Number.isSafeInteger(Number(settings.legionApplyTargetId)) || Number(settings.legionApplyTargetId) <= 0)) {
    return '请填写有效的目标俱乐部ID';
  }
  return null;
}
function launchTask(task, userId, db, gameManager, executor) {
  const key = userId + ':' + task.id;
  if (activeRuns.has(key)) return null;
  const startedAt = new Date().toISOString();
  db.updateScheduledTask(task.id, { lastRun: startedAt, lastResult: { running: true, startedAt } }, userId);
  const run = Promise.resolve().then(() => executor(task, userId, db, gameManager)).then(result => {
    db.updateScheduledTask(task.id, { lastRun: startedAt, lastResult: { success: true, running: false, summary: result } }, userId);
    return result;
  }).catch(error => {
    try {
      db.updateScheduledTask(task.id, { lastRun: startedAt, lastResult: { success: false, running: false, error: error.message } }, userId);
    } catch (saveError) { gameLogger.warn('[定时任务] 保存结果失败: ' + saveError.message); }
    gameLogger.warn('[定时任务] 执行失败: ' + error.message);
  }).finally(() => { if (activeRuns.get(key) === run) activeRuns.delete(key); });
  activeRuns.set(key, run);
  return run;
}

export function scheduledTaskRoutes(db, gameManager, { executor = executeScheduledTask } = {}) {
  const r = Router();
  const findTask = req => db.getAllScheduledTasks(req.userId).find(task => task.id === req.params.id);
  r.get('/', (req, res) => res.json(db.getAllScheduledTasks(req.userId)));
  r.post('/', (req, res) => {
    const { name, cron: cronExpr, taskType, tokenIds, settings, enabled } = req.body;
    if (!cronExpr || !isValidCron(cronExpr)) return res.status(400).json({ error: 'invalid cron expression' });
    const task = { id: 'sched_' + Date.now() + '_' + Math.random().toString(36).slice(2),
      name: name || '', cron: cronExpr, taskType: taskType || 'batch_daily',
      tokenIds: tokenIds || [], settings: settings || {}, enabled: enabled !== false };
    const error = validateAccounts(task, req.userId, db);
    if (error) return res.status(400).json({ error });
    task.tokenIds = [...new Set(task.tokenIds)];
    db.addScheduledTask(task, req.userId);
    if (task.enabled) scheduleJob(task, req.userId, db, gameManager, executor);
    res.json({ ...task, createdAt: new Date().toISOString() });
  });
  r.put('/:id', (req, res) => {
    const current = findTask(req);
    if (!current) return res.status(404).json({ error: 'not found' });
    const task = { ...current, ...req.body, id: current.id };
    const error = validateAccounts(task, req.userId, db);
    if (error) return res.status(400).json({ error });
    if (!isValidCron(task.cron)) return res.status(400).json({ error: 'invalid cron expression' });
    db.updateScheduledTask(task.id, req.body, req.userId);
    cancelJob(task.id);
    if (task.enabled) scheduleJob(task, req.userId, db, gameManager, executor);
    res.json({ ok: true });
  });
  r.delete('/:id', (req, res) => {
    const task = findTask(req);
    if (!task) return res.status(404).json({ error: 'not found' });
    cancelJob(task.id);
    db.removeScheduledTask(task.id, req.userId);
    res.json({ ok: true });
  });
  // A long task is independent of the HTTP request and survives closing the page.
  r.post('/:id/run', (req, res) => {
    const task = findTask(req);
    if (!task) return res.status(404).json({ error: 'not found' });
    const error = validateAccounts(task, req.userId, db);
    if (error) return res.status(400).json({ error });
    if (!launchTask(task, req.userId, db, gameManager, executor)) {
      return res.status(409).json({ ok: false, error: '该任务正在执行中，请勿重复启动' });
    }
    res.status(202).json({ ok: true, msg: '任务已交给服务器执行，关闭网页不影响' });
  });
  for (const user of db.getAllUsers?.() || []) {
    for (const task of db.getAllScheduledTasks(user.id)) {
      if (task.lastResult?.running && !activeRuns.has(user.id + ':' + task.id)) {
        db.updateScheduledTask(task.id, { lastResult: { success: false, running: false, error: '服务已重启，上次执行中断，请重新执行' } }, user.id);
      }
      if (task.enabled && isValidCron(task.cron)) scheduleJob(task, user.id, db, gameManager, executor);
    }
  }
  return r;
}
function scheduleJob(task, userId, db, gameManager, executor) {
  cancelJob(task.id);
  const job = new Cron(task.cron, { timezone: 'Asia/Shanghai' }, () => {
    const current = db.getAllScheduledTasks(userId).find(item => item.id === task.id);
    if (!current?.enabled) return;
    const error = validateAccounts(current, userId, db);
    if (error) { gameLogger.warn('[定时任务] ' + error); return; }
    launchTask(current, userId, db, gameManager, executor);
  });
  cronJobs.set(task.id, job);
}
function cancelJob(id) {
  cronJobs.get(id)?.stop();
  cronJobs.delete(id);
}
