import { computeBalance, compareConfigs, ROLE_LABEL } from '/src/domain/compute.js'
import { METHOD_LABEL } from '/src/domain/meters.js'
import {
  parseReadingsCsv, parseMetersCsv, parseBindingsCsv, parseEventsCsv,
  exportDailyCsv, exportIntervalsCsv, exportJson,
} from '/src/domain/io.js'
import { fmtTime, dayKey, parseTime } from '/src/domain/time.js'

const $ = (sel) => document.querySelector(sel)

const state = {
  zone: 'DMA-01',
  threshold: 0.8,
  meters: [],          // [{id,name,modulus,bidirectional,maxRateM3h}]
  readingsByMeter: {}, // meterId -> [{t,v,source}]
  events: [],
  bindings: [],
  snapshot: null,      // 导入/加载样本时的配置快照（用于修正前后对比）
  compareMode: false,
  result: null,
  compare: null,
  selectedDay: null,
}

/* ---------------- 导入 ---------------- */

async function loadSample(name) {
  try {
    const base = `/samples/${name}`
    const [metersTxt, bindingsTxt, eventsTxt, readingsTxt] = await Promise.all(
      ['meters.csv', 'bindings.csv', 'events.csv', 'readings.csv'].map((f) =>
        fetch(`${base}/${f}`).then((r) => {
          if (!r.ok) throw new Error(`${f}: HTTP ${r.status}`)
          return r.text()
        })),
    )
    resetState()
    state.meters = parseMetersCsv(metersTxt)
    state.bindings = parseBindingsCsv(bindingsTxt)
    state.events = parseEventsCsv(eventsTxt)
    mergeReadings(parseReadingsCsv(readingsTxt))
    state.zone = state.bindings[0]?.zone || state.zone
    $('#zone-input').value = state.zone
    takeSnapshot()
    recompute()
    setStatus(`已加载样本 ${name.toUpperCase()}：${state.meters.length} 表计 / ${countReadings()} 条读数 / ${state.events.length} 事件。`)
    $('#sample-hint').textContent = SAMPLE_HINTS[name] || ''
  } catch (e) {
    setStatus(`样本加载失败：${e.message}`, true)
  }
}

const SAMPLE_HINTS = {
  a: '含换表(11-12)、回绕推定(UM-01)、人工更正(UM-03)、未解释负差(IN-02 11-14)、缺测与跨日分摊(UM-02)',
  b: '双向边界表夜间反向计量，差额可正可负',
  c: 'BD-07 绑定为过时配置（全期进水）；请在下方修正为 11-12 起出水，再勾选"对比修正前后"',
}

function resetState() {
  state.meters = []
  state.readingsByMeter = {}
  state.events = []
  state.bindings = []
  state.selectedDay = null
  state.compareMode = false
  $('#compare-toggle').checked = false
}

function mergeReadings(rows) {
  for (const r of rows) {
    const arr = (state.readingsByMeter[r.meterId] ??= [])
    if (!arr.some((x) => x.t === r.t)) arr.push({ t: r.t, v: r.v, source: r.source })
  }
  for (const arr of Object.values(state.readingsByMeter)) arr.sort((a, b) => a.t - b.t)
}

// 读数导入后自动登记表计与绑定（角色来自导入入口）
function autoRegister(role) {
  for (const meterId of Object.keys(state.readingsByMeter)) {
    if (!state.meters.some((m) => m.id === meterId)) {
      state.meters.push({ id: meterId, name: meterId, modulus: null, bidirectional: false, maxRateM3h: null })
    }
    if (role && !state.bindings.some((b) => b.meterId === meterId)) {
      const firstDay = dayKey(state.readingsByMeter[meterId][0].t)
      state.bindings.push({ meterId, zone: state.zone, role, effectiveFrom: firstDay, effectiveTo: '' })
    }
  }
}

