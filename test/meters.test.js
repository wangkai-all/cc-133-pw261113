import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSegments, Method } from '../src/domain/meters.js'
import { parseTime } from '../src/domain/time.js'

const T = (s) => parseTime(s)
const meter = (over = {}) => ({ id: 'M1', modulus: 100000, bidirectional: false, maxRateM3h: null, ...over })
const rd = (t, v) => ({ t: T(t), v })

test('普通正差：normal', () => {
  const segs = buildSegments([rd('2026-11-10 00:00', 100), rd('2026-11-11 00:00', 340)], meter())
  assert.equal(segs.length, 1)
  assert.equal(segs[0].method, Method.NORMAL)
  assert.equal(segs[0].usage, 240)
})

test('负差 + 有模数 + 能力范围内：回绕推定，带假设标记', () => {
  const segs = buildSegments([rd('2026-11-10 00:00', 99900), rd('2026-11-11 00:00', 150)], meter({ maxRateM3h: 100 }))
  assert.equal(segs[0].method, Method.ROLLOVER)
  assert.equal(segs[0].usage, 250) // 100000 - 99900 + 150
  assert.equal(segs[0].assumptions.length, 1)
})

test('负差 + 超出表计能力：未解释，不计入用量', () => {
  const segs = buildSegments([rd('2026-11-10 00:00', 40000), rd('2026-11-11 00:00', 39900)], meter({ maxRateM3h: 100 }))
  // 回绕换算 = 100000-100 = 99900 > 100*24*1.05
  assert.equal(segs[0].method, Method.UNEXPLAINED)
  assert.equal(segs[0].usage, null)
  assert.equal(segs[0].known, false)
})

test('负差 + 无模数：未解释（不能一律当回绕）', () => {
  const segs = buildSegments([rd('2026-11-10 00:00', 500), rd('2026-11-11 00:00', 100)], meter({ modulus: null }))
  assert.equal(segs[0].method, Method.UNEXPLAINED)
  assert.equal(segs[0].usage, null)
})

test('负差 + 双向表：反向计量，用量为负', () => {
  const segs = buildSegments([rd('2026-11-10 00:00', 500), rd('2026-11-11 00:00', 380)], meter({ bidirectional: true }))
  assert.equal(segs[0].method, Method.REVERSE)
  assert.equal(segs[0].usage, -120)
})

test('换表事件：区间切分为新旧两段，分别计量', () => {
  const readings = [rd('2026-11-12 00:00', 77750), rd('2026-11-13 00:00', 320)]
  const events = [{ type: 'replacement', meterId: 'M1', time: T('2026-11-12 10:30'), oldFinal: 78230, newInitial: 0, note: 'DN100换表' }]
  const segs = buildSegments(readings, meter(), events)
  assert.equal(segs.length, 2)
  assert.equal(segs[0].method, Method.REPLACEMENT)
  assert.equal(segs[0].usage, 480) // 78230 - 77750
  assert.equal(segs[1].method, Method.REPLACEMENT)
  assert.equal(segs[1].usage, 320) // 320 - 0
})

test('换表记录缺旧表止码：前段未知，后段正常', () => {
  const readings = [rd('2026-11-12 00:00', 77750), rd('2026-11-13 00:00', 320)]
  const events = [{ type: 'replacement', meterId: 'M1', time: T('2026-11-12 10:30'), oldFinal: null, newInitial: 0 }]
  const segs = buildSegments(readings, meter(), events)
  assert.equal(segs[0].known, false)
  assert.equal(segs[0].usage, null)
  assert.equal(segs[1].usage, 320)
})

test('人工更正：替换误抄读数后按普通差计算，方法记为更正', () => {
  const readings = [rd('2026-11-13 00:00', 3000), rd('2026-11-14 00:00', 5320), rd('2026-11-15 00:00', 3800)]
  const events = [{ type: 'correction', meterId: 'M1', time: T('2026-11-14 00:00'), correctedValue: 3520, note: '误抄' }]
  const segs = buildSegments(readings, meter(), events)
  assert.equal(segs.length, 2)
  assert.equal(segs[0].method, Method.CORRECTION)
  assert.equal(segs[0].usage, 520) // 3520-3000
  assert.equal(segs[1].method, Method.CORRECTION)
  assert.equal(segs[1].usage, 280) // 3800-3520
})

test('人工更正给定区间用量：采用给定值并标记估算', () => {
  const readings = [rd('2026-11-13 00:00', 3000), rd('2026-11-14 00:00', 5320), rd('2026-11-15 00:00', 3800)]
  const events = [{ type: 'correction', meterId: 'M1', time: T('2026-11-14 00:00'), correctedValue: 5320, usageOverride: 600, note: '按邻表比对给定' }]
  const segs = buildSegments(readings, meter(), events)
  // override 作用于更正点之后的区间
  assert.equal(segs[1].method, Method.CORRECTION_OVERRIDE)
  assert.equal(segs[1].usage, 600)
  assert.equal(segs[1].estimated, true)
  assert.equal(segs[0].method, Method.CORRECTION)
})

test('更正后仍为负差：未解释，不再回退为回绕', () => {
  const readings = [rd('2026-11-13 00:00', 5000), rd('2026-11-14 00:00', 100)]
  const events = [{ type: 'correction', meterId: 'M1', time: T('2026-11-14 00:00'), correctedValue: 100 }]
  const segs = buildSegments(readings, meter(), events)
  assert.equal(segs[0].method, Method.UNEXPLAINED)
  assert.equal(segs[0].usage, null)
})
