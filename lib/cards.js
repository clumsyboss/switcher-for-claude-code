const MAX_ACCOUNTS = 500
const MAX_NOTE_VALUE = 120
const NOTE_KINDS = ['hint', 'extra']

function cleanOrder(value, names) {
  if (!Array.isArray(value)) return null
  const known = new Set(names)
  const out = []
  for (const n of value.slice(0, MAX_ACCOUNTS)) {
    if (typeof n === 'string' && known.has(n) && !out.includes(n)) out.push(n)
  }
  return out
}

function cleanNotes(value, names) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const known = new Set(names)
  const out = {}
  for (const [k, v] of Object.entries(value)) {
    if (typeof v !== 'string' || v.length > MAX_NOTE_VALUE) continue
    const i = k.lastIndexOf(':')
    if (i < 1) continue
    if (!known.has(k.slice(0, i)) || !NOTE_KINDS.includes(k.slice(i + 1))) continue
    out[k] = v
  }
  return out
}

function ordered(list, order, fallback) {
  const o = Array.isArray(order) ? order : []
  const at = (x) => { const i = o.indexOf(x.name); return i < 0 ? Infinity : i }
  return list.slice().sort((a, b) => {
    const d = at(a) - at(b)
    if (d) return d
    return fallback ? fallback(a, b) : 0
  })
}

const SYMBOLS = { USD: '$', EUR: '€', GBP: '£', JPY: '¥', INR: '₹' }

function extraOf(e) {
  if (!e || !e.is_enabled) return null
  if (typeof e.used_credits !== 'number' || typeof e.monthly_limit !== 'number' || e.monthly_limit <= 0) return null
  const f = Math.pow(10, extraDecimals(e))
  const round = (c) => Math.round(c) / f
  return { used: round(e.used_credits), limit: round(e.monthly_limit), currency: extraSymbol(e) }
}

const NO_MINOR_UNIT = new Set(['JPY', 'KRW', 'VND', 'CLP', 'ISK', 'UGX', 'PYG', 'RWF', 'XAF', 'XOF', 'XPF'])

function extraCode(e) { return e && typeof e.currency === 'string' && e.currency ? e.currency.toUpperCase() : 'USD' }

function extraSymbol(e) { const code = extraCode(e); return SYMBOLS[code] || (code.slice(0, 3) + ' ') }

function extraDecimals(e) {
  if (e && typeof e.decimal_places === 'number' && e.decimal_places >= 0 && e.decimal_places <= 4) return e.decimal_places
  return NO_MINOR_UNIT.has(extraCode(e)) ? 0 : 2
}

const STALE_MS = 2 * 60 * 60 * 1000

function roomBack(rows, waiting, seen, now) {
  const out = { fire: [], due: [], next: null }
  const names = new Set(rows.map((r) => r.name))
  for (const n of Object.keys(waiting)) if (!names.has(n)) delete waiting[n]
  for (const r of rows) {
    if (r.active || r.needsLogin) { delete waiting[r.name]; continue }
    const full = [r.rawSession, r.rawWeekly].filter((l) => l && typeof l.percent === 'number' && l.percent >= 100)
    const fetched = r.fetchedAtMs || 0
    if (full.length) {
      const times = full.map((l) => Date.parse(l.resets_at)).filter((t) => !Number.isNaN(t))
      if (times.length !== full.length) { delete waiting[r.name]; continue }
      const until = Math.max(...times)
      if (fetched >= until) { delete waiting[r.name]; continue }
      waiting[r.name] = until
      if (until <= now) out.due.push(r.name)
      else if (out.next === null || until < out.next) out.next = until
      continue
    }
    const until = waiting[r.name]
    if (!until) continue
    if (fetched < until) { if (until <= now) out.due.push(r.name); continue }
    if (seen[r.name] === until || now - until > STALE_MS) { delete waiting[r.name]; continue }
    out.fire.push({ name: r.name, until })
  }
  return out
}

module.exports = { cleanOrder, cleanNotes, ordered, extraOf, extraSymbol, extraDecimals, roomBack, MAX_ACCOUNTS }
