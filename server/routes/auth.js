import { Router } from 'express';
import { authMiddleware, createToken } from '../lib/auth.js';

export function authRoutes(db) {
  const r = Router();
  const registerAttempts = new Map();
  let registrationRequestCount = 0;

  function requireAdmin(req, res, next) {
    if (req.username !== 'admin') {
      return res.status(403).json({ error: '仅 admin 用户可以审核注册申请' });
    }
    next();
  }

  function registrationRateLimit(req, res, next) {
    const now = Date.now();
    const windowMs = 10 * 60 * 1000;
    registrationRequestCount++;
    if (registrationRequestCount % 100 === 0) {
      for (const [ip, attempts] of registerAttempts) {
        const active = attempts.filter((time) => now - time < windowMs);
        if (active.length > 0) registerAttempts.set(ip, active);
        else registerAttempts.delete(ip);
      }
    }
    if (!registerAttempts.has(req.ip) && registerAttempts.size >= 10000) {
      return res.status(429).json({ error: '注册申请过于频繁，请稍后再试' });
    }
    const previous = registerAttempts.get(req.ip) || [];
    const recent = previous.filter((time) => now - time < windowMs);
    if (recent.length >= 10) {
      return res.status(429).json({ error: '注册申请过于频繁，请稍后再试' });
    }
    recent.push(now);
    registerAttempts.set(req.ip, recent);
    next();
  }

  r.post('/register', registrationRateLimit, (req, res) => {
    const rawUsername = req.body?.username;
    const password = req.body?.password;
    if (typeof rawUsername !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ error: '用户名和密码必填' });
    }
    const username = rawUsername.trim();
    if (!username || !password) return res.status(400).json({ error: '用户名和密码必填' });
    if (username.length < 2 || username.length > 20) return res.status(400).json({ error: '用户名2-20个字符' });
    if (password.length < 6 || password.length > 128) return res.status(400).json({ error: '密码长度为6-128位' });
    if (username.toLowerCase() === 'admin') return res.status(400).json({ error: '该用户名不可注册' });

    const existing = db.getUserCaseInsensitive(username);
    if (existing) return res.status(400).json({ error: '用户名已存在' });
    if (db.getRegistrationRequestByUsername(username)) {
      return res.status(409).json({ error: '该用户名的注册申请正在等待审核' });
    }

    const request = db.createRegistrationRequest(username, password);
    res.status(202).json({ requestId: request.id, username: request.username, status: 'pending' });
  });

  r.get('/registration-requests', authMiddleware, requireAdmin, (_req, res) => {
    res.json(db.getRegistrationRequests());
  });

  r.post('/registration-requests/:id/approve', authMiddleware, requireAdmin, (req, res) => {
    try {
      const user = db.approveRegistrationRequest(req.params.id);
      if (!user) return res.status(404).json({ error: '注册申请不存在或已处理' });
      res.status(201).json({ userId: user.id, username: user.username });
    } catch (error) {
      if (error.code === 'USERNAME_EXISTS') return res.status(409).json({ error: error.message });
      throw error;
    }
  });

  r.delete('/registration-requests/:id', authMiddleware, requireAdmin, (req, res) => {
    if (!db.rejectRegistrationRequest(req.params.id)) {
      return res.status(404).json({ error: '注册申请不存在或已处理' });
    }
    res.json({ success: true });
  });

  r.post('/login', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: '用户名和密码必填' });
    const user = db.getUser(username);
    if (!user) {
      if (db.getRegistrationRequestByUsername(username)) {
        return res.status(403).json({ error: '注册申请正在等待 admin 审核' });
      }
      return res.status(401).json({ error: '用户名或密码错误' });
    }
    if (!db.verifyPassword(user, password)) return res.status(401).json({ error: '用户名或密码错误' });
    const token = createToken(user.id, user.username);
    res.json({ token, userId: user.id, username: user.username });
  });

  return r;
}
