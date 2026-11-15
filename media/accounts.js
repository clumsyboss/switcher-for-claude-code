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
  let receivedAt = 0
  const busy = new Set()
  let rendered = false
  let lastLive = null
  const barWidth = new Map()

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
    down: '<path d="m6 9 6 6 6-6"/>',
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
  function whenText(limit) {
    if (!limit) return 'No figures yet'
    if (limit.resetSince) return 'Already reset'
    const t = limit.resetsAt ? Date.parse(limit.resetsAt) : NaN
    if (Number.isNaN(t)) return 'Reset time unknown'
    const u = until(t)
    return u ? 'Resets in ' + u : 'Resets any moment'
  }

  function send(type, data, key) {
    lastJson = ''
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
  function openMenu(kind, name, btn, focusIndex) {
    const a = ((state && state.accounts) || []).find((x) => x.name === name)
    const el = kind === 'ac-mode' ? modeMenu() : kind === 'ac-pick' ? pickMenu() : kind === 'ac-when' ? whenMenu()
      : !a ? null : kind === 'pins' ? pinsPopover(a) : actionsMenu(a)
    if (!el) return
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
    openMenu(kind, name, btn, at === -1 ? null : at)
  }

  function actionsMenu(a) {
    const item = (ic, text, fn, cls) => h('button', { role: 'menuitem', class: cls || null, tabindex: '-1',
      onclick: () => { closeMenu(false); fn() } }, icon(ic, 'sm'), text)
    const wl = a.windowLogin
    return h('div', { class: 'menu', role: 'menu', 'aria-label': 'Actions for ' + a.label, tabindex: '-1' },
      item('edit', 'Edit name & icon', () => openEdit(a)),
      item('login', 'Sign in again', () => send('relogin', { name: a.name })),
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
      h('div', { class: 'hint', text: wl && wl.signedIn
        ? 'Window login: signed in' + (wl.email ? ' as ' + wl.email : '')
        : wl ? 'Window login: not finished' : 'Window login: lets you pin folders to this account' }),
      item('window', wl ? (wl.signedIn ? 'Sign window login in again' : 'Finish window login') : 'Set up window login',
        () => send('windowLogin', { name: a.name })),
      wl ? item('x', 'Forget window login', () => send('forgetWindowLogin', { name: a.name })) : null,
      h('hr'),
      item('trash', 'Forget account', () => send('forget', { name: a.name }), 'danger'))
  }

  function pinsPopover(a) {
    const pins = (state.pins || []).filter((p) => p.name === a.name)
    return h('div', { class: 'menu pop', role: 'dialog', 'aria-label': 'Folders pinned to ' + a.label, tabindex: '-1' },
      h('div', { class: 'hint', text: pins.length === 1 ? '1 folder pinned to ' + a.label
        : pins.length + ' folders pinned to ' + a.label }),
      pins.map((p) => h('div', { class: 'pop-folder' }, icon('folder', 'sm'),
        h('span', { class: 'path', title: p.folder, text: p.folder }),
        p.here ? h('span', { class: 'here', text: 'this window' }) : null)))
  }

  function meter(key, title, limit) {
    const pct = limit ? limit.percent : null
    const fill = h('i', { class: pct === null ? '' : pct >= 95 ? 'bad' : pct >= 80 ? 'warn' : '' })
    const target = (pct === null ? 0 : Math.min(100, Math.max(0, pct))) + '%'
    fill.style.width = barWidth.has(key) ? barWidth.get(key) : '0%'
    fill.dataset.target = target
    fill.dataset.key = key
    return h('div', { class: 'meter' },
      h('div', { class: 'row' },
        h('span', { text: title }),
        h('span', { class: 'val', text: pct === null ? '' : pct + '%' })),
      h('div', { class: 'track', role: 'progressbar', 'aria-label': title,
        'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': pct === null ? null : String(pct) }, fill),
      h('div', { class: 'when', 'data-when': limit ? JSON.stringify(limit) : '' },
        h('span', { class: 'dot' }), h('span', { text: whenText(limit), title: whenText(limit) })))
  }

  function toggle(label, short, on, aria, onChange) {
    const sw = h('button', { class: 'switch', role: 'switch', 'aria-checked': String(on), 'aria-label': aria })
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

  function card(a) {
    const s = state
    const switching = busy.has('switch:' + a.name)
    const pins = (s.pins || []).filter((p) => p.name === a.name)
    const pinBtn = pins.length
      ? h('button', { class: 'btn ghost pins', 'data-menu': 'pins:' + a.name, 'aria-haspopup': 'dialog',
        'aria-expanded': 'false', title: 'Pinned folders',
        'aria-label': (pins.length === 1 ? '1 folder' : pins.length + ' folders') + ' pinned to ' + a.label,
        onclick: (e) => { e.stopPropagation(); toggleMenu('pins', a.name, e.currentTarget, e) } },
      icon('pin', 'sm'), String(pins.length))
      : null
    const running = !!(a.session && !a.session.resetSince && a.session.resetsAt && Date.parse(a.session.resetsAt) > now())
    const startBtn = s.features && s.features.startSession && !a.active && !a.needsLogin && !a.noSession
      ? h('button', { class: 'icon-btn start' + (a.keepAlive ? ' keep' : ''), disabled: running || a.starting || null,
        title: (a.starting ? 'Starting a 5-hour session…'
          : running ? 'Session running · resets in ' + (until(Date.parse(a.session.resetsAt)) || 'a moment') : 'Start a 5-hour session') +
          (a.keepAlive ? ' · Keep alive is on' : ''),
        'aria-label': (running ? '5-hour session running for ' : 'Start a 5-hour session for ') + a.label,
        onclick: () => send('startSession', { name: a.name }) },
      icon(a.starting ? 'refresh' : 'play', a.starting ? 'sm spin' : 'sm'))
      : null
    const moreBtn = h('button', { class: 'icon-btn', 'data-menu': 'actions:' + a.name, title: 'More actions',
      'aria-label': 'More actions for ' + a.label, 'aria-haspopup': 'menu', 'aria-expanded': 'false',
      onclick: (e) => { e.stopPropagation(); toggleMenu('actions', a.name, e.currentTarget, e) } }, icon('kebab'))

    let ctxGrid = null
    if (s.features && s.features.context) {
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
    return h('article', { class: 'card' + (a.active ? ' live' : '') + (justLive ? ' just-live' : ''),
      'aria-label': a.label + (a.active ? ' (live account)' : '') },
      h('div', { class: 'card-head' }, avatar(a, 'avatar'),
        h('div', { class: 'ident' },
          h('div', { class: 'name', text: a.label }),
          h('div', { class: 'sub', text: [a.email, a.plan, orgText(a.org)].filter(Boolean).join(' · ') || a.name })),
        h('div', { class: 'head-actions' }, startBtn, pinBtn, moreBtn)),
      ctxGrid,
      a.needsLogin
        ? h('div', { class: 'alert', role: 'status' }, icon('alert', 'sm'),
          h('div', { class: 'grow', text: 'This saved login has expired.' }),
          h('button', { class: 'btn soft sm', onclick: () => send('relogin', { name: a.name }) }, 'Sign in again'))
        : null,
      a.needsLogin ? null : h('div', { class: 'meters' },
        a.noSession
          ? meter(a.name + ':model', ((a.scoped && a.scoped.model) || 'Model') + ' Limit', a.scoped)
          : meter(a.name + ':5h', 'Session Limit', a.session),
        meter(a.name + ':wk', 'Weekly Limit', a.weekly)),
      h('div', { class: 'card-foot' },
        toggle('Remote Control', 'Remote', !a.remoteOff, 'Remote Control for ' + a.label,
          (on) => send('remote', { name: a.name, on })),
        s.features && s.features.artifacts
          ? toggle('Artifacts', null, !a.artifactsOff, 'Artifacts for ' + a.label,
            (on) => send('artifacts', { name: a.name, on }))
          : null,
        a.active || a.needsLogin ? null
          : h('button', { class: 'btn primary switch-btn', disabled: switching || null,
            title: 'Switch to ' + a.label, 'aria-label': (switching ? 'Switching to ' : 'Switch to ') + a.label,
            onclick: () => send('switch', { name: a.name }, 'switch:' + a.name) },
          icon(switching ? 'refresh' : 'swap', switching ? 'sm spin' : 'sm'),
          h('span', { class: 'btn-text', text: switching ? 'Switching…' : 'Switch' }))))
  }

  function banner() {
    const s = state
    if (s.registryError) {
      return h('div', { class: 'banner warn' }, icon('alert'),
        h('div', { class: 'grow' }, h('strong', { text: 'The settings file has an error' }),
          h('div', { class: 'muted', text: s.registryError })),
        h('button', { class: 'btn primary sm', onclick: () => send('openConfig') }, 'Open it'))
    }
    if (s.duplicates && s.duplicates.length) {
      const g = s.duplicates[0]
      return h('div', { class: 'banner warn' }, icon('alert'),
        h('div', { class: 'grow' }, h('strong', { text: g.join(' and ') + ' are the same account' }),
          h('div', { class: 'muted', text: 'Each holds its own login, and only one stays current. Keep one, and use ⋯ → Forget account on the others.' })))
    }
    if (s.live && !s.live.saved && s.live.email) {
      return h('div', { class: 'banner warn' }, icon('alert'),
        h('div', { class: 'grow' }, h('strong', { text: 'Your current login isn’t saved yet' }),
          h('div', { class: 'muted', text: s.live.email + ' · Save it so you can come back to it any time.' })),
        h('button', { class: 'btn primary sm', onclick: () => send('saveCurrent') }, 'Save it'))
    }
    if (s.window && s.window.pinnedTo) {
      return h('div', { class: 'banner' }, icon('pin'),
        h('div', { class: 'grow' }, h('strong', { text: (SIDEBAR ? 'Pinned to ' : 'This window is pinned to ') + s.window.pinnedLabel }),
          h('div', { class: 'muted', text: SIDEBAR ? 'Other windows follow the switcher.'
            : 'Its chats run as ' + s.window.pinnedLabel + '. Other windows follow the switcher.' })),
        h('button', { class: 'btn ghost sm', onclick: () => send('pin') }, 'Change'))
    }
    return null
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
    closeEdit()
    let pick = state.autoContinue.pick
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
      if (pick === 'order') orderDialog(Object.assign({ mode: 'switch' }, extra || {}))
      else { send('autoContinue', Object.assign({ mode: 'switch', pick: 'room' }, extra || {})); closeEdit() }
    })
    draw()
    showDialog(h('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'dlg-t' },
      h('div', null, h('h3', { id: 'dlg-t', text: 'Switch to which account?' }),
        h('p', { text: 'When a chat hits its limit, Switcher for Claude Code moves to another account and continues the chat there.' })),
      list,
      h('div', { class: 'actions' }, h('button', { class: 'btn ghost', onclick: closeEdit }, 'Cancel'), next)))
    const on = list.querySelector('[aria-checked="true"]')
    if (on) on.focus()
  }

  function orderDialog(extra) {
    closeEdit()
    const accounts = state.accounts || []
    const ac = state.autoContinue
    let order = (ac.order || []).filter((n) => accounts.some((a) => a.name === n))
    if (!order.length) order = accounts.filter((a) => !a.needsLogin).map((a) => a.name)
    let dragging = null
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
          on ? h('button', { class: 'icon-btn', title: 'Earlier', 'aria-label': 'Move ' + a.label + ' earlier', disabled: i === 0 || null,
            onclick: () => move(i, i - 1) }, icon('up', 'sm')) : null,
          on ? h('button', { class: 'icon-btn', title: 'Later', 'aria-label': 'Move ' + a.label + ' later', disabled: i === order.length - 1 || null,
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
    showDialog(h('div', { class: 'dialog wide', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'dlg-t' },
      h('div', null, h('h3', { id: 'dlg-t', text: 'Switch order' }),
        h('p', { text: 'It moves to the first account here that has room, so it comes back to an earlier one once that has reset. ' +
          'Accounts switched off are never used. If none has room, it waits for the first one to reset.' })),
      list,
      h('div', { class: 'actions' }, h('button', { class: 'btn ghost', onclick: closeEdit }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: () => {
          send('autoContinue', Object.assign({ pick: 'order', order: order.slice() }, extra || {}))
          closeEdit()
        } }, 'Save'))))
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
      ac.mode === 'switch' && ac.pick === 'order' ? h('button', { class: 'linkbtn', onclick: () => orderDialog() }, 'Edit order') : null)
    const waiting = ac.waiting && ac.waiting.length
      ? h('div', { class: 'pin-list ac-wait' }, ac.waiting.map((w) => h('div', { class: 'pin-row' }, icon('clock', 'sm'),
        h('div', { class: 'grow' }, h('span', { class: 'path ltr', text: w.title }),
          h('span', { class: 'who', text: 'continues at ' + w.at + (w.on ? ' on ' + w.on : '') })),
        h('button', { class: 'btn soft-danger sm', onclick: () => send('cancelContinue', { id: w.id }) }, 'Cancel'))))
      : null
    const how = h('details', { class: 'how' }, h('summary', null, icon('info', 'sm'), 'How it works'),
      h('p', { text: 'Switcher for Claude Code sends the stopped chat one note asking it to continue, and the chat picks up by itself, ' +
        'live in the panel. A switch needs no reload. Chats in a pinned folder always wait for their own account, and a weekly ' +
        'limit is never waited out. If a chat answers the note instead of continuing, you can let it trust these notes from then on.' }))
    return h('section', null, h('div', { class: 'section-head' }, h('h2', { text: 'Auto-continue After Limits' })), sentence, waiting, how)
  }

  function pinsSection() {
    const s = state
    const accounts = s.accounts || []
    const rows = (s.pins || []).map((p) => {
      const a = accounts.find((x) => x.name === p.name) || { name: p.name, label: p.label, icon: null }
      return h('div', { class: 'pin-row' },
        avatar(a, 'avatar sm'),
        h('div', { class: 'grow' },
          h('span', { class: 'path', title: p.folder, text: p.folder }),
          h('span', { class: 'who', text: p.label + (p.here ? ' · this window' : '') })),
        h('button', { class: 'btn soft-danger sm', 'aria-label': 'Unpin ' + p.folder,
          onclick: () => send('unpin', { folder: p.folder }) }, 'Unpin'))
    })
    return h('section', null,
      h('div', { class: 'section-head' },
        h('h2', { text: 'Pinned Folders' }),
        h('button', { class: 'btn ghost sm', onclick: () => send('pin') }, icon('pin', 'sm'), 'Pin a folder…')),
      rows.length
        ? h('div', { class: 'pin-list' }, rows)
        : h('div', { class: 'empty' }, h('strong', { text: 'No pinned folders' }),
          'Pin a folder to give its windows their own account. Chat history stays shared.'))
  }

  let dialog = null
  function openEdit(a) {
    closeEdit()
    let chosen = a.icon
    let chosenColor = a.color && COLORS[a.color] ? a.color : 'auto'
    const input = h('input', { id: 'f-label', value: a.label, maxlength: '40', autocomplete: 'off' })
    const err = h('div', { class: 'err', 'aria-live': 'polite' })
    const preview = h('div', { class: 'avatar lg', 'aria-hidden': 'true' })
    const drawPreview = () => {
      preview.style.setProperty('--hue', hueOf({ name: a.name, color: chosenColor === 'auto' ? null : chosenColor }))
      preview.replaceChildren(codicon(chosen) || initials(input.value.trim() || a.label))
    }
    input.addEventListener('input', drawPreview)
    const pickColor = (c) => {
      chosenColor = c
      colors.querySelectorAll('[data-color]').forEach((x) => x.setAttribute('aria-checked', String(x.dataset.color === c)))
      drawPreview()
    }
    const colors = h('div', { class: 'colors', role: 'radiogroup', 'aria-label': 'Colour' },
      h('button', { class: 'auto-color', role: 'radio', 'data-color': 'auto', 'aria-checked': String(chosenColor === 'auto'),
        title: 'Picked from the account name (' + COLORS[autoColor(a.name)][0].toLowerCase() + ')',
        onclick: () => pickColor('auto') }, 'Automatic'),
      Object.entries(COLORS).map(([c, [label, value]]) => h('button', { class: 'color', role: 'radio', 'data-color': c,
        'aria-checked': String(c === chosenColor), 'aria-label': label, title: label, style: { '--hue': value },
        onclick: () => pickColor(c) }, icon('check', 'sm'))))
    const swatches = h('div', { class: 'swatches', role: 'group', 'aria-label': 'Icon' },
      Object.keys(ICONS).map((nm) => {
        const shown = ICON_NAMES[nm] || nm
        const b = h('button', { class: 'swatch', title: shown, 'aria-label': shown, 'data-icon': nm,
          'aria-pressed': String(nm === chosen),
          onclick: () => {
            chosen = nm
            swatches.querySelectorAll('.swatch').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.icon === nm)))
            drawPreview()
          } },
        codicon(nm) || h('span', { class: 'nm', text: shown }))
        return b
      }))
    const save = () => {
      const label = input.value.trim()
      if (!label || label.length > 40) { err.textContent = 'Enter 1–40 characters.'; input.focus(); return }
      send('edit', { name: a.name, label, icon: chosen, color: chosenColor })
      closeEdit()
    }
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save() })
    const box = h('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'dlg-t' },
      h('div', { class: 'dlg-head' }, preview,
        h('div', null, h('h3', { id: 'dlg-t', text: 'Edit account' }),
          h('p', { text: 'Changes how “' + a.name + '” appears in VS Code. The Claude account itself isn’t changed.' }))),
      h('div', { class: 'field' }, h('label', { for: 'f-label', text: 'Display name' }), input, err),
      h('div', { class: 'field' }, h('label', { text: 'Colour' }), colors),
      h('div', { class: 'field' }, h('label', { text: 'Icon' }), swatches),
      h('div', { class: 'actions' },
        h('button', { class: 'btn ghost', onclick: closeEdit }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: save }, 'Save')))
    dialog = h('div', { class: 'overlay open', onclick: (e) => { if (e.target === dialog) closeEdit() } }, box)
    document.body.append(dialog)
    drawPreview()
    input.focus()
    input.select()
  }
  function showDialog(box) {
    closeMenu(false)
    dialog = h('div', { class: 'overlay open', onclick: (e) => { if (e.target === dialog) closeEdit() } }, box)
    document.body.append(dialog)
  }

  function closeEdit() {
    if (!dialog) return
    const d = dialog
    dialog = null
    d.classList.add('closing')
    setTimeout(() => d.remove(), 120)
    if (state) renderSafely()
  }

  function render() {
    if (!state) return
    const s = state
    const updating = s.updating || busy.has('update')
    const accounts = s.accounts || []

    const toolbar = h('div', { class: 'toolbar' },
      h('button', { class: 'btn ghost', disabled: updating || null, onclick: () => send('update', null, 'update') },
        icon('refresh', updating ? 'sm spin' : 'sm'), updating ? 'Updating…' : 'Update usage'),
      h('button', { class: 'btn primary', onclick: () => send('add') }, icon('plus', 'sm'), 'Add account'))

    const page = [
      SIDEBAR
        ? h('header', { class: 'top' }, toolbar)
        : h('header', { class: 'top' },
          h('div', null, h('h1', { text: 'Switcher for Claude Code' }),
            h('p', { text: 'Switch Claude accounts globally or per VS Code Window (folder)' })),
          toolbar),
      banner(),
      h('section', { class: 'accounts' },
        h('div', { class: 'section-head' },
          h('h2', { text: 'Accounts' }),
          s.tracking ? null : h('span', { class: 'note', text: 'Usage tracking is off' })),
        accounts.length
          ? h('div', { class: 'grid' }, accounts.map(card))
          : h('div', { class: 'empty' }, h('strong', { text: 'No saved accounts yet' }),
            'Add an account, or save the one you’re signed in to now.')),
      pinsSection(),
      autoContinueSection(),
      h('footer', { class: 'foot' },
        SIDEBAR
          ? h('button', { class: 'linkbtn', onclick: () => send('openTab') }, 'Open as a Tab')
          : h('button', { class: 'linkbtn', onclick: () => send('openSidebar') }, 'Show in Sidebar'),
        h('button', { class: 'linkbtn', onclick: () => send('openConfig') }, 'Open Settings File')),
    ]
    app.replaceChildren(...page.filter(Boolean))

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
    const live = accounts.find((a) => a.active)
    lastLive = live ? live.name : null
    rendered = true
  }

  function tick() {
    document.querySelectorAll('.when[data-when]').forEach((el) => {
      const raw = el.getAttribute('data-when')
      el.lastChild.textContent = whenText(raw ? JSON.parse(raw) : null)
      el.lastChild.title = el.lastChild.textContent
    })
  }
  setInterval(tick, 30000)

  document.addEventListener('pointerdown', (e) => {
    if (menu && !menu.el.contains(e.target) && !menu.btn.contains(e.target)) closeMenu(false)
  })
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { if (dialog) closeEdit(); else closeMenu(true); return }
    if (!menu || !menu.el.contains(document.activeElement)) return
    const items = [...menu.el.querySelectorAll('[role^="menuitem"]')]
    if (!items.length) return
    const i = items.indexOf(document.activeElement)
    const go = { ArrowDown: i + 1, ArrowUp: i === -1 ? items.length - 1 : i - 1, Home: 0, End: items.length - 1 }[e.key]
    if (go === undefined) return
    e.preventDefault()
    items[(go + items.length) % items.length].focus()
  })
  window.addEventListener('resize', () => place())
  window.addEventListener('scroll', () => place(), { passive: true })

  window.addEventListener('message', (e) => {
    const msg = e.data
    if (!msg || msg.type !== 'state') return
    const json = JSON.stringify(Object.assign({}, msg.state, { now: 0 }))
    const same = json === lastJson && !busy.size
    state = msg.state
    receivedAt = Date.now()
    lastJson = json
    busy.clear()
    if (same) { tick(); return }
    if (!dialog) renderSafely()
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
