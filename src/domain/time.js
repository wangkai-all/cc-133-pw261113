// 时间工具：全部按本地时区处理，"日"指本地自然日 [00:00, 次日00:00)

export function parseTime(s) {
  const m = String(s).trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/)
  if (!m) throw new Error(`无法解析时间: ${s}`)
  const [, Y, Mo, D, h = '0', mi = '0', se = '0'] = m
  const t = new Date(+Y, +Mo - 1, +D, +h, +mi, +se).getTime()
  if (Number.isNaN(t)) throw new Error(`无法解析时间: ${s}`)
  return t
}

const pad = (n) => String(n).padStart(2, '0')

export function fmtTime(ms) {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// 本地日键 YYYY-MM-DD
export function dayKey(ms) {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// 某本地日的起始毫秒（含），终日 = 翌日起始（不含）
export function dayStartMs(day) {
  return parseTime(day)
}

export function addDays(day, n) {
  return dayKey(dayStartMs(day) + n * 86400000 + 43200000) // 正午偏移避免 DST 边界
}

export function eachDay(fromDay, toDay) {
  const out = []
  for (let d = fromDay; d <= toDay; d = addDays(d, 1)) out.push(d)
  return out
}

export const HOUR_MS = 3600000
