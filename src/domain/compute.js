// 平衡计算编排：读数→区间→按日聚合→分区日平衡。
//  - 边界表按绑定(bindings)的角色与生效日期参与计算，分区关系变更后各日按当时配置；
//  - 差额 = 输入 − 输出，仅表示未平衡，不直接认定漏损；
//  - 有效覆盖率低于阈值时不输出确定的漏损比例（ratio=null）。

import { buildSegments, Method } from './meters.js'
import { aggregateMeterDay, splitSegmentByDay, round3 } from './days.js'
import { dayKey } from './time.js'

export const ROLE_LABEL = { inlet: '入口表', outlet: '出口表', user: '用户总表' }

// binding: {meterId, zone, role:'inlet'|'outlet'|'user', effectiveFrom:'YYYY-MM-DD', effectiveTo:'YYYY-MM-DD'|''}
export function bindingActiveOn(b, zone, day) {
  return b.zone === zone && b.effectiveFrom <= day && (!b.effectiveTo || day < b.effectiveTo)
}

// state: {
//   zone, threshold,
//   meters: [{id,name,modulus,bidirectional,maxRateM3h}],
//   readingsByMeter: {meterId: [{t,v,source?}]},
//   events: [...], bindings: [...]
// }
export function computeBalance(state) {
  const threshold = state.threshold ?? 0.8
  const metersById = new Map(state.meters.map((m) => [m.id, m]))

  // 1) 每表生成区间段
  const segmentsByMeter = new Map()
  for (const m of state.meters) {
    const readings = (state.readingsByMeter[m.id] || []).slice().sort((a, b) => a.t - b.t)
    segmentsByMeter.set(m.id, buildSegments(readings, m, state.events))
  }

  // 2) 日范围：所有段覆盖的自然日
  let minDay = null
  let maxDay = null
  for (const segs of segmentsByMeter.values()) {
    for (const s of segs) {
      for (const p of splitSegmentByDay(s)) {
        if (!minDay || p.day < minDay) minDay = p.day
        if (!maxDay || p.day > maxDay) maxDay = p.day
      }
    }
  }
  const days = []
  if (!minDay) return { days, unexplained: [] }

  // 3) 逐日：按当时生效的绑定纳入表计，分角色汇总
  for (let day = minDay; day <= maxDay; day = nextDay(day)) {
    const active = state.bindings.filter((b) => bindingActiveOn(b, state.zone, day))
    const meterDays = []
    let input = 0
    let output = 0
    let coverage = 1
    const flags = { estimated: false, assumed: false, gaps: false, unexplained: false, reverse: false, replacement: false, correction: false }
    const unexplained = []

    for (const b of active) {
      const meter = metersById.get(b.meterId)
      if (!meter) continue
      const md = aggregateMeterDay(segmentsByMeter.get(b.meterId) || [], day)
      const entry = { meterId: meter.id, name: meter.name || meter.id, role: b.role, ...md }
      meterDays.push(entry)
      if (b.role === 'inlet') input += md.usage
      else output += md.usage // outlet 与 user 均计输出侧
      coverage = Math.min(coverage, md.coverage)
      flags.estimated = flags.estimated || md.hasEstimated
      flags.assumed = flags.assumed || md.hasAssumption
      flags.reverse = flags.reverse || md.hasReverse
      flags.gaps = flags.gaps || md.gapHours > 0
      flags.unexplained = flags.unexplained || md.unexplainedHours > 0
      flags.replacement = flags.replacement || md.methods.includes(Method.REPLACEMENT)
      flags.correction = flags.correction || md.methods.includes(Method.CORRECTION) || md.methods.includes(Method.CORRECTION_OVERRIDE)
      for (const u of md.unexplained) {
        unexplained.push({ day, meterId: meter.id, name: meter.name, ...u })
      }
    }
    if (active.length === 0) coverage = 0

    input = round3(input)
    output = round3(output)
    const difference = round3(input - output)
    // 覆盖率不足或输入非正：不输出确定比例
    const ratio = coverage >= threshold && input > 0 ? round3(difference / input) : null

    days.push({
      day, input, output, difference, ratio,
      coverage: round3(coverage),
      ratioSuppressed: ratio === null,
      flags,
      meters: meterDays,
      unexplained,
    })
  }

  const unexplained = days.flatMap((d) => d.unexplained)
  return { days, unexplained }
}

function nextDay(day) {
  // 本地日 +1（正午偏移避免 DST 边界）
  return dayKey(new Date(day + 'T12:00:00').getTime() + 86400000)
}

// 修正前后对比：同一批读数，两套配置（绑定/事件/表计属性）分别计算
export function compareConfigs(baseState, editedState) {
  const base = computeBalance(baseState)
  const edited = computeBalance(editedState)
  const editedByDay = new Map(edited.days.map((d) => [d.day, d]))
  const rows = base.days.map((b) => {
    const e = editedByDay.get(b.day)
    return {
      day: b.day,
      baseDifference: b.difference,
      editedDifference: e ? e.difference : null,
      delta: e ? round3(e.difference - b.difference) : null,
      baseRatio: b.ratio,
      editedRatio: e ? e.ratio : null,
      baseCoverage: b.coverage,
      editedCoverage: e ? e.coverage : null,
    }
  })
  return { rows, base, edited }
}

export { Method }
