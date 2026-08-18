// 盐场离线分析器
// 用法: node 盐场离线分析.mjs "数据文件.json" [myCodeId]
// 读取抓包 json -> 解码 -> 输出: 玩家、行军、战斗、对面阵容、阵容变动提醒
import { g_utils } from './src/utils/bonProtocol.js';
import fs from 'fs';
import path from 'path';

const argFile = process.argv[2];
const myCodeId = process.argv[3] ? String(process.argv[3]) : null;
if (!argFile) {
  console.error('用法: node 盐场离线分析.mjs "数据文件.json" [myCodeId]');
  process.exit(1);
}

function decode(r) {
  const b = Buffer.from(r.base64, 'base64');
  return g_utils.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), 'auto', !!r.isSalt);
}

function fmtTime(t) { return new Date(t * 1000).toLocaleTimeString('zh-CN', { hour12: false }); }

// 阵容指纹: 按 slot 顺序的 power 串（换武将必变，掉血不变）
function teamFingerprint(teamInfo) {
  if (!teamInfo) return '';
  return Object.keys(teamInfo).sort((a, b) => a - b)
    .map(k => `${teamInfo[k].power}|${teamInfo[k].star}|${teamInfo[k].color}`)
    .join(' , ');
}

function loadRecords() {
  const j = JSON.parse(fs.readFileSync(argFile, 'utf8'));
  return j.records || [];
}

// 累积全场玩家信息（codeId -> {name,legionID,position,state,...}）
function buildRoles(records) {
  const roles = {};
  for (const r of records) {
    if (r.kind !== 'binary' || r.byteLength <= 1) continue;
    try {
      const p = decode(r);
      const rs = (p.rawData ?? p.body)?.battlefield?.roles;
      if (rs) for (const [c, v] of Object.entries(rs)) roles[c] = { ...(roles[c] || {}), ...v };
    } catch (e) {}
  }
  return roles;
}

// 外部名单库: codeId -> name（跨文件合并，补全缺名字的批次）
let NAME_DB = {};
function loadNameDB() {
  const dbPath = path.join(path.dirname(argFile), '_codeId名单.json');
  if (fs.existsSync(dbPath)) {
    try { NAME_DB = JSON.parse(fs.readFileSync(dbPath, 'utf8')); } catch (e) {}
  }
}

function nameOf(roles, code) {
  const c = String(code);
  const r = roles[c];
  if (r && r.name) return r.name;
  if (NAME_DB[c]) return NAME_DB[c];
  return '#' + code;
}

// 战斗事件汇总
function analyzeBattles(records, roles) {
  const events = [];
  for (const r of records) {
    if (r.kind !== 'binary' || r.byteLength <= 1) continue;
    try {
      const p = decode(r);
      const d = p.rawData ?? p.body;
      if (p.cmd === 'war_endbattlenotify') {
        events.push({ time: r.time, type: 'battle',
          atk: d.roleCodeId, def: d.targetCodeId, win: d.winCodeId, building: d.buildingId });
      }
    } catch (e) {}
  }
  return events;
}

// 行军事件汇总
function analyzeMarches(records, roles) {
  const out = [];
  for (const r of records) {
    if (r.kind !== 'binary' || r.byteLength <= 1) continue;
    try {
      const p = decode(r);
      const d = p.rawData ?? p.body;
      if (p.cmd === 'war_startmarchresp') {
        const m = d?.battlefield?.marches;
        if (m) for (const mv of Object.values(m)) {
          if (mv && mv.from && mv.to) out.push({ time: r.time, codeId: mv.codeId,
            legionId: mv.legionId, from: mv.from, to: mv.to, end: mv.endTime });
        }
      }
    } catch (e) {}
  }
  return out;
}

// 对面阵容变动检测：同一 codeId 的阵容指纹发生变化就提醒
function analyzeTeamChanges(records, roles) {
  const last = {};       // codeId -> 上一次指纹
  const alerts = [];
  let pendingCode = null;
  for (const r of records) {
    if (r.kind !== 'binary' || r.byteLength <= 1) continue;
    try {
      const p = decode(r);
      const d = p.rawData ?? p.body;
      if (p.cmd === 'war_getteaminfo' && r.dir === 'send') {
        pendingCode = String(d.roleCodeId);
      } else if (p.cmd === 'war_getteaminforesp') {
        const fp = teamFingerprint(d.teamInfo);
        const code = pendingCode;
        if (code != null) {
          if (last[code] !== undefined && last[code] !== fp)
            alerts.push({ time: r.time, code, before: last[code], after: fp });
          last[code] = fp;
          pendingCode = null;
        }
      }
    } catch (e) {}
  }
  return alerts;
}

const LINES = [];
function log(s = '') { LINES.push(s); }