async function importFile(input, handler) {
  const file = input.files[0]
  if (!file) return
  try {
    handler(await file.text())
    takeSnapshot()
    recompute()
    setStatus(`已导入 ${file.name}：${state.meters.length} 表计 / ${countReadings()} 条读数 / ${state.events.length} 事件 / ${state.bindings.length} 绑定。`)
  } catch (e) {
    setStatus(`导入 ${file.name} 失败：${e.message}`, true)
  } finally {
    input.value = ''
  }
}

function countReadings() {
  return Object.values(state.readingsByMeter).reduce((n, a) => n + a.length, 0)
}

function setStatus(msg, isErr = false) {
  $('#import-status').innerHTML = isErr ? `<span class="err">${escapeHtml(msg)}</span>` : escapeHtml(msg)
}

/* ---------------- 计算与渲染 ---------------- */

function currentConfig() {
  return {
    zone: state.zone,
    threshold: state.threshold,
    meters: state.meters,
    readingsByMeter: state.readingsByMeter,
    events: state.events,
    bindings: state.bindings,
  }
}

function takeSnapshot() {
  state.snapshot = structuredClone({
    meters: state.meters, events: state.events, bindings: state.bindings,
    readingsByMeter: state.readingsByMeter, zone: state.zone, threshold: state.threshold,
  })
}

function recompute() {
  if (state.meters.length === 0) return
  state.result = computeBalance(currentConfig())
  state.compare = null
  if (state.compareMode && state.snapshot) {
    state.compare = compareConfigs(
      { ...state.snapshot, threshold: state.threshold },
      currentConfig(),
    )
  }
  renderAll()
}

function renderAll() {
  const has = state.result && state.result.days.length > 0
  $('#summary-section').hidden = !has
  $('#config-section').hidden = state.meters.length === 0
  if (!has) { $('#drill-section').hidden = true; return }
  renderChart()
  renderDailyTable()
  renderDrill()
  renderConfigTables()
  renderCompare()
}

/* ---------------- 日平衡表 ---------------- */

const FLAG_TAGS = [
  ['estimated', '含估算分摊', 'est'],
  ['assumed', '含回绕推定', 'est'],
  ['replacement', '换表', ''],
  ['correction', '人工更正', ''],
  ['reverse', '反向计量', ''],
  ['gaps', '有缺测', 'bad'],
  ['unexplained', '有未解释', 'bad'],
]

function flagTags(flags) {
  return FLAG_TAGS.filter(([k]) => flags[k])
    .map(([, label, cls]) => `<span class="tag ${cls}">${label}</span>`)
    .join('')
}

function fmtNum(n, digits = 1) {
  if (n === null || n === undefined) return '—'
  return Number(n.toFixed(digits)).toLocaleString('zh-CN')
}

function renderDailyTable() {
  const rows = state.result.days.map((d) => `
    <tr class="clickable ${d.day === state.selectedDay ? 'selected' : ''} ${d.ratioSuppressed ? 'suppressed' : ''}" data-day="${d.day}">
      <td>${d.day}</td>
      <td class="num">${fmtNum(d.input)}</td>
      <td class="num">${fmtNum(d.output)}</td>
      <td class="num"><strong>${fmtNum(d.difference)}</strong></td>
      <td class="num">${(d.coverage * 100).toFixed(0)}%</td>
      <td class="num">${d.ratio === null ? `<span class="muted" title="有效覆盖率低于阈值 ${state.threshold}，不输出确定比例">—</span>` : (d.ratio * 100).toFixed(1) + '%'}</td>
      <td>${flagTags(d.flags)}</td>
    </tr>`).join('')
  $('#daily-table').innerHTML = `
    <thead><tr>
      <th>日期</th><th class="num">输入 (m³)</th><th class="num">输出 (m³)</th><th class="num">差额 (m³)</th>
      <th class="num">有效覆盖率</th><th class="num">参考漏损率</th><th>数据性质</th>
    </tr></thead><tbody>${rows}</tbody>`
  $('#daily-table').querySelectorAll('tr[data-day]').forEach((tr) =>
    tr.addEventListener('click', () => {
      state.selectedDay = state.selectedDay === tr.dataset.day ? null : tr.dataset.day
      renderDailyTable()
      renderDrill()
    }))
}

