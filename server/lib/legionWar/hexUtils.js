/**
 * 盐场六边形地图相邻格计算
 * 方向数组取自 src/utils/legionWar.js（HexGraph），按列 x 奇偶不同
 */

const evenQDirs = [{ q: -1, r: 0 }, { q: -1, r: -1 }, { q: 0, r: 1 }, { q: 0, r: -1 }, { q: 1, r: 0 }, { q: 1, r: -1 }];
const oddQDirs = [{ q: -1, r: 0 }, { q: -1, r: 1 }, { q: 0, r: 1 }, { q: 0, r: -1 }, { q: 1, r: 0 }, { q: 1, r: 1 }];

// 道路坐标取自 src/utils/legionWar.js 的 roadPointList（type=9）。
// 战场 buildingData 可能只包含建筑，不能用它判断道路是否存在。
const roadPointIds = new Set(`
20_16 20_18 19_16 19_17 21_17 21_16 22_17 23_16 23_14 24_15 24_13 25_13 26_15 27_15 29_14 30_14 30_15 32_14 32_15 33_14 34_16 34_17 35_16 37_15 37_16 38_16 36_14 35_13 36_12 37_11 36_10 35_9 34_11 34_12 33_11 33_9 32_9 30_8 29_8 29_10 28_11 26_10 26_9 24_9 23_9 21_9 21_8 21_6 21_4 21_3 19_3 19_4 27_23 18_6 21_11 22_11 19_11 18_12 19_13 20_13 20_7 21_14 21_15 21_18 22_19 24_19 24_18 26_18 26_19 25_20 25_21 26_23 26_24 28_25 28_26 27_25 30_26 31_26 32_28 32_29 31_28 29_28 28_28 27_29 27_30 25_30 24_30 25_28 25_27 26_28 24_26 25_25 22_28 23_28 23_27 21_29 21_30 19_29 19_30 19_27 20_27 19_25 19_24 19_22 18_23 21_22 22_22 21_20 20_21 19_18 19_19 17_19 16_19 17_17 18_17 19_15 18_15 15_20 16_21 14_19 13_18 11_19 10_19 10_20 8_19 8_20 5_17 9_17 10_17 12_15 12_16 12_14 12_13 11_11 11_10 12_9 12_8 13_8 14_10 14_11 13_10 10_8 9_5 15_13 15_12 14_15 14_16 16_15 16_16 8_24 8_25 10_26 11_25 9_22 9_21 11_23 12_23 14_24 14_25 16_25 17_24 31_25 32_23 32_24 33_23 31_21 31_20 33_18 33_19 34_19 31_16 30_17 28_18 28_19 28_20 28_21 30_20 29_22 29_23 9_13 9_12 8_11 8_10 9_8 10_14 11_5 12_6 13_4 13_3 15_3 16_4 15_5 15_6 14_6 17_5 17_6 16_8 15_8 31_12 31_11 2_18 3_18 3_17 3_22 4_20 4_22 4_24 5_20 5_24 6_15 6_18 6_17 6_22 6_23 7_10 7_14 7_15 7_19 7_22 7_24 8_5 8_6 9_7 8_15
`.trim().split(/\s+/));

export const isRoadPoint = (x, y) => roadPointIds.has(`${x}_${y}`);

/** 返回 (x,y) 的 6 个相邻坐标 */
export function neighbors(x, y) {
  const dirs = x % 2 === 0 ? evenQDirs : oddQDirs;
  return dirs.map((d) => ({ x: x + d.q, y: y + d.r }));
}

/**
 * 从相邻格里挑一个战场上真实存在的格子（随机）
 * @param {number} x 当前 x
 * @param {number} y 当前 y
 * @param {object} buildingData 战场建筑数据，key 为 "x_y"
 * @returns {{x:number,y:number}|null}
 */
export function pickRandomNeighbor(x, y, buildingData, previousPosition = null) {
  const cands = neighbors(Number(x), Number(y)).filter((n) => {
    const key = `${n.x}_${n.y}`;
    return isRoadPoint(n.x, n.y) || (buildingData && Object.prototype.hasOwnProperty.call(buildingData, key));
  });
  if (cands.length === 0) return null;
  const forward = cands.filter((n) => !previousPosition || n.x !== Number(previousPosition.x) || n.y !== Number(previousPosition.y));
  const choices = forward.length ? forward : cands;
  return choices[Math.floor(Math.random() * choices.length)];
}
