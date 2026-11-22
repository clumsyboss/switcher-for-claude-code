(function () {
  'use strict'

  const vscode = acquireVsCodeApi()
  const ICONS = window.__ICONS__ || {}
  const ICON_NAMES = window.__ICON_NAMES__ || {}
  const HAS_FONT = !!window.__HAS_FONT__
  const LAYOUT = window.__LAYOUT__ === 'sidebar' ? 'sidebar' : 'tab'
  const SIDEBAR = LAYOUT === 'sidebar'
  document.body.classList.add('layout-' + LAYOUT)
  const NARROW_PX = 500
  let narrowNow = null
  function fitWidth() {
    const narrow = document.documentElement.clientWidth < NARROW_PX
    if (narrow === narrowNow) return
    narrowNow = narrow
    document.body.classList.toggle('narrow', narrow)
    const box = document.querySelector('.find-input')
    if (box) box.placeholder = searchHint()
    if (typeof fitBadges === 'function') fitBadges()
  }
  const searchHint = () => (narrowNow ? 'Search accounts' : 'Search name, email or organisation')
  const app = document.getElementById('app')
  fitWidth()
  window.addEventListener('resize', fitWidth)
  if (typeof ResizeObserver === 'function') new ResizeObserver(() => { fitWidth(); fitWhens() }).observe(document.documentElement)

  let state = null
  let lastJson = ''
  let lastShape = ''
  let receivedAt = 0
  const busy = new Set()
  let rendered = false
  let lastLive = null
  let acEditing = false
  const find = { q: '', sort: 'order', filter: 'all', searchOpen: false }
  const collapsed = new Set()

  const PREF_DEFAULTS = { tint: true, context: false, cardToggles: true, statusLoginDays: true,
    statusUsage: true, trackAll: true, listView: false, groupByOrg: false, accountsView: 'tab', confirmOrgSwitch: true, askSecondLogin: true, compact: false, validity: true }
  function pref(k) { const p = (state && state.prefs) || {}; return k in p ? p[k] : PREF_DEFAULTS[k] }
  const barWidth = new Map()
  let uidSeq = 0
  const uid = () => 'u' + (++uidSeq)

  function h(tag, props, ...kids) {
    const el = document.createElement(tag)
    for (const [k, v] of Object.entries(props || {})) {
      if (v === null || v === undefined || v === false) continue
      if (k === 'class') el.className = v
      else if (k === 'text') el.textContent = v
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v)
      else if (k === 'style') for (const [sk, sv] of Object.entries(v)) el.style.setProperty(sk, sv)
      else el.setAttribute(k, v === true ? '' : v)
    }
    for (const kid of kids.flat()) {
      if (kid === null || kid === undefined || kid === false) continue
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)))
    }
    return el
  }

  const SVG = {
    plus: '<path d="M5 12h14M12 5v14"/>',
    refresh: '<path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M3 21v-5h5"/><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>',
    swap: '<path d="m16 3 4 4-4 4"/><path d="M20 7H4"/><path d="m8 21-4-4 4-4"/><path d="M4 17h16"/>',
    kebab: '<circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
    login: '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><path d="m10 17 5-5-5-5"/><path d="M15 12H3"/>',
    trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
    pin: '<path d="M12 17v5"/><path d="M9 10.8a2 2 0 0 1-1.1 1.8l-1.8.9A2 2 0 0 0 5 15.2V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.8a2 2 0 0 0-1.1-1.8l-1.8-.9A2 2 0 0 1 15 10.8V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1Z"/>',
    folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9l-.8-1.2A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
    alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
    window: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    play: '<path d="M7 4v16l13-8Z"/>',
    pc: '<rect width="20" height="14" x="2" y="3" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/><path d="m9 10 3-3 3 3"/><path d="M12 7v6"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/>',
    up: '<path d="m18 15-6-6-6 6"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    filter: '<path d="M22 3H2l8 9.46V19l4 2v-8.54Z"/>',
    sort: '<path d="m3 16 4 4 4-4"/><path d="M7 20V4"/><path d="m21 8-4-4-4 4"/><path d="M17 4v16"/>',
    'circle-check': '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13"/><path d="M3 6h.01M3 12h.01M3 18h.01"/>',
    grid: '<rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/>',
    grip: '<circle cx="9" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="18" r="1"/>',
    clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
    info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
    help: '<circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
    down: '<path d="m6 9 6 6 6-6"/>',
    copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2"/>',
    arrow: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
    sparkle: '<path d="M12 3 13.9 8.1 19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9Z"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m9 12 2 2 4-4"/>',
    chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z"/>',
    gear: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2Z"/><circle cx="12" cy="12" r="3"/>',
    'plant-free': '<path d="M12 21v-4"/><circle cx="12" cy="14" r="2.5"/>',
    'plant-pro': '<path d="M12 21V10"/><circle cx="12" cy="7.5" r="2.5"/><path d="M12 16c-2 0-4-1-4-3M12 14c2 0 4-1 4-3"/>',
    'plant-max': '<path d="M12 21V10"/><circle cx="12" cy="7" r="2.5"/><path d="M12 17 7 14M12 17l5-3M12 13l-4-2M12 13l4-2"/><circle cx="6.5" cy="13.5" r="1"/><circle cx="17.5" cy="13.5" r="1"/>',
    'plant-ultra': '<path d="M12 21v-8"/><circle cx="12" cy="8" r="2"/><circle cx="12" cy="8" r="5"/><path d="M12 3v2M12 11v2M7 8h2M15 8h2M8.5 4.5l1.4 1.4M14.1 10.1l1.4 1.4M8.5 11.5l1.4-1.4M14.1 5.9l1.4-1.4"/><path d="M12 18c-2 0-3.5-1-3.5-2.5M12 18c2 0 3.5-1 3.5-2.5"/>',
    'plant-team': '<path d="M6 21v-6M12 21V9M18 21v-6"/><circle cx="6" cy="13" r="2"/><circle cx="12" cy="7" r="2.5"/><circle cx="18" cy="13" r="2"/>',
    zap: '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8Z"/>',
    signin: '<path d="M5.5 7A9 9 0 1 1 5.5 17"/><path d="M2 12h14"/><path d="m12 8 4 4-4 4"/>',
    'sort-order': '<path d="M10 6h11M10 12h11M10 18h11"/><path d="M4 10h2"/><path d="M4 6h1v4"/><path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1"/>',
    hourglass: '<path d="M5 22h14M5 2h14"/><path d="M17 22v-4.17a2 2 0 0 0-.59-1.42L12 12l-4.41 4.41A2 2 0 0 0 7 17.83V22"/><path d="M7 2v4.17a2 2 0 0 0 .59 1.42L12 12l4.41-4.41A2 2 0 0 0 17 6.17V2"/>',
    calendar: '<path d="M8 2v4M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/>',
    'timer-reset': '<path d="M10 2h4"/><path d="M12 14v-4"/><path d="M4 13a8 8 0 0 1 8-7 8 8 0 1 1-5.3 14L4 17.6"/><path d="M9 17H4v5"/>',
    'sort-az': '<path d="m3 16 4 4 4-4"/><path d="M7 4v16"/><path d="M20 8h-5"/><path d="M15 10V6.5a2.5 2.5 0 0 1 5 0V10"/><path d="M15 14h5l-5 6h5"/>',
    fold: '<path d="M4 12h16"/><path d="M12 3v6"/><path d="m9 6 3 3 3-3"/><path d="M12 21v-6"/><path d="m9 18 3-3 3 3"/>',
    unfold: '<path d="M4 12h16"/><path d="M12 9V3"/><path d="m9 6 3-3 3 3"/><path d="M12 15v6"/><path d="m9 18 3 3 3-3"/>',
  }
  function icon(name, cls) {
    const span = document.createElement('span')
    span.innerHTML = '<svg class="i ' + (cls || '') + '" viewBox="0 0 24 24" aria-hidden="true">' + (SVG[name] || '') + '</svg>'
    return span.firstChild
  }
  function codicon(name) {
    if (!HAS_FONT || typeof name !== 'string' || !Object.prototype.hasOwnProperty.call(ICONS, name)) return null
    const codes = Array.isArray(ICONS[name]) ? ICONS[name] : [ICONS[name]]
    return h('span', { class: 'codicon' + (codes.length > 1 ? ' pair' : ''), 'aria-hidden': 'true',
      text: codes.map((c) => String.fromCodePoint(c)).join('') })
  }

  const COLORS = {
    red: ['Red', 'var(--vscode-charts-red, #f14c4c)'],
    orange: ['Orange', 'var(--vscode-charts-orange, #d18616)'],
    yellow: ['Yellow', 'var(--vscode-charts-yellow, #cca700)'],
    green: ['Green', 'var(--vscode-charts-green, #89d185)'],
    teal: ['Teal', 'var(--vscode-terminal-ansiCyan, #11a8cd)'],
    blue: ['Blue', 'var(--vscode-charts-blue, #3794ff)'],
    purple: ['Purple', 'var(--vscode-charts-purple, #b180d7)'],
    pink: ['Pink', 'var(--vscode-terminal-ansiMagenta, #bc3fbc)'],
  }
  const AUTO = ['blue', 'purple', 'green', 'orange', 'yellow', 'red']
  function autoColor(name) {
    let x = 0
    for (const c of String(name)) x = (x * 31 + c.charCodeAt(0)) >>> 0
    return AUTO[x % AUTO.length]
  }
  function hueOf(a) { return COLORS[(a.color && COLORS[a.color]) ? a.color : autoColor(a.name)][1] }
  function initials(label) {
    const parts = String(label).split(/[\s._-]+/).filter(Boolean)
    return ((parts[0] || '?')[0] + (parts[1] ? parts[1][0] : (parts[0] || '').slice(1, 2))).toUpperCase()
  }
  function avatar(a, cls) {
    return h('div', { class: cls, 'aria-hidden': 'true', style: { '--hue': hueOf(a) } },
      codicon(a.icon) || initials(a.label))
  }

  function ctxShade(k, filled) {
    const r = Math.abs((Math.sin(k * 12.9898) * 43758.5453) % 1)
    const v = (k / Math.max(1, filled)) * 0.75 + r * 0.4
    return v > 0.95 ? 3 : v > 0.7 ? 2 : v > 0.4 ? 1 : 0
  }

  function now() { return state ? state.now + (Date.now() - receivedAt) : Date.now() }

  function until(t) {
    let m = Math.round((t - now()) / 60000)
    if (m <= 0) return null
    const d = Math.floor(m / 1440); m -= d * 1440
    const hr = Math.floor(m / 60); m -= hr * 60
    return [d ? d + 'd' : null, hr ? hr + 'h' : null, !d && m ? m + 'm' : null].filter(Boolean).join(' ') || '1m'
  }
  function whenShort(limit) { return isOut(limit) ? clockText(Date.parse(limit.resetsAt)) : whenText(limit).replace(/^Resets in /, '') }
  function setWhen(when, limit) {
    const long = when.querySelector('.w-long')
    const short = when.querySelector('.w-short')
    long.textContent = whenText(limit)
    short.textContent = whenShort(limit)
    when.title = long.textContent
    when.dataset.full = long.textContent
    const meter = when.closest('.meter')
    if (meter && meter.classList.contains('wk')) {
      const t = miniWhen(limit)
      long.textContent = t
      short.textContent = t
      when.classList.toggle('no-time', !t)
    } else if (meter && meter.classList.contains('mdl')) {
      const t = isOut(limit) ? miniWhen(limit) : ''
      long.textContent = t
      short.textContent = t
      when.classList.toggle('none', !t)
    }
    const mini = when.closest('.meter.mini')
    if (mini) {
      const at = Number(mini.dataset.at)
      mini.title = (mini.dataset.label || '') + ' · ' + long.textContent +
        (/:wk$/.test(mini.dataset.key || '') && mini.dataset.at ? ' · Usage as of ' + clockText(at) + ' (' + agoShort(now() - at) + ')' : '')
      const t = /:model$/.test(mini.dataset.key || '') ? '' : miniWhen(limit)
      short.textContent = t
      when.classList.toggle('none', !t)
    }
  }
  function fitFoot() {
    app.querySelectorAll('.card-foot').forEach((f) => {
      f.classList.remove('foot-short', 'foot-icon')
      const wraps = () => { const ks = [...f.children].filter((k) => k.getClientRects().length).map((k) => k.getBoundingClientRect()); return ks.some((r) => r.top >= ks[0].bottom - 1) || ks.some((r) => r.top >= Math.min(...ks.map((x) => x.bottom)) - 1) }
      if (wraps()) f.classList.add('foot-short')
      if (wraps()) f.classList.add('foot-icon')
    })
  }
  let fitQueued = false
  function fitWhens() {
    if (fitQueued) return
    fitQueued = true
    requestAnimationFrame(() => { fitQueued = false; fitWhensNow() })
  }
  function fitWhensNow() {
    fitFoot()
    app.querySelectorAll('.card .meter:not(.mini):not(.mdl) .when').forEach((w) => {
      w.classList.remove('age-short', 'age-gone', 'use-short')
      const text = () => [...w.querySelectorAll('.w-long, .w-short')].find((x) => getComputedStyle(x).display !== 'none')
      const cut = () => { const t = text(); return !!t && t.scrollWidth > t.clientWidth }
      const fresh = w.querySelector('.fresh')
      if (fresh) {
        if (cut()) w.classList.add('age-short')
        if (cut()) w.classList.add('age-gone')
        w.title = (w.dataset.full || '') + (w.classList.contains('age-gone') ? ' · ' + fresh.title : '')
      } else if (cut()) w.classList.add('use-short')
    })
    app.querySelectorAll('.lrow .meter.mini .when[data-when]').forEach((w) => {
      let lim = null
      try { lim = JSON.parse(w.getAttribute('data-when') || 'null') } catch { }
      const s = w.querySelector('.w-short')
      if (!lim || !s || !isOut(lim)) return
      s.textContent = miniWhen(lim)
      if (w.scrollWidth > w.clientWidth + 0.5) { const u = until(Date.parse(lim.resetsAt)); if (u) s.textContent = u.replace(/\s+/g, '') }
    })
  }
  function agoShort(ms) {
    const m = Math.max(0, Math.round(ms / 60000))
    if (m < 1) return 'just now'
    if (m < 60) return m + 'm ago'
    const hr = Math.round(m / 60)
    return hr < 24 ? hr + 'h ago' : Math.round(hr / 24) + 'd ago'
  }
  function paintFresh(el, at) {
    if (typeof at !== 'number') return
    el.dataset.at = String(at)
    const ago = el.querySelector('.ft')
    if (ago) {
      const t = agoShort(now() - at)
      const m = /^(.*?)( ago)$/.exec(t)
      ago.replaceChildren(m ? m[1] : t, ...(m ? [h('span', { class: 'ft-ago', text: m[2] })] : []))
    }
    el.classList.toggle('old', now() - at > 3600000)
    el.title = 'Usage as of ' + clockText(at)
  }
  function miniWhen(limit) {
    if (!limit || limit.resetSince || !limit.resetsAt) return ''
    const t = Date.parse(limit.resetsAt)
    if (Number.isNaN(t)) return ''
    if (isOut(limit)) return clockText(t)
    const u = until(t)
    return u ? u.replace(/\s+/g, '') : 'now'
  }
  function whenText(limit) {
    if (!limit) return 'No figures yet'
    if (limit.resetSince) return 'Already reset'
    if (isOut(limit)) return 'Out until ' + clockText(Date.parse(limit.resetsAt))
    const t = limit.resetsAt ? Date.parse(limit.resetsAt) : NaN
    if (Number.isNaN(t)) return 'Reset time unknown'
    const u = until(t)
    return u ? 'Resets in ' + u : 'Resets any moment'
  }

  function isOut(limit) { return !!(limit && limit.percent >= 100 && limit.resetsAt && !Number.isNaN(Date.parse(limit.resetsAt)) && Date.parse(limit.resetsAt) > now()) }
  function clockText(t) {
    const d = new Date(t)
    const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(/s?([AP])M$/i, (m, x) => ' ' + x.toLowerCase() + 'm')
    return d.toDateString() === new Date(now()).toDateString() ? time : d.toLocaleDateString([], { weekday: 'short' }) + ' ' + time
  }
  function agoText(ms) {
    const m = Math.max(0, Math.round(ms / 60000))
    if (m < 1) return 'just now'
    if (m < 60) return m + ' min ago'
    const hr = Math.round(m / 60)
    return hr < 24 ? hr + ' h ago' : Math.round(hr / 24) + ' d ago'
  }

  const DAY = 86400000
  function loginLeft(expiresAt) {
    if (typeof expiresAt !== 'number') return null
    const ms = expiresAt - now()
    if (ms <= 0) return { text: 'Expired', level: 'bad' }
    const d = Math.floor(ms / DAY)
    const hr = Math.max(1, Math.floor(ms / 3600000))
    return { text: d >= 1 ? d + (d === 1 ? ' day' : ' days') : hr + (hr === 1 ? ' hour' : ' hours'), level: ms < 5 * DAY ? 'warn' : '' }
  }
  function accountByName(name) { return ((state && state.accounts) || []).find((x) => x.name === name) || null }
  function pinsOf(name) {
    const s = state || {}
    return { chats: (s.chatPins || []).filter((c) => c.name === name), folders: (s.pins || []).filter((p) => p.name === name) }
  }
  function pinCount(name) { const p = pinsOf(name); return p.chats.length + p.folders.length }
  function pinningOk(a) { return !!(a && a.pinning && typeof a.pinning.expiresAt === 'number' && a.pinning.expiresAt > now()) }
  function headPinButton(key, title, ic, onclick) {
    return h('button', { class: 'btn tint sm head-pin', 'data-fk': key, title, 'aria-label': title, onclick },
      h('span', { class: 'hp-word', text: 'Pin' }), icon(ic, 'sm'))
  }
  function modelName(limit) { return limit && limit.model && limit.model !== 'scoped' ? limit.model : 'Fable' }
  function folderName(p) { return String(p).split(/[\\/]/).filter(Boolean).pop() || String(p) }

  function send(type, data, key) {
    lastJson = ''
    if (key === 'update' && rendered && !cvAnim && !stack.length && app.querySelector('.toolbar [data-fk="update"]')) { busy.add(key); patchUpdating() }
    else {
      lastShape = ''
      if (key) { busy.add(key); renderSafely() }
    }
    vscode.postMessage(Object.assign({ type }, data || {}))
  }

  const layer = h('div', { class: 'menu-layer' })
  document.body.append(layer)
  let menu = null

  function toggleMenu(kind, name, btn, e) {
    if (menu && menu.key === kind + ':' + name) { closeMenu(true); return }
    closeMenu(false)
    openMenu(kind, name, btn, e && e.detail === 0 ? 0 : -1)
  }
  function openMenu(kind, name, btn, focusIndex, again) {
    const a = ((state && state.accounts) || []).find((x) => x.name === name)
    const el = kind === 'settings' ? settingsMenu()
      : kind === 'ac-mode' ? modeMenu() : kind === 'ac-pick' ? pickMenu() : kind === 'ac-when' ? whenMenu() : kind === 'ac-sort' ? sortMenu() : kind === 'ac-filter' ? filterMenu()
      : !a ? null : actionsMenu(a)
    if (!el) return
    if (again) el.classList.add('still')
    layer.replaceChildren(el)
    menu = { key: kind + ':' + name, kind, name, el, btn }
    btn.setAttribute('aria-expanded', 'true')
    place()
    if (focusIndex !== null) {
      const items = el.querySelectorAll('[role^="menuitem"]')
      const target = (focusIndex >= 0 && items[Math.min(focusIndex, items.length - 1)]) || el
      target.focus({ preventScroll: true })
    }
  }
  function place() {
    if (!menu) return
    const r = menu.btn.getBoundingClientRect()
    const el = menu.el
    const vw = document.documentElement.clientWidth
    const vh = document.documentElement.clientHeight
    const w = el.offsetWidth
    const ht = el.offsetHeight
    const left = Math.max(8, Math.min(menu.kind.startsWith('ac-') ? r.left : r.right - w, vw - w - 8))
    const up = r.bottom + 6 + ht > vh - 8 && r.top - 6 - ht >= 8
    el.style.setProperty('left', left + 'px')
    el.style.setProperty('top', (up ? r.top - 6 - ht : r.bottom + 6) + 'px')
    el.classList.toggle('up', up)
  }
  function closeMenu(refocus) {
    if (!menu) return
    const m = menu
    menu = null
    m.btn.setAttribute('aria-expanded', 'false')
    layer.replaceChildren()
    lastTrigger = { el: m.btn, key: keyOf(m.btn) }
    if (refocus && document.body.contains(m.btn)) m.btn.focus({ preventScroll: true })
  }
  function reattachMenu() {
    if (!menu) return
    const btn = app.querySelector('[data-menu="' + CSS.escape(menu.key) + '"]')
    if (!btn) { closeMenu(false); return }
    const items = [...menu.el.querySelectorAll('[role^="menuitem"]')]
    const at = items.indexOf(document.activeElement)
    const { kind, name } = menu
    menu = null
    openMenu(kind, name, btn, at === -1 ? null : at, true)
  }

  function actionsMenu(a) {
    const item = (ic, text, fn, cls) => h('button', { role: 'menuitem', class: cls || null, tabindex: '-1',
      onclick: () => { closeMenu(false); fn() } }, icon(ic, 'sm'), h('span', { class: 'grow', text }))
    return h('div', { class: 'menu', role: 'menu', 'aria-label': 'Actions for ' + a.label, tabindex: '-1' },
      item('edit', 'Edit name & icon', () => openEdit(a)),
      pref('listView') === true
        ? item('pin', 'Pins for ' + a.label + (pinCount(a.name) ? ' (' + pinCount(a.name) + ')' : '') + '…', () => openPinPanel(a.name))
        : null,
      item('login', 'Sign in again', () => send('relogin', { name: a.name })),
      'pinning' in a && !pinningOk(a)
        ? item('pin', 'Add account for pinning', () => send('addPinning', { name: a.name }))
        : null,
      state.features && state.features.spareLogin
        ? item('pc', 'Make a login for another PC…', () => send('spareLogin', { name: a.name }))
        : null,
      state.features && state.features.transfer
        ? item('upload', 'Move to another PC…', () => send('moveOut', { name: a.name }))
        : null,
      state.features && state.features.keepAlive && !a.noSession
        ? h('button', { role: 'menuitemcheckbox', 'aria-checked': a.keepAlive ? 'true' : 'false', tabindex: '-1',
          title: 'Starts the next 5-hour session as soon as one ends',
          onclick: () => { closeMenu(false); send('keepAlive', { name: a.name, on: !a.keepAlive }) } },
          icon(a.keepAlive ? 'check' : 'play', 'sm'), a.keepAlive ? 'Keep alive: on' : 'Keep alive')
        : null,
      h('hr'),
      item('trash', 'Forget account', () => send('forget', { name: a.name }), 'danger'))
  }

  function settingsMenu() {
    const sw = (key, text, hint) => h('button', { role: 'menuitemcheckbox', class: 'set-row', 'aria-checked': String(!!pref(key)),
      tabindex: '-1', title: hint || null, onclick: () => send('setting', { key, value: !pref(key) }) },
      h('span', { class: 'grow', text }), h('span', { class: 'switch', 'aria-hidden': 'true', 'aria-checked': String(!!pref(key)) }))
    const choice = (key, value, text) => h('button', { role: 'menuitemradio', class: 'set-row', 'aria-checked': String(pref(key) === value),
      tabindex: '-1', onclick: () => send('setting', { key, value }) },
      icon(pref(key) === value ? 'check' : 'none', 'sm'), h('span', { class: 'grow', text }))
    const head = (text) => h('div', { class: 'hint set-head', text })
    return h('div', { class: 'menu settings', role: 'menu', 'aria-label': 'Settings', tabindex: '-1' },
      head('Cards'),
      sw('groupByOrg', 'Group by organisation', 'Folds accounts under their organisation, with a count'),
      sw('tint', 'Tint cards with their colour'),
      sw('context', 'Context usage on cards', 'The faint grid showing how full the latest chat is'),
      sw('cardToggles', 'Remote Control and Artifacts switches'),
      sw('validity', 'Show login validity around each card', 'A thin line around each card that shrinks as its main login runs out. Off: the active account’s card gets a green line instead'),
      h('hr'),
      head('Status bar'),
      sw('statusUsage', 'Usage figures'),
      sw('statusLoginDays', 'Days left on the logins', 'After the usage figures: the main login, then the pinning login, such as 29d · 16d'),
      h('hr'),
      head('Switching'),
      sw('confirmOrgSwitch', 'Ask before switching organization',
        'Chats that move to another organization lose Claude’s earlier thinking, so their next replies cost more'),
      h('hr'),
      head('Usage'),
      sw('trackAll', 'Track every account', 'Keeps saved logins renewed in the background so their figures stay up to date'),
      h('hr'),
      head('Pinning'),
      sw('askSecondLogin', 'Ask about a second login', 'After you add an account, offer a second login for pinning chats and folders'),
      h('hr'),
      head('Open Accounts in'),
      choice('accountsView', 'tab', 'An editor tab'),
      choice('accountsView', 'sidebar', 'The sidebar'),
      h('hr'),
      h('button', { role: 'menuitem', tabindex: '-1', onclick: () => { closeMenu(false); send('checkAll') } },
        icon('shield', 'sm'), 'Check everything'),
      h('button', { role: 'menuitem', tabindex: '-1', onclick: () => { closeMenu(false); startTour(TOUR) } },
        icon('info', 'sm'), 'Take the tour'),
      h('button', { role: 'menuitem', tabindex: '-1', onclick: () => { closeMenu(false); send('openConfig') } },
        icon('edit', 'sm'), 'Open settings file'))
  }

  function meter(key, title, limit, short, mini, fetchedAt) {
    const fill = h('i')
    fill.style.width = barWidth.has(key) ? barWidth.get(key) : '0%'
    fill.dataset.key = key
    const kind = /:wk$/.test(key) ? 'wk' : /:model$/.test(key) ? 'mdl' : ''
    const name = key.replace(/:(5h|wk|model)$/, '')
    const whenEl = h('div', { class: 'when' }, h('span', { class: 'dot' }), h('span', { class: 'w-long' }), h('span', { class: 'w-short' }),
      !mini && kind === 'wk' && typeof fetchedAt === 'number'
        ? [h('span', { class: 'w-sep', text: '·' }), h('span', { class: 'fresh w-fresh', 'data-acc': name, 'data-at': String(fetchedAt) }, icon('refresh', 'sm'), h('span', { class: 'ft' }))]
        : null)
    const el = h('div', { class: (mini ? 'meter mini' : 'meter') + (!mini && kind ? ' ' + kind : ''), 'data-key': key, 'data-label': mini ? title : null,
      'data-at': typeof fetchedAt === 'number' ? String(fetchedAt) : null },
      h('div', { class: 'row' },
        short ? h('span', { class: 'm-label', title }, h('span', { class: 'm-long', text: title }), h('span', { class: 'm-short', text: short }))
          : h('span', { class: 'm-label', text: title }),
        mini ? whenEl : null,
        h('span', { class: 'val' })),
      h('div', { class: 'track', role: 'progressbar', 'aria-label': title, 'aria-valuemin': '0', 'aria-valuemax': '100' }, fill),
      mini ? null : whenEl)
    fillMeter(el, limit, false)
    const fresh = el.querySelector('.fresh')
    if (fresh) paintFresh(fresh, fetchedAt)
    return el
  }
  function fillMeter(el, limit, move) {
    const pct = limit ? limit.percent : null
    const fill = el.querySelector('.track > i')
    fill.className = pct === null ? '' : pct >= 100 ? 'bad' : pct >= 90 ? 'warn' : ''
    el.classList.toggle('near', pct !== null && pct >= 90 && pct < 100)
    el.classList.toggle('out', pct !== null && pct >= 100)
    const target = (pct === null ? 0 : Math.min(100, Math.max(0, pct))) + '%'
    fill.dataset.target = target
    if (move) { fill.style.width = target; barWidth.set(fill.dataset.key, target) }
    el.querySelector('.val').textContent = pct === null ? '' : pct + '%'
    const track = el.querySelector('.track')
    if (pct === null) track.removeAttribute('aria-valuenow')
    else track.setAttribute('aria-valuenow', String(pct))
    const when = el.querySelector('.when')
    when.setAttribute('data-when', limit ? JSON.stringify(limit) : '')
    setWhen(when, limit)
  }
  function meterSpecs(a, list) {
    if (a.needsLogin) return []
    if (list) {
      return [a.noSession ? null : [a.name + ':5h', '5h Session', a.session, '5h'],
        a.scoped ? [a.name + ':model', modelName(a.scoped) + ' limit', a.scoped, modelName(a.scoped)] : null,
        [a.name + ':wk', 'Weekly, all models', a.weekly, 'W', a.fetchedAtMs]].filter(Boolean)
    }
    return [
      a.noSession ? null : [a.name + ':5h', '5h Session', a.session, '5h'],
      a.scoped || a.noSession ? [a.name + ':model', modelName(a.scoped), a.scoped] : null,
      [a.name + ':wk', 'Weekly', a.weekly, undefined, a.fetchedAtMs],
    ].filter(Boolean)
  }
  function patchMeters() {
    const els = app.querySelectorAll('.meter[data-key]')
    const lay = layoutOf()
    if (lay.drawn.map((a) => a.name).join('|') !== lastDrawn) return false
    const specs = new Map(lay.drawn.flatMap((a) => meterSpecs(a, pref('listView') === true)).map((m) => [m[0], m]))
    if (els.length !== specs.size) return false
    for (const el of els) if (!specs.has(el.dataset.key)) return false
    for (const el of els) {
      const spec = specs.get(el.dataset.key)
      if (typeof spec[4] === 'number') el.dataset.at = String(spec[4])
      fillMeter(el, spec[2], true)
    }
    paintNotes()
    patchStrips(lay.drawn)
    patchUpdating()
    fitWhens()
    const row = app.querySelector('.this-chat')
    if (row) row.replaceWith(thisChat() || document.createComment(''))
    return true
  }
  function patchStrips(drawn) {
    const had = document.activeElement && app.contains(document.activeElement) ? keyOf(document.activeElement) : null
    for (const a of drawn) {
      const card = app.querySelector('[data-acc="' + CSS.escape(a.name) + '"].card')
      if (!card) continue
      const old = card.querySelector(':scope > .u-notes')
      const next = usageNotes(a)
      if (old && next && old.outerHTML === next.outerHTML) continue
      if (old && next) old.replaceWith(next)
      else if (old) old.remove()
      else if (next) card.append(next)
    }
    if (had && !app.contains(document.activeElement)) {
      const again = app.querySelector('[data-fk="' + CSS.escape(had) + '"]')
      if (again) again.focus({ preventScroll: true })
    }
  }
  function patchUpdating() {
    const btn = app.querySelector('.toolbar [data-fk="update"]')
    if (!btn) return
    const updating = !!(state.updating || busy.has('update'))
    if (btn.disabled === updating) return
    btn.disabled = updating
    btn.title = updating ? 'Updating…' : 'Update usage'
    btn.setAttribute('aria-label', btn.title)
    btn.replaceChildren(icon('refresh', updating ? 'sm spin' : 'sm'))
  }
  function paintNotes() {
    const byName = new Map((state.accounts || []).map((a) => [a.name, a]))
    app.querySelectorAll('.fresh[data-acc]').forEach((el) => {
      const a = byName.get(el.dataset.acc)
      if (a && typeof a.fetchedAtMs === 'number') paintFresh(el, a.fetchedAtMs)
    })
    app.querySelectorAll('.u-hint[data-acc]').forEach((el) => {
      const hint = weeklyHint(byName.get(el.dataset.acc))
      if (hint) { el.querySelector('.u-text').textContent = hintText(hint); el.title = hintFull(hint) }
    })
  }

  function loginWords(main, pin) {
    const one = (name, at) => { const left = loginLeft(at); return left ? name + (left.level === 'bad' ? ': ended.' : ': ' + left.text + ' left.') : null }
    return [typeof main === 'number' ? one('Main login', main) : null,
      pin === null ? null : pin === '' ? 'No pinning login.' : one('Pinning login', pin)].filter(Boolean).join(' ')
  }
  const pinField = (a) => (!('pinning' in a) ? null : a.pinning ? a.pinning.expiresAt : '')

  const SVGNS = 'http://www.w3.org/2000/svg'
  const FULL_DAYS = 30
  const STROKE = 1
  function svgEl(tag, cls) { const e = document.createElementNS(SVGNS, tag); if (cls) e.setAttribute('class', cls); return e }
  function validityStroke(a) {
    if (typeof a.loginExpiresAt !== 'number') return null
    const svg = svgEl('svg', 'vstroke')
    svg.setAttribute('aria-hidden', 'true')
    svg.dataset.main = String(a.loginExpiresAt)
    svg.append(svgEl('rect', 'vs-line'))
    return svg
  }
  function drawStroke(svg) {
    const box = { width: svg.clientWidth, height: svg.clientHeight }
    if (!box.width || !box.height) { const r = svg.getBoundingClientRect(); box.width = r.width; box.height = r.height }
    if (!box.width || !box.height) return
    const rect = svg.querySelector('rect')
    if (!rect) return
    const R = 16
    const inset = STROKE / 2
    const w = box.width - 2 * inset
    const ht = box.height - 2 * inset
    const rx = Math.max(0, R - inset)
    for (const [k, v] of [['x', inset], ['y', inset], ['width', w], ['height', ht], ['rx', rx], ['stroke-width', STROKE]]) rect.setAttribute(k, String(v))
    const until = Number(svg.dataset.main)
    const left = until ? until - now() : NaN
    if (!svg.dataset.drawn) { svg.dataset.drawn = '1'; rect.style.transition = 'none'; requestAnimationFrame(() => requestAnimationFrame(() => rect.style.removeProperty('transition'))) }
    if (until > 0) rect.style.setProperty('--vs', validityColour(until))
    else rect.style.removeProperty('--vs')
    const P = 2 * (w - 2 * rx) + 2 * (ht - 2 * rx) + 2 * Math.PI * rx
    const f = left > 0 ? Math.min(1, left / (FULL_DAYS * DAY)) : 0
    rect.setAttribute('visibility', f > 0 ? 'visible' : 'hidden')
    rect.setAttribute('stroke-dasharray', f * P + ' ' + (1 - f) * P)
    rect.setAttribute('stroke-dashoffset', String(P - (w / 2 - rx)))
  }
  const strokeSizes = typeof ResizeObserver === 'function' ? new ResizeObserver((all) => { for (const e of all) drawStroke(e.target) }) : null

  const VALIDITY_STOPS = [[0, [36, 0, 55]], [0.6, [36, 92, 40]], [1, [0, 72, 40]]]
  function validityColour(until) {
    const used = Math.min(1, Math.max(0, 1 - (until - now()) / (FULL_DAYS * DAY)))
    const t = used <= 0.5 ? 0 : (used - 0.5) / 0.5
    let i = 0
    while (i < VALIDITY_STOPS.length - 2 && t > VALIDITY_STOPS[i + 1][0]) i++
    const [t0, a] = VALIDITY_STOPS[i]
    const [t1, b] = VALIDITY_STOPS[i + 1]
    const k = (t - t0) / (t1 - t0)
    const at = (j) => (a[j] + (b[j] - a[j]) * k).toFixed(1)
    return 'hsl(' + at(0) + ' ' + at(1) + '% ' + at(2) + '%)'
  }

  function toggle(label, short, on, aria, onChange) {
    const sw = h('button', { class: 'switch', role: 'switch', 'aria-checked': String(on), 'aria-label': aria, 'data-fk': 'sw:' + aria })
    sw.addEventListener('click', () => {
      const next = sw.getAttribute('aria-checked') !== 'true'
      sw.setAttribute('aria-checked', String(next))
      onChange(next)
    })
    return h('span', { class: 'toggle' },
      h('span', { class: short ? 'tl has-short' : 'tl', title: short ? label : null, onclick: () => sw.click() },
        h('span', { class: 'long', text: label }), short ? h('span', { class: 'short', text: short }) : null),
      sw)
  }

  function orgText(org) {
    return org && !/'s Organization$/.test(org) ? org : null
  }

  function plantIcon(kind) {
    const el = icon(SVG['plant-' + kind] ? 'plant-' + kind : 'plant-free', 'plant')
    el.setAttribute('viewBox', '0 3 24 18')
    return el
  }

  function planBadge(plan) {
    if (!plan) return null
    const kind = /^(Team|Enterprise)/.test(plan) ? 'team' : String(plan).toLowerCase()
    return h('span', { class: 'plan-badge', title: plan + ' plan' },
      plantIcon(kind), h('span', { text: plan }))
  }

  function fitBadges() {
    for (const row of app.querySelectorAll('.name-row')) {
      const name = row.querySelector('.name')
      if (!name || !row.querySelector('.plan-badge')) continue
      row.classList.remove('compact')
      if (name.scrollWidth > name.clientWidth) row.classList.add('compact')
    }
  }

  const orgLabel = (a) => orgText(a.org) || 'Personal'
  let groupOf = new Map()
  function refreshGroups(accounts) {
    const n = new Map()
    for (const a of accounts) n.set(orgLabel(a), (n.get(orgLabel(a)) || 0) + 1)
    groupOf = new Map(accounts.map((a) => [a.name, n.get(orgLabel(a)) > 1 ? orgLabel(a) : 'Others']))
  }
  const grpName = (a) => groupOf.get(a.name) || orgLabel(a)
  const groupRank = (g) => (g === 'Others' ? 2 : g === 'Personal' ? 1 : 0)
  const SORTS = [
    ['order', 'Your order', 'sort-order', 'Pick it to drag accounts into place'],
    ['session', 'Most session limits', 'hourglass', ''],
    ['weekly', 'Most weekly limits', 'calendar', ''],
    ['reset', 'Soonest reset', 'timer-reset', ''],
    ['name', 'A → Z', 'sort-az', ''],
  ]
  const sortOf = () => SORTS.find((x) => x[0] === find.sort) || SORTS[0]
  const sortLabel = () => sortOf()[1]
  function sortMenu() {
    const m = h('div', { class: 'menu choices-menu sort-menu', role: 'menu', 'aria-label': 'Sort accounts', tabindex: '-1' },
      SORTS.map(([v, title, ic, tip]) => h('button', { role: 'menuitemradio', 'aria-checked': String(v === find.sort), tabindex: '-1',
        title: tip ? (v === find.sort ? 'Drag cards or rows to change it' : tip) : null,
        onclick: () => { closeMenu(false); find.sort = v; renderSafely() } },
      h('span', { class: 'mi-check' }, v === find.sort ? icon('check', 'sm') : null),
      icon(ic, 'sm'), h('span', { class: 'grow mi-name', text: title }))))
    m.append(h('hr'), h('button', { role: 'menuitem', tabindex: '-1', onclick: () => { closeMenu(false); reorderDialog() } },
      h('span', { class: 'mi-check' }), icon('grip', 'sm'), h('span', { class: 'grow', text: 'Reorder accounts…' })))
    return m
  }
  function filterMenu() {
    const opts = filterOptions((state && state.accounts) || [])
    const row = ([k, text, n]) => h('button', { role: 'menuitemradio', 'aria-checked': String(find.filter === k), tabindex: '-1',
      onclick: () => { closeMenu(false); find.filter = k; renderSafely() } },
    h('span', { class: 'mi-check' }, find.filter === k ? icon('check', 'sm') : null),
    h('span', { class: 'grow mi-name', text }), h('span', { class: 'mi-n', text: String(n) }))
    const kids = []
    opts.forEach((o, i) => {
      if (i && (o[0] === 'pin' ? false : o[0].startsWith('org:') && !opts[i - 1][0].startsWith('org:'))) kids.push(h('hr'))
      kids.push(row(o))
    })
    return h('div', { class: 'menu choices-menu filter-menu', role: 'menu', 'aria-label': 'Filter accounts', tabindex: '-1' }, kids)
  }

  function used(a, which) {
    const l = a[which]
    if (l) return l.percent
    return a.session || a.weekly ? 0 : 100
  }
  function nextReset(a) {
    const ts = [a.session, a.weekly].filter((l) => l && l.resetsAt).map((l) => Date.parse(l.resetsAt)).filter((t) => t > now())
    return ts.length ? Math.min(...ts) : Infinity
  }
  function sortKey(a, key) {
    switch (key) {
      case 'session': return used(a, 'session')
      case 'weekly': return used(a, 'weekly')
      case 'reset': return nextReset(a)
      case 'name': return String(a.label).toLowerCase()
      default: return 0
    }
  }
  function matches(a) {
    const q = find.q.trim().toLowerCase()
    if (q && ![a.label, a.name, a.email, a.org, orgLabel(a)].some((x) => x && String(x).toLowerCase().includes(q))) return false
    if (find.filter === 'pin') return pinningOk(a)
    if (find.filter === 'nopin') return !pinningOk(a)
    if (find.filter.startsWith('org:')) return grpName(a) === find.filter.slice(4)
    return true
  }
  function layoutOf() {
    const all = (state && state.accounts) || []
    refreshGroups(all)
    const at = new Map(all.map((a, i) => [a, i]))
    let list = all.filter(matches)
    if (find.sort !== 'order') {
      list.sort((x, y) => {
        if (!!x.needsLogin !== !!y.needsLogin) return x.needsLogin ? 1 : -1
        const kx = sortKey(x, find.sort)
        const ky = sortKey(y, find.sort)
        const c = typeof kx === 'string' ? kx.localeCompare(ky, undefined, { numeric: true, sensitivity: 'base' }) : kx === ky ? 0 : kx < ky ? -1 : 1
        return c || at.get(x) - at.get(y)
      })
    }
    list = [...list.filter((a) => a.active), ...list.filter((a) => !a.active)]
    if (pref('groupByOrg') !== true) return { list, groups: null, drawn: list }
    const by = new Map()
    for (const a of list) { const k = grpName(a); if (!by.has(k)) by.set(k, []); by.get(k).push(a) }
    const groups = [...by].map(([name, items]) => ({ name, items }))
    groups.sort((x, y) => (y.items.some((a) => a.active) - x.items.some((a) => a.active)) ||
      (groupRank(x.name) - groupRank(y.name)) || x.name.localeCompare(y.name, undefined, { sensitivity: 'base' }))
    const folded = (g) => collapsed.has(g.name) && !find.q.trim()
    return { list, groups, drawn: groups.filter((g) => !folded(g)).flatMap((g) => g.items) }
  }
  let lastDrawn = ''

  function filterOptions(accounts) {
    refreshGroups(accounts)
    const count = (fn) => accounts.filter(fn).length
    const list = [['all', 'All', accounts.length]]
    if (accounts.some((a) => 'pinning' in a)) list.push(['pin', 'Has a pinning login', count(pinningOk)], ['nopin', 'Needs a pinning login', count((a) => !pinningOk(a))])
    const orgs = [...new Set(accounts.map(grpName))].sort((x, y) => (groupRank(x) - groupRank(y)) || x.localeCompare(y, undefined, { sensitivity: 'base' }))
    if (orgs.length > 1) for (const o of orgs) list.push(['org:' + o, o, count((a) => grpName(a) === o)])
    return list
  }

  function paintSearch() {
    const t = app.querySelector('.tools')
    if (t) t.classList.toggle('s-open', find.searchOpen || !!find.q.trim())
  }
  function closeSearch() {
    find.q = ''
    find.searchOpen = false
    const input = app.querySelector('.find-input')
    if (input) input.value = ''
    drawResults()
    paintSearch()
  }
  function viewButton() {
    const list = pref('listView') === true
    const what = list ? 'Show as cards' : 'Show as a list'
    return h('button', { class: 'btn soft tool-btn icon-only view-toggle', 'data-fk': 'viewToggle', title: what, 'aria-label': what,
      onclick: () => send('setting', { key: 'listView', value: !list }) }, icon(list ? 'grid' : 'list', 'sm'))
  }
  function tools(accounts) {
    const opts = filterOptions(accounts)
    if (!opts.some((o) => o[0] === find.filter)) find.filter = 'all'
    const finder = accounts.length >= 4 || find.q || find.filter !== 'all'
    const cur = opts.find((o) => o[0] === find.filter)
    const on = find.filter !== 'all'
    const input = h('input', { class: 'find-input', type: 'search', placeholder: searchHint(),
      'aria-label': 'Search accounts by name, email or organisation', 'data-fk': 'find:q', value: find.q, autocomplete: 'off', spellcheck: 'false',
      oninput: () => { find.q = input.value; drawResults(); paintSearch() },
      onsearch: () => { if (!input.value && find.q) closeSearch() },
      onblur: () => { if (!input.value && find.searchOpen) { find.searchOpen = false; paintSearch() } },
      onkeydown: (e) => {
        if (e.key !== 'Escape' || !(find.searchOpen || find.q)) return
        e.preventDefault()
        closeSearch()
        const btn = app.querySelector('.t-search-btn')
        if (btn && btn.offsetParent) btn.focus({ preventScroll: true })
      } })
    const searchBtn = h('button', { class: 'btn soft tool-btn icon-only t-search-btn', 'data-fk': 'find:open', title: 'Search accounts', 'aria-label': 'Search accounts',
      onclick: () => { find.searchOpen = true; paintSearch(); input.focus() } }, icon('search', 'sm'))
    const menuBtn = (cls, kind, ic, text, label) => h('button', { class: 'btn soft tool-btn ' + cls, 'data-menu': kind + ':x', 'aria-haspopup': 'menu', 'aria-expanded': 'false',
      title: label, 'aria-label': label, onclick: (e) => toggleMenu(kind, 'x', e.currentTarget, e) },
    icon(ic, 'sm'), h('span', { class: 'tb-text', text }), cls.includes('t-filter') && on ? h('span', { class: 'f-dot', 'aria-hidden': 'true' }) : null)
    return h('div', { class: 'tools' + (find.searchOpen || find.q.trim() ? ' s-open' : '') + (finder ? '' : ' bare') },
      h('div', { class: 'tools-in' },
        finder ? [h('div', { class: 't-search' }, searchBtn, input),
          menuBtn('t-filter' + (on ? ' on' : ''), 'ac-filter', 'filter', on ? cur[1] : 'Filter',
            'Filter accounts, now: ' + cur[1] + (on ? ' (' + cur[2] + ')' : '')),
          h('button', { class: 'btn soft tool-btn icon-only t-sort', 'data-menu': 'ac-sort:x', 'aria-haspopup': 'menu', 'aria-expanded': 'false',
            title: 'Sort: ' + sortLabel(), 'aria-label': 'Sort: ' + sortLabel(), onclick: (e) => toggleMenu('ac-sort', 'x', e.currentTarget, e) },
          icon(sortOf()[2], 'sm'))] : null,
        compactButton(), viewButton(),
        h('div', { class: 't-pins' },
          headPinButton('pinChat', 'Pin a chat to an account', 'chat', () => send('pinChat')),
          headPinButton('pinFolder', 'Pin a folder to an account', 'folder', () => send('pin')))))
  }

  function weeklyHint(a) {
    const w = a && a.weekly
    if (!a || a.needsLogin || !w || !w.resetsAt) return null
    const left = Date.parse(w.resetsAt) - now()
    const unused = 100 - w.percent
    return left > 0 && left <= DAY && unused > 40 ? { unused, left } : null
  }
  function hintDur(hint) {
    const hrs = Math.round(hint.left / 3600000)
    return hrs < 1 ? Math.max(1, Math.round(hint.left / 60000)) + ' min' : hrs + ' h'
  }
  function hintText(hint) { return hint.unused + '% weekly unused, reset: ' + hintDur(hint) }
  function hintFull(hint) {
    return hint.unused + '% of this week’s allowance is unused and it resets in ' + hintDur(hint) + ', so now is a good time to use it'
  }
  function money(n) { return Number.isInteger(n) ? String(n) : n.toFixed(2) }
  const noteStamp = {
    hint: (a) => 'wk:' + ((a.weekly && a.weekly.resetsAt) || ''),
    extra: (a) => { const d = new Date(now()); return 'mo:' + d.getFullYear() + '-' + (d.getMonth() + 1) + (a.extra.used >= a.extra.limit ? ':full' : '') },
  }
  const noteHidden = (a, kind) => { const d = pref('dismissedNotes'); return !!(d && typeof d === 'object' && d[a.name + ':' + kind] === noteStamp[kind](a)) }
  function dismissNote(a, kind) {
    const d = Object.assign({}, pref('dismissedNotes') || {})
    d[a.name + ':' + kind] = noteStamp[kind](a)
    if (state) state.prefs = Object.assign({}, state.prefs, { dismissedNotes: d })
    send('setting', { key: 'dismissedNotes', value: d })
    const fromKeys = document.activeElement && document.activeElement.classList.contains('u-x')
    renderSafely()
    if (fromKeys) {
      const card = app.querySelector('[data-acc="' + CSS.escape(a.name) + '"].card')
      const next = card && (card.querySelector('.u-x') || card.querySelector('.card-foot button:not([disabled])'))
      if (next) next.focus({ preventScroll: true })
    }
  }
  function usageNotes(a) {
    if (a.needsLogin) return null
    const hint = weeklyHint(a)
    const x = a.extra && typeof a.extra.used === 'number' && typeof a.extra.limit === 'number' ? a.extra : null
    const cur = (x && x.currency) || '$'
    const showHint = hint && !noteHidden(a, 'hint')
    const showX = x && !noteHidden(a, 'extra')
    if (!showHint && !showX) return null
    const strip = (cls, kind, ic, text, full) => h('div', { class: 'u-line ' + cls, 'data-acc': kind === 'hint' ? a.name : null, title: full },
      icon(ic, 'sm'), h('span', { class: 'u-text', text }),
      h('button', { class: 'u-x', 'data-fk': 'note-x:' + kind + ':' + a.name, title: 'Hide', 'aria-label': 'Hide this note for ' + a.label,
        onclick: () => dismissNote(a, kind), onkeydown: (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); dismissNote(a, kind) } } },
      icon('x', 'sm')))
    const out = x && x.used >= x.limit
    return h('div', { class: 'u-notes' },
      showHint ? strip('u-hint', 'hint', 'sparkle', hintText(hint), hintFull(hint)) : null,
      showX ? strip('u-extra' + (out ? ' full' : ''), 'extra', 'zap', 'Extra usage: ' + cur + money(x.used) + '/' + money(x.limit) + (out ? ' · used up' : ''),
        'Extra usage this month: ' + cur + money(x.used) + ' of ' + cur + money(x.limit) + (out ? ', used up' : '')) : null)
  }

  function thisChat() {
    const c = state && state.thisChat
    if (!c) return null
    if (c.kind === 'unsure') {
      return h('div', { class: 'this-chat unsure', role: 'status' }, icon('help', 'sm'),
        h('div', { class: 'tc-text' }, h('strong', { text: 'This chat: can’t tell which account it uses' }),
          h('span', { class: 'tc-sub', text: 'Two chats share this title. Rename one and this row knows.', title: c.title || null })))
    }
    const a = accountByName(c.name)
    if (!a) return null
    const bits = []
    const lim = (name, l) => { if (l) bits.push(isOut(l) ? name + ' out until ' + clockText(Date.parse(l.resetsAt)) : name + ' ' + l.percent + '%') }
    if (!a.needsLogin) { if (!a.noSession) lim('5h', a.session); lim('Weekly', a.weekly) }
    return h('div', { class: 'this-chat', role: 'status', style: { '--hue': hueOf(a) } }, avatar(a, 'avatar sm'),
      h('div', { class: 'tc-text' },
        h('span', { class: 'tc-line' }, h('span', { text: 'This chat: ' }), h('strong', { text: (c.via === 'folder' ? 'folder pinned to ' : 'pinned to ') + a.label })),
        bits.length ? h('span', { class: 'tc-nums', text: bits.join(' · ') }) : null))
  }

  function activeMark(cls) {
    return h('button', { class: cls + ' active-mark', disabled: true, title: 'This is the active account', 'aria-label': 'Active account' },
      icon('circle-check', 'sm'), h('span', { class: 'btn-text', text: 'Active' }))
  }
  function listRow(a) {
    const switching = busy.has('switch:' + a.name)
    const named = a.label + (a.active ? ' (active account)' : '')
    const org = orgText(a.org)
    const days = loginWords(a.loginExpiresAt, pinField(a))
    const sw = a.active ? activeMark('btn sm l-switch')
      : a.needsLogin
        ? h('button', { class: 'btn soft sm l-switch signin-btn', 'data-fk': 'signin:' + a.name, title: 'Sign in again', 'aria-label': 'Sign in again to ' + a.label,
        onclick: () => send('relogin', { name: a.name }) }, icon('signin', 'sm'), h('span', { class: 'btn-text', text: 'Sign in' }))
      : h('button', { class: 'btn primary sm l-switch', disabled: switching || null, 'data-fk': 'switch:' + a.name, title: 'Switch to ' + a.label,
        'aria-label': (switching ? 'Switching to ' : 'Switch to ') + a.label, onclick: () => requestSwitch(a) },
      icon(switching ? 'refresh' : 'swap', switching ? 'sm spin' : 'sm'), h('span', { class: 'btn-text', text: switching ? 'Switching…' : 'Switch' }))
    const more = h('button', { class: 'icon-btn', 'data-menu': 'actions:' + a.name, title: 'More actions', 'aria-label': 'More actions for ' + a.label,
      'aria-haspopup': 'menu', 'aria-expanded': 'false', onclick: (e) => { e.stopPropagation(); toggleMenu('actions', a.name, e.currentTarget, e) } }, icon('kebab'))
    const bars = meterSpecs(a, true).map((m) => meter(m[0], m[1], m[2], m[3], true, m[4]))
    return sortable(h('article', { class: 'lrow' + (a.active ? ' live' : '') + (a.needsLogin ? ' ended' : '') + (pref('tint') ? ' tinted' : ''), style: { '--hue': hueOf(a) },
      'aria-label': named, 'data-acc': a.name },
    h('div', { class: 'l-id' }, avatar(a, 'avatar sm'),
      h('div', { class: 'l-name' },
        h('div', { class: 'name-row' }, planBadge(a.plan), h('span', { class: 'name', text: a.label, title: [a.email, org, days].filter(Boolean).join('\n') || null })),
        org ? h('span', { class: 'sub', text: org }) : null)),
    a.needsLogin ? h('div', { class: 'l-ended' }, icon('alert', 'sm'), h('span', { text: 'Login ended' }))
      : h('div', { class: 'l-bars' }, bars),
    h('div', { class: 'l-act' }, sw, more)), a)
  }

  const canReorder = (a) => find.sort === 'order' && !a.active && ((state && state.accounts) || []).length > 2
  function sortable(el, a) {
    if (!canReorder(a)) return el
    el.classList.add('sortable')
    el.setAttribute('aria-keyshortcuts', 'Alt+ArrowUp Alt+ArrowDown')
    return el
  }
  const saveOrder = (names) => send('setting', { key: 'accountOrder', value: names })
  function moveAccount(name, target, after) {
    const names = ((state && state.accounts) || []).map((a) => a.name)
    const from = names.indexOf(name)
    if (from < 0 || name === target) return false
    names.splice(from, 1)
    const at = names.indexOf(target)
    if (at < 0) return false
    names.splice(after ? at + 1 : at, 0, name)
    saveOrder(names)
    return names.indexOf(name) + 1
  }
  let liveRegion = null
  function say(text) {
    if (!liveRegion) { liveRegion = h('div', { class: 'sr', role: 'status', 'aria-live': 'polite' }); document.body.append(liveRegion) }
    liveRegion.textContent = ''
    setTimeout(() => { liveRegion.textContent = text }, 30)
  }
  function emptyArea(t) {
    if (!(t instanceof Element)) return false
    if (t.closest('button, a, input, select, textarea, label, summary, [role="switch"], .switch, .toggle, .menu, [data-menu]')) return false
    for (const n of t.childNodes) if (n.nodeType === 3 && n.nodeValue.trim()) return false
    return true
  }
  const reduceMotion = () => !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches)
  let press = null
  let drag = null
  const DRAG_PX = 5
  function slotsOf(items) {
    return items.map((el) => { const r = el.getBoundingClientRect(); return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height } })
  }
  function slotAfter(slots, from, to) {
    const column = slots.every((p) => Math.abs(p.x - slots[0].x) < 2)
    const order = slots.map((_, i) => i)
    order.splice(to, 0, order.splice(from, 1)[0])
    const at = new Map()
    if (column) {
      let y = slots[0].y
      order.forEach((i, j) => {
        at.set(i, { x: slots[0].x, y })
        const next = slots[j + 1]
        y += slots[i].h + (next ? Math.max(0, next.y - (slots[j].y + slots[j].h)) : 0)
      })
    } else order.forEach((i, j) => at.set(i, { x: slots[j].x, y: slots[j].y }))
    return at
  }
  const SLIDE_MS = 350
  const SLIDE_PAGE = '[data-acc].card, [data-acc].lrow, .pin-row[data-sk]'
  const slideKey = (el) => el.dataset.sk || (el.classList.contains('lrow') ? 'row:' : 'card:') + el.dataset.acc
  function slideCapture(root, sel) {
    if (reduceMotion() || cvAnim || cvPending || document.documentElement.classList.contains('cv-anim')) return null
    const map = new Map()
    root.querySelectorAll(sel).forEach((el) => { if (!el.classList.contains('slide-ghost')) map.set(slideKey(el), { r: el.getBoundingClientRect(), el }) })
    return { map, w: root.clientWidth }
  }
  function slideRun(root, sel, before) {
    if (!before || !before.map.size || before.w !== root.clientWidth || reduceMotion()) return
    const keys = [...root.querySelectorAll(sel)].filter((el) => !el.classList.contains('slide-ghost')).map(slideKey)
    const was0 = [...before.map.keys()]
    if (keys.length === was0.length && keys.every((k, i) => k === was0[i])) return
    const moved = []
    const born = []
    const kept = new Set()
    let home = null
    root.querySelectorAll(sel).forEach((el) => {
      if (el.classList.contains('slide-ghost')) return
      home = home || el.parentElement
      const key = slideKey(el)
      const was = before.map.get(key)
      if (!was) { born.push(el); return }
      kept.add(key)
      const r = el.getBoundingClientRect()
      const dx = was.r.left - r.left
      const dy = was.r.top - r.top
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return
      tilt(el, dx, dy)
      const at = keys.indexOf(key)
      if (at < was0.indexOf(key)) el.classList.add(at === 0 ? 'slide-lead' : 'slide-up')
      moved.push(el)
    })
    const gone = []
    if (kept.size && home) {
      before.map.forEach(({ r, el }, key) => {
        if (kept.has(key) || el.isConnected) return
        const g = el.cloneNode(true)
        g.classList.add('slide-ghost')
        g.classList.remove('sliding', 'shifting', 'settling', 'dragging')
        g.removeAttribute('data-acc'); g.removeAttribute('data-sk'); g.removeAttribute('id')
        g.querySelectorAll('[id], [data-fk], [data-menu]').forEach((x) => { x.removeAttribute('id'); x.removeAttribute('data-fk'); x.removeAttribute('data-menu') })
        g.setAttribute('aria-hidden', 'true'); g.inert = true
        g.style.cssText = 'position:absolute;margin:0;pointer-events:none;width:' + r.width + 'px;height:' + r.height + 'px;left:0;top:0'
        home.append(g)
        const o = g.getBoundingClientRect()
        g.style.left = (r.left - o.left) + 'px'
        g.style.top = (r.top - o.top) + 'px'
        gone.push(g)
      })
    }
    if (!moved.length && !born.length && !gone.length) return
    born.forEach((el) => { el.style.opacity = '0' })
    document.body.getBoundingClientRect()
    requestAnimationFrame(() => {
      moved.concat(born).forEach((el) => { el.classList.add('sliding'); el.style.transform = ''; el.style.opacity = '' })
      gone.forEach((g) => { g.classList.add('sliding'); g.style.opacity = '0' })
      setTimeout(() => {
        moved.concat(born).forEach((el) => el.classList.remove('sliding', 'slide-lead', 'slide-up'))
        gone.forEach((g) => g.remove())
      }, SLIDE_MS + 50)
    })
  }
  const tilt = (el, x, y, extra) => { el.style.transform = x || y || extra ? 'translate(' + Math.round(x) + 'px,' + Math.round(y) + 'px)' + (extra || '') : '' }
  function dragUpdate() {
    const d = drag
    if (!d || !d.art.isConnected) return
    const px = d.x + scrollX
    const py = d.y + scrollY
    const own = d.slots[d.from]
    const area = d.art.parentElement.getBoundingClientRect()
    const grow = own.w * 0.01
    const left = own.x - scrollX
    const lo = area.left + grow - left
    const hi = area.right - grow - (left + own.w)
    const dx = lo > hi ? 0 : Math.min(Math.max(px - d.px0, lo), hi)
    tilt(d.art, dx, py - d.py0, ' scale(1.02)')
    let best = d.to
    let bestDist = Infinity
    d.slots.forEach((p, i) => {
      if (i < d.min) return
      const dist = Math.hypot(px - (p.x + p.w / 2), py - (p.y + p.h / 2))
      if (dist < bestDist) { best = i; bestDist = dist }
    })
    d.to = best
    const at = slotAfter(d.slots, d.from, d.to)
    d.items.forEach((el, i) => {
      if (el === d.art) return
      const p = at.get(i)
      const own = d.slots[i]
      tilt(el, p.x - own.x, p.y - own.y)
    })
  }
  function dragClean(items) {
    const done = () => items.forEach((el) => { el.classList.remove('shifting', 'dragging', 'settling'); el.style.transform = '' })
    if (reduceMotion()) return done()
    setTimeout(done, SLIDE_MS + 50)
  }
  function endDrag(drop) {
    if (!drag) return
    const d = drag
    drag = null
    clearInterval(d.timer)
    document.body.classList.remove('dragging-acc')
    if (!d.art.isConnected) return
    d.art.classList.remove('dragging')
    d.art.classList.add('settling')
    if (drop && d.to !== d.from) {
      const at = slotAfter(d.slots, d.from, d.to).get(d.from)
      tilt(d.art, at.x - d.slots[d.from].x, at.y - d.slots[d.from].y)
      moveAccount(d.art.dataset.acc, d.items[d.to].dataset.acc, d.to > d.from)
    } else d.items.forEach((el) => { el.style.transform = '' })
    dragClean(d.items)
  }
  app.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.pointerType === 'touch') return
    const art = e.target.closest && e.target.closest('.sortable[data-acc]')
    if (!art || !emptyArea(e.target)) return
    e.preventDefault()
    press = { art, x: e.clientX, y: e.clientY }
  })
  document.addEventListener('pointermove', (e) => {
    if (press && !drag && Math.hypot(e.clientX - press.x, e.clientY - press.y) >= DRAG_PX) {
      const art = press.art
      const items = [...art.parentElement.children].filter((el) => el.dataset && el.dataset.acc)
      const slots = slotsOf(items)
      const from = items.indexOf(art)
      const first = accountByName(items[0].dataset.acc)
      drag = { art, items, slots, from, to: from, min: first && first.active ? 1 : 0, x: e.clientX, y: e.clientY,
        px0: press.x + scrollX, py0: press.y + scrollY, timer: setInterval(() => {
          const vh = document.documentElement.clientHeight
          if (drag.y < 40) window.scrollBy(0, -12)
          else if (drag.y > vh - 40) window.scrollBy(0, 12)
          else return
          dragUpdate()
        }, 30) }
      items.forEach((el) => el.classList.add(el === art ? 'dragging' : 'shifting'))
      document.body.classList.add('dragging-acc')
      closeMenu(false)
    }
    if (!drag) return
    drag.x = e.clientX
    drag.y = e.clientY
    dragUpdate()
  })
  document.addEventListener('pointerup', () => { press = null; endDrag(true) })
  document.addEventListener('pointercancel', () => { press = null; endDrag(false) })
  document.addEventListener('keydown', (e) => { if (drag && e.key === 'Escape') { e.preventDefault(); press = null; endDrag(false) } })
  app.addEventListener('keydown', (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return
    const art = e.target.closest && e.target.closest('.sortable[data-acc]')
    if (!art) return
    e.preventDefault()
    const drawn = layoutOf().drawn
    const at = drawn.findIndex((a) => a.name === art.dataset.acc)
    const next = drawn[at + (e.key === 'ArrowUp' ? -1 : 1)]
    if (at < 0 || !next || next.active) return
    const label = (accountByName(art.dataset.acc) || {}).label || art.dataset.acc
    const pos = moveAccount(art.dataset.acc, next.name, e.key === 'ArrowDown')
    if (pos) say(label + ' moved to place ' + pos + ' of ' + ((state && state.accounts) || []).length)
  })

  function reorderDialog() {
    const accounts = (state && state.accounts) || []
    const active = accounts.find((a) => a.active)
    let order = accounts.filter((a) => !a.active).map((a) => a.name)
    let dragging = null
    const tid = uid()
    const list = h('div', { class: 'order-list plain' })
    const move = (from, to) => { order.splice(to, 0, order.splice(from, 1)[0]); draw() }
    const draw = () => {
      const row = (a, i) => {
        const fixed = i === null
        const r = h('div', { class: 'order-row' + (fixed ? ' off' : '') + (pref('tint') ? ' tinted' : ''), style: { '--hue': hueOf(a) }, 'data-sk': 'ro:' + a.name, draggable: fixed ? null : 'true' },
          h('span', { class: 'grip', title: fixed ? null : 'Drag to reorder' }, fixed ? null : icon('grip', 'sm')),
          h('span', { class: 'rank', text: fixed ? '' : String(i + 1) }),
          avatar(a, 'avatar sm'),
          h('div', { class: 'grow' }, h('span', { class: 'nm', text: a.label }), fixed ? h('span', { class: 'who', text: 'in use now, always shown first' }) : null),
          fixed ? null : h('button', { class: 'icon-btn order-move', title: 'Earlier', 'aria-label': 'Move ' + a.label + ' earlier', disabled: i === 0 || null,
            'data-fk': 'ro:up:' + a.name, onclick: () => move(i, i - 1) }, icon('up', 'sm')),
          fixed ? null : h('button', { class: 'icon-btn order-move', title: 'Later', 'aria-label': 'Move ' + a.label + ' later', disabled: i === order.length - 1 || null,
            'data-fk': 'ro:down:' + a.name, onclick: () => move(i, i + 1) }, icon('down', 'sm')))
        if (!fixed) {
          r.addEventListener('dragstart', (e) => { dragging = a.name; r.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move' })
          r.addEventListener('dragend', () => { dragging = null; draw() })
          r.addEventListener('dragover', (e) => {
            if (!dragging || dragging === a.name) return
            e.preventDefault()
            move(order.indexOf(dragging), order.indexOf(a.name))
          })
        }
        return r
      }
      const had = list.contains(document.activeElement) ? keyOf(document.activeElement) : null
      const before = slideCapture(list, '.order-row')
      list.replaceChildren(...(active ? [row(active, null)] : []), ...order.map((n, i) => row(accounts.find((a) => a.name === n), i)))
      slideRun(list, '.order-row', before)
      if (had) {
        const twin = had.replace(/^(\w+):(up|down):/, (m, p, d) => p + ':' + (d === 'up' ? 'down' : 'up') + ':')
        const again = [had, twin].map((k) => list.querySelector('[data-fk="' + CSS.escape(k) + '"]')).find((x) => x && !x.disabled)
        if (again) again.focus({ preventScroll: true })
      }
    }
    draw()
    showDialog(h('div', { class: 'dialog wide', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': tid },
      h('div', null, h('h3', { id: tid, text: 'Reorder accounts' }),
        h('p', { text: 'Drag the accounts into the order you want. Your order is how the list and the cards are sorted when the sort is Your order.' })),
      list,
      h('div', { class: 'actions' }, h('button', { class: 'btn ghost', onclick: closeEdit }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: () => {
          const names = order.slice()
          if (active) names.splice(Math.min(accounts.indexOf(active), names.length), 0, active.name)
          find.sort = 'order'
          saveOrder(names)
          closeEdit()
        } }, 'Save'))))
  }

  function results() {
    const lay = layoutOf()
    lastDrawn = lay.drawn.map((a) => a.name).join('|')
    const asList = pref('listView') === true
    const box = h('div', { class: 'results' })
    if (!lay.list.length) {
      box.append(h('div', { class: 'empty' }, h('strong', { text: 'No accounts match' }),
        h('span', { text: 'Try other words, or show everything again.' }),
        h('button', { class: 'btn soft sm', 'data-fk': 'find:clear', onclick: () => { find.q = ''; find.filter = 'all'; renderSafely() } }, 'Show all accounts')))
      return box
    }
    const body = (items) => (asList ? items.map(listRow) : h('div', { class: 'grid' }, items.map(card)))
    const shell = (kids) => (asList ? h('div', { class: 'list' }, kids) : h('div', { class: 'cards' }, kids))
    if (!lay.groups) { box.append(shell(body(lay.list))); return box }
    const auto = !!find.q.trim()
    box.append(shell(lay.groups.map((g) => {
      const open = auto || !collapsed.has(g.name)
      const id = uid()
      return h('section', { class: 'group', 'data-open': String(open) },
        h('button', { class: 'group-head', 'aria-expanded': String(open), 'aria-controls': id, 'data-fk': 'group:' + g.name,
          onclick: () => { if (collapsed.has(g.name)) collapsed.delete(g.name); else collapsed.add(g.name); renderSafely() } },
        icon('down', 'sm chev'), h('span', { class: 'g-name', text: g.name }), h('span', { class: 'g-count', text: String(g.items.length) })),
        open ? h('div', { id, class: 'g-body' }, body(g.items)) : null)
    })))
    return box
  }
  function drawResults() {
    const old = app.querySelector('.results')
    if (!old) { renderSafely(); return }
    const before = slideCapture(app, SLIDE_PAGE)
    old.replaceWith(results())
    fitWhensNow()
    settleDraw()
    slideRun(app, SLIDE_PAGE, before)
  }
  function settleDraw() {
    void app.offsetWidth
    app.querySelectorAll('.track > i').forEach((f) => {
      f.style.width = f.dataset.target
      barWidth.set(f.dataset.key, f.dataset.target)
    })
    app.querySelectorAll('svg.vstroke').forEach(drawStroke)
    if (strokeSizes) { strokeSizes.disconnect(); app.querySelectorAll('svg.vstroke').forEach((el) => strokeSizes.observe(el)) }
    fitBadges()
  }

  function card(a) {
    const s = state
    const switching = busy.has('switch:' + a.name)
    const running = !!(a.session && !a.session.resetSince && a.session.resetsAt && Date.parse(a.session.resetsAt) > now())
    const startBtn = s.features && s.features.startSession && !a.active && !a.needsLogin && !a.noSession
      ? h('button', { class: 'icon-btn start' + (a.keepAlive ? ' keep' : ''), disabled: running || a.starting || null, 'data-fk': 'start:' + a.name,
        title: (a.starting ? 'Starting a 5-hour session…'
          : running ? 'Session running · resets in ' + (until(Date.parse(a.session.resetsAt)) || 'a moment') : 'Start a 5-hour session') +
          (a.keepAlive ? ' · Keep alive is on' : ''),
        'aria-label': (running ? '5-hour session running for ' : 'Start a 5-hour session for ') + a.label,
        onclick: () => send('startSession', { name: a.name }) },
      icon(a.starting ? 'refresh' : 'play', a.starting ? 'sm spin' : 'sm'))
      : null
    const count = pinCount(a.name)
    const pinBtn = h('button', { class: 'pin-btn', 'data-fk': 'pins:' + a.name, 'aria-haspopup': 'dialog',
      title: count ? count + ' pinned to ' + a.label : 'Pin chats and folders to ' + a.label,
      'aria-label': 'Pinning for ' + a.label + (count ? ', ' + count + ' pinned' : ''),
      onclick: () => openPinPanel(a.name) },
    icon('pin', 'sm'), count ? h('span', { class: 'pin-count', 'aria-hidden': 'true', text: count > 99 ? '99+' : String(count) }) : null)
    const moreBtn = h('button', { class: 'icon-btn', 'data-menu': 'actions:' + a.name, title: 'More actions',
      'aria-label': 'More actions for ' + a.label, 'aria-haspopup': 'menu', 'aria-expanded': 'false',
      onclick: (e) => { e.stopPropagation(); toggleMenu('actions', a.name, e.currentTarget, e) } }, icon('kebab'))

    let ctxGrid = null
    if (s.features && s.features.context && pref('context')) {
      const cols = 30
      const rows = 3
      const pct = a.context ? a.context.pct : 0
      const filled = Math.round((cols * rows * pct) / 100)
      const hot = pct >= 95 ? ' bad' : pct >= 80 ? ' warn' : ''
      const shuffle = !!(a.context && a.context.compacting)
      ctxGrid = h('div', { class: 'ctx' + hot + (shuffle ? ' shuffle' : ''), 'aria-hidden': 'true',
        title: shuffle ? 'Compacting…' : a.context ? 'Context ' + pct + '%' : 'No recent chat on this account' })
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const order = (rows - 1 - r) * cols + c
          const cell = h('i', { class: order < filled ? 'on s' + ctxShade(order, filled) : null })
          if (shuffle) cell.style.setProperty('animation-delay', (-(Math.abs(Math.sin(order * 78.233) * 43758.5453) % 1) * 1.6).toFixed(2) + 's')
          ctxGrid.append(cell)
        }
      }
    }
    const justLive = a.active && rendered && lastLive !== null && lastLive !== a.name
    const days = loginWords(a.loginExpiresAt, pinField(a))
    const who = [a.email, orgText(a.org)].filter(Boolean).join(' · ')
    const named = a.label + (a.active ? ' (active account)' : '')
    return sortable(h('article', { class: 'card' + (a.active ? ' live' : '') + (justLive ? ' just-live' : '') + (pref('tint') ? ' tinted' : ''),
      style: { '--hue': hueOf(a) }, 'aria-label': named + (days ? '. ' + days : ''), 'data-named': named,
      'data-acc': a.name, 'data-main': typeof a.loginExpiresAt === 'number' ? String(a.loginExpiresAt) : null, 'data-pin': pinField(a) === null ? null : String(pinField(a)) },
      pref('validity') === false ? null : validityStroke(a),
      h('div', { class: 'card-head', title: days || null }, avatar(a, 'avatar'),
        h('div', { class: 'ident' },
          h('div', { class: 'name-row' }, h('div', { class: 'name', text: a.label, 'data-who': who || null, title: [who, days].filter(Boolean).join('\n') || null }),
            planBadge(a.plan)),
          h('div', { class: 'sub', text: who || a.name })),
        h('div', { class: 'head-actions' }, startBtn, pinBtn, moreBtn)),
      ctxGrid,
      a.needsLogin
        ? h('div', { class: 'alert', role: 'status' }, icon('alert', 'sm'),
          h('div', { class: 'grow', text: 'This account’s main login has ended.' }),
          h('button', { class: 'btn soft sm signin-btn', title: 'Sign in again', 'aria-label': 'Sign in again to ' + a.label, 'data-fk': 'signin:' + a.name,
            onclick: () => send('relogin', { name: a.name }) }, icon('signin', 'sm'), h('span', { class: 'btn-text', text: 'Sign in again' })))
        : null,
      a.needsLogin ? null : h('div', { class: 'meters' }, meterSpecs(a).map((m) => meter(m[0], m[1], m[2], m[3], false, m[4]))),
      h('div', { class: 'card-foot' },
        pref('cardToggles') ? toggle('Remote Control', 'Remote', !a.remoteOff, 'Remote Control for ' + a.label,
          (on) => send('remote', { name: a.name, on })) : null,
        pref('cardToggles') && s.features && s.features.artifacts
          ? toggle('Artifacts', null, !a.artifactsOff, 'Artifacts and publishing to claude.ai for ' + a.label,
            (on) => send('artifacts', { name: a.name, on }))
          : null,
        a.needsLogin ? null : a.active ? activeMark('btn switch-btn')
          : h('button', { class: 'btn primary switch-btn', disabled: switching || null, 'data-fk': 'switch:' + a.name,
            title: 'Switch to ' + a.label, 'aria-label': (switching ? 'Switching to ' : 'Switch to ') + a.label,
            onclick: () => requestSwitch(a) },
          icon(switching ? 'refresh' : 'swap', switching ? 'sm spin' : 'sm'),
          h('span', { class: 'btn-text', text: switching ? 'Switching…' : 'Switch' }))),
      usageNotes(a)), a)
  }

  function banners() {
    const s = state
    const out = []
    if (s.registryError) {
      out.push(h('div', { class: 'banner warn' }, icon('alert'),
        h('div', { class: 'grow' }, h('strong', { text: 'The settings file has an error' }),
          h('div', { class: 'muted', text: s.registryError })),
        h('button', { class: 'btn primary sm', 'data-fk': 'banner:config', onclick: () => send('openConfig') }, 'Open it')))
    }
    if (s.duplicates && s.duplicates.length) {
      const g = s.duplicates[0]
      out.push(h('div', { class: 'banner warn' }, icon('alert'),
        h('div', { class: 'grow' }, h('strong', { text: g.join(' and ') + ' are the same account' }),
          h('div', { class: 'muted', text: 'Each holds its own login, and only one stays current. Keep one, and use ⋯ → Forget account on the others.' }))))
    }
    if (s.live && !s.live.saved && s.live.email) {
      out.push(h('div', { class: 'banner warn' }, icon('alert'),
        h('div', { class: 'grow' }, h('strong', { text: 'Your current login isn’t saved yet' }),
          h('div', { class: 'muted', text: s.live.email + ' · Save it so you can come back to it any time.' })),
        h('button', { class: 'btn primary sm', 'data-fk': 'banner:save', onclick: () => send('saveCurrent') }, 'Save it')))
    }
    const told = new Set()
    for (const a of s.accounts || []) {
      if (!('pinning' in a) || pinningOk(a) || !pinCount(a.name)) continue
      told.add(a.label)
      const n = pinCount(a.name)
      const what = n === 1 ? 'Its pinned chat or folder uses' : 'Its ' + n + ' pinned chats and folders use'
      out.push(a.pinning
        ? h('div', { class: 'banner warn' }, icon('pin'),
          h('div', { class: 'grow' }, h('strong', { text: a.label + '’s pinning login has ended' }),
            h('div', { class: 'muted', text: what + ' the active account until you sign in again.' })),
          h('button', { class: 'btn primary sm', 'data-fk': 'banner:pin:' + a.name, onclick: () => send('addPinning', { name: a.name }) }, 'Sign in again'))
        : h('div', { class: 'banner warn' }, icon('pin'),
          h('div', { class: 'grow' }, h('strong', { text: a.label + ' needs a pinning login' }),
            h('div', { class: 'muted', text: what + ' the active account until it has one.' })),
          h('button', { class: 'btn primary sm', 'data-fk': 'banner:pin:' + a.name, onclick: () => send('addPinning', { name: a.name }) },
            'Add account for pinning')))
    }
    const needs = s.window && (s.window.needsPinning || s.window.needsKey)
    if (needs && !told.has(needs)) {
      const a = (s.accounts || []).find((x) => x.label === needs)
      out.push(h('div', { class: 'banner warn' }, icon('pin'),
        h('div', { class: 'grow' }, h('strong', { text: 'This folder is pinned to ' + needs + ', which needs a pinning login' }),
          h('div', { class: 'muted', text: 'Chats here use the active account until it has one.' })),
        a ? h('button', { class: 'btn primary sm', 'data-fk': 'banner:needs', onclick: () => send('addPinning', { name: a.name }) },
          'Add account for pinning') : null))
    }
    if (s.window && s.window.pinnedTo) {
      out.push(h('div', { class: 'banner' }, icon('pin'),
        h('div', { class: 'grow' }, h('strong', null, h('span', { class: 'nw-hide', text: 'This folder is pinned to ' }), h('span', { class: 'nw-only', text: 'Pinned to ' }), s.window.pinnedLabel)),
        h('button', { class: 'btn ghost sm', 'data-fk': 'banner:change', onclick: () => send('pin') }, 'Change')))
    }
    return out
  }

  function checklistItems() {
    const s = state
    const accounts = s.accounts || []
    const mine = accounts.find((a) => a.active) || accounts[0] || null
    return [
      { key: 'saved', done: !(s.live && s.live.email && !s.live.saved), text: 'Save the account you’re using',
        act: 'Save it', run: () => send('saveCurrent') },
      { key: 'another', done: accounts.some((a) => !a.active), text: 'Add another account',
        act: 'Add account', run: () => send('add') },
      { key: 'pinning', done: accounts.some(pinningOk), text: 'Add a pinning login', optional: true,
        act: 'Add', disabled: !mine, run: () => { if (mine) send('addPinning', { name: mine.name }) } },
    ]
  }
  function checklistList(withButtons) {
    return h('ol', { class: 'gs-list' }, checklistItems().map((it, i) => h('li', { class: 'gs-item' + (it.done ? ' done' : '') },
      h('span', { class: 'gs-tick', 'aria-hidden': 'true' }, it.done ? icon('check', 'sm') : String(i + 1)),
      h('span', { class: 'gs-text' }, h('span', { text: it.text }), it.optional ? h('span', { class: 'gs-opt', text: '(optional)' }) : null,
        h('span', { class: 'sr', text: it.done ? ', done' : '' })),
      withButtons && !it.done
        ? h('button', { class: 'btn soft sm', 'data-fk': 'gs:' + it.key, disabled: it.disabled || null, onclick: it.run }, it.act)
        : null)))
  }
  function checklistCard() {
    if (!state.checklist) return null
    const all = checklistItems().every((i) => i.done)
    return h('section', { class: 'getting-started', 'aria-label': 'Getting started' },
      h('div', { class: 'gs-head' }, h('h2', { text: all ? 'You’re all set' : 'Getting started' }),
        h('button', { class: 'icon-btn', title: 'Hide', 'aria-label': 'Hide the getting started list', 'data-fk': 'gs:hide',
          onclick: () => send('checklistDone') }, icon('x', 'sm'))),
      checklistList(true))
  }

  const AC_MODES = [
    ['ask', 'Ask me what to do', 'Choose an action from the VS Code notification'],
    ['wait', 'Auto-continue on the same account', 'Wait for the limit to reset and continue'],
    ['switch', 'Auto-continue on a different account', 'Switch to another account and continue'],
    ['off', 'Do nothing', 'Leave the chat stopped'],
  ]
  const AC_PICKS = [
    ['room', 'The account with the most limit', 'Recommended'],
    ['order', 'The first account in my order', 'Uses accounts you chose'],
  ]
  const AC_EARLY_MODES = [
    ['switch', 'Switch to a different account', 'Work carries on, on another account'],
    ['ask', 'Ask me what to do', 'Choose an action from the VS Code notification'],
  ]
  const EARLY_MIN = 50
  const EARLY_MAX = 90
  const lower = (t) => t.charAt(0).toLowerCase() + t.slice(1)
  const acLabel = (list, v) => lower((list.find((x) => x[0] === v) || list[0])[1])

  function choiceMenu(label, list, current, pick) {
    return h('div', { class: 'menu choices-menu', role: 'menu', 'aria-label': label, tabindex: '-1' },
      list.map(([v, title, sub]) => h('button', { role: 'menuitemradio', 'aria-checked': String(v === current), tabindex: '-1',
        onclick: () => { closeMenu(false); pick(v) } },
      h('span', { class: 'mi-check' }, v === current ? icon('check', 'sm') : null),
      h('span', { class: 'mi-text' }, h('span', { text: title }), h('span', { class: 'mi-sub', text: sub })))))
  }

  function modeMenu() {
    const ac = state.autoContinue
    return choiceMenu('What to do', ac.early ? AC_EARLY_MODES : AC_MODES, ac.mode, (v) => {
      if (v === 'switch' && ac.mode !== 'switch') switchDialog()
      else if (v !== ac.mode) send('autoContinue', { mode: v })
    })
  }

  function whenMenu() {
    const ac = state.autoContinue
    let v = ac.early || 80
    const value = h('span', { class: 'ws-val', text: v + '%' })
    const slider = h('input', { type: 'range', class: 'ws-range', min: String(EARLY_MIN), max: String(EARLY_MAX), step: '1',
      value: String(v), 'aria-label': 'Share of the 5-hour limit to switch at' })
    slider.addEventListener('input', () => { v = Number(slider.value); value.textContent = v + '%' })
    slider.addEventListener('change', () => { if (ac.early && v !== ac.early) send('autoContinue', { early: v }) })
    const item = (on, title, sub, pick) => h('button', { role: 'menuitemradio', 'aria-checked': String(on), tabindex: '-1',
      onclick: () => { closeMenu(false); pick() } },
    h('span', { class: 'mi-check' }, on ? icon('check', 'sm') : null),
    h('span', { class: 'mi-text' }, h('span', { text: title }), h('span', { class: 'mi-sub', text: sub })))
    return h('div', { class: 'menu choices-menu when-menu', role: 'menu', 'aria-label': 'When', tabindex: '-1' },
      item(!ac.early, 'Hits its limit', 'Act once the limit has stopped the chat', () => { if (ac.early) send('autoContinue', { early: null }) }),
      item(!!ac.early, 'Reaches a share of its limit', 'Switch early, so work doesn’t stop', () => chooseEarly(v)),
      h('div', { class: 'ws-row' }, h('span', { class: 'ws-end', text: EARLY_MIN + '%' }), slider,
        h('span', { class: 'ws-end', text: EARLY_MAX + '%' }), value),
      h('div', { class: 'mi-sub ws-note', text: 'The 5-hour limit switches at this share, the weekly limit at 95%.' }))
  }

  function chooseEarly(v) {
    const ac = state.autoContinue
    if (ac.mode === 'switch' || ac.mode === 'ask') send('autoContinue', { early: v })
    else switchDialog({ early: v })
  }

  function pickMenu() {
    const ac = state.autoContinue
    return choiceMenu('Which account', AC_PICKS, ac.pick, (v) => {
      if (v === 'order') orderDialog({ mode: 'switch' })
      else if (v !== ac.pick) send('autoContinue', { pick: 'room' })
    })
  }

  function switchDialog(extra) {
    let pick = state.autoContinue.pick
    const tid = uid()
    const list = h('div', { class: 'rc-list', role: 'radiogroup', 'aria-label': 'Switch to which account?' })
    const next = h('button', { class: 'btn primary' })
    const draw = () => {
      const card = (v, title, text) => h('button', { class: 'radio-card' + (pick === v ? ' on' : ''), role: 'radio',
        'aria-checked': String(pick === v), onclick: () => { pick = v; draw() } },
      h('span', { class: 'dot' }), h('span', { class: 'rc-text' }, h('strong', { text: title }), h('span', { text: text })))
      list.replaceChildren(
        card('room', 'The account with the most limit', 'Whichever of your accounts has used the least. Recommended.'),
        card('order', 'In my order', 'You choose the order and the accounts Claude uses'))
      next.textContent = pick === 'order' ? 'Next: Set the Order' : 'Done'
    }
    next.addEventListener('click', () => {
      if (pick === 'order') orderDialog(Object.assign({ mode: 'switch' }, extra || {}), true)
      else { send('autoContinue', Object.assign({ mode: 'switch', pick: 'room' }, extra || {})); closeEdit() }
    })
    draw()
    showDialog(h('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': tid },
      h('div', null, h('h3', { id: tid, text: 'Switch to which account?' }),
        h('p', { text: 'When a chat hits its limit, Switcher for Claude Code moves to another account and continues the chat there.' })),
      list,
      h('div', { class: 'actions' }, h('button', { class: 'btn ghost', onclick: closeEdit }, 'Cancel'), next)))
    const on = list.querySelector('[aria-checked="true"]')
    if (on) on.focus()
  }

  function orderDialog(extra, replace) {
    const accounts = state.accounts || []
    const ac = state.autoContinue
    let order = (ac.order || []).filter((n) => accounts.some((a) => a.name === n))
    if (!order.length) order = accounts.filter((a) => !a.needsLogin).map((a) => a.name)
    let dragging = null
    const tid = uid()
    const list = h('div', { class: 'order-list' })
    const move = (from, to) => { order.splice(to, 0, order.splice(from, 1)[0]); draw() }
    const draw = () => {
      const row = (a, i) => {
        const on = i !== null
        const why = [a.active ? 'in use now' : null, a.needsLogin ? 'needs signing in' : null, on ? null : 'never switched to'].filter(Boolean)
        const r = h('div', { class: 'order-row' + (on ? '' : ' off') + (pref('tint') ? ' tinted' : ''), style: { '--hue': hueOf(a) }, 'data-sk': 'ro:' + a.name, draggable: on ? 'true' : null },
          h('span', { class: 'grip', title: on ? 'Drag to reorder' : null }, on ? icon('grip', 'sm') : null),
          h('span', { class: 'rank', text: on ? String(i + 1) : '' }),
          avatar(a, 'avatar sm'),
          h('div', { class: 'grow' }, h('span', { class: 'nm', text: a.label }), why.length ? h('span', { class: 'who', text: why.join(' · ') }) : null),
          on ? h('button', { class: 'icon-btn order-move', title: 'Earlier', 'aria-label': 'Move ' + a.label + ' earlier', disabled: i === 0 || null,
            'data-fk': 'oo:up:' + a.name, onclick: () => move(i, i - 1) }, icon('up', 'sm')) : null,
          on ? h('button', { class: 'icon-btn order-move', title: 'Later', 'aria-label': 'Move ' + a.label + ' later', disabled: i === order.length - 1 || null,
            'data-fk': 'oo:down:' + a.name, onclick: () => move(i, i + 1) }, icon('down', 'sm')) : null,
          h('button', { class: 'switch', role: 'switch', 'aria-checked': String(on), 'aria-label': (on ? 'Leave out ' : 'Include ') + a.label, 'data-fk': 'oo:on:' + a.name,
            onclick: () => { order = on ? order.filter((n) => n !== a.name) : order.concat([a.name]); draw() } }))
        if (on) {
          r.addEventListener('dragstart', (e) => { dragging = a.name; r.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move' })
          r.addEventListener('dragend', () => { dragging = null; draw() })
          r.addEventListener('dragover', (e) => {
            if (!dragging || dragging === a.name) return
            e.preventDefault()
            move(order.indexOf(dragging), order.indexOf(a.name))
          })
        }
        return r
      }
      const had = list.contains(document.activeElement) ? keyOf(document.activeElement) : null
      const before = slideCapture(list, '.order-row')
      list.replaceChildren(...order.map((n, i) => row(accounts.find((a) => a.name === n), i)),
        ...accounts.filter((a) => !order.includes(a.name)).map((a) => row(a, null)))
      slideRun(list, '.order-row', before)
      if (had) {
        const twin = had.replace(/^(\w+):(up|down):/, (m, p, d) => p + ':' + (d === 'up' ? 'down' : 'up') + ':')
        const again = [had, twin].map((k) => list.querySelector('[data-fk="' + CSS.escape(k) + '"]')).find((x) => x && !x.disabled)
        if (again) again.focus({ preventScroll: true })
      }
    }
    draw()
    showDialog(h('div', { class: 'dialog wide', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': tid },
      h('div', null, h('h3', { id: tid, text: 'Switch order' }),
        h('p', { text: 'It moves to the first account here that has room, so it comes back to an earlier one once that has reset. ' +
          'Accounts switched off are never used. If none has room, it waits for the first one to reset.' })),
      list,
      h('div', { class: 'actions' }, h('button', { class: 'btn ghost', onclick: closeEdit }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: () => {
          send('autoContinue', Object.assign({ pick: 'order', order: order.slice() }, extra || {}))
          closeEdit()
        } }, 'Save'))), { replace: !!replace })
  }

  function autoContinueSection() {
    const s = state
    const ac = s.autoContinue
    if (!ac || !s.features || !s.features.autoContinue) return null
    const chip = (kind, text) => h('button', { class: 'chip', 'data-menu': kind + ':x', 'aria-haspopup': 'menu', 'aria-expanded': 'false',
      onclick: (e) => toggleMenu(kind, 'x', e.currentTarget, e) }, h('span', { text }), icon('down', 'sm'))
    const sentence = h('div', { class: 'ac-row sentence' },
      h('span', { text: 'When a chat' }), chip('ac-when', ac.early ? 'reaches ' + ac.early + '% of its limit' : 'hits its limit'),
      h('span', { class: 'comma', text: ',' }),
      chip('ac-mode', acLabel(ac.early ? AC_EARLY_MODES : AC_MODES, ac.mode)),
      ac.mode === 'switch' ? h('span', { text: 'using' }) : null,
      ac.mode === 'switch' ? chip('ac-pick', acLabel(AC_PICKS, ac.pick)) : null,
      ac.mode === 'switch' && ac.pick === 'order' ? h('button', { class: 'linkbtn', 'data-fk': 'ac:order', onclick: () => orderDialog() }, 'Edit order') : null)
    const waiting = ac.waiting && ac.waiting.length
      ? h('div', { class: 'pin-list ac-wait' }, ac.waiting.map((w) => h('div', { class: 'pin-row' }, icon('clock', 'sm'),
        h('div', { class: 'grow' }, h('span', { class: 'path ltr', text: w.title }),
          h('span', { class: 'who', text: 'continues at ' + w.at + (w.on ? ' on ' + w.on : '') })),
        h('button', { class: 'btn soft-danger sm', 'data-fk': 'ac:cancel:' + w.id, onclick: () => send('cancelContinue', { id: w.id }) }, 'Cancel'))))
      : null
    const how = h('details', { class: 'how' }, h('summary', null, icon('info', 'sm'), 'How it works'),
      h('p', { text: 'Switcher for Claude Code sends the stopped chat one note asking it to continue, and the chat picks up by itself, ' +
        'right there in the panel. A switch needs no reload. Chats in a pinned folder always wait for their own account, and a weekly ' +
        'limit is never waited out. If a chat answers the note instead of continuing, you can let it trust these notes from then on.' }))
    const pick = ac.mode === 'switch' ? (ac.pick === 'order' ? 'my order' : 'most limit') : null
    const step = (ic, text, sub) => h('span', { class: 'step' }, icon(ic, 'sm'), h('span', { text }),
      sub ? h('span', { class: 'step-sub', text: '· ' + sub }) : null)
    const arrow = () => h('span', { class: 'step-arrow', 'aria-hidden': 'true', text: '→' })
    const action = {
      switch: step('swap', 'Switch account', pick),
      wait: step('clock', 'Wait for the reset'),
      ask: step('info', 'Ask me'),
      off: step('x', 'Do nothing'),
    }[ac.mode] || step('info', acLabel(AC_MODES, ac.mode))
    const result = ac.mode === 'switch' || ac.mode === 'wait' ? step('check', 'Chat continues')
      : ac.mode === 'ask' ? step('check', 'You choose') : null
    const steps = h('div', { class: 'ac-row ac-steps' },
      step('zap', ac.early ? 'At ' + ac.early + '%' : 'At the limit'), arrow(), action,
      result ? arrow() : null, result,
      h('button', { class: 'btn soft sm ac-edit', 'aria-expanded': String(acEditing), 'data-fk': 'ac:edit',
        onclick: () => { acEditing = !acEditing; renderSafely() } }, acEditing ? 'Done' : 'Edit'))
    return h('section', null, h('div', { class: 'section-head' }, h('h2', { text: 'Auto-continue After Limits' })),
      steps, acEditing ? sentence : null, waiting, how)
  }

  function waitStrip(c, key) {
    return h('div', { class: 'wait-strip' }, icon('clock', 'sm'),
      h('span', { class: 'wait-text', text: 'Moves to ' + c.label + ' when this reply finishes' }),
      h('button', { class: 'btn soft sm', 'data-fk': key, onclick: () => reopenNowDialog(c) }, 'Reopen now'))
  }

  function pinsSection() {
    const s = state
    const accounts = s.accounts || []
    const rows = (s.pins || []).map((p) => {
      const a = accounts.find((x) => x.name === p.name) || { name: p.name, label: p.label, icon: null }
      return h('div', { class: 'pin-row', 'data-sk': 'pin:' + p.folder },
        avatar(a, 'avatar'),
        h('div', { class: 'grow' },
          h('span', { class: 'path', title: p.folder, text: p.folder }),
          h('span', { class: 'who', text: p.label + (p.here ? ' · this window' : '') + (p.ready === false ? ' · needs a pinning login' : '') })),
        h('button', { class: 'btn soft-danger sm', 'aria-label': 'Unpin ' + p.folder, 'data-fk': 'unpin:' + p.folder,
          onclick: () => send('unpin', { folder: p.folder }) }, 'Unpin'))
    })
    for (const c of s.chatPins || []) {
      const a = accounts.find((x) => x.name === c.name) || { name: c.name, label: c.label, icon: null }
      const title = c.title || 'Untitled chat'
      rows.push(h('div', { class: 'pin-row chat' + (c.waiting ? ' waiting' : ''), 'data-sk': 'chat:' + c.id },
        avatar(a, 'avatar'),
        h('div', { class: 'grow' },
          h('span', { class: 'path ltr', title, text: title }),
          c.waiting ? null
            : h('span', { class: 'who' }, icon('chat', 'sm'), h('span', { text: c.label + ' · chat' + (c.ready === false ? ' · needs a pinning login' : '') }))),
        h('button', { class: 'btn soft-danger sm', 'aria-label': 'Unpin the chat ' + title, 'data-fk': 'unpin:' + c.id,
          onclick: () => send('unpinChat', { id: c.id }) }, 'Unpin'),
        c.waiting ? waitStrip(c, 'reopen:' + c.id) : null))
    }
    return h('section', { class: 'pins' },
      h('div', { class: 'section-head' },
        h('h2', { text: 'Pinned' }),
        h('button', { class: 'btn ghost sm', onclick: () => send('pin') }, icon('pin', 'sm'), 'Pin a folder…')),
      rows.length
        ? h('div', { class: 'pin-list grid' }, rows)
        : h('div', { class: 'empty' }, h('strong', { text: 'Nothing pinned' }),
          h('span', { text: 'Pin a folder or a chat to give it its own account. Chat history stays shared.' })))
  }

  const stack = []
  let overlay = null
  let lastTrigger = null

  function keyOf(el) { return (el && el.getAttribute && (el.getAttribute('data-fk') || el.getAttribute('data-menu'))) || null }
  function focusBack() {
    const el = document.activeElement
    if (el && el !== document.body && el !== document.documentElement) return { el, key: keyOf(el) }
    return lastTrigger
  }
  function restoreFocus(back) {
    if (!back) return
    let el = back.el && back.el.isConnected ? back.el : null
    if (!el && back.key) el = document.querySelector('[data-fk="' + CSS.escape(back.key) + '"], [data-menu="' + CSS.escape(back.key) + '"]')
    if (el && !el.closest('[hidden]')) el.focus({ preventScroll: true })
  }
  document.addEventListener('click', (e) => {
    const b = e.target && e.target.closest ? e.target.closest('button, a, summary') : null
    if (b && !layer.contains(b)) lastTrigger = { el: b, key: keyOf(b) }
  }, true)

  function openPop(box, o) {
    const opts = o || {}
    closeMenu(false)
    const back = opts.back || focusBack()
    if (!overlay) {
      overlay = h('div', { class: 'overlay open', onclick: (e) => {
        const top = stack[stack.length - 1]
        if (e.target === overlay && top && !top.sticky) cancelPop(top)
      } })
      document.body.append(overlay)
    }
    const top = stack[stack.length - 1]
    if (top) top.box.hidden = true
    const pop = { box, back, cancel: opts.cancel || null, refresh: opts.refresh || null, update: null,
      askId: opts.askId || null, done: false, timer: null, sticky: !!opts.sticky }
    overlay.append(box)
    stack.push(pop)
    fitActions(box)
    return pop
  }
  function fitActions(box) {
    for (const row of box.querySelectorAll('.actions')) {
      row.classList.remove('stacked')
      const first = row.firstElementChild
      if (first && first.getBoundingClientRect().left < row.getBoundingClientRect().left - 1) row.classList.add('stacked')
    }
  }
  function swapPop(pop, box, o) {
    const opts = o || {}
    clearTimeout(pop.timer)
    pop.box.replaceWith(box)
    Object.assign(pop, { box, cancel: opts.cancel || null, refresh: opts.refresh || null, update: null,
      askId: opts.askId || null, done: false, timer: null, sticky: !!opts.sticky })
    box.hidden = pop !== stack[stack.length - 1]
    fitActions(box)
    return pop
  }
  function closePop(pop) {
    const i = stack.indexOf(pop)
    if (i === -1) return
    clearTimeout(pop.timer)
    stack.splice(i, 1)
    const wasTop = i === stack.length
    if (!stack.length) {
      const o = overlay
      overlay = null
      o.classList.add('closing')
      setTimeout(() => o.remove(), 120)
      if (state) renderSafely()
    } else {
      pop.box.remove()
      if (wasTop) {
        const below = stack[stack.length - 1]
        below.box.hidden = false
        if (below.refresh) below.refresh()
        fitActions(below.box)
      }
    }
    if (wasTop) restoreFocus(pop.back)
  }
  function cancelPop(pop) { if (pop.cancel) pop.cancel(); else closePop(pop) }
  function closeEdit() { const top = stack[stack.length - 1]; if (top) closePop(top) }
  function showDialog(box, o) {
    const opts = o || {}
    const top = stack[stack.length - 1]
    return opts.replace && top ? swapPop(top, box, opts) : openPop(box, opts)
  }
  function trapTab(box, e) {
    const f = [...box.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
      .filter((x) => !x.disabled && x.offsetParent !== null)
    if (!f.length) return
    const first = f[0]
    const last = f[f.length - 1]
    if (!box.contains(document.activeElement)) { e.preventDefault(); (e.shiftKey ? last : first).focus(); return }
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
  }
  const xBtn = (fn) => h('button', { class: 'icon-btn dlg-x', title: 'Close', 'aria-label': 'Close', onclick: fn }, icon('x'))

  function confirmBox(spec, done) {
    const tid = uid()
    const buttons = Array.isArray(spec.buttons) && spec.buttons.length ? spec.buttons : null
    const a = spec.account ? accountByName(spec.account) : null
    let check = null
    let field = null
    const extra = () => Object.assign({}, check ? { checked: check.checked } : {}, field ? { text: field.value } : {})
    const title = h('h3', { id: tid }, spec.title || 'Are you sure?')
    const head = spec.art
      ? h('div', { class: 'dlg-top' }, h('div', { class: 'dlg-art ' + spec.art, 'aria-hidden': 'true' },
        icon(spec.art === 'pin' ? 'pin' : spec.art === 'warn' ? 'alert' : 'check'),
        spec.art === 'warn' ? null : [h('span', { class: 'spark s1' }, icon('sparkle')), h('span', { class: 'spark s2' }, icon('sparkle')),
          h('span', { class: 'spark s3' }, icon('sparkle'))]), title)
      : a ? h('div', { class: 'dlg-head' }, avatar(a, 'avatar lg'), h('div', null, title))
        : h('div', null, title)
    const parts = [head]
    if (spec.message) parts.push(h('p', { class: 'dlg-msg', text: spec.message }))
    if (Array.isArray(spec.facts) && spec.facts.length) {
      parts.push(h('dl', { class: 'facts' }, spec.facts.flatMap((f) => [h('dt', { text: String(f[0]) }), h('dd', { text: String(f[1]) })])))
    }
    for (const sec of Array.isArray(spec.sections) ? spec.sections : []) {
      parts.push(h('div', { class: 'dlg-section' }, sec.title ? h('strong', null, sec.title) : null,
        sec.text ? h('p', { text: sec.text }) : null))
    }
    if (spec.warning) parts.push(h('div', { class: 'dlg-warn', role: 'note' }, icon('alert', 'sm'), h('span', { text: spec.warning })))
    if (spec.field) {
      const fid = uid()
      field = h('input', { id: fid, type: 'text', value: spec.field.value || '', placeholder: spec.field.placeholder || '',
        maxlength: '40', autocomplete: 'off', spellcheck: 'false' })
      parts.push(h('div', { class: 'field' }, h('label', { for: fid, text: spec.field.label || 'Name' }), field))
    }
    if (spec.check) {
      const cid = uid()
      const tipId = uid()
      check = h('input', { type: 'checkbox', id: cid, checked: spec.check.checked ? true : null,
        'aria-describedby': spec.check.help ? tipId : null })
      parts.push(h('div', { class: 'check-row' },
        h('label', { class: 'check', for: cid }, check, h('span', { text: spec.check.label })),
        spec.check.help ? h('button', { class: 'help', type: 'button', 'aria-label': 'What does this do?' }, icon('help', 'sm')) : null,
        spec.check.help ? h('div', { class: 'tip', id: tipId, role: 'tooltip', text: spec.check.help }) : null))
    }
    parts.push(h('div', { class: 'actions' },
      spec.cancel === false ? null
        : h('button', { class: 'btn ghost', onclick: () => done(null) }, typeof spec.cancel === 'string' ? spec.cancel : 'Cancel'),
      buttons
        ? buttons.map((b, i, all) => h('button', { class: 'btn ' + (i === all.length - 1 ? 'primary' : 'ghost'),
          onclick: () => done(Object.assign({ value: b }, extra())) }, b))
        : h('button', { class: 'btn primary', onclick: () => done(Object.assign({ value: 'yes' }, extra())) }, spec.confirmLabel || 'OK')))
    const close = () => done(spec.cancel === false && (check || field) ? Object.assign({ closed: true }, extra()) : null)
    const box = h('div', { class: 'dialog ask-dialog' + (spec.art ? ' has-art' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': tid },
      xBtn(close), parts)
    box.closeAsk = close
    return box
  }

  function pickParts(items, onPick) {
    const accounts = (state && state.accounts) || []
    const rows = items.map((it) => {
      const a = it.account ? accounts.find((x) => x.name === it.account) : null
      const lead = a ? avatar(a, 'avatar sm') : h('span', { class: 'ask-ico', 'aria-hidden': 'true' }, it.icon ? icon(it.icon, 'sm') : null)
      return h('button', { class: 'ask-row' + (it.current ? ' current' : ''), 'data-text': (it.label + ' ' + (it.description || '')).toLowerCase(),
        onclick: () => onPick(it) },
      lead,
      h('span', { class: 'ask-text' }, h('span', { class: 'ask-label' }, h('span', { text: it.label })),
        it.description ? h('span', { class: 'ask-desc', text: it.description }) : null),
      it.current ? h('span', { class: 'ask-now', text: 'current' }) : null)
    })
    const parts = []
    let search = null
    if (rows.length > 7) {
      search = h('input', { class: 'ask-search', type: 'search', placeholder: 'Search', 'aria-label': 'Search' })
      search.addEventListener('input', () => {
        const q = search.value.trim().toLowerCase()
        for (const r of rows) r.hidden = !!q && !r.dataset.text.includes(q)
      })
      search.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); const first = rows.find((r) => !r.hidden); if (first) first.click() }
        if (e.key === 'ArrowDown') { e.preventDefault(); const first = rows.find((r) => !r.hidden); if (first) first.focus() }
      })
      parts.push(search)
    }
    const list = h('div', { class: 'ask-list', role: 'listbox' }, rows)
    list.addEventListener('keydown', (e) => {
      const shown = rows.filter((r) => !r.hidden)
      const at = shown.indexOf(document.activeElement)
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const next = shown[(at + (e.key === 'ArrowDown' ? 1 : shown.length - 1)) % shown.length]
        if (next) next.focus()
      }
    })
    parts.push(list)
    return { parts, focus: () => { const f = search || rows[0]; if (f) f.focus() } }
  }
  function pickBox(spec, items, onPick, onClose) {
    const tid = uid()
    const heading = spec.title || spec.placeholder || 'Claude Accounts'
    const sub = spec.title ? spec.placeholder : null
    const p = pickParts(items, onPick)
    const box = h('div', { class: 'dialog ask-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': tid },
      xBtn(onClose),
      h('div', null, h('h3', { id: tid }, heading), sub ? h('p', { text: sub }) : null),
      p.parts)
    return { box, focus: p.focus }
  }

  function lookForm(o) {
    let chosen = o.icon || null
    let chosenColor = o.color && COLORS[o.color] ? o.color : 'auto'
    const fid = uid()
    const input = h('input', { id: fid, value: o.label || '', maxlength: '40', autocomplete: 'off', spellcheck: 'false',
      placeholder: o.placeholder || '' })
    const err = h('div', { class: 'err', 'aria-live': 'polite' })
    const preview = h('div', { class: 'avatar lg', 'aria-hidden': 'true' })
    const seed = () => o.name || input.value.trim() || 'new account'
    const drawPreview = () => {
      preview.style.setProperty('--hue', hueOf({ name: seed(), color: chosenColor === 'auto' ? null : chosenColor }))
      preview.replaceChildren(codicon(chosen) || codicon(o.label || input.value.trim() ? null : 'account') ||
        initials(input.value.trim() || o.label || '?'))
    }
    input.addEventListener('input', () => { err.textContent = ''; drawPreview() })
    const pickColor = (c) => {
      chosenColor = c
      colors.querySelectorAll('[data-color]').forEach((x) => x.setAttribute('aria-checked', String(x.dataset.color === c)))
      drawPreview()
    }
    const colors = h('div', { class: 'colors', role: 'radiogroup', 'aria-label': 'Colour' },
      h('button', { class: 'auto-color', role: 'radio', 'data-color': 'auto', 'aria-checked': String(chosenColor === 'auto'),
        title: o.name ? 'Picked from the account name (' + COLORS[autoColor(o.name)][0].toLowerCase() + ')' : 'Picked from the name',
        onclick: () => pickColor('auto') }, 'Automatic'),
      Object.entries(COLORS).map(([c, [label, value]]) => h('button', { class: 'color', role: 'radio', 'data-color': c,
        'aria-checked': String(c === chosenColor), 'aria-label': label, title: label, style: { '--hue': value },
        onclick: () => pickColor(c) }, icon('check', 'sm'))))
    const swatches = h('div', { class: 'swatches', role: 'group', 'aria-label': 'Icon' },
      Object.keys(ICONS).map((nm) => {
        const shown = ICON_NAMES[nm] || nm
        return h('button', { class: 'swatch', title: shown, 'aria-label': shown, 'data-icon': nm,
          'aria-pressed': String(nm === chosen),
          onclick: () => {
            chosen = chosen === nm && o.clearable ? null : nm
            swatches.querySelectorAll('.swatch').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.icon === chosen)))
            drawPreview()
          } },
        codicon(nm) || h('span', { class: 'nm', text: shown }))
      }))
    drawPreview()
    return {
      input, err, preview,
      fields: [
        h('div', { class: 'field' }, h('label', { for: fid, text: o.nameLabel || 'Display name' }), input,
          o.hint ? h('div', { class: 'hint', text: o.hint }) : null, err),
        h('div', { class: 'field' }, h('label', { text: 'Colour' }), colors),
        h('div', { class: 'field' }, h('label', { text: 'Icon' }), swatches),
      ],
      values: () => ({ label: input.value.trim(), color: chosenColor, icon: chosen }),
    }
  }

  function signinBox(id, spec, answer) {
    let sp = spec
    let checking = false
    const tid = uid()
    const fid = uid()
    const status = h('div', { class: 'signin-wait', role: 'status' })
    const code = h('input', { id: fid, type: 'text', autocomplete: 'off', spellcheck: 'false', placeholder: 'Paste code' })
    const err = h('div', { class: 'err', 'aria-live': 'polite' })
    const add = h('button', { class: 'btn primary' })
    const link = h('div', { class: 'link-text', tabindex: '0', 'aria-label': 'Login link' })
    const copy = h('button', { class: 'btn soft sm copy-btn', 'aria-label': 'Copy the login link' }, icon('copy', 'sm'), h('span', { text: 'Copy' }))
    const draw = () => {
      status.replaceChildren(h('span', { class: 'spinner', 'aria-hidden': 'true' }),
        h('span', { text: checking ? 'Checking the code…' : 'Waiting to log you in automatically' }))
      err.textContent = sp.error || ''
      code.setAttribute('aria-invalid', sp.error ? 'true' : 'false')
      add.disabled = checking || !code.value.trim()
      add.textContent = checking ? 'Checking…' : (sp.confirmLabel || 'Add account')
      link.textContent = sp.url || ''
      link.title = sp.url || ''
    }
    code.addEventListener('input', () => { if (sp.error) sp = Object.assign({}, sp, { error: null }); draw() })
    add.addEventListener('click', () => {
      const v = code.value.trim()
      if (!v || checking) return
      checking = true
      sp = Object.assign({}, sp, { error: null })
      draw()
      send('signinCode', { id, code: v })
    })
    copy.addEventListener('click', () => copyText(sp.url, copy))
    const box = h('div', { class: 'dialog ask-dialog signin', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': tid },
      xBtn(() => answer({ cancel: true })),
      h('div', null, h('h3', { id: tid }, spec.title || 'Finish signing in on the browser'),
        spec.message ? h('p', { text: spec.message }) : null),
      status,
      spec.email ? h('div', { class: 'signin-email' }, icon('info', 'sm'),
        h('span', null, 'We filled in ', h('strong', { text: spec.email }), ' on the sign-in page for you.')) : null,
      h('div', { class: 'field' }, h('span', { class: 'label', text: 'Login link:' }), h('div', { class: 'link-row' }, link, copy)),
      h('div', { class: 'field' }, h('label', { for: fid, text: 'Paste code' }), code,
        h('div', { class: 'hint', text: 'Paste the code here if you receive it' }), err),
      h('div', { class: 'actions' }, h('button', { class: 'btn ghost', onclick: () => answer({ cancel: true }) }, 'Cancel'), add))
    draw()
    return { box, sticky: true, focus: () => code.focus(),
      update: (next) => { sp = next; checking = next.stage === 'checking'; draw(); if (next.error) { code.focus(); code.select() } } }
  }

  function copyText(text, btn) {
    const t = String(text || '')
    const said = () => {
      const label = btn.querySelector('span')
      if (!label) return
      label.textContent = 'Copied'
      setTimeout(() => { label.textContent = 'Copy' }, 1500)
    }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(t).then(said, () => { send('copy', { text: t }); said() })
        return
      }
    } catch {  }
    send('copy', { text: t })
    said()
  }

  function checksBox(spec, answer) {
    let sp = spec
    const tid = uid()
    const list = h('div', { class: 'checks', role: 'list' })
    const sum = h('p', { class: 'check-sum', 'aria-live': 'polite' })
    const again = h('button', { class: 'btn ghost', onclick: () => answer({ value: 'again' }) }, 'Check again')
    const done = h('button', { class: 'btn primary', onclick: () => answer({ value: 'done' }) }, 'Done')
    const WORDS = { run: 'checking', ok: 'fine', warn: 'needs a look', bad: 'needs fixing', info: 'note' }
    const draw = () => {
      const items = Array.isArray(sp.items) ? sp.items : []
      list.replaceChildren(...items.map((it, i) => {
        const st = WORDS[it.status] ? it.status : 'run'
        return h('div', { class: 'check-item ' + st, role: 'listitem' },
          h('span', { class: 'st', 'aria-hidden': 'true' },
            st === 'run' ? h('span', { class: 'spinner sm' }) : icon(st === 'ok' ? 'check' : st === 'info' ? 'info' : 'alert', 'sm')),
          h('div', { class: 'grow' }, h('span', { class: 'lbl', text: it.label }),
            h('span', { class: 'det' }, h('span', { class: 'sr', text: WORDS[st] + ': ' }), it.detail || '')),
          it.fix && st !== 'run' ? h('button', { class: 'btn soft sm', onclick: () => answer({ value: 'fix', index: i }) }, it.fix) : null)
      }))
      sum.textContent = sp.summary || (sp.done ? '' : 'Checking…')
      again.disabled = !sp.done
    }
    draw()
    const box = h('div', { class: 'dialog ask-dialog wide', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': tid },
      xBtn(() => answer({ cancel: true })),
      h('div', null, h('h3', { id: tid, text: sp.title || 'Check everything' }),
        h('p', { text: sp.message || 'A quick look at everything Switcher looks after on this PC.' })),
      list, sum,
      h('div', { class: 'actions' }, again, done))
    return { box, focus: () => done.focus(), update: (next) => { sp = next; draw() } }
  }

  function askPop(id) { return stack.find((p) => p.askId === id) || null }

  function buildAsk(id, spec, answer) {
    if (spec.kind === 'confirm') {
      const box = confirmBox(spec, (d) => answer(d || { cancel: true }))
      return { box, cancel: box.closeAsk, focus: () => { const b = box.querySelector('.actions .btn.primary'); if (b) b.focus() } }
    }
    if (spec.kind === 'pick') {
      return pickBox(spec, Array.isArray(spec.items) ? spec.items : [], (it) => answer({ index: it.i }), () => answer({ cancel: true }))
    }
    if (spec.kind === 'account') {
      const tid = uid()
      const look = lookForm({ label: spec.label || '', color: spec.color, icon: spec.icon, clearable: true,
        nameLabel: 'Name (optional)', placeholder: spec.placeholder || 'Work, Personal, Client…',
        hint: spec.hint || 'Leave it empty to use the name from your email after you sign in.' })
      const box = h('div', { class: 'dialog ask-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': tid },
        xBtn(() => answer({ cancel: true })),
        h('div', { class: 'dlg-head' }, look.preview,
          h('div', null, h('h3', { id: tid, text: spec.title || 'Add an account' }),
            h('p', { text: spec.prompt || 'How it looks in VS Code. You can change it any time.' }))),
        look.fields,
        h('div', { class: 'actions' }, h('button', { class: 'btn ghost', onclick: () => answer({ cancel: true }) }, 'Cancel'),
          h('button', { class: 'btn primary', onclick: () => {
            const v = look.values()
            if (v.label.length > 40) { look.err.textContent = 'Use 40 characters or fewer.'; look.input.focus(); return }
            answer({ value: v.label, color: v.color, icon: v.icon })
          } }, spec.confirmLabel || 'Next')))
      return { box, focus: () => look.input.focus() }
    }
    if (spec.kind === 'signin') return signinBox(id, spec, answer)
    if (spec.kind === 'checks') return checksBox(spec, answer)
    const tid = uid()
    const fid = uid()
    const heading = spec.title || spec.prompt || 'Claude Accounts'
    const sub = spec.title ? spec.prompt : null
    const field = h('input', { id: fid, type: spec.password ? 'password' : 'text', value: spec.value || '',
      placeholder: spec.placeholder || '', autocomplete: 'off', spellcheck: 'false', 'aria-label': heading })
    const err = h('div', { class: 'err', 'aria-live': 'polite', text: spec.error || '' })
    const box = h('div', { class: 'dialog ask-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': tid },
      xBtn(() => answer({ cancel: true })),
      h('div', null, h('h3', { id: tid, text: heading }), sub ? h('p', { text: sub }) : null),
      h('div', { class: 'field' }, field, err),
      h('div', { class: 'actions' },
        h('button', { class: 'btn ghost', onclick: () => answer({ cancel: true }) }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: () => answer({ value: field.value }) }, 'OK')))
    return { box, focus: () => { field.focus(); field.select() } }
  }

  function showAsk(id, spec) {
    if (!spec || typeof spec !== 'object') return
    const open = askPop(id)
    if (open) { if (open.update && !open.done) open.update(spec); return }
    let pop = null
    let answered = false
    const answer = (data) => {
      if (answered || !pop) return
      answered = true
      send('answer', Object.assign({ id }, data))
      settle(pop, !!(data.cancel || data.closed))
    }
    const built = buildAsk(id, spec, answer)
    const top = stack[stack.length - 1]
    const o = { askId: id, cancel: built.cancel || (() => answer({ cancel: true })), sticky: !!built.sticky }
    pop = top && top.askId && top.done ? swapPop(top, built.box, o) : openPop(built.box, o)
    pop.update = built.update || null
    if (built.focus) built.focus()
  }
  function settle(pop, atOnce) {
    if (pop.done) return
    pop.done = true
    if (atOnce) { closePop(pop); return }
    pop.box.classList.add('waiting')
    pop.timer = setTimeout(() => closePop(pop), 400)
  }

  const NOTE_MS = 12000
  let noteStack = null
  function showNote(n) {
    if (!n || typeof n.id !== 'number' || (noteStack && noteStack.querySelector('[data-note="' + n.id + '"]'))) return
    if (!noteStack) { noteStack = h('div', { class: 'note-stack', role: 'status', 'aria-live': 'polite' }); document.body.appendChild(noteStack) }
    const buttons = Array.isArray(n.buttons) ? n.buttons : []
    const tone = n.tone === 'error' ? 'bad' : n.tone === 'warn' ? 'warn' : 'info'
    const done = (label) => { dropNote(n.id); send('note', { id: n.id, label }) }
    const el = h('div', { class: 'note ' + tone, 'data-note': String(n.id) },
      h('span', { class: 'i' }, icon(tone === 'info' ? 'info' : 'alert', 'sm')),
      h('div', { class: 'grow' }, h('div', { class: 'note-text', text: String(n.text || '') }),
        buttons.length ? h('div', { class: 'note-actions' }, buttons.map((b, i) =>
          h('button', { class: 'btn sm ' + (i === 0 ? 'primary' : 'ghost'), onclick: () => done(b) }, b))) : null),
      h('button', { class: 'icon-btn note-x', title: 'Close', 'aria-label': 'Close this notice', onclick: () => done(null) }, icon('x', 'sm')))
    noteStack.appendChild(el)
    if (!buttons.length) setTimeout(() => { if (el.isConnected) done(null) }, NOTE_MS)
  }
  function dropNote(id) {
    const el = noteStack && noteStack.querySelector('[data-note="' + id + '"]')
    if (el) el.remove()
  }

  function openEdit(a) {
    const tid = uid()
    const look = lookForm({ name: a.name, label: a.label, color: a.color, icon: a.icon })
    const save = () => {
      const v = look.values()
      if (!v.label || v.label.length > 40) { look.err.textContent = 'Enter 1–40 characters.'; look.input.focus(); return }
      send('edit', { name: a.name, label: v.label, icon: v.icon, color: v.color })
      closeEdit()
    }
    showDialog(h('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': tid },
      h('div', { class: 'dlg-head' }, look.preview,
        h('div', null, h('h3', { id: tid, text: 'Edit account' }),
          h('p', { text: 'Changes how “' + a.name + '” appears in VS Code. The Claude account itself isn’t changed.' }))),
      look.fields,
      h('div', { class: 'actions' },
        h('button', { class: 'btn ghost', onclick: closeEdit }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: save }, 'Save'))))
    look.input.focus()
    look.input.select()
  }
  function requestSwitch(a) {
    const live = (state.accounts || []).find((x) => x.active)
    const other = pref('confirmOrgSwitch') && live && live.orgId && a.orgId && live.orgId !== a.orgId
    if (!other) { send('switch', { name: a.name }, 'switch:' + a.name); return }
    orgSwitchDialog(a)
  }

  function orgSwitchDialog(a) {
    const tid = uid()
    const dontAsk = h('input', { type: 'checkbox', id: 'org-dont-ask' })
    const go = () => {
      send('switch', { name: a.name, confirmed: true, dontAsk: dontAsk.checked }, 'switch:' + a.name)
      closeEdit()
    }
    const box = h('div', { class: 'dialog org-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': tid },
      xBtn(closeEdit),
      h('div', { class: 'dlg-head' }, avatar(a, 'avatar lg'),
        h('div', null, h('h3', { id: tid, text: a.label + ' is in another organization' }))),
      h('p', { class: 'org-why' },
        'Chats that continue there can’t use Claude’s earlier thinking or cache, so the whole chat is read again and uses more tokens. ',
        h('a', { href: '#', onclick: (e) => { e.preventDefault(); send('learnMore') } }, 'Learn more')),
      h('label', { class: 'check', for: 'org-dont-ask' }, dontAsk, h('span', { text: 'Don’t ask again' })),
      h('div', { class: 'actions' },
        h('button', { class: 'btn ghost', onclick: closeEdit }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: go }, icon('swap', 'sm'), 'Switch')))
    showDialog(box)
    box.querySelector('.btn.primary').focus()
  }

  function openPinPanel(name) {
    const box = h('div', { class: 'dialog pin-panel', role: 'dialog', 'aria-modal': 'true' })
    const pop = showDialog(box, { refresh: () => draw() })
    let drawn = ''
    const draw = () => {
      const a = accountByName(name)
      if (!a) { closePop(pop); return }
      const { chats, folders } = pinsOf(name)
      const ok = pinningOk(a)
      const left = a.pinning ? loginLeft(a.pinning.expiresAt) : null
      const movable = ((state && state.accounts) || []).some((x) => x.name !== name && pinningOk(x))
      const sig = JSON.stringify([a.label, a.email, a.color, a.icon, a.name, a.pinning || null, 'pinning' in a, left, chats, folders, movable])
      if (sig === drawn) return
      drawn = sig
      const had = box.contains(document.activeElement) ? keyOf(document.activeElement) : null
      const tid = uid()
      box.setAttribute('aria-labelledby', tid)
      const hasField = 'pinning' in a
      const loginBox = !hasField ? null : h('div', { class: 'pp-login ' + (!a.pinning ? 'none' : left ? left.level : '') },
        h('span', { class: 'pp-ico', 'aria-hidden': 'true' }, icon(ok ? 'signin' : 'alert', 'sm')),
        h('div', { class: 'grow' },
          h('strong', { text: !a.pinning ? 'No pinning login yet' : ok ? 'Pinning login · ' + left.text + ' left' : 'The pinning login has ended' }),
          h('div', { class: 'muted', text: !a.pinning
            ? 'Pinning needs a second login for ' + a.label + ', so pinned chats never sign out your other chats.'
            : ok ? 'A second login, just for pinned chats and folders. It never signs out your other chats.'
              : 'Its pinned chats and folders use the active account until you sign in again.' })),
        !a.pinning
          ? h('button', { class: 'btn primary sm', 'data-fk': 'pp:add', onclick: () => send('addPinning', { name }) }, 'Add account for pinning')
          : h('button', { class: 'btn ' + (ok && left.level !== 'warn' ? 'soft' : 'primary') + ' sm', 'data-fk': 'pp:signin',
            onclick: () => send('addPinning', { name }) }, 'Sign in again'))
      const moveBtn = (what, label, key) => h('button', { class: 'btn ghost sm', 'data-fk': key, disabled: movable ? null : true,
        title: movable ? 'Move to another account' : 'No other account has a pinning login yet',
        'aria-label': 'Move ' + label + ' to another account', onclick: () => movePinDialog(what, label, name) }, 'Move')
      const unpinBtn = (fn, label, key) => h('button', { class: 'btn soft-danger sm', 'data-fk': key, 'aria-label': 'Unpin ' + label, onclick: fn }, 'Unpin')
      const rows = [
        ...chats.map((c) => {
          const title = c.title || 'Untitled chat'
          return h('div', { class: 'pp-row' + (c.waiting ? ' waiting' : '') },
            h('span', { class: 'pp-kind', 'aria-hidden': 'true' }, icon('chat', 'sm')),
            h('div', { class: 'grow' }, h('span', { class: 't', title, text: title }),
              c.waiting ? null : h('span', { class: 's', text: 'Chat' + (c.ready === false ? ' · needs a pinning login' : '') })),
            h('div', { class: 'row-btns' },
              c.waiting ? null : moveBtn({ id: c.id }, title, 'pp:move:' + c.id),
              unpinBtn(() => send('unpinChat', { id: c.id }), title, 'pp:unpin:' + c.id)),
            c.waiting ? waitStrip(c, 'pp:reopen:' + c.id) : null)
        }),
        ...folders.map((p) => h('div', { class: 'pp-row' },
          h('span', { class: 'pp-kind', 'aria-hidden': 'true' }, icon('folder', 'sm')),
          h('div', { class: 'grow' }, h('span', { class: 't path', title: p.folder, text: p.folder }),
            h('span', { class: 's', text: 'Folder' + (p.here ? ' · this window' : '') + (p.ready === false ? ' · needs a pinning login' : '') })),
          h('div', { class: 'row-btns' }, moveBtn({ folder: p.folder }, folderName(p.folder), 'pp:move:' + p.folder),
            unpinBtn(() => send('unpin', { folder: p.folder }), p.folder, 'pp:unpin:' + p.folder)))),
      ]
      box.replaceChildren(...[
        xBtn(() => closePop(pop)),
        h('div', { class: 'dlg-head' }, avatar(a, 'avatar lg'),
          h('div', null, h('h3', { id: tid }, 'Pinning for ' + a.label), h('p', { text: a.email || a.name }))),
        loginBox,
        h('div', { class: 'pp-section' },
          h('div', { class: 'pp-head', text: rows.length ? 'Pinned to ' + a.label + ' (' + rows.length + ')' : 'Nothing pinned yet' }),
          rows.length ? h('div', { class: 'pp-list' }, rows)
            : h('p', { class: 'pp-empty', text: 'Pin a chat or a folder to run it on ' + a.label + ', whichever account is active.' })),
        h('div', { class: 'actions' },
          h('button', { class: 'btn ghost', 'data-fk': 'pp:folder', onclick: () => send('pin', { name }) }, icon('folder', 'sm'), 'Pin a folder'),
          h('button', { class: 'btn primary', 'data-fk': 'pp:chat', onclick: () => send('pinChat', { name }) }, icon('chat', 'sm'), 'Pin a chat')),
      ].filter(Boolean))
      fitActions(box)
      if (had) restoreFocus({ el: null, key: had })
      if (had && !box.contains(document.activeElement)) { const b = box.querySelector('.actions .btn.primary'); if (b) b.focus({ preventScroll: true }) }
    }
    draw()
    const first = box.querySelector('.actions .btn.primary')
    if (first) first.focus()
  }

  function movePinDialog(what, label, from) {
    const options = ((state && state.accounts) || []).filter((x) => x.name !== from && pinningOk(x))
    const items = options.map((x) => ({ label: x.label, description: 'Pinning login: ' + loginLeft(x.pinning.expiresAt).text + ' left', account: x.name }))
    const p = pickBox({ title: 'Move “' + label + '”', placeholder: 'To which account? Only accounts with a pinning login can take it.' }, items,
      (it) => { closePop(pop); send('movePin', Object.assign({ to: it.account }, what)) }, () => closePop(pop))
    const pop = showDialog(p.box)
    p.focus()
  }

  function reopenNowDialog(c) {
    const box = confirmBox({ title: 'Reopen “' + (c.title || 'this chat') + '” now?',
      message: 'Claude is still replying in this chat. Reopening now stops the reply, and the work in progress will be interrupted.',
      buttons: ['Reopen now'] }, (d) => { closePop(pop); if (d) send('reopenNow', { id: c.id }) })
    const pop = showDialog(box)
    box.querySelector('.actions .btn.primary').focus()
  }

  const TOUR = [
    { id: 'cards', sel: '.grid .card', title: 'Your accounts',
      text: 'Each card shows an account’s limits as they change; point at its name for how long its logins last. The highlighted one is the active account: the one Claude Code is using now.' },
    { id: 'switch', sel: '.switch-btn', title: 'Switch in a click',
      text: 'Open chats carry on with the new account from their next message. No reload, nothing lost.' },
    { id: 'plan', sel: '.plan-badge', title: 'Plan at a glance',
      text: 'Free, Pro, Max, Ultra or Team. The status bar also shows how many days each login has left.' },
    { id: 'pinbtn', sel: '.grid .pin-btn', title: 'Each account’s pins',
      text: 'The blue pin opens what’s pinned to the account and its pinning login. The number counts its pinned chats and folders.' },
    { id: 'pins', sel: '.tools .t-pins', title: 'Pin a chat or a folder',
      text: 'Give one chat, or every window of a folder, an account of its own, while the rest follow your switches.' },
    { id: 'auto', sel: '.ac-steps', title: 'Never stuck at a limit',
      text: 'When a chat hits its limit, it can switch account or wait for the reset, then carry on by itself.' },
    { id: 'settings', sel: '[data-menu="settings:x"]', title: 'Make it yours',
      text: 'Choose what the cards show, check that everything works, and take this tour again from here any time.' },
  ]

  let tour = null
  let welcomed = false

  function welcomeArt() {
    return h('div', { class: 'welcome-art', 'aria-hidden': 'true' },
      window.__LOGO__ ? h('img', { class: 'wa-logo', src: window.__LOGO__, alt: '' }) : null,
      h('span', { class: 'wa a' }, icon('swap')), h('span', { class: 'wa b' }, icon('chat')), h('span', { class: 'wa c' }, icon('pin')))
  }

  function maybeWelcome() {
    const w = state && state.welcome
    if (welcomed || !w || stack.length || menu) return
    welcomed = true
    const done = (toured) => send('welcomeDone', { kind: w.kind, version: w.version || null, toured })
    const take = (steps) => { closeEdit(); done(true); setTimeout(() => startTour(steps), 180) }
    const skip = () => { closeEdit(); done(false) }
    const tid = uid()
    let box
    if (w.kind === 'update') {
      const items = Array.isArray(w.items) ? w.items : []
      const steps = TOUR.filter((t) => items.some((i) => i.step === t.id))
      box = h('div', { class: 'dialog welcome', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': tid },
        xBtn(skip),
        welcomeArt(),
        h('div', { class: 'welcome-badge', text: 'Updated to ' + (w.version || 'a new version') }),
        h('h3', { id: tid, text: 'What’s new' }),
        h('ul', { class: 'whats-new' }, items.map((i) => h('li', { title: i.text || null },
          h('span', { class: 'wn-ico', 'aria-hidden': 'true' }, icon(i.icon || 'check', 'sm')),
          h('span', { class: 'wn-title', text: i.title })))),
        h('div', { class: 'actions' },
          h('button', { class: 'btn ghost', onclick: skip }, 'Got it'),
          steps.length ? h('button', { class: 'btn primary', onclick: () => take(steps) }, 'Show me', h('span', { class: 'btn-note', text: '30 sec' })) : null))
    } else {
      box = h('div', { class: 'dialog welcome', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': tid },
        xBtn(skip),
        welcomeArt(),
        h('h3', { id: tid, text: 'Welcome to Switcher for Claude Code' }),
        h('p', { class: 'welcome-text', text: 'Keep all your Claude accounts in one place. See every account’s limits, switch in a click, ' +
          'give folders and chats their own account, and keep chats going when a limit hits.' }),
        state.checklist ? h('div', { class: 'welcome-steps' }, h('div', { class: 'ws-title', text: 'Three steps to get going' }), checklistList(false)) : null,
        h('div', { class: 'actions' },
          h('button', { class: 'btn ghost', onclick: skip }, 'Skip'),
          h('button', { class: 'btn primary', onclick: () => take(TOUR) }, 'Take the tour', h('span', { class: 'btn-note', text: '1 min' }))),
        h('p', { class: 'welcome-foot', text: 'You can take it later from the ⚙ menu.' }))
    }
    showDialog(box, { cancel: skip })
    const first = box.querySelector('.btn.primary') || box.querySelector('.btn.ghost')
    if (first) first.focus()
  }

  function startTour(steps) {
    endTour()
    closeMenu(false)
    const layer = h('div', { class: 'tour', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Tour' })
    const spot = h('div', { class: 'tour-spot', 'aria-hidden': 'true' })
    const tip = h('div', { class: 'tour-tip', role: 'document' })
    layer.append(spot, tip)
    document.body.append(layer)
    tour = { steps: steps.slice(), at: 0, layer, spot, tip }
    tourGo(0, 1)
  }

  function tourTarget(step) {
    const el = app.querySelector(step.sel)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return r.width && r.height ? el : null
  }

  function tourGo(i, dir) {
    if (!tour) return
    const d = dir || (i >= tour.at ? 1 : -1)
    while (i >= 0 && i < tour.steps.length && !tourTarget(tour.steps[i])) i += d
    if (i >= tour.steps.length) { endTour(); return }
    if (i < 0) return
    tour.at = i
    tourTarget(tour.steps[i]).scrollIntoView({ block: 'center', behavior: 'smooth' })
    drawTip()
    placeTour()
    setTimeout(placeTour, 300)
  }

  function drawTip() {
    const t = tour
    const shown = t.steps.filter((s) => tourTarget(s))
    const n = shown.indexOf(t.steps[t.at]) + 1
    const last = !t.steps.slice(t.at + 1).some((s) => tourTarget(s))
    const step = t.steps[t.at]
    t.tip.replaceChildren(
      h('div', { class: 'tour-head' }, h('span', { class: 'tour-count', text: n + ' of ' + shown.length }),
        h('button', { class: 'icon-btn', title: 'End the tour', 'aria-label': 'End the tour', onclick: endTour }, icon('x', 'sm'))),
      h('strong', { class: 'tour-title', text: step.title }),
      h('p', { class: 'tour-text', text: step.text }),
      h('div', { class: 'tour-dots', 'aria-hidden': 'true' }, shown.map((s, k) => h('i', { class: k === n - 1 ? 'on' : null }))),
      h('div', { class: 'tour-actions' },
        n > 1 ? h('button', { class: 'btn ghost sm', onclick: () => tourGo(t.at - 1, -1) }, 'Back') : h('span'),
        h('button', { class: 'btn primary sm', onclick: () => tourGo(t.at + 1, 1) }, last ? 'Done' : 'Next')))
    const next = t.tip.querySelector('.btn.primary')
    if (next) next.focus({ preventScroll: true })
  }

  function placeTour() {
    if (!tour) return
    const el = tourTarget(tour.steps[tour.at])
    if (!el) { tourGo(tour.at, 1); return }
    const r = el.getBoundingClientRect()
    const pad = 6
    Object.assign(tour.spot.style, { left: (r.left - pad) + 'px', top: (r.top - pad) + 'px',
      width: (r.width + pad * 2) + 'px', height: (r.height + pad * 2) + 'px' })
    const vw = document.documentElement.clientWidth
    const vh = document.documentElement.clientHeight
    const tip = tour.tip
    const w = Math.min(300, vw - 24)
    tip.style.width = w + 'px'
    const ht = tip.offsetHeight
    const below = r.bottom + pad + 12
    const top = below + ht <= vh - 8 ? below : Math.max(8, r.top - pad - 12 - ht)
    const left = Math.max(12, Math.min(r.left + r.width / 2 - w / 2, vw - w - 12))
    tip.style.left = left + 'px'
    tip.style.top = top + 'px'
  }

  function endTour() {
    if (!tour) return
    const t = tour
    tour = null
    t.layer.classList.add('closing')
    setTimeout(() => t.layer.remove(), 150)
  }

  window.addEventListener('resize', () => placeTour())
  window.addEventListener('scroll', () => placeTour(), { passive: true })

  const CV_BOXES = '.card, .banner, .pin-row, .ac-row, .empty, .getting-started'
  const CV_OUT = 100
  const CV_IN = 200
  const CV_TIME = 310
  const docEl = document.documentElement
  let cvLocal = null
  let cvAnim = null
  let cvPending = false

  function compactWanted() { return cvLocal ? cvLocal.on : pref('compact') === true }
  function reducedMotion() {
    return document.body.classList.contains('vscode-reduce-motion') ||
      (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches)
  }
  function paintCompactButton(btn) {
    const on = compactWanted()
    const what = on ? 'Comfortable view' : 'Compact view'
    btn.setAttribute('aria-pressed', String(on))
    btn.title = what
    btn.setAttribute('aria-label', 'Compact view')
    btn.replaceChildren(icon(on ? 'unfold' : 'fold', 'sm'))
    return btn
  }
  function compactButton() {
    return paintCompactButton(h('button', { class: 'btn soft tool-btn icon-only cv-toggle', 'data-fk': 'compactView', onclick: () => toggleCompact() }))
  }
  function toggleCompact() {
    const on = !compactWanted()
    cvLocal = { on, at: Date.now() }
    send('setting', { key: 'compact', value: on })
    app.querySelectorAll('.cv-toggle').forEach(paintCompactButton)
    if (!reducedMotion() && pref('listView') !== true) { cvStart(on); return }
    cvEnd()
    docEl.classList.toggle('compact-view', on)
    fitBadges()
  }

  function cvMeasure(boxes) {
    return boxes.map((el) => {
      const box = el.getBoundingClientRect()
      let bottom = box.top
      for (const c of el.children) {
        if (getComputedStyle(c).position === 'absolute') continue
        const r = c.getBoundingClientRect()
        if (r.height) bottom = Math.max(bottom, r.bottom)
      }
      return { h: box.height, e: bottom - box.top }
    })
  }
  const easeInOut = (k) => (p) => (p < 0.5 ? Math.pow(2 * p, k) / 2 : 1 - Math.pow(2 - 2 * p, k) / 2)
  const easeOut = (k) => (p) => 1 - Math.pow(1 - p, k)
  const order = (k) => Math.min(60, Math.max(3, k))

  function cvStart(on) {
    const start = performance.now()
    const prev = cvAnim
    if (prev) cancelAnimationFrame(prev.raf)
    const boxes = [...app.querySelectorAll(CV_BOXES)]
    const from = boxes.map((el) => el.getBoundingClientRect().height)
    const was = docEl.classList.contains('compact-view')
    const cvo = prev ? prev.cvo : was ? 1 : 0
    const opacity = prev ? prev.opacity : 1
    for (const el of prev ? prev.boxes : boxes) { el.style.removeProperty('height'); el.style.removeProperty('min-height') }
    docEl.style.removeProperty('--cvo')
    const now = cvMeasure(boxes)
    docEl.classList.toggle('compact-view', on)
    fitFoot()
    const then = cvMeasure(boxes)
    docEl.classList.toggle('compact-view', was)
    fitFoot()
    const swap = was !== on
    const tf = swap ? opacity * CV_OUT : 0
    const a = tf / CV_TIME
    let m = 1
    let n = 0
    boxes.forEach((el, i) => {
      const s = from[i]
      const to = then[i].h
      if (to < s - 0.5) m = Math.min(m, (s - now[i].e) / (s - to))
      else if (to > s + 0.5) n = Math.max(n, (then[i].e - s) / (to - s))
    })
    const kIn = a > 0 && m < 0.5 ? (m > 0 ? Math.log(2 * 0.9 * m) / Math.log(2 * a) : 60) : 3
    const kOut = a > 0 && n > 0 ? (n < 1 ? Math.log(0.9 * (1 - n)) / Math.log(1 - a) : 60) : 3
    cvAnim = { on, swap, tf, start, boxes, from, to: then.map((x) => x.h),
      shrink: easeInOut(order(kIn)), grow: easeOut(order(kOut)), k: [order(kIn), order(kOut)], m, n,
      cvo0: cvo, cvo, opacity0: opacity, opacity, raf: 0 }
    for (const el of boxes) el.style.minHeight = '0px'
    docEl.classList.add('cv-anim')
    cvFrame()
  }
  function cvFrame() {
    const A = cvAnim
    if (!A) return
    const t = performance.now() - A.start
    const p = Math.min(1, t / CV_TIME)
    if (A.swap && t >= A.tf && docEl.classList.contains('compact-view') !== A.on) {
      docEl.classList.toggle('compact-view', A.on)
      fitFoot()
      fitBadges()
    }
    A.opacity = A.swap && t < A.tf ? A.opacity0 * (1 - t / A.tf) : Math.min(1, (A.swap ? 0 : A.opacity0) + (t - A.tf) / CV_IN)
    A.cvo = A.cvo0 + ((A.on ? 1 : 0) - A.cvo0) * (A.on ? A.shrink : A.grow)(p)
    docEl.style.setProperty('--cv-o', A.opacity.toFixed(3))
    docEl.style.setProperty('--cvo', A.cvo.toFixed(4))
    A.boxes.forEach((el, i) => {
      const f = A.from[i]
      const to = A.to[i]
      el.style.height = (f + (to - f) * (to < f ? A.shrink : A.grow)(p)).toFixed(2) + 'px'
    })
    if (p >= 1 && A.opacity >= 1) cvEnd()
    else A.raf = requestAnimationFrame(cvFrame)
  }
  function cvEnd() {
    const A = cvAnim
    if (!A) return
    cancelAnimationFrame(A.raf)
    cvAnim = null
    if (docEl.classList.contains('compact-view') !== A.on) { docEl.classList.toggle('compact-view', A.on); fitFoot() }
    docEl.classList.remove('cv-anim')
    docEl.style.removeProperty('--cv-o')
    docEl.style.removeProperty('--cvo')
    for (const el of A.boxes) { el.style.removeProperty('height'); el.style.removeProperty('min-height') }
    fitBadges()
    if (cvPending) { cvPending = false; requestAnimationFrame(() => renderSafely()) }
  }

  function render() {
    if (!state) return
    if (cvAnim) { cvPending = true; return }
    docEl.classList.toggle('compact-view', compactWanted())
    docEl.classList.toggle('no-validity', pref('validity') === false)
    docEl.classList.toggle('list-view', pref('listView') === true)
    const s = state
    const updating = s.updating || busy.has('update')
    const accounts = s.accounts || []

    const toolbar = h('div', { class: 'toolbar' },
      h('button', { class: 'btn ghost icon-only', disabled: updating || null, 'data-fk': 'update', title: updating ? 'Updating…' : 'Update usage',
        'aria-label': updating ? 'Updating…' : 'Update usage', onclick: () => send('update', null, 'update') },
      icon('refresh', updating ? 'sm spin' : 'sm')),
      h('button', { class: 'btn primary', 'data-fk': 'add', onclick: () => send('add') }, icon('plus', 'sm'), 'Add account'),
      h('button', { class: 'btn ghost icon-only', 'data-menu': 'settings:x', title: 'Settings', 'aria-label': 'Settings',
        'aria-haspopup': 'menu', 'aria-expanded': 'false', onclick: (e) => toggleMenu('settings', 'x', e.currentTarget, e) }, icon('gear', 'sm')))

    const page = [
      SIDEBAR
        ? h('header', { class: 'top' }, toolbar)
        : h('header', { class: 'top' },
          h('div', { class: 'top-text' }, h('h1', { text: 'Switcher for Claude Code' }),
            h('p', { text: 'Switch Claude accounts in a click, or pin a chat or folder to an account of its own' })),
          toolbar),
      ...banners(),
      thisChat(),
      checklistCard(),
      h('section', { class: 'accounts' },
        h('div', { class: 'section-head' },
          h('h2', { text: 'Accounts' }),
          s.tracking ? null : h('span', { class: 'note', text: 'Usage tracking is off' }),
          null),
        accounts.length
          ? [tools(accounts), results()]
          : h('div', { class: 'empty' }, h('strong', { text: 'No saved accounts yet' }),
            h('span', { text: 'Add an account, or save the one you’re signed in to now.' }))),
      pinsSection(),
      autoContinueSection(),
      h('footer', { class: 'foot' },
        SIDEBAR
          ? h('button', { class: 'linkbtn', 'data-fk': 'foot:view', onclick: () => send('openTab') }, 'Open as a Tab')
          : h('button', { class: 'linkbtn', 'data-fk': 'foot:view', onclick: () => send('openSidebar') }, 'Show in Sidebar'),
        h('button', { class: 'linkbtn', 'data-fk': 'foot:config', onclick: () => send('openConfig') }, 'Open Settings File')),
    ]
    const had = app.contains(document.activeElement) ? keyOf(document.activeElement) : null
    const before = slideCapture(app, SLIDE_PAGE)
    app.replaceChildren(...page.filter(Boolean))
    fitWhensNow()
    settleDraw()
    slideRun(app, SLIDE_PAGE, before)
    if (had) {
      const again = app.querySelector('[data-fk="' + CSS.escape(had) + '"], [data-menu="' + CSS.escape(had) + '"]')
      if (again) again.focus({ preventScroll: true })
    }

    if (!rendered) {
      app.classList.add('enter')
      setTimeout(() => app.classList.remove('enter'), 260)
    }
    reattachMenu()
    const live = accounts.find((a) => a.active)
    lastLive = live ? live.name : null
    rendered = true
    if (tour) placeTour()
    else maybeWelcome()
  }

  function tick() {
    document.querySelectorAll('.when[data-when]').forEach((el) => {
      const raw = el.getAttribute('data-when')
      setWhen(el, raw ? JSON.parse(raw) : null)
    })
    app.querySelectorAll('.card[data-named]').forEach((el) => {
      const pin = el.dataset.pin === undefined ? null : el.dataset.pin === '' ? '' : Number(el.dataset.pin)
      const days = loginWords(el.dataset.main ? Number(el.dataset.main) : null, pin)
      el.setAttribute('aria-label', el.dataset.named + (days ? '. ' + days : ''))
      const head = el.querySelector('.card-head')
      if (head && days) head.title = days
      const nm = el.querySelector('.card-head .name')
      if (nm) nm.title = [nm.dataset.who || '', days || ''].filter(Boolean).join('\n')
    })
    app.querySelectorAll('svg.vstroke').forEach(drawStroke)
    app.querySelectorAll('.fresh[data-at]').forEach((el) => paintFresh(el, Number(el.dataset.at)))
    fitWhens()
  }
  setInterval(tick, 30000)

  function shapeOf(s) {
    const strip = (l) => (l ? { model: l.model || null } : null)
    return JSON.stringify(Object.assign({}, s, { now: 0, updating: false, accounts: (s.accounts || []).map((a) =>
      Object.assign({}, a, { session: strip(a.session), weekly: strip(a.weekly), scoped: strip(a.scoped), fetchedAtMs: 0, extra: null })) }))
  }

  document.addEventListener('pointerdown', (e) => {
    if (menu && !menu.el.contains(e.target) && !menu.btn.contains(e.target)) closeMenu(false)
  })
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (tour) endTour()
      else if (stack.length) { e.preventDefault(); cancelPop(stack[stack.length - 1]) }
      else closeMenu(true)
      return
    }
    if (tour && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) { tourGo(tour.at + (e.key === 'ArrowRight' ? 1 : -1)); return }
    if (stack.length && !tour) {
      const top = stack[stack.length - 1]
      if (e.key === 'Enter' && !e.defaultPrevented && !e.isComposing && top.box.contains(e.target)) {
        if (e.target.closest('button, a, summary, select, textarea')) return
        const main = top.box.querySelector('.actions .btn.primary')
        if (main && !main.disabled) { e.preventDefault(); main.click() }
        return
      }
      if (e.key === 'Tab') { trapTab(top.box, e); return }
    }
    if (!menu || !menu.el.contains(document.activeElement)) return
    const items = [...menu.el.querySelectorAll('[role^="menuitem"]')]
    if (!items.length) return
    const i = items.indexOf(document.activeElement)
    const go = { ArrowDown: i + 1, ArrowUp: i === -1 ? items.length - 1 : i - 1, Home: 0, End: items.length - 1 }[e.key]
    if (go === undefined) return
    e.preventDefault()
    items[(go + items.length) % items.length].focus()
  })
  window.addEventListener('resize', () => { cvEnd(); place(); fitBadges(); const top = stack[stack.length - 1]; if (top) fitActions(top.box) })
  window.addEventListener('scroll', () => place(), { passive: true })

  window.addEventListener('message', (e) => {
    const msg = e.data
    if (msg && msg.type === 'note') { showNote(msg); return }
    if (msg && msg.type === 'noteDone') { dropNote(msg.id); return }
    if (msg && msg.type === 'ask') { showAsk(msg.id, msg.spec); return }
    if (msg && msg.type === 'askDone') { const p = askPop(msg.id); if (p) settle(p, false); return }
    if (!msg || msg.type !== 'state') return
    const json = JSON.stringify(Object.assign({}, msg.state, { now: 0 }))
    const same = json === lastJson && !busy.size
    state = msg.state
    receivedAt = Date.now()
    lastJson = json
    busy.clear()
    if (cvLocal && (pref('compact') === cvLocal.on || Date.now() - cvLocal.at > 5000)) cvLocal = null
    if (same) { tick(); return }
    const shape = shapeOf(msg.state)
    const onlyFigures = shape === lastShape
    lastShape = shape
    for (const p of stack) if (p.refresh && !p.box.hidden) p.refresh()
    if (stack.length) return
    if (cvAnim) { cvPending = true; return }
    if (onlyFigures && rendered && patchMeters()) { tick(); return }
    renderSafely()
  })

  function renderSafely() {
    try { render() } catch (err) {
      app.replaceChildren(h('div', { class: 'banner warn' }, icon('alert'),
        h('div', { class: 'grow' }, h('strong', { text: 'This page couldn’t be drawn' }),
          h('div', { class: 'muted', text: String((err && err.message) || err) })),
        h('button', { class: 'btn primary sm', onclick: () => send('openConfig') }, 'Open Settings File'),
        h('button', { class: 'btn ghost sm', onclick: () => send('status') }, 'Show Status')))
    }
  }

  vscode.postMessage({ type: 'ready' })
})()
