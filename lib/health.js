const cp = require('child_process')
const fs = require('fs')
const path = require('path')

const chatpins = require('./chatpins')

const SELFTEST_FLAG = '--switcher-selftest'
const SELFTEST_LINE = /^claudeswitcher-wrapper ok (\S+)\s*$/
const DAY = 86400e3
const HOUR = 3600e3
const MARGIN = HOUR

function selfTest(wrapperPath, opts) {
  const timeoutMs = (opts && opts.timeoutMs) || 3000
  return new Promise((resolve) => {
    let done = false
    let timer = null
    let child = null
    const finish = (ok, version, reason) => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      resolve({ ok, version: version || null, reason: reason || null })
    }
    if (!wrapperPath || !fs.existsSync(wrapperPath)) return finish(false, null, 'missing')
    const viaSh = process.platform === 'win32' && /\.sh$/i.test(wrapperPath)
    try {
      child = cp.spawn(viaSh ? 'sh' : wrapperPath, viaSh ? [wrapperPath, SELFTEST_FLAG] : [SELFTEST_FLAG],
        { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    } catch (e) { return finish(false, null, 'error: ' + (e.code || e.message)) }
    timer = setTimeout(() => {
      try { child.stdout.destroy(); child.unref() } catch {  }
      try { child.kill('SIGKILL') } catch {  }
      finish(false, null, 'timed out')
    }, timeoutMs)
    let out = ''
    child.stdout.on('data', (d) => {
      if (done) return
      out += d
      if (out.length > 4096) {
        child.stdout.destroy()
        try { child.kill('SIGKILL') } catch {  }
        finish(false, null, 'unexpected answer')
      }
    })
    child.on('error', (e) => finish(false, null, 'error: ' + (e.code || e.message)))
    child.on('close', (code) => {
      const m = SELFTEST_LINE.exec(out)
      if (code === 0 && m) finish(true, m[1], null)
      else if (code !== 0) finish(false, null, 'exit ' + code)
      else finish(false, null, 'unexpected answer')
    })
  })
}

function readPins(root) {
  let text = ''
  try { text = fs.readFileSync(chatpins.wrapperFile(root), 'utf8') } catch { return [] }
  const out = []
  for (const line of text.split(/\r?\n/)) {
    const p = line.split('\t')
    if (p.length === 3 && (p[0] === 'chat' || p[0] === 'folder')) out.push({ kind: p[0], name: p[2] })
  }
  return out
}

function daysText(ms) {
  const d = Math.floor(ms / DAY)
  if (d >= 1) return d + (d === 1 ? ' day' : ' days') + ' left'
  const h = Math.max(1, Math.floor(ms / HOUR))
  return h + (h === 1 ? ' hour' : ' hours') + ' left'
}

function loginRow(area, name, which, login, now) {
  if (!login || typeof login.expiresAt !== 'number') return { area, name, state: 'warn', text: 'The ' + which + ' login\'s end date is unknown' }
  const left = login.expiresAt - now
  if (left <= 0) return { area, name, state: 'bad', text: 'The ' + which + ' login has ended. Sign in again' }
  if (left < DAY) return { area, name, state: 'warn', text: 'The ' + which + ' login ends today (' + daysText(left) + ')' }
  if (left < 5 * DAY) return { area, name, state: 'warn', text: 'The ' + which + ' login ends soon (' + daysText(left) + ')' }
  return { area, name, state: 'ok', text: 'The ' + which + ' login is fine (' + daysText(left) + ')' }
}

function alive(pid) {
  try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
}

function liveNotes(root) {
  const dir = path.join(root, 'pinning', '.inuse')
  let names = []
  try { names = fs.readdirSync(dir) } catch { return [] }
  const out = []
  for (const n of names) {
    const m = /^(\d+)\.json$/.exec(n)
    if (!m) continue
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'))
      if (j && j.pid === Number(m[1]) && alive(j.pid)) out.push(j)
    } catch {  }
  }
  return out
}

