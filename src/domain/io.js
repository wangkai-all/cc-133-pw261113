// 导入 CSV → 状态；状态/结果 → 导出 CSV/JSON。
// 导出保留换算过程（每段方法、假设、是否估算）与尚未解释的区间。

import { parseCsvObjects, toCsv } from './csv.js'
import { parseTime, fmtTime } from './time.js'
import { METHOD_LABEL, Method } from './meters.js'
import { ROLE_LABEL } from './compute.js'

const bool = (s) => /^(1|true|yes|y|是)$/i.test(String(s).trim())
const numOrNull = (s) => (s === '' || s === null || s === undefined ? null : Number(s))

// 读数 CSV: meter_id,timestamp,value[,source]
export function parseReadingsCsv(text, role) {
  return parseCsvObjects(text).map((r, i) => {
    if (!r.meter_id || !r.timestamp || r.value === '') throw new Error(`读数第 ${i + 2} 行缺少 meter_id/timestamp/value`)
    return { meterId: r.meter_id, t: parseTime(r.timestamp), v: Number(r.value), source: r.source || 'import', role }
  })
}

// 表计属性 CSV: meter_id,name,modulus,bidirectional,max_rate_m3h
export function parseMetersCsv(text) {
  return parseCsvObjects(text).map((r) => ({
    id: r.meter_id,
    name: r.name || r.meter_id,
    modulus: numOrNull(r.modulus),
    bidirectional: bool(r.bidirectional),
    maxRateM3h: numOrNull(r.max_rate_m3h),
  }))
}

// 绑定 CSV: meter_id,zone,role,effective_from,effective_to(可空)
export function parseBindingsCsv(text) {
  return parseCsvObjects(text).map((r, i) => {
    if (!r.meter_id || !r.role || !r.effective_from) throw new Error(`绑定第 ${i + 2} 行缺少 meter_id/role/effective_from`)
    if (!['inlet', 'outlet', 'user'].includes(r.role)) throw new Error(`绑定第 ${i + 2} 行 role 须为 inlet/outlet/user`)
    return { meterId: r.meter_id, zone: r.zone || 'DMA-01', role: r.role, effectiveFrom: r.effective_from, effectiveTo: r.effective_to || '' }
  })
}

// 事件 CSV: event_type(replacement|correction),meter_id,time,old_final,new_initial,corrected_value,usage_override,note
export function parseEventsCsv(text) {
  return parseCsvObjects(text).map((r, i) => {
    if (!r.event_type || !r.meter_id || !r.time) throw new Error(`事件第 ${i + 2} 行缺少 event_type/meter_id/time`)
    if (!['replacement', 'correction'].includes(r.event_type)) throw new Error(`事件第 ${i + 2} 行 event_type 须为 replacement/correction`)
    return {
      type: r.event_type,
      meterId: r.meter_id,
      time: parseTime(r.time),
      oldFinal: numOrNull(r.old_final),
      newInitial: numOrNull(r.new_initial),
      correctedValue: numOrNull(r.corrected_value),
      usageOverride: numOrNull(r.usage_override),
      note: r.note || '',
    }
  })
}

// 日汇总 CSV
export function exportDailyCsv(result, threshold) {
  const rows = [[
    '日期', '输入(m³)', '输出(m³)', '差额(m³)', '有效覆盖率',
    `参考漏损率(覆盖率≥${threshold}时给出)`, '含估算分摊', '含推定/更正', '有缺测', '有未解释区间', '含反向计量',
  ]]
  for (const d of result.days) {
    rows.push([
      d.day, d.input, d.output, d.difference, d.coverage,
      d.ratio === null ? '' : d.ratio,
      yn(d.flags.estimated), yn(d.flags.assumed), yn(d.flags.gaps), yn(d.flags.unexplained), yn(d.flags.reverse),
    ])
  }
  return toCsv(rows)
}

// 区间明细 CSV：每表每日的换算过程；未解释与缺测也各占一行
export function exportIntervalsCsv(result, state) {
  const rows = [[
    '日期', '表计', '名称', '角色', '段起', '段止', '起读数', '止读数',
    '段用量(m³)', '分摊到当日(h)', '当日分摊量(m³)', '换算方式', '估算', '假设/说明',
  ]]
  const meterById = new Map(state.meters.map((m) => [m.id, m]))
  for (const d of result.days) {
    for (const md of d.meters) {
      for (const p of md.parts) {
        const seg = p.seg
        rows.push([
          d.day, p.meterId, md.name, ROLE_LABEL[md.role] || md.role,
          fmtTime(p.t0), fmtTime(p.t1),
          seg.known ? seg.v0 : '', seg.known ? seg.v1 : '',
          seg.known ? seg.usage : '',
          p.hours, p.known ? p.usage : '',
          METHOD_LABEL[p.method] || p.method,
          yn(p.estimated),
          [...(seg.assumptions || []), ...(seg.notes || [])].join('；'),
        ])
      }
      for (const g of md.gaps) {
        rows.push([d.day, md.meterId, md.name, ROLE_LABEL[md.role] || md.role, fmtTime(g.t0), fmtTime(g.t1), '', '', '', g.hours, '', '缺测', '', '无读数覆盖，按未知处理（不计 0）'])
      }
    }
    for (const u of d.unexplained) {
      rows.push([d.day, u.meterId, u.name, '', fmtTime(u.t0), fmtTime(u.t1), '', '', '', u.hours, '', METHOD_LABEL[Method.UNEXPLAINED], '', (u.notes || []).join('；')])
    }
  }
  return toCsv(rows)
}

// 完整 JSON：结果 + 配置 + 未解释清单
export function exportJson(result, state) {
  return JSON.stringify({
    generatedAt: new Date().toISOString(),
    zone: state.zone,
    coverageThreshold: state.threshold,
    note: '差额=输入−输出，仅表示水量未平衡（可能含计量误差、缺测、回绕推定等），不能直接认定为漏水。',
    days: result.days.map((d) => ({
      ...d,
      meters: d.meters.map((md) => ({
        ...md,
        parts: md.parts.map((p) => ({
          t0: fmtTime(p.t0), t1: fmtTime(p.t1), hours: p.hours, usage: p.usage,
          estimated: p.estimated, method: p.method,
          seg: {
            v0: p.seg.v0, v1: p.seg.v1, usage: p.seg.usage, known: p.seg.known,
            assumptions: p.seg.assumptions, notes: p.seg.notes,
          },
        })),
        gaps: md.gaps.map((g) => ({ t0: fmtTime(g.t0), t1: fmtTime(g.t1), hours: g.hours })),
        unexplained: md.unexplained.map((u) => ({ t0: fmtTime(u.t0), t1: fmtTime(u.t1), hours: u.hours, notes: u.notes })),
      })),
      unexplained: d.unexplained.map((u) => ({ ...u, t0: fmtTime(u.t0), t1: fmtTime(u.t1) })),
    })),
    unexplained: result.unexplained.map((u) => ({ ...u, t0: fmtTime(u.t0), t1: fmtTime(u.t1) })),
    config: {
      meters: state.meters,
      bindings: state.bindings,
      events: state.events.map((e) => ({ ...e, time: fmtTime(e.time) })),
    },
  }, null, 2)
}

const yn = (b) => (b ? '是' : '')
