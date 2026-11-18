// 区间按日分摊与单表日聚合。
//  - 区间跨自然日时按重叠时长比例分摊，分摊结果标记 estimated（估算），不与整点实测混淆；
//  - 缺测（无读数覆盖的时段）不是 0：单独统计 gapHours 与缺测范围；
//  - 有效覆盖率 = 当日可确定用量的时长 / 24h。

import { dayKey, dayStartMs, fmtTime, HOUR_MS } from './time.js'
import { Method } from './meters.js'

// 将 segment 按自然日切分；跨日段各部分 estimated=true
export function splitSegmentByDay(seg) {
  const parts = []
  const totalHours = (seg.t1 - seg.t0) / HOUR_MS
  const crosses = dayKey(seg.t0) !== dayKey(seg.t1 - 1)
  let cursor = seg.t0
  while (cursor < seg.t1) {
    const day = dayKey(cursor)
    const nextMidnight = dayStartMs(day) + 86400000
    const end = Math.min(nextMidnight, seg.t1)
    const hours = (end - cursor) / HOUR_MS
    parts.push({
      meterId: seg.meterId,
      day,
      t0: cursor,
      t1: end,
      hours,
      // 未知段保持未知（null），不按比例造数
      usage: seg.known && totalHours > 0 ? (seg.usage * hours) / totalHours : null,
      estimated: crosses || seg.estimated,
      method: seg.method,
      known: seg.known,
      seg,
    })
    cursor = end
  }
  return parts
}

// 单表单日聚合：返回当日用量、覆盖/缺测/未解释时长、缺测范围、明细 parts
export function aggregateMeterDay(segments, day) {
  const dayStart = dayStartMs(day)
  const dayEnd = dayStart + 86400000
  const parts = []
  for (const seg of segments) {
    if (seg.t1 <= dayStart || seg.t0 >= dayEnd) continue
    for (const p of splitSegmentByDay(seg)) {
      if (p.day === day) parts.push(p)
    }
  }
  parts.sort((a, b) => a.t0 - b.t0)

  let usage = 0
  let knownHours = 0
  let unexplainedHours = 0
  let hasEstimated = false
  let hasAssumption = false
  let hasReverse = false
  const methods = new Set()
  const unexplained = []
  for (const p of parts) {
    if (p.method) methods.add(p.method)
    if (p.known) {
      usage += p.usage
      knownHours += p.hours
      if (p.method === Method.REVERSE) hasReverse = true
    } else {
      unexplainedHours += p.hours
      unexplained.push({ t0: p.t0, t1: p.t1, hours: p.hours, notes: p.seg.notes })
    }
    if (p.estimated) hasEstimated = true
    if (p.seg.assumptions && p.seg.assumptions.length > 0) hasAssumption = true
  }

  // 缺测范围：当日既非已知也非未解释的时段
  const covered = parts.map((p) => [p.t0, p.t1]).sort((a, b) => a[0] - b[0])
  const gaps = []
  let cursor = dayStart
  for (const [s, e] of covered) {
    if (s > cursor) gaps.push({ t0: cursor, t1: Math.min(s, dayEnd) })
    cursor = Math.max(cursor, e)
  }
  if (cursor < dayEnd) gaps.push({ t0: cursor, t1: dayEnd })
  const gapHours = gaps.reduce((acc, g) => acc + (g.t1 - g.t0) / HOUR_MS, 0)

  return {
    day,
    usage: round3(usage),
    knownHours: round3(knownHours),
    unexplainedHours: round3(unexplainedHours),
    gapHours: round3(gapHours),
    coverage: round3(knownHours / 24),
    hasEstimated,
    hasAssumption,
    hasReverse,
    methods: [...methods],
    parts,
    gaps: gaps.map((g) => ({ ...g, hours: round3((g.t1 - g.t0) / HOUR_MS) })),
    unexplained,
  }
}

export function round3(x) {
  return Math.round(x * 1000) / 1000
}

export function fmtRange(t0, t1) {
  return `${fmtTime(t0)} ~ ${fmtTime(t1)}`
}