async function report(o) {
  const opts = o || {}
  const now = typeof opts.now === 'number' ? opts.now : Date.now()
  const root = opts.root
  const logins = Array.isArray(opts.logins) ? opts.logins.filter((l) => l && typeof l.name === 'string') : []
  const pins = Array.isArray(opts.pins) ? opts.pins : (root ? readPins(root) : [])
  const pinned = [...new Set(pins.map((p) => p && p.name).filter(Boolean))]
  const rows = []
  const row = (area, name, state, text) => rows.push({ area, name, state, text })

  const need = pinned.length > 0
  const ours = opts.wrapperPath || null
  const installed = !!ours && fs.existsSync(ours)
  if (!installed) row('wrapper', 'Installed', need ? 'bad' : 'warn', 'The pin wrapper isn\'t installed' + (need ? ', so pinned chats start on the active account' : ''))
  else {
    row('wrapper', 'Installed', 'ok', 'The pin wrapper is installed')
    const st = opts.selfTest || await selfTest(ours)
    if (st.ok) row('wrapper', 'Self-test', 'ok', 'The pin wrapper answers (version ' + st.version + ')')
    else row('wrapper', 'Self-test', need ? 'bad' : 'warn', 'The pin wrapper doesn\'t answer (' + st.reason + ')' + (need ? ', so pinned chats may not start' : ''))
  }
  const setting = opts.wrapperSetting || ''
  const isOurs = !!ours && chatpins.samePath(setting, ours)
  if (setting && !isOurs) row('wrapper', 'Claude Code setting', need ? 'bad' : 'warn', 'Claude Code starts chats through another wrapper (' + setting + '), so the switcher leaves it alone' + (need ? ' and pins don\'t work' : ''))
  else if (need && !isOurs) row('wrapper', 'Claude Code setting', 'bad', 'Claude Code isn\'t starting chats through the pin wrapper, so pinned chats start on the active account')
  else if (need) row('wrapper', 'Claude Code setting', 'ok', 'Claude Code starts chats through the pin wrapper')
  else if (isOurs) row('wrapper', 'Claude Code setting', 'warn', 'The pin wrapper is still on with nothing pinned')
  else row('wrapper', 'Claude Code setting', 'ok', 'Nothing is pinned, so the pin wrapper is off')

  if (opts.claudeVersion) row('claude', 'Claude Code', 'ok', 'Claude Code ' + opts.claudeVersion)
  else row('claude', 'Claude Code', 'warn', 'Claude Code\'s version couldn\'t be read')

  for (const l of logins) {
    if (l.main) rows.push(loginRow('login', l.name, 'main', l.main, now))
    if (l.pinning) {
      const r = loginRow('pinning', l.name, 'pinning', l.pinning, now)
      if (root && l.pinning.dir && l.pinning.dir !== path.join(root, 'pinning', l.name)) {
        r.state = 'bad'
        r.text = 'The pinning login is in the wrong folder, so pinned chats won\'t use it'
      }
      rows.push(r)
    }
  }

  for (const name of pinned) {
    const l = logins.find((x) => x.name === name)
    const n = pins.filter((p) => p && p.name === name).length
    const what = n + (n === 1 ? ' pin' : ' pins')
    if (!l) row('pins', name, 'bad', what + ' for an account that isn\'t saved any more')
    else if (!l.pinning) row('pins', name, 'bad', what + ', but no pinning login: these chats start on the active account')
    else if (typeof l.pinning.expiresAt !== 'number' || l.pinning.expiresAt <= now + MARGIN) row('pins', name, 'bad', what + ', but the pinning login has ended or ends within the hour: these chats start on the active account')
    else row('pins', name, 'ok', what + ', on its pinning login')
  }

  if (root) {
    const live = liveNotes(root)
    if (live.length) row('pins', 'Running now', 'ok', live.length + (live.length === 1 ? ' chat is' : ' chats are') + ' running on pinning logins')
  }
  return rows
}

module.exports = { SELFTEST_FLAG, selfTest, report, readPins, liveNotes }
