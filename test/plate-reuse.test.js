'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  generateImposition,
  planPlateReuse,
} = require('../src/imposition');

/** 把 8 页标准拼版改乱（交换第 1、2 张纸的正面左版），使其无法通过校验 */
function makeInvalid(imp) {
  [imp.sheets[0].front.left, imp.sheets[1].front.left] = [
    imp.sheets[1].front.left,
    imp.sheets[0].front.left,
  ];
  return imp;
}

/* ---------- 校验门槛 ---------- */

test('印版复用：结构非法返回 null', () => {
  const ok = generateImposition(8);
  assert.equal(planPlateReuse(null, ok), null);
  assert.equal(planPlateReuse(ok, null), null);
  assert.equal(planPlateReuse({ pages: 3, totalPages: 8, sheets: [] }, ok), null);
  assert.equal(planPlateReuse(ok, { pages: 3, totalPages: 8, sheets: [] }), null);
});

test('印版复用：基线未通过校验时拒绝核算', () => {
  const result = planPlateReuse(makeInvalid(generateImposition(8)), generateImposition(8));
  assert.equal(result.side, 'baseline');
  assert.match(result.error, /基线拼版未通过校验/);
  assert.ok(result.errors); // 附带校验错误明细
});

test('印版复用：当前方案未通过校验时拒绝核算', () => {
  const result = planPlateReuse(generateImposition(8), makeInvalid(generateImposition(8)));
  assert.equal(result.side, 'current');
  assert.match(result.error, /当前拼版未通过校验/);
  assert.ok(result.errors);
});

/* ---------- 匹配与汇总 ---------- */

test('印版复用：完全相同的两份拼版全部复用，无新制、无作废', () => {
  const result = planPlateReuse(generateImposition(8), generateImposition(8));
  assert.equal(result.baselineFaceCount, 4);
  assert.equal(result.faceCount, 4);
  assert.equal(result.reused, 4);
  assert.equal(result.newMade, 0);
  assert.equal(result.discarded, 0);
  assert.ok(result.faces.every((f) => f.status === 'reuse'));
  // 复用来源指向基线中相同位置的面
  assert.deepEqual(
    result.faces.map((f) => [f.sheet, f.side, f.source.sheet, f.source.side]),
    [
      [1, 'front', 1, 'front'],
      [1, 'back', 1, 'back'],
      [2, 'front', 2, 'front'],
      [2, 'back', 2, 'back'],
    ]
  );
});

test('印版复用：部分面一致时按面核算复用 / 新制 / 旧面作废', () => {
  // 基线 8 页：第 1 张 正面[8,1]/反面[2,7]，第 2 张 正面[6,3]/反面[4,5]
  // 当前 6 页（补齐至 8）：第 1 张 正面[空白,1]/反面[2,空白]，第 2 张 正面[6,3]/反面[4,5]
  const result = planPlateReuse(generateImposition(8), generateImposition(6));
  assert.equal(result.reused, 2); // 第 2 张纸的正反两面
  assert.equal(result.newMade, 2); // 第 1 张纸的正反两面（空白版位不同）
  assert.equal(result.discarded, 2); // 基线第 1 张纸的正反两面作废
  assert.deepEqual(
    result.faces.map((f) => f.status),
    ['new', 'new', 'reuse', 'reuse']
  );
  assert.deepEqual(result.faces[2].source, { sheet: 2, side: 'front' });
  assert.deepEqual(result.faces[3].source, { sheet: 2, side: 'back' });
  assert.ok(!('sig' in result.faces[2].source)); // 单帖基线的来源不带帖号
});

test('印版复用：跨帖号与纸张序号查找（单帖基线 ↔ 分帖当前）', () => {
  // 8 页 M=2 的分帖结果与单帖 8 页的面内容完全一致，仅帖号 / 纸张归属不同
  const result = planPlateReuse(generateImposition(8), generateImposition(8, 2));
  assert.equal(result.reused, 4);
  assert.equal(result.newMade, 0);
  assert.equal(result.discarded, 0);
  // 当前面带帖号，复用来源为单帖基线（不带帖号）
  assert.equal(result.faces[0].sig, 1);
  assert.deepEqual(result.faces[0].source, { sheet: 1, side: 'front' });
});

