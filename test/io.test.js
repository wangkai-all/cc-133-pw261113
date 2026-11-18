import test from 'node:test'
import assert from 'node:assert/strict'
import { parseCsv, parseCsvObjects, toCsv } from '../src/domain/csv.js'
import { parseReadingsCsv, parseEventsCsv, parseBindingsCsv, parseMetersCsv } from '../src/domain/io.js'
import { parseTime } from '../src/domain/time.js'

test('CSV 解析：引号、逗号、换行转义', () => {
  const rows = parseCsv('a,b\r\n"x,y","he said ""hi"""\r\n1,2\n')
  assert.deepEqual(rows, [['a', 'b'], ['x,y', 'he said "hi"'], ['1', '2']])
})

test('CSV 序列化往返', () => {
  const rows = [['日期', '备注'], ['2026-11-10', '含,逗号与"引号"']]
  const back = parseCsv(toCsv(rows))
  assert.deepEqual(back, rows)
})

test('读数 CSV 导入', () => {
  const rs = parseReadingsCsv('meter_id,timestamp,value\nIN1,2026-11-10 00:00,1000\nIN1,2026-11-11 00:00,1480\n', 'inlet')
  assert.equal(rs.length, 2)
  assert.equal(rs[0].t, parseTime('2026-11-10 00:00'))
  assert.equal(rs[0].v, 1000)
  assert.equal(rs[0].role, 'inlet')
})

test('事件 CSV 导入：换表与更正', () => {
  const es = parseEventsCsv([
    'event_type,meter_id,time,old_final,new_initial,corrected_value,usage_override,note',
    'replacement,IN1,2026-11-12 10:30,78230,0,,,DN100换表',
    'correction,UM1,2026-11-14 00:00,,,3520,,误抄',
  ].join('\n'))
  assert.equal(es[0].type, 'replacement')
  assert.equal(es[0].oldFinal, 78230)
  assert.equal(es[1].correctedValue, 3520)
  assert.equal(es[1].newInitial, null)
})

test('绑定 CSV 导入：角色与生效日期', () => {
  const bs = parseBindingsCsv('meter_id,zone,role,effective_from,effective_to\nBD9,DMA-01,inlet,2026-11-01,2026-11-11\nBD9,DMA-01,outlet,2026-11-11,\n')
  assert.equal(bs[0].effectiveTo, '2026-11-11')
  assert.equal(bs[1].effectiveTo, '')
  assert.throws(() => parseBindingsCsv('meter_id,zone,role,effective_from,effective_to\nBD9,DMA-01,sideways,2026-11-01,\n'))
})

test('表计属性 CSV 导入', () => {
  const ms = parseMetersCsv('meter_id,name,modulus,bidirectional,max_rate_m3h\nOUT1,出口1,100000,true,500\n')
  assert.equal(ms[0].bidirectional, true)
  assert.equal(ms[0].maxRateM3h, 500)
})
