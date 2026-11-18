import test from 'node:test'
import assert from 'node:assert/strict'
import { computeBalance, compareConfigs } from '../src/domain/compute.js'
import { parseTime } from '../src/domain/time.js'

const T = (s) => parseTime(s)
const rd = (t, v) => ({ t: T(t), v })

function baseState(over = {}) {
  return {
    zone: 'DMA-01',
    threshold: 0.8,
    meters: [
      { id: 'IN1', name: '入口1', modulus: 100000, bidirectional: false, maxRateM3h: null },
      { id: 'UM1', name: '用户1', modulus: 10000, bidirectional: false, maxRateM3h: null },
    ],
    readingsByMeter: {
      IN1: [rd('2026-11-10 00:00', 1000), rd('2026-11-11 00:00', 1480), rd('2026-11-12 00:00', 1960)],
      UM1: [rd('2026-11-10 00:00', 500), rd('2026-11-11 00:00', 900), rd('2026-11-12 00:00', 1300)],
    },
    events: [],
    bindings: [
      { meterId: 'IN1', zone: 'DMA-01', role: 'inlet', effectiveFrom: '2026-11-01', effectiveTo: '' },
      { meterId: 'UM1', zone: 'DMA-01', role: 'user', effectiveFrom: '2026-11-01', effectiveTo: '' },
    ],
    ...over,
  }
}

test('日平衡：输入−输出=差额，覆盖充分时给出参考比例', () => {
  const { days } = computeBalance(baseState())
  assert.equal(days.length, 2)
  assert.equal(days[0].day, '2026-11-10')
  assert.equal(days[0].input, 480)
  assert.equal(days[0].output, 400)
  assert.equal(days[0].difference, 80)
  assert.equal(days[0].coverage, 1)
  assert.equal(days[0].ratio, 0.167) // 保留 3 位小数
})

test('缺测拉低覆盖率：低于阈值时不输出确定比例', () => {
  const st = baseState()
  st.readingsByMeter.UM1 = [rd('2026-11-10 00:00', 500), rd('2026-11-10 12:00', 700)] // 只覆盖半天
  const { days } = computeBalance(st)
  const d0 = days.find((d) => d.day === '2026-11-10')
  assert.equal(d0.coverage, 0.5)
  assert.equal(d0.ratio, null)
  assert.equal(d0.ratioSuppressed, true)
  assert.equal(d0.flags.gaps, true)
})

test('缺测不当零：输出侧只计已知部分，差额如实反映', () => {
  const st = baseState()
  st.readingsByMeter.UM1 = [rd('2026-11-10 00:00', 500), rd('2026-11-10 12:00', 700)]
  const { days } = computeBalance(st)
  const d0 = days.find((d) => d.day === '2026-11-10')
  assert.equal(d0.output, 200) // 仅已知半日用量，不补 0 也不外推
})

test('边界表按生效日期参与：关系变更后各日按当时配置', () => {
  const st = baseState()
  st.meters.push({ id: 'BD9', name: '边界9', modulus: 100000, bidirectional: false, maxRateM3h: null })
  st.readingsByMeter.BD9 = [rd('2026-11-10 00:00', 0), rd('2026-11-11 00:00', 100), rd('2026-11-12 00:00', 200)]
  // 11-11 起 BD9 由进水改为出水
  st.bindings.push(
    { meterId: 'BD9', zone: 'DMA-01', role: 'inlet', effectiveFrom: '2026-11-01', effectiveTo: '2026-11-11' },
    { meterId: 'BD9', zone: 'DMA-01', role: 'outlet', effectiveFrom: '2026-11-11', effectiveTo: '' },
  )
  const { days } = computeBalance(st)
  const d0 = days.find((d) => d.day === '2026-11-10')
  const d1 = days.find((d) => d.day === '2026-11-11')
  assert.equal(d0.input, 480 + 100) // 变更前计入输入
  assert.equal(d0.output, 400)
  assert.equal(d1.input, 480) // 变更后计入输出
  assert.equal(d1.output, 400 + 100)
})

test('反向计量：双向表负用量冲减输出', () => {
  const st = baseState()
  st.meters.push({ id: 'OUT1', name: '出口1', modulus: 100000, bidirectional: true, maxRateM3h: null })
  st.readingsByMeter.OUT1 = [rd('2026-11-10 00:00', 2000), rd('2026-11-11 00:00', 1950), rd('2026-11-12 00:00', 2100)]
  st.bindings.push({ meterId: 'OUT1', zone: 'DMA-01', role: 'outlet', effectiveFrom: '2026-11-01', effectiveTo: '' })
  const { days } = computeBalance(st)
  const d0 = days.find((d) => d.day === '2026-11-10')
  assert.equal(d0.output, 400 - 50) // 反向 50 冲减
  assert.equal(d0.flags.reverse, true)
})

test('未解释区间进入清单，且降低覆盖率', () => {
  const st = baseState()
  st.meters[0].modulus = null // IN1 无模数
  st.readingsByMeter.IN1 = [rd('2026-11-10 00:00', 1000), rd('2026-11-11 00:00', 900), rd('2026-11-12 00:00', 1500)]
  const { days, unexplained } = computeBalance(st)
  const d0 = days.find((d) => d.day === '2026-11-10')
  assert.equal(d0.flags.unexplained, true)
  assert.ok(unexplained.some((u) => u.meterId === 'IN1' && u.day === '2026-11-10'))
  assert.ok(d0.coverage < 1)
})

test('修正关联后比较前后差额', () => {
  const base = baseState()
  base.meters.push({ id: 'BD9', name: '边界9', modulus: 100000, bidirectional: false, maxRateM3h: null })
  base.readingsByMeter.BD9 = [rd('2026-11-10 00:00', 0), rd('2026-11-11 00:00', 100), rd('2026-11-12 00:00', 200)]
  // 原始（错误）配置：BD9 全期按进水
  base.bindings.push({ meterId: 'BD9', zone: 'DMA-01', role: 'inlet', effectiveFrom: '2026-11-01', effectiveTo: '' })
  // 修正配置：11-11 起改为出水
  const edited = structuredClone(base)
  edited.bindings = edited.bindings.filter((b) => b.meterId !== 'BD9')
  edited.bindings.push(
    { meterId: 'BD9', zone: 'DMA-01', role: 'inlet', effectiveFrom: '2026-11-01', effectiveTo: '2026-11-11' },
    { meterId: 'BD9', zone: 'DMA-01', role: 'outlet', effectiveFrom: '2026-11-11', effectiveTo: '' },
  )
  const { rows } = compareConfigs(base, edited)
  const r0 = rows.find((r) => r.day === '2026-11-10')
  const r1 = rows.find((r) => r.day === '2026-11-11')
  assert.equal(r0.delta, 0) // 11-10 配置一致
  assert.equal(r1.baseDifference, (480 + 100) - 400)
  assert.equal(r1.editedDifference, 480 - (400 + 100))
  assert.equal(r1.delta, -200)
})