test('印版复用：空白版位不同的面不可复用', () => {
  // 基线 8 页第 1 张 正面[8,1]；当前 6 页第 1 张 正面[空白,1]：左版 8 ↔ 空白，不匹配
  const result = planPlateReuse(generateImposition(8), generateImposition(6));
  const front1 = result.faces.find((f) => f.sheet === 1 && f.side === 'front');
  assert.equal(front1.status, 'new');
  assert.equal(front1.source, undefined);
});

test('印版复用：该面实际爬移量相同才可复用', () => {
  // 基线启用爬移（纸厚 0.10、上限 2）：第 1 张 c=0、第 2 张 c=0.20；当前未启用（各面 c=0）
  const baseline = generateImposition(8, null, { thickness: 0.1, cap: 2 });
  const result = planPlateReuse(baseline, generateImposition(8));
  assert.deepEqual(
    result.faces.map((f) => f.status),
    ['reuse', 'reuse', 'new', 'new'] // 第 1 张 c=0 复用；第 2 张 0.20 ≠ 0 新制
  );
  assert.equal(result.reused, 2);
  assert.equal(result.newMade, 2);
  assert.equal(result.discarded, 2);

  // 双方启用相同爬移参数时全部复用
  const same = planPlateReuse(baseline, generateImposition(8, null, { thickness: 0.1, cap: 2 }));
  assert.equal(same.reused, 4);
  assert.equal(same.discarded, 0);
});

test('印版复用：全空白面跨帖号匹配，来源指向旧面位置', () => {
  // 基线 9 页 M=1：第 3 帖 1 张纸 正面[空白,9]/反面[空白,空白]
  // 当前 9 页 M=2：第 2 帖 1 张纸 正面[空白,9]/反面[空白,空白]
  const result = planPlateReuse(generateImposition(9, 1), generateImposition(9, 2));
  assert.equal(result.baselineFaceCount, 6); // 3 帖各 1 张纸
  assert.equal(result.faceCount, 6); // 第 1 帖 2 张 + 第 2 帖 1 张
  assert.equal(result.reused, 2); // 末帖的正面[空白,9] 与全空白反面
  assert.equal(result.newMade, 4);
  assert.equal(result.discarded, 4);
  const last = result.faces[result.faces.length - 1];
  assert.deepEqual(last, {
    sig: 2,
    sheet: 1,
    side: 'back',
    status: 'reuse',
    source: { sig: 3, sheet: 1, side: 'back' },
  });
});

test('印版复用：每个旧面最多匹配一个新面', () => {
  // 基线 1 页：仅 1 个全空白反面；当前 9 页 M=1：末帖也只有 1 个全空白反面
  // 一对一匹配后基线无剩余全空白面，其余当前面均为新制
  const result = planPlateReuse(generateImposition(1), generateImposition(9, 1));
  assert.equal(result.baselineFaceCount, 2);
  assert.equal(result.faceCount, 6);
  assert.equal(result.reused, 1);
  assert.equal(result.newMade, 5);
  assert.equal(result.discarded, 1); // 基线正面[空白,1] 未被匹配，作废
  const reusedFaces = result.faces.filter((f) => f.status === 'reuse');
  assert.equal(reusedFaces.length, 1);
  assert.deepEqual(reusedFaces[0].source, { sheet: 1, side: 'back' });
});

test('印版复用：逐面结果按当前帖与纸张顺序排列', () => {
  // 当前 9 页 M=1：3 帖各 1 张纸，面序为 帖1正/反 → 帖2正/反 → 帖3正/反
  const result = planPlateReuse(generateImposition(8), generateImposition(9, 1));
  assert.deepEqual(
    result.faces.map((f) => [f.sig, f.sheet, f.side]),
    [
      [1, 1, 'front'],
      [1, 1, 'back'],
      [2, 1, 'front'],
      [2, 1, 'back'],
      [3, 1, 'front'],
      [3, 1, 'back'],
    ]
  );
});