/* ---------------- 单日钻取 ---------------- */

function renderDrill() {
  const sec = $('#drill-section')
  const d = state.result?.days.find((x) => x.day === state.selectedDay)
  if (!d) { sec.hidden = true; return }
  sec.hidden = false
  $('#drill-title').textContent = `${d.day} 核对：输入 ${fmtNum(d.input)} − 输出 ${fmtNum(d.output)} = 差额 ${fmtNum(d.difference)} m³（覆盖率 ${(d.coverage * 100).toFixed(0)}%）`
  $('#drill-body').innerHTML = d.meters.map(renderMeterDay).join('')
}

function renderMeterDay(md) {
  const segRows = md.parts.map((p) => {
    const seg = p.seg
    const notes = [...(seg.assumptions || []), ...(seg.notes || [])].join('；')
    return `<tr>
      <td>${fmtTime(p.t0)} ~ ${fmtTime(p.t1)}</td>
      <td class="num">${seg.known ? fmtNum(seg.v0, 0) : '—'}</td>
      <td class="num">${seg.known ? fmtNum(seg.v1, 0) : '—'}</td>
      <td class="num">${seg.known ? fmtNum(seg.usage) : '未知'}</td>
      <td class="num">${fmtNum(p.hours, 2)}</td>
      <td class="num">${p.known ? fmtNum(p.usage) : '—'}</td>
      <td>${METHOD_LABEL[p.method] || p.method}${p.estimated ? ' <span class="tag est">估算</span>' : ''}</td>
      <td class="small muted">${escapeHtml(notes)}</td>
    </tr>`
  }).join('')
  const gaps = md.gaps.map((g) => `<li>${fmtTime(g.t0)} ~ ${fmtTime(g.t1)}（${g.hours}h，无读数覆盖，按未知处理）</li>`).join('')
  const unexp = md.unexplained.map((u) => `<li>${fmtTime(u.t0)} ~ ${fmtTime(u.t1)}（${u.hours}h）：${escapeHtml((u.notes || []).join('；'))}</li>`).join('')
  return `
  <div class="meter-card">
    <h4>${escapeHtml(md.name)}（${md.meterId} · ${ROLE_LABEL[md.role] || md.role}）
      <span class="sub">当日 ${fmtNum(md.usage)} m³ · 覆盖 ${md.knownHours}h / 缺测 ${md.gapHours}h / 未解释 ${md.unexplainedHours}h</span>
    </h4>
    <div class="table-scroll"><table>
      <thead><tr><th>时段</th><th class="num">起读数</th><th class="num">止读数</th><th class="num">段用量</th><th class="num">当日(h)</th><th class="num">分摊量</th><th>换算方式</th><th>说明</th></tr></thead>
      <tbody>${segRows || '<tr><td colspan="8" class="muted">当日无读数区间</td></tr>'}</tbody>
    </table></div>
    ${gaps ? `<div><strong class="small">缺测范围：</strong><ul class="small">${gaps}</ul></div>` : ''}
    ${unexp ? `<div><strong class="small">未解释区间：</strong><ul class="small">${unexp}</ul></div>` : ''}
  </div>`
}

/* ---------------- 配置表（修正关联） ---------------- */

