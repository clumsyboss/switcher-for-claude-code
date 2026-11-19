(function () {
  'use strict'

  const vscode = acquireVsCodeApi()
  const ICONS = window.__ICONS__ || {}
  const ICON_NAMES = window.__ICON_NAMES__ || {}
  const HAS_FONT = !!window.__HAS_FONT__
  const LAYOUT = window.__LAYOUT__ === 'sidebar' ? 'sidebar' : 'tab'
  const SIDEBAR = LAYOUT === 'sidebar'
  document.body.classList.add('layout-' + LAYOUT)
  const app = document.getElementById('app')

  let state = null
  let lastJson = ''
  let lastShape = ''
  let receivedAt = 0
  const busy = new Set()
  let rendered = false
  let lastLive = null
  let acEditing = false

  const PREF_DEFAULTS = { tint: true, context: false, plan: true, cardToggles: true, statusLoginDays: true,
    statusUsage: true, trackAll: true, accountsView: 'tab', confirmOrgSwitch: true, askSecondLogin: true, compact: false }
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
  function whenShort(limit) { return whenText(limit).replace(/^Resets in /, '') }
  function setWhen(when, limit) {
    const long = when.querySelector('.w-long')
    const short = when.querySelector('.w-short')
    long.textContent = whenText(limit)
    short.textContent = whenShort(limit)
    when.title = long.textContent
  }
  function whenText(limit) {
    if (!limit) return 'No figures yet'
    if (limit.resetSince) return 'Already reset'
    const t = limit.resetsAt ? Date.parse(limit.resetsAt) : NaN
    if (Number.isNaN(t)) return 'Reset time unknown'
    const u = until(t)
    return u ? 'Resets in ' + u : 'Resets any moment'
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
  function betaTag() { return h('span', { class: 'beta', text: 'Beta' }) }
  function headPinButton(key, title, ic, word, onclick) {
    const long = 'Pin ' + word.toLowerCase()
    return h('button', { class: 'btn tint sm', 'data-fk': key, title, 'aria-label': long + ' (Beta)', onclick },
      icon(ic, 'sm'), h('span', { class: 'hb-long', text: long }), h('span', { class: 'hb-short', text: word }),
      h('span', { class: 'beta', 'aria-hidden': 'true' }, h('span', { class: 'hb-long', text: 'Beta' }), h('span', { class: 'hb-short', text: 'B' })))
  }
  function modelName(limit) { return limit && limit.model && limit.model !== 'scoped' ? limit.model : 'Fable' }
  function folderName(p) { return String(p).split(/[\\/]/).filter(Boolean).pop() || String(p) }

  function send(type, data, key) {
    lastJson = ''
    lastShape = ''
    if (key) { busy.add(key); renderSafely() }
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
      : kind === 'ac-mode' ? modeMenu() : kind === 'ac-pick' ? pickMenu() : kind === 'ac-when' ? whenMenu()
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
    const item = (ic, text, fn, cls, beta) => h('button', { role: 'menuitem', class: cls || null, tabindex: '-1',
      onclick: () => { closeMenu(false); fn() } }, icon(ic, 'sm'), h('span', { class: 'grow', text }), beta ? betaTag() : null)
    return h('div', { class: 'menu', role: 'menu', 'aria-label': 'Actions for ' + a.label, tabindex: '-1' },
      item('edit', 'Edit name & icon', () => openEdit(a)),
      item('login', 'Sign in again', () => send('relogin', { name: a.name })),
      'pinning' in a && !pinningOk(a)
        ? item('pin', 'Add account for pinning', () => send('addPinning', { name: a.name }), null, true)
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
      sw('tint', 'Tint cards with their colour'),
      sw('context', 'Context usage on cards', 'The faint grid showing how full the latest chat is'),
      sw('plan', 'Plan and organisation'),
      sw('cardToggles', 'Remote Control and Artifacts switches'),
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

  function meter(key, title, limit, short) {
    const fill = h('i')
    fill.style.width = barWidth.has(key) ? barWidth.get(key) : '0%'
    fill.dataset.key = key
    const el = h('div', { class: 'meter', 'data-key': key },
      h('div', { class: 'row' },
        short ? h('span', { class: 'm-label', title }, h('span', { class: 'm-long', text: title }), h('span', { class: 'm-short', text: short }))
          : h('span', { class: 'm-label', text: title }),
        h('span', { class: 'val' })),
      h('div', { class: 'track', role: 'progressbar', 'aria-label': title, 'aria-valuemin': '0', 'aria-valuemax': '100' }, fill),
      h('div', { class: 'when' }, h('span', { class: 'dot' }), h('span', { class: 'w-long' }), h('span', { class: 'w-short' })))
    fillMeter(el, limit, false)
    return el
  }
  function fillMeter(el, limit, move) {
    const pct = limit ? limit.percent : null
    const fill = el.querySelector('.track > i')
    fill.className = pct === null ? '' : pct >= 95 ? 'bad' : pct >= 80 ? 'warn' : ''
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
  function meterSpecs(a) {
    if (a.needsLogin) return []
    return [
      a.noSession ? null : [a.name + ':5h', '5h Session', a.session, '5h'],
      a.scoped || a.noSession ? [a.name + ':model', modelName(a.scoped), a.scoped] : null,
      [a.name + ':wk', 'Weekly', a.weekly],
    ].filter(Boolean)
  }
  function patchMeters() {
    const els = app.querySelectorAll('.meter[data-key]')
    const specs = new Map((state.accounts || []).flatMap(meterSpecs).map((m) => [m[0], m]))
    if (els.length !== specs.size) return false
    for (const el of els) if (!specs.has(el.dataset.key)) return false
    for (const el of els) fillMeter(el, specs.get(el.dataset.key)[2], true)
    return true
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
    const box = svg.getBoundingClientRect()
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
    const who = [a.email, pref('plan') ? orgText(a.org) : null].filter(Boolean).join(' · ')
    const named = a.label + (a.active ? ' (active account)' : '')
    return h('article', { class: 'card' + (a.active ? ' live' : '') + (justLive ? ' just-live' : '') + (pref('tint') ? ' tinted' : ''),
      style: { '--hue': hueOf(a) }, 'aria-label': named + (days ? '. ' + days : ''), 'data-named': named,
      'data-main': typeof a.loginExpiresAt === 'number' ? String(a.loginExpiresAt) : null, 'data-pin': pinField(a) === null ? null : String(pinField(a)) },
      validityStroke(a),
      h('div', { class: 'card-head', title: days || null }, avatar(a, 'avatar'),
        h('div', { class: 'ident' },
          h('div', { class: 'name-row' }, h('div', { class: 'name', text: a.label, 'data-who': who || null, title: [who, days].filter(Boolean).join('\n') || null }),
            pref('plan') ? planBadge(a.plan) : null),
          h('div', { class: 'sub', text: who || a.name })),
        h('div', { class: 'head-actions' }, startBtn, pinBtn, moreBtn)),
      ctxGrid,
      a.needsLogin
        ? h('div', { class: 'alert', role: 'status' }, icon('alert', 'sm'),
          h('div', { class: 'grow', text: 'This account’s main login has ended.' }),
          h('button', { class: 'btn soft sm signin-btn', title: 'Sign in again', 'aria-label': 'Sign in again to ' + a.label, 'data-fk': 'signin:' + a.name,
            onclick: () => send('relogin', { name: a.name }) }, icon('signin', 'sm'), h('span', { class: 'btn-text', text: 'Sign in again' })))
        : null,
      a.needsLogin ? null : h('div', { class: 'meters' }, meterSpecs(a).map((m) => meter(m[0], m[1], m[2], m[3]))),
      h('div', { class: 'card-foot' },
        pref('cardToggles') ? toggle('Remote Control', 'Remote', !a.remoteOff, 'Remote Control for ' + a.label,
          (on) => send('remote', { name: a.name, on })) : null,
        pref('cardToggles') && s.features && s.features.artifacts
          ? toggle('Artifacts', null, !a.artifactsOff, 'Artifacts for ' + a.label,
            (on) => send('artifacts', { name: a.name, on }))
          : null,
        a.active || a.needsLogin ? null
          : h('button', { class: 'btn primary switch-btn', disabled: switching || null, 'data-fk': 'switch:' + a.name,
            title: 'Switch to ' + a.label, 'aria-label': (switching ? 'Switching to ' : 'Switch to ') + a.label,
            onclick: () => requestSwitch(a) },
          icon(switching ? 'refresh' : 'swap', switching ? 'sm spin' : 'sm'),
          h('span', { class: 'btn-text', text: switching ? 'Switching…' : 'Switch' }))))
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
            'Add account for pinning', betaTag())))
    }
    const needs = s.window && (s.window.needsPinning || s.window.needsKey)
    if (needs && !told.has(needs)) {
      const a = (s.accounts || []).find((x) => x.label === needs)
      out.push(h('div', { class: 'banner warn' }, icon('pin'),
        h('div', { class: 'grow' }, h('strong', { text: 'This folder is pinned to ' + needs + ', which needs a pinning login' }),
          h('div', { class: 'muted', text: 'Chats here use the active account until it has one.' })),
        a ? h('button', { class: 'btn primary sm', 'data-fk': 'banner:needs', onclick: () => send('addPinning', { name: a.name }) },
          'Add account for pinning', betaTag()) : null))
    }
    if (s.window && s.window.pinnedTo) {
      out.push(h('div', { class: 'banner' }, icon('pin'),
        h('div', { class: 'grow' }, h('strong', { text: (SIDEBAR ? 'Pinned to ' : 'This folder is pinned to ') + s.window.pinnedLabel })),
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
      { key: 'pinning', done: accounts.some(pinningOk), text: 'Add a pinning login', optional: true, beta: true,
        act: 'Add', disabled: !mine, run: () => { if (mine) send('addPinning', { name: mine.name }) } },
    ]
  }
  function checklistList(withButtons) {
    return h('ol', { class: 'gs-list' }, checklistItems().map((it, i) => h('li', { class: 'gs-item' + (it.done ? ' done' : '') },
      h('span', { class: 'gs-tick', 'aria-hidden': 'true' }, it.done ? icon('check', 'sm') : String(i + 1)),
      h('span', { class: 'gs-text' }, h('span', { text: it.text }), it.optional ? h('span', { class: 'gs-opt', text: '(optional)' }) : null,
        h('span', { class: 'sr', text: it.done ? ', done' : '' })),
      withButtons && !it.done
        ? h('button', { class: 'btn soft sm', 'data-fk': 'gs:' + it.key, disabled: it.disabled || null, onclick: it.run }, it.act, it.beta ? betaTag() : null)
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
        const r = h('div', { class: 'order-row' + (on ? '' : ' off'), draggable: on ? 'true' : null },
          h('span', { class: 'grip', title: on ? 'Drag to reorder' : null }, on ? icon('grip', 'sm') : null),
          h('span', { class: 'rank', text: on ? String(i + 1) : '' }),
          avatar(a, 'avatar sm'),
          h('div', { class: 'grow' }, h('span', { class: 'nm', text: a.label }), why.length ? h('span', { class: 'who', text: why.join(' · ') }) : null),
          on ? h('button', { class: 'icon-btn order-move', title: 'Earlier', 'aria-label': 'Move ' + a.label + ' earlier', disabled: i === 0 || null,
            onclick: () => move(i, i - 1) }, icon('up', 'sm')) : null,
          on ? h('button', { class: 'icon-btn order-move', title: 'Later', 'aria-label': 'Move ' + a.label + ' later', disabled: i === order.length - 1 || null,
            onclick: () => move(i, i + 1) }, icon('down', 'sm')) : null,
          h('button', { class: 'switch', role: 'switch', 'aria-checked': String(on), 'aria-label': (on ? 'Leave out ' : 'Include ') + a.label,
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
      list.replaceChildren(...order.map((n, i) => row(accounts.find((a) => a.name === n), i)),
        ...accounts.filter((a) => !order.includes(a.name)).map((a) => row(a, null)))
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

  function waitLine(c) {
    return h('span', { class: 'who wait' }, icon('clock', 'sm'), h('span', { text: 'Moves to ' + c.label + ' when this reply finishes' }))
  }

  function pinsSection() {
    const s = state
    const accounts = s.accounts || []
    const rows = (s.pins || []).map((p) => {
      const a = accounts.find((x) => x.name === p.name) || { name: p.name, label: p.label, icon: null }
      return h('div', { class: 'pin-row' },
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
      rows.push(h('div', { class: 'pin-row chat' },
        avatar(a, 'avatar'),
        h('div', { class: 'grow' },
          h('span', { class: 'path ltr', title, text: title }),
          c.waiting ? waitLine(c)
            : h('span', { class: 'who' }, icon('chat', 'sm'), h('span', { text: c.label + ' · chat' + (c.ready === false ? ' · needs a pinning login' : '') }))),
        c.waiting ? h('button', { class: 'btn soft sm', 'data-fk': 'reopen:' + c.id, onclick: () => reopenNowDialog(c) }, 'Reopen now') : null,
        h('button', { class: 'btn soft-danger sm', 'aria-label': 'Unpin the chat ' + title, 'data-fk': 'unpin:' + c.id,
          onclick: () => send('unpinChat', { id: c.id }) }, 'Unpin')))
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
    const betas = Array.isArray(spec.betaButtons) ? spec.betaButtons : []
    const a = spec.account ? accountByName(spec.account) : null
    let check = null
    let field = null
    const extra = () => Object.assign({}, check ? { checked: check.checked } : {}, field ? { text: field.value } : {})
    const title = h('h3', { id: tid }, spec.title || 'Are you sure?', spec.beta ? betaTag() : null)
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
      parts.push(h('div', { class: 'dlg-section' }, sec.title ? h('strong', null, sec.title, sec.beta ? betaTag() : null) : null,
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
          onclick: () => done(Object.assign({ value: b }, extra())) }, b, betas.includes(b) ? betaTag() : null))
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
      h('span', { class: 'ask-text' }, h('span', { class: 'ask-label' }, h('span', { text: it.label }), it.beta ? betaTag() : null),
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
      h('div', null, h('h3', { id: tid }, heading, spec.beta ? betaTag() : null), sub ? h('p', { text: sub }) : null),
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
      h('div', null, h('h3', { id: tid }, spec.title || 'Finish signing in on the browser', spec.beta ? betaTag() : null),
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
          ? h('button', { class: 'btn primary sm', 'data-fk': 'pp:add', onclick: () => send('addPinning', { name }) }, 'Add account for pinning', betaTag())
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
              c.waiting ? waitLine(c) : h('span', { class: 's', text: 'Chat' + (c.ready === false ? ' · needs a pinning login' : '') })),
            h('div', { class: 'row-btns' },
              c.waiting ? h('button', { class: 'btn soft sm', 'data-fk': 'pp:reopen:' + c.id, onclick: () => reopenNowDialog(c) }, 'Reopen now')
                : moveBtn({ id: c.id }, title, 'pp:move:' + c.id),
              unpinBtn(() => send('unpinChat', { id: c.id }), title, 'pp:unpin:' + c.id)))
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
          h('div', null, h('h3', { id: tid }, 'Pinning for ' + a.label, betaTag()), h('p', { text: a.email || a.name }))),
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
    { id: 'pins', sel: '.section-head .head-buttons', title: 'Pin a chat or a folder',
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
    const what = on ? 'Expanded view' : 'Compact view'
    btn.setAttribute('aria-pressed', String(on))
    btn.title = what
    btn.setAttribute('aria-label', 'Compact view')
    btn.replaceChildren(icon(on ? 'unfold' : 'fold', 'sm'))
    return btn
  }
  function compactButton() {
    return paintCompactButton(h('button', { class: 'btn ghost sm icon-only cv-toggle', 'data-fk': 'compactView', onclick: () => toggleCompact() }))
  }
  function toggleCompact() {
    const on = !compactWanted()
    cvLocal = { on, at: Date.now() }
    send('setting', { key: 'compact', value: on })
    app.querySelectorAll('.cv-toggle').forEach(paintCompactButton)
    if (!reducedMotion()) { cvStart(on); return }
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
    const then = cvMeasure(boxes)
    docEl.classList.toggle('compact-view', was)
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
    docEl.classList.toggle('compact-view', A.on)
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
    const s = state
    const updating = s.updating || busy.has('update')
    const accounts = s.accounts || []

    const toolbar = h('div', { class: 'toolbar' },
      h('button', { class: 'btn ghost', disabled: updating || null, 'data-fk': 'update', onclick: () => send('update', null, 'update') },
        icon('refresh', updating ? 'sm spin' : 'sm'), updating ? 'Updating…' : 'Update usage'),
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
      checklistCard(),
      h('section', { class: 'accounts' },
        h('div', { class: 'section-head' },
          h('h2', { text: 'Accounts' }),
          s.tracking ? null : h('span', { class: 'note', text: 'Usage tracking is off' }),
          h('div', { class: 'head-buttons' },
            compactButton(),
            headPinButton('pinChat', 'Run a chat on an account of its own', 'chat', 'Chat', () => send('pinChat')),
            headPinButton('pinFolder', 'Give a folder’s chats an account of their own', 'pin', 'Folder', () => send('pin')))),
        accounts.length
          ? h('div', { class: 'grid' }, accounts.map(card))
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
    app.replaceChildren(...page.filter(Boolean))
    if (had) {
      const again = app.querySelector('[data-fk="' + CSS.escape(had) + '"], [data-menu="' + CSS.escape(had) + '"]')
      if (again) again.focus({ preventScroll: true })
    }

    if (!rendered) {
      app.classList.add('enter')
      setTimeout(() => app.classList.remove('enter'), 260)
    }
    void app.offsetWidth
    app.querySelectorAll('.track > i').forEach((f) => {
      f.style.width = f.dataset.target
      barWidth.set(f.dataset.key, f.dataset.target)
    })
    reattachMenu()
    if (strokeSizes) { strokeSizes.disconnect(); app.querySelectorAll('svg.vstroke').forEach((el) => strokeSizes.observe(el)) }
    else app.querySelectorAll('svg.vstroke').forEach(drawStroke)
    const live = accounts.find((a) => a.active)
    lastLive = live ? live.name : null
    rendered = true
    fitBadges()
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
  }
  setInterval(tick, 30000)

  function shapeOf(s) {
    const strip = (l) => (l ? { model: l.model || null } : null)
    return JSON.stringify(Object.assign({}, s, { now: 0, accounts: (s.accounts || []).map((a) =>
      Object.assign({}, a, { session: strip(a.session), weekly: strip(a.weekly), scoped: strip(a.scoped), fetchedAtMs: 0 })) }))
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
