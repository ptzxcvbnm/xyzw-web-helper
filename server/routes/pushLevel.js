import { Router } from 'express';

export function pushLevelRoutes(pushLevelService, db) {
  const r = Router();
  const ownedIds = req => new Set(db.getAllTokens(req.userId).map(t => t.id));

  // 控制、状态和历史日志均按登录用户的账号范围过滤。
  function requireToken(req, res, next) {
    const tokenId = req.params.tokenId || req.body?.tokenId;
    if (typeof tokenId !== 'string' || !tokenId) return res.status(400).json({ ok: false, msg: 'tokenId required' });
    if (!db.getToken(tokenId, req.userId)) return res.status(404).json({ ok: false, msg: '账号不存在' });
    next();
  }

  r.post('/start', requireToken, async (req, res) => {
    const { tokenId, maxFail, reconnectMinutes, accelerated, autoContinue } = req.body;
    try {
      res.json(await pushLevelService.start(tokenId, req.userId, {
        maxFail, reconnectMinutes, accelerated: accelerated === true, autoContinue: autoContinue !== false,
      }));
    } catch (error) {
      res.status(500).json({ ok: false, msg: error.message });
    }
  });

  r.post('/stop', requireToken, (req, res) => {
    res.json(pushLevelService.stop(req.body.tokenId));
  });

  r.post('/torch', requireToken, async (req, res) => {
    try {
      const { tokenId, itemId, quantity } = req.body;
      res.json(await pushLevelService.useTorch(tokenId, itemId, quantity));
    } catch (error) {
      res.status(500).json({ ok: false, msg: error.message });
    }
  });

  r.get('/logs', (req, res) => res.json(pushLevelService.getLogs(ownedIds(req))));
  r.get('/status/:tokenId', requireToken, (req, res) => res.json(pushLevelService.getStatus(req.params.tokenId)));
  r.get('/status', (req, res) => res.json(pushLevelService.getAllStatus(ownedIds(req))));
  return r;
}
