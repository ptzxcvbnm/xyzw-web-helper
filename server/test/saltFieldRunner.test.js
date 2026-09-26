import test from 'node:test';
import assert from 'node:assert/strict';
import { roadPointList } from '../../src/utils/legionWar.js';
import { isRoadPoint, neighbors, pickRandomNeighbor } from '../lib/legionWar/hexUtils.js';
import { getDefaultBattleTeam } from '../lib/legionWar/saltFieldRunner.js';

test('每个大本营都能通过静态道路离开出生点', () => {
  const roads = roadPointList.filter((point) => point.type === 9);
  assert.ok(roads.length > 200);
  for (const road of roads) {
    const [x, y] = road.id.split('_').map(Number);
    assert.ok(isRoadPoint(x, y), `${road.id} 未同步到后端道路表`);
  }
  const homes = roadPointList.filter((point) => point.type === 4);
  assert.equal(homes.length, 20);
  for (const home of homes) {
    const [x, y] = home.id.split('_').map(Number);
    const target = pickRandomNeighbor(x, y, {});
    assert.ok(target, `${home.id} 没有相邻道路`);
    assert.ok(isRoadPoint(target.x, target.y));
    assert.ok(neighbors(x, y).some((point) => point.x === target.x && point.y === target.y));
  }
});

test('相邻格选择避开刚走过的格子并兼容字符串坐标', () => {
  const target = pickRandomNeighbor('7', '4', {}, { x: 8, y: 5 });
  assert.deepEqual(target, { x: 8, y: 5 }); // 唯一出口仍可回退
  assert.equal(pickRandomNeighbor(0, 0, {}), null);
});

test('从主服角色信息提取默认阵容，缺失时不使用吕布硬编码', () => {
  assert.deepEqual(getDefaultBattleTeam({ role: { battleTeam: { 0: 107, 1: '108', 2: 0 } } }), { 0: 107, 1: 108 });
  assert.deepEqual(getDefaultBattleTeam({ role: { heroes: {
    107: { heroId: 107, battleTeamSlot: 0 },
    108: { heroId: 108, battleTeamSlot: 2 },
    109: { heroId: 109, battleTeamSlot: -1 },
  } } }), { 0: 107, 2: 108 });
  assert.deepEqual(getDefaultBattleTeam({ role: {} }), {});
});