function renderConfigTables() {
  // 表计属性
  $('#meters-table').innerHTML = `
    <thead><tr><th>表计</th><th>名称</th><th>回绕模数</th><th>双向计量</th><th>最大流量(m³/h)</th><th>读数条数</th></tr></thead>
    <tbody>${state.meters.map((m, i) => `<tr>
      <td>${escapeHtml(m.id)}</td>
      <td><input type="text" value="${escapeHtml(m.name)}" data-m="${i}" data-f="name"></td>
      <td><input type="number" value="${m.modulus ?? ''}" data-m="${i}" data-f="modulus" min="0" style="width:90px"></td>
      <td><input type="checkbox" ${m.bidirectional ? 'checked' : ''} data-m="${i}" data-f="bidirectional"></td>
      <td><input type="number" value="${m.maxRateM3h ?? ''}" data-m="${i}" data-f="maxRateM3h" min="0" style="width:90px"></td>
      <td class="num">${(state.readingsByMeter[m.id] || []).length}</td>
    </tr>`).join('')}</tbody>`
  $('#meters-table').querySelectorAll('input').forEach((inp) =>
    inp.addEventListener('change', () => {
      const m = state.meters[+inp.dataset.m]
      const f = inp.dataset.f
      if (f === 'bidirectional') m[f] = inp.checked
      else if (f === 'name') m[f] = inp.value
      else m[f] = inp.value === '' ? null : Number(inp.value)
      recompute()
    }))

  // 边界绑定
  const meterOptions = (sel) => state.meters.map((m) =>
    `<option value="${escapeHtml(m.id)}" ${m.id === sel ? 'selected' : ''}>${escapeHtml(m.id)}</option>`).join('')
  $('#bindings-table').innerHTML = `
    <thead><tr><th>表计</th><th>分区</th><th>角色/方向</th><th>生效起</th><th>生效止(不含,空=持续)</th><th></th></tr></thead>
    <tbody>${state.bindings.map((b, i) => `<tr>
      <td><select data-b="${i}" data-f="meterId">${meterOptions(b.meterId)}</select></td>
      <td><input type="text" value="${escapeHtml(b.zone)}" data-b="${i}" data-f="zone" size="8"></td>
      <td><select data-b="${i}" data-f="role">
        ${['inlet', 'outlet', 'user'].map((r) => `<option value="${r}" ${b.role === r ? 'selected' : ''}>${ROLE_LABEL[r]}</option>`).join('')}
      </select></td>
      <td><input type="date" value="${b.effectiveFrom}" data-b="${i}" data-f="effectiveFrom"></td>
      <td><input type="date" value="${b.effectiveTo}" data-b="${i}" data-f="effectiveTo"></td>
      <td><button data-del-b="${i}">删除</button></td>
    </tr>`).join('')}</tbody>`
  $('#bindings-table').querySelectorAll('input,select').forEach((inp) =>
    inp.addEventListener('change', () => {
      state.bindings[+inp.dataset.b][inp.dataset.f] = inp.value
      recompute()
    }))
  $('#bindings-table').querySelectorAll('button[data-del-b]').forEach((btn) =>
    btn.addEventListener('click', () => {
      state.bindings.splice(+btn.dataset.delB, 1)
      recompute()
    }))

  // 事件
  $('#events-table').innerHTML = `
    <thead><tr><th>类型</th><th>表计</th><th>时间</th><th>旧表止码</th><th>新表起码</th><th>更正值</th><th>给定用量</th><th>备注</th><th></th></tr></thead>
    <tbody>${state.events.map((e, i) => `<tr>
      <td><select data-e="${i}" data-f="type">
        <option value="replacement" ${e.type === 'replacement' ? 'selected' : ''}>换表</option>
        <option value="correction" ${e.type === 'correction' ? 'selected' : ''}>人工更正</option>
      </select></td>
      <td><select data-e="${i}" data-f="meterId">${meterOptions(e.meterId)}</select></td>
      <td><input type="text" value="${fmtTime(e.time)}" data-e="${i}" data-f="time" size="16" placeholder="YYYY-MM-DD HH:MM"></td>
      <td><input type="number" value="${e.oldFinal ?? ''}" data-e="${i}" data-f="oldFinal" style="width:80px"></td>
      <td><input type="number" value="${e.newInitial ?? ''}" data-e="${i}" data-f="newInitial" style="width:80px"></td>
      <td><input type="number" value="${e.correctedValue ?? ''}" data-e="${i}" data-f="correctedValue" style="width:80px"></td>
      <td><input type="number" value="${e.usageOverride ?? ''}" data-e="${i}" data-f="usageOverride" style="width:80px"></td>
      <td><input type="text" value="${escapeHtml(e.note || '')}" data-e="${i}" data-f="note" size="14"></td>
      <td><button data-del-e="${i}">删除</button></td>
    </tr>`).join('')}</tbody>`
  $('#events-table').querySelectorAll('input,select').forEach((inp) =>
    inp.addEventListener('change', () => {
      const e = state.events[+inp.dataset.e]
      const f = inp.dataset.f
      if (f === 'time') {
        try { e.time = parseTime(inp.value) } catch { setStatus(`事件时间无法解析：${inp.value}`, true); return }
      } else if (['oldFinal', 'newInitial', 'correctedValue', 'usageOverride'].includes(f)) {
        e[f] = inp.value === '' ? null : Number(inp.value)
      } else e[f] = inp.value
      recompute()
    }))
  $('#events-table').querySelectorAll('button[data-del-e]').forEach((btn) =>
    btn.addEventListener('click', () => {
      state.events.splice(+btn.dataset.delE, 1)
      recompute()
    }))
}