function main() {
  loadNameDB();
  const records = loadRecords();
  const roles = buildRoles(records);
  const battles = analyzeBattles(records, roles);
  const marches = analyzeMarches(records, roles);
  const teamChanges = analyzeTeamChanges(records, roles);
  const myLegion = myCodeId ? (roles[myCodeId]?.legionID ?? null) : null;

  log('========== 盐场离线分析 ==========');
  log('文件: ' + path.basename(argFile));
  log('全场玩家数: ' + Object.keys(roles).length);
  if (myCodeId) log('我的 codeId: ' + myCodeId + '  名字: ' + nameOf(roles, myCodeId) + '  俱乐部: ' + myLegion);

  if (myCodeId) printMyStats(battles, roles);
  printBattles(battles, roles);
  if (myCodeId) printIncoming(marches, roles, myLegion);
  printMarches(marches, roles);
  printTeamChanges(teamChanges, roles);

  const suffix = myCodeId ? ('_code' + myCodeId) : '_全局';
  const outPath = argFile.replace(/\.json$/i, '') + '_分析报告' + suffix + '.txt';
  fs.writeFileSync(outPath, LINES.join('\n'), 'utf8');
  console.log('report written:', outPath);
  console.log('lines:', LINES.length);
}

function printMyStats(battles, roles) {
  let atkWin = 0, atkLose = 0, defWin = 0, defLose = 0;
  const killed = {}, killedBy = {};
  for (const b of battles) {
    const a = String(b.atk), df = String(b.def), w = String(b.win);
    if (a === myCodeId) { if (w === myCodeId) { atkWin++; killed[df] = (killed[df]||0)+1; } else atkLose++; }
    else if (df === myCodeId) { if (w === myCodeId) defWin++; else { defLose++; killedBy[a] = (killedBy[a]||0)+1; } }
  }
  log('\n----- 我的战绩 -----');
  log(`主动出击: ${atkWin} 胜 / ${atkLose} 负`);
  log(`被挑战  : ${defWin} 胜 / ${defLose} 负`);
  const kList = Object.entries(killed).sort((a,b)=>b[1]-a[1]).map(([c,n])=>nameOf(roles,c)+'x'+n);
  const dList = Object.entries(killedBy).sort((a,b)=>b[1]-a[1]).map(([c,n])=>nameOf(roles,c)+'x'+n);
  if (kList.length) log('我击败: ' + kList.join(', '));
  if (dList.length) log('败给我手下: ' + dList.join(', '));
}

function printBattles(battles, roles) {
  log('\n----- 战斗记录 (' + battles.length + ') -----');
  const mine = myCodeId ? battles.filter(b => [b.atk, b.def, b.win].map(String).includes(myCodeId)) : battles;
  for (const b of mine.slice(0, 80)) {
    const win = String(b.win) === String(b.atk) ? '攻胜' : '守胜';
    log(`${b.time} [${b.building}] ${nameOf(roles, b.atk)} 攻 ${nameOf(roles, b.def)} -> 胜:${nameOf(roles, b.win)} (${win})`);
  }
  if (mine.length > 80) log(`... 共 ${mine.length} 场`);
}

function printIncoming(marches, roles, myLegion) {
  // 朝"我当前所在点"移动、且非我方俱乐部的行军
  const myPos = roles[myCodeId]?.position;
  log('\n----- 朝我移动的敌人 -----');
  if (!myPos || myPos.x < 0) { log('(未找到我的有效坐标，跳过)'); return; }
  const myKey = myPos.x + '_' + myPos.y;
  let n = 0;
  for (const m of marches) {
    const toKey = m.to.x + '_' + m.to.y;
    if (toKey !== myKey) continue;
    const enemy = String(m.legionId) !== String(myLegion);
    if (!enemy) continue;
    log(`${m.time} ${nameOf(roles, m.codeId)} -> 我点(${myKey}) 到达:${fmtTime(m.end)}`);
    n++;
  }
  if (!n) log(`(没有敌人朝我所在点 ${myKey} 移动)`);
}

function printMarches(marches, roles) {
  log('\n----- 行军记录 (' + marches.length + ') -----');
  for (const m of marches.slice(0, 80)) {
    log(`${m.time} ${nameOf(roles, m.codeId)} (${m.from.x},${m.from.y})->(${m.to.x},${m.to.y}) 到达:${fmtTime(m.end)}`);
  }
  if (marches.length > 80) log(`... 共 ${marches.length} 次行军`);
}

function printTeamChanges(alerts, roles) {
  log('\n----- 对面阵容变动提醒 (' + alerts.length + ') -----');
  if (!alerts.length) { log('(本文件内未检测到同一玩家阵容前后变化)'); return; }
  for (const a of alerts) {
    log(`[变动] ${a.time} ${nameOf(roles, a.code)} 阵容变动`);
    log(`   旧: ${a.before}`);
    log(`   新: ${a.after}`);
  }
}

main();
