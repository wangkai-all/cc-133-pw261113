import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSegments } from '../src/domain/meters.js'
import { splitSegmentByDay, aggregateMeterDay } from '../src/domain/days.js'
import { parseTime } from '../src/domain/time.js'

const T = (s) => parseTime(s)
const meter = (over = {}) => ({ id: 'M1', modulus: 100000, ...over })
const rd = (t, v) => ({ t: T(t), v })

test('区间跨日：按时长比例分摊，分摊部分标记估算', () => {
  // 11-10 08:00 → 11-11 08:00，用量 240 → 10 日 16h=160，11 日 8h=80
  const [seg] = buildSegments([rd('2026-11-10 08:00', 0), rd('2026-11-11 08:00', 240)], meter())
  const parts = splitSegmentByDay(seg)
  assert.equal(parts.length, 2)
  assert.equal(parts[0].day, '2026-11-10')
  assert.equal(parts[0].hours, 16)
  assert.equal(parts[0].usage, 160)
  assert.equal(parts[0].estimated, true)
  assert.equal(parts[1].day, '2026-11-11')
  assert.equal(parts[1].usage, 80)
  assert.equal(parts[1].estimated, true)
})

test('整点日界区间：不跨日，不标记估算', () => {
  const [seg] = buildSegments([rd('2026-11-10 00:00', 0), rd('2026-11-11 00:00', 240)], meter())
  const parts = splitSegmentByDay(seg)
  assert.equal(parts.length, 1)
  assert.equal(parts[0].estimated, false)
  assert.equal(parts[0].usage, 240)
})

test('缺测不当零：无读数时段计为缺测，覆盖率下降', () => {
  // 只有 11-10 00:00 → 11-11 00:00 的读数；11-11 全天无覆盖
  const segs = buildSegments([rd('2026-11-10 00:00', 0), rd('2026-11-11 00:00', 240)], meter())
  const md = aggregateMeterDay(segs, '2026-11-11')
  assert.equal(md.usage, 0) // 当日没有已知分摊量
  assert.equal(md.knownHours, 0)
  assert.equal(md.gapHours, 24)
  assert.equal(md.coverage, 0)
  assert.equal(md.gaps.length, 1)
})

test('部分缺测：当日 6 小时无读数覆盖', () => {
  const segs = buildSegments([rd('2026-11-10 00:00', 0), rd('2026-11-10 18:00', 180)], meter())
  const md = aggregateMeterDay(segs, '2026-11-10')
  assert.equal(md.usage, 180)
  assert.equal(md.knownHours, 18)
  assert.equal(md.gapHours, 6)
  assert.equal(md.coverage, 0.75)
  assert.equal(md.gaps.length, 1)
  assert.equal(new Date(md.gaps[0].t0).getHours(), 18)
  assert.equal(new Date(md.gaps[0].t1).getHours(), 0)
})

test('未解释区间：降低有效覆盖率但不计入用量', () => {
  const segs = buildSegments(
    [rd('2026-11-10 00:00', 0), rd('2026-11-10 12:00', 120), rd('2026-11-11 00:00', 50)],
    meter({ modulus: null }),
  )
  const md = aggregateMeterDay(segs, '2026-11-10')
  assert.equal(md.usage, 120)
  assert.equal(md.knownHours, 12)
  assert.equal(md.unexplainedHours, 12)
  assert.equal(md.coverage, 0.5)
  assert.equal(md.unexplained.length, 1)
})