/* ---------------- 修正前后对比 ---------------- */

function renderCompare() {
  const body = $('#compare-body')
  if (!state.compareMode || !state.compare) { body.innerHTML = ''; return }
  const rows = state.compare.rows.map((r) => `
    <tr class="${r.delta ? '' : 'suppressed'}">
      <td>${r.day}</td>
      <td class="num">${fmtNum(r.baseDifference)}</td>
      <td class="num">${r.editedDifference === null ? '—' : fmtNum(r.editedDifference)}</td>
      <td class="num"><strong>${r.delta === null ? '—' : (r.delta > 0 ? '+' : '') + fmtNum(r.delta)}</strong></td>
      <td class="num">${(r.baseCoverage * 100).toFixed(0)}%</td>
      <td class="num">${r.editedCoverage === null ? '—' : (r.editedCoverage * 100).toFixed(0) + '%'}</td>
    </tr>`).join('')
  body.innerHTML = `
    <h3>修正前后差额对比（快照 vs 当前配置）</h3>
    <div class="table-scroll"><table>
      <thead><tr><th>日期</th><th class="num">修正前差额</th><th class="num">修正后差额</th><th class="num">变化</th><th class="num">前覆盖率</th><th class="num">后覆盖率</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`
}

/* ---------------- 图表 ---------------- */

