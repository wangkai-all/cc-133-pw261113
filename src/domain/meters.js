// 累计读数 → 区间用量换算。
// 规则要点：
//  - 负差不能一律当回绕：仅当表计配置了模数(modulus)且换算结果在该表计量能力内，才记为"回绕推定"；
//    有换表事件按换表分段；有人工更正按更正处理；双向表负差为反向计量；其余记为"未解释"，不计入用量。
//  - 未解释区间用量为 null（未知），不是 0。

export const Method = {
  NORMAL: 'normal',                       // 普通累计差
  ROLLOVER: 'rollover-inferred',          // 回绕推定（按模数换算，带假设标记）
  REPLACEMENT: 'replacement',             // 换表分段
  CORRECTION: 'correction',               // 人工更正后的普通差
  CORRECTION_OVERRIDE: 'correction-override', // 更正记录直接给定区间用量（估算）
  REVERSE: 'reverse',                     // 双向表反向计量（用量为负）
  UNEXPLAINED: 'unexplained',             // 未解释（负差无依据）
}

export const METHOD_LABEL = {
  [Method.NORMAL]: '普通差值',
  [Method.ROLLOVER]: '回绕推定',
  [Method.REPLACEMENT]: '换表分段',
  [Method.CORRECTION]: '人工更正',
  [Method.CORRECTION_OVERRIDE]: '更正给定用量(估算)',
  [Method.REVERSE]: '反向计量',
  [Method.UNEXPLAINED]: '未解释',
}

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v))

// readings: [{t, v, source?}]（单表）；meter: {id, modulus?, bidirectional?, maxRateM3h?}
// events: [{type:'replacement'|'correction', time, oldFinal?, newInitial?, correctedValue?, usageOverride?, note?}]
// 返回 segments: [{meterId,t0,t1,v0,v1,usage,known,method,estimated,assumptions,notes}]
export function buildSegments(readings, meter, events = []) {
  const corrections = events.filter((e) => e.type === 'correction' && e.meterId === meter.id)
  const replacements = events
    .filter((e) => e.type === 'replacement' && e.meterId === meter.id)
    .sort((a, b) => a.time - b.time)

  // 1) 应用人工更正：替换同时刻读数，无则插入更正读数点
  let pts = readings.map((r) => ({ t: r.t, v: r.v, source: r.source || 'auto' }))
  for (const c of corrections) {
    const cv = num(c.correctedValue)
    if (cv === null) continue
    const idx = pts.findIndex((p) => p.t === c.time)
    if (idx >= 0) pts[idx] = { ...pts[idx], v: cv, corrected: true }
    else pts.push({ t: c.time, v: cv, source: 'correction', corrected: true })
  }
  pts.sort((a, b) => a.t - b.t)
  // 同时刻去重（保留后者）
  pts = pts.filter((p, i) => i === pts.length - 1 || p.t !== pts[i + 1].t)

  // 2) 相邻读数形成区间，再按换表事件切分
  const segments = []
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i]
    const b = pts[i + 1]
    const rep = replacements.find((e) => e.time > a.t && e.time < b.t)
    const coincident = replacements.find((e) => e.time === a.t || e.time === b.t)
    if (rep) {
      const oldFinal = num(rep.oldFinal)
      const newInitial = num(rep.newInitial)
      segments.push(makeSeg(meter, a.t, rep.time, a.v, oldFinal, {
        methodHint: Method.REPLACEMENT,
        notes: [`换表前段（事件 ${fmtNote(rep)}）${oldFinal === null ? '：缺旧表止码，本段用量未知' : ''}`],
        corrected: a.corrected,
      }))
      segments.push(makeSeg(meter, rep.time, b.t, newInitial, b.v, {
        methodHint: Method.REPLACEMENT,
        notes: [`换表后段（事件 ${fmtNote(rep)}）${newInitial === null ? '：缺新表起码，本段用量未知' : ''}`],
        corrected: b.corrected,
      }))
    } else {
      const notes = []
      if (coincident) notes.push('换表事件与读数时刻重合，未自动切分，请核对事件时间')
      const corr = corrections.find((c) => c.time === a.t && num(c.usageOverride) !== null)
      segments.push(makeSeg(meter, a.t, b.t, a.v, b.v, {
        notes,
        involvesCorrection: a.corrected || b.corrected || false,
        correctionOverride: corr ? num(corr.usageOverride) : null,
        correctionNote: corr ? corr.note : null,
      }))
    }
  }
  return segments.map((s) => classify(s, meter))
}

function fmtNote(rep) {
  return rep.note ? `${rep.note}` : '换表'
}

function makeSeg(meter, t0, t1, v0, v1, extra = {}) {
  const known = v0 !== null && v0 !== undefined && v1 !== null && v1 !== undefined
  return {
    meterId: meter.id,
    t0, t1, v0, v1,
    usage: null,
    known,
    method: null,
    estimated: false,
    assumptions: [],
    notes: extra.notes || [],
    methodHint: extra.methodHint || null,
    involvesCorrection: extra.involvesCorrection || false,
    correctionOverride: extra.correctionOverride ?? null,
    correctionNote: extra.correctionNote || null,
  }
}

function classify(seg, meter) {
  if (!seg.known) {
    return { ...seg, method: seg.methodHint || Method.UNEXPLAINED }
  }
  const diff = seg.v1 - seg.v0

  if (seg.methodHint === Method.REPLACEMENT) {
    if (diff >= 0) return { ...seg, usage: diff, method: Method.REPLACEMENT }
    return {
      ...seg, usage: null, known: false, method: Method.UNEXPLAINED,
      notes: [...seg.notes, '换表分段内读数下降，请核对换表记录（止码/起码）'],
    }
  }

  if (seg.correctionOverride !== null) {
    return {
      ...seg, usage: seg.correctionOverride, method: Method.CORRECTION_OVERRIDE, estimated: true,
      assumptions: [`采用人工更正给定的区间用量${seg.correctionNote ? `（${seg.correctionNote}）` : ''}`],
    }
  }

  if (diff >= 0) {
    return { ...seg, usage: diff, method: seg.involvesCorrection ? Method.CORRECTION : Method.NORMAL }
  }

  // diff < 0：分别处理，不能一律当回绕
  if (meter.bidirectional) {
    return { ...seg, usage: diff, method: Method.REVERSE, notes: [...seg.notes, '双向表：读数下降按反向流量计（用量为负）'] }
  }
  if (seg.involvesCorrection) {
    return {
      ...seg, usage: null, known: false, method: Method.UNEXPLAINED,
      notes: [...seg.notes, '更正后读数仍下降，需人工确认，未计入用量'],
    }
  }
  if (meter.modulus > 0) {
    const inferred = meter.modulus + diff
    const hours = (seg.t1 - seg.t0) / 3600000
    if (meter.maxRateM3h && hours > 0 && inferred > meter.maxRateM3h * hours * 1.05) {
      return {
        ...seg, usage: null, known: false, method: Method.UNEXPLAINED,
        notes: [...seg.notes, `负差若按回绕(模数${meter.modulus})换算为 ${inferred}，超出该表最大计量能力(${meter.maxRateM3h}/h)，不予认定`],
      }
    }
    return {
      ...seg, usage: inferred, method: Method.ROLLOVER,
      assumptions: [...seg.assumptions, `按模数 ${meter.modulus} 推定回绕：${seg.v0} → ${seg.v1} 计 ${inferred}`],
    }
  }
  return {
    ...seg, usage: null, known: false, method: Method.UNEXPLAINED,
    notes: [...seg.notes, '读数下降，且无模数/换表/更正记录可依，原因未明，未计入用量'],
  }
}