function renderChart() {
  const days = state.result.days
  const el = $('#chart')
  if (!days.length) { el.innerHTML = ''; return }

  const W = 960, H = 280, ML = 52, MR = 12, MT = 14, MB = 30
  const plotW = W - ML - MR, plotH = H - MT - MB
  const maxV = Math.max(1, ...days.map((d) => Math.max(d.input, d.output)))
  const minV = Math.min(0, ...days.map((d) => d.difference))
  const [lo, hi, ticks] = niceScale(minV, maxV)
  const y = (v) => MT + plotH - ((v - lo) / (hi - lo)) * plotH
  const band = plotW / days.length
  const barW = Math.min(24, band / 2 - 3)

  let svg = ''
  // 网格与刻度
  for (const t of ticks) {
    svg += `<line x1="${ML}" y1="${y(t)}" x2="${W - MR}" y2="${y(t)}" class="grid"/>`
    svg += `<text x="${ML - 6}" y="${y(t) + 4}" class="tick" text-anchor="end">${fmtNum(t, 0)}</text>`
  }
  // 零线
  svg += `<line x1="${ML}" y1="${y(0)}" x2="${W - MR}" y2="${y(0)}" class="zero"/>`

  const linePts = []
  days.forEach((d, i) => {
    const cx = ML + band * i + band / 2
    const x1 = cx - barW - 1, x2 = cx + 1
    for (const [x, v, cls] of [[x1, d.input, 'in'], [x2, d.output, 'out']]) {
      const top = y(Math.max(0, v)), h = Math.abs(y(v) - y(0))
      if (h > 0) svg += `<rect x="${x}" y="${top}" width="${barW}" height="${h}" rx="4" class="bar ${cls}"/>`
    }
    linePts.push(`${cx},${y(d.difference)}`)
    const label = days.length > 14 && i % 2 ? '' : d.day.slice(5)
    if (label) svg += `<text x="${cx}" y="${H - 10}" class="tick" text-anchor="middle">${label}</text>`
  })
  svg += `<polyline points="${linePts.join(' ')}" class="line diff"/>`
  days.forEach((d, i) => {
    const cx = ML + band * i + band / 2
    svg += `<circle cx="${cx}" cy="${y(d.difference)}" r="4" class="dot diff"/>`
  })
  // 悬停热区
  days.forEach((d, i) => {
    svg += `<rect x="${ML + band * i}" y="${MT}" width="${band}" height="${plotH}" class="hit" data-i="${i}"/>`
  })

  el.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="按日输入输出与差额图">
      <style>
        .grid { stroke: var(--gridline); stroke-width: 1; }
        .zero { stroke: var(--baseline); stroke-width: 1; }
        .tick { fill: var(--text-muted); font-size: 11px; font-variant-numeric: tabular-nums; }
        .bar.in { fill: var(--series-1); }
        .bar.out { fill: var(--series-2); }
        .line.diff { fill: none; stroke: var(--series-3); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
        .dot.diff { fill: var(--series-3); stroke: var(--surface-1); stroke-width: 2; }
        .hit { fill: transparent; }
      </style>${svg}</svg>
    <div class="legend">
      <span class="key"><span class="swatch" style="background:var(--series-1)"></span>输入 (m³)</span>
      <span class="key"><span class="swatch" style="background:var(--series-2)"></span>输出 (m³)</span>
      <span class="key"><span class="swatch line" style="background:var(--series-3)"></span>差额 (m³)</span>
    </div>
    <div class="tooltip" id="chart-tip"></div>`

  const tip = $('#chart-tip')
  el.querySelectorAll('.hit').forEach((hit) => {
    hit.addEventListener('mousemove', (ev) => {
      const d = days[+hit.dataset.i]
      const rect = el.getBoundingClientRect()
      tip.style.display = 'block'
      tip.style.left = `${ev.clientX - rect.left + 14}px`
      tip.style.top = `${ev.clientY - rect.top - 10}px`
      tip.innerHTML = `<strong>${d.day}</strong><br>输入 ${fmtNum(d.input)} · 输出 ${fmtNum(d.output)} · 差额 ${fmtNum(d.difference)} m³<br>覆盖率 ${(d.coverage * 100).toFixed(0)}%${d.ratio === null ? '（不足，不输出比例）' : ` · 参考漏损率 ${(d.ratio * 100).toFixed(1)}%`}`
    })
    hit.addEventListener('mouseleave', () => { tip.style.display = 'none' })
    hit.addEventListener('click', () => {
      const d = days[+hit.dataset.i]
      state.selectedDay = state.selectedDay === d.day ? null : d.day
      renderDailyTable()
      renderDrill()
      $('#drill-section').scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    })
  })
}

function niceScale(min, max) {
  const span = max - min || 1
  const step0 = span / 4
  const mag = 10 ** Math.floor(Math.log10(step0))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => step0 <= s) || 10 * mag
  const lo = Math.floor(min / step) * step
  const hi = Math.ceil(max / step) * step
  const ticks = []
  for (let t = lo; t <= hi + 1e-9; t += step) ticks.push(Math.round(t * 1e6) / 1e6)
  return [lo, hi, ticks]
}

/* ---------------- 导出 ---------------- */

function download(filename, text, mime = 'text/csv') {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob(['\uFEFF' + text], { type: `${mime};charset=utf-8` }))
  a.download = filename
  a.click()
  URL.revokeObjectURL(a.href)
}

/* ---------------- 事件绑定 ---------------- */

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

document.querySelectorAll('[data-sample]').forEach((btn) =>
  btn.addEventListener('click', () => loadSample(btn.dataset.sample)))

$('#file-inlet').addEventListener('change', (e) => importFile(e.target, (txt) => { mergeReadings(parseReadingsCsv(txt, 'inlet')); autoRegister('inlet') }))
$('#file-outlet').addEventListener('change', (e) => importFile(e.target, (txt) => { mergeReadings(parseReadingsCsv(txt, 'outlet')); autoRegister('outlet') }))
$('#file-user').addEventListener('change', (e) => importFile(e.target, (txt) => { mergeReadings(parseReadingsCsv(txt, 'user')); autoRegister('user') }))
$('#file-meters').addEventListener('change', (e) => importFile(e.target, (txt) => {
  for (const m of parseMetersCsv(txt)) {
    const i = state.meters.findIndex((x) => x.id === m.id)
    if (i >= 0) state.meters[i] = m
    else state.meters.push(m)
  }
}))
$('#file-bindings').addEventListener('change', (e) => importFile(e.target, (txt) => { state.bindings = parseBindingsCsv(txt) }))
$('#file-events').addEventListener('change', (e) => importFile(e.target, (txt) => {
  for (const ev of parseEventsCsv(txt)) {
    if (!state.events.some((x) => x.type === ev.type && x.meterId === ev.meterId && x.time === ev.time)) state.events.push(ev)
  }
}))

$('#zone-input').addEventListener('change', (e) => { state.zone = e.target.value.trim() || 'DMA-01'; recompute() })
$('#threshold-input').addEventListener('change', (e) => {
  state.threshold = Math.min(1, Math.max(0, Number(e.target.value) || 0.8))
  recompute()
})

$('#add-binding').addEventListener('click', () => {
  const firstMeter = state.meters[0]?.id || ''
  const from = state.result?.days[0]?.day || dayKey(Date.now())
  state.bindings.push({ meterId: firstMeter, zone: state.zone, role: 'inlet', effectiveFrom: from, effectiveTo: '' })
  recompute()
})
$('#add-event').addEventListener('click', () => {
  const firstMeter = state.meters[0]?.id || ''
  state.events.push({ type: 'replacement', meterId: firstMeter, time: Date.now(), oldFinal: null, newInitial: null, correctedValue: null, usageOverride: null, note: '' })
  recompute()
})
$('#compare-toggle').addEventListener('change', (e) => { state.compareMode = e.target.checked; recompute() })
$('#reset-snapshot').addEventListener('click', () => {
  if (!state.snapshot) return
  state.meters = structuredClone(state.snapshot.meters)
  state.events = structuredClone(state.snapshot.events)
  state.bindings = structuredClone(state.snapshot.bindings)
  state.zone = state.snapshot.zone
  $('#zone-input').value = state.zone
  recompute()
  setStatus('已重置为导入时配置。')
})

$('#export-daily').addEventListener('click', () => download(`日汇总_${state.zone}.csv`, exportDailyCsv(state.result, state.threshold)))
$('#export-intervals').addEventListener('click', () => download(`区间明细_${state.zone}.csv`, exportIntervalsCsv(state.result, state)))
$('#export-json').addEventListener('click', () => download(`水平衡_${state.zone}.json`, exportJson(state.result, state), 'application/json'))
