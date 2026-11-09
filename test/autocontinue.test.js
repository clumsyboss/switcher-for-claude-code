require('./fake-security')

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const auto = require('../lib/autocontinue.js')

let passed = 0
let failed = 0
function check(what, ok, extra) {
  if (ok) { passed++; console.log('  ok   ' + what) } else { failed++; console.log('  FAIL ' + what + (extra ? '  <- ' + extra : '')) }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'switcher-autocontinue-'))
let n = 0
function chat(records) {
  const f = path.join(TMP, 'chat-' + (++n) + '.jsonl')
  fs.writeFileSync(f, records.map((r) => JSON.stringify(r)).join('\n') + '\n')
  return f
}
const at = (min) => new Date(Date.UTC(2026, 9, 16, 12, min)).toISOString()
const prompt = (text, min, mode) => ({ type: 'user', timestamp: at(min), permissionMode: mode || 'auto', message: { role: 'user', content: text } })
const toolUse = (min) => ({ type: 'assistant', timestamp: at(min), message: { content: [{ type: 'tool_use', id: 't' + min, name: 'Bash', input: {} }] } })
const toolResult = (min) => ({ type: 'user', timestamp: at(min), message: { content: [{ type: 'tool_result', tool_use_id: 't' + min, content: 'ok' }] } })
const reply = (text, min) => ({ type: 'assistant', timestamp: at(min), message: { content: [{ type: 'text', text }] } })
const limit = (text, min) => ({ type: 'assistant', uuid: 'stop-' + min, sessionId: 'sess-1', timestamp: at(min), isApiErrorMessage: true,
  error: 'rate_limit', entrypoint: 'claude-vscode', message: { model: '<synthetic>', stop_reason: 'stop_sequence', content: [{ type: 'text', text }] } })
const meta = (type) => ({ type, timestamp: at(59) })
const peer = (body, min) => ({ type: 'user', isMeta: true, timestamp: at(min), origin: { kind: 'peer', name: auto.SENDER_NAME, body },
  message: { content: 'Another Claude session sent a message:\n<cross-session-message>\n' + body + '\n</cross-session-message>' } })

console.log('finding a stop')
{
  const f = chat([prompt('fix the tests', 1, 'acceptEdits'), toolUse(2), toolResult(3),
    limit("You've hit your session limit · resets 4:10pm (Asia/Dubai)", 4), meta('system'), meta('last-prompt'), meta('ai-title')])
  const s = auto.limitStop(f)
  check('a turn cut off by the session limit is a stop', s && s.id === 'stop-4' && s.kind === 'session' && s.sessionId === 'sess-1', JSON.stringify(s))
  check('with the chat\'s permission mode and when it happened', s && s.permissionMode === 'acceptEdits' && s.at === Date.parse(at(4)))
  check('the weekly limit is told apart', auto.limitStop(chat([prompt('x', 1), limit("You've hit your weekly limit · resets 5pm (Asia/Dubai)", 2)])).kind === 'weekly')
  check('so is a model\'s own limit', auto.limitStop(chat([prompt('x', 1),
    limit("You've hit your Fable limit. Switch to another model, or wait for the reset.", 2)])).kind === 'model')
  check('a chat that ended normally is not', auto.limitStop(chat([prompt('x', 1), reply('done', 2)])) === null)
  check('nor one where the user typed after the stop', auto.limitStop(chat([prompt('x', 1), limit('You\'ve hit your session limit', 2), prompt('continue', 3)])) === null)
  check('nor one the user interrupted', auto.limitStop(chat([prompt('x', 1), toolUse(2),
    { type: 'user', timestamp: at(3), message: { content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } }])) === null)
  const notes = (min) => ({ type: 'user', timestamp: at(min), message: { role: 'user', content: '<task-notification>\n<task-id>ad5e9db18511dc76d</task-id>\n</task-notification>' } })
  const stillStopped = auto.limitStop(chat([prompt('fix it', 1), toolUse(2), limit("You've hit your session limit · resets 5:50pm (Asia/Dubai)", 4),
    notes(5), notes(6), { type: 'user', isMeta: true, timestamp: at(7), message: { content: 'a note from Claude Code' } }, notes(8)]))
  check('background agents reporting back after a stop don\'t count as carrying on', stillStopped && stillStopped.id === 'stop-4', JSON.stringify(stillStopped))
  check('nor do Claude Code\'s own notes; but the user typing after them does', auto.limitStop(chat([prompt('x', 1),
    limit('You\'ve hit your session limit', 2), notes(3), prompt('Continue', 4)])) === null)
  check('nor one already sent a notice', auto.limitStop(chat([prompt('x', 1), limit('You\'ve hit your session limit', 2),
    peer(auto.noticeFor({ kind: 'session' }, 'reset'), 3)])) === null)
  check('a background agent reporting back that hit the limit again is still a stop', auto.limitStop(chat([prompt('x', 1),
    limit('You\'ve hit your session limit · resets 4:10pm', 2), prompt('<task-notification>done</task-notification>', 3),
    limit('You\'ve hit your session limit · resets 4:10pm', 4)])).id === 'stop-4')
  check('another kind of API error is not a limit stop', auto.limitStop(chat([prompt('x', 1),
    { ...limit('API Error: overloaded', 2), error: 'overloaded' }])) === null)
}

console.log('when it resets')
{
  const from = new Date(2026, 9, 16, 12, 3).getTime()
  const r = auto.parseReset('resets 4:10pm (Asia/Dubai)', from)
  check('"4:10pm" is later the same day', new Date(r).getHours() === 16 && new Date(r).getMinutes() === 10 && r > from)
  check('"5pm" works without minutes', new Date(auto.parseReset('resets 5pm', from)).getHours() === 17)
  check('a time already past is tomorrow', auto.parseReset('resets 9am', from) - from > 12 * 3600e3)
  const mon = auto.parseReset('resets Mon 12:00am', from)
  check('a weekday is the next one', new Date(mon).getDay() === 1 && mon > from && mon - from <= 7 * 86400e3)
  check('the older "usage limit reached|<epoch>" form', auto.parseReset('Claude AI usage limit reached|1792000000', from) === 1792000000 * 1000)
  check('no time, no guess', auto.parseReset("You've hit your Fable limit.", from) === null)
  const stop = { kind: 'session', text: 'resets 4:10pm', at: from }
  const own = new Date(from + 3600e3).toISOString()
  check('the account\'s own reset time wins over the notice', auto.resetFor(stop, { session: { resetsAt: own } }) === Date.parse(own))
  check('and the notice is used when the account has none', auto.resetFor(stop, null) === r)
}

console.log('which account to switch to')
{
  const row = (name, s, w, extra) => ({ name, session: s === null ? null : { percent: s }, weekly: w === null ? null : { percent: w }, ...extra })
  const rows = [row('stopped', 100, 40), row('busy', 92, 10), row('full-week', 5, 96), row('roomy', 20, 30), row('roomier', 5, 50),
    row('expired', 0, 0, { needsLogin: true }), row('unknown', null, null)]
  check('the one with the most room, never the one that stopped', auto.pickAccount(rows, { exclude: 'stopped', kind: 'session' }) === 'roomy')
  check('accounts near their limits, signed out or without figures are skipped',
    !['busy', 'full-week', 'expired', 'unknown'].includes(auto.pickAccount(rows, { exclude: 'stopped' })))
  check('in the user\'s order, the first with room', auto.pickAccount(rows, { exclude: 'stopped', pick: 'order', order: ['busy', 'roomier', 'roomy'] }) === 'roomier')
  check('accounts left out of the order are never used', auto.pickAccount(rows, { exclude: 'stopped', pick: 'order', order: ['busy', 'full-week'] }) === null)
  check('an account just past its reset counts as empty', auto.hasRoom({ session: { percent: 100, resetSince: true }, weekly: { percent: 10 } }, 'session'))
  check('a model\'s own limit counts for a model stop', !auto.hasRoom({ session: { percent: 5 }, weekly: { percent: 5 }, scoped: { percent: 99 } }, 'model'))

  const now = Date.now()
  const iso = (ms) => new Date(now + ms).toISOString()
  const full = (name, resetIn) => ({ name, session: { percent: 100, resetsAt: iso(resetIn) }, weekly: { percent: 30 } })
  const all = [full('one', 20 * 60e3), full('two', 90 * 60e3), full('three', 4 * 3600e3)]
  const next = auto.nextAvailable(all, { exclude: 'three', stoppedAt: now + 4 * 3600e3, kind: 'session', now })
  check('with no account free, the one that resets first is next, even another one', next && next.name === 'one' && next.at === now + 20 * 60e3)
  check('in the user\'s order, only accounts in it count', auto.nextAvailable(all, { exclude: 'three', stoppedAt: now + 4 * 3600e3,
    kind: 'session', pick: 'order', order: ['two', 'three'], now }).name === 'two')
  check('and the stopped account itself, when it resets first', auto.nextAvailable(all, { exclude: 'three', stoppedAt: now + 5 * 60e3,
    kind: 'session', now }).name === 'three')
  check('an account full for the week waits for its weekly reset', auto.availableAt({ session: { percent: 10 },
    weekly: { percent: 99, resetsAt: iso(2 * 86400e3) } }, 'session', now) === now + 2 * 86400e3)
}

console.log('switching early, before anything stops')
{
  const row = (name, s, w) => ({ name, session: { percent: s }, weekly: { percent: w } })
  check('off unless a share is chosen, and only 50-90%', auto.cleanSettings({}).early === null && auto.cleanSettings({ early: 80 }).early === 80 &&
    auto.cleanSettings({ early: 49 }).early === null && auto.cleanSettings({ early: 91 }).early === null && auto.cleanSettings({ early: 80.5 }).early === null)
  check('the 5-hour limit triggers at the chosen share', auto.earlyTrigger(row('live', 80, 10), 80) === 'session' && auto.earlyTrigger(row('live', 79, 10), 80) === null)
  check('the weekly limit triggers on its own at 95%', auto.earlyTrigger(row('live', 20, 95), 80) === 'weekly' && auto.earlyTrigger(row('live', 20, 94), 80) === null)
  check('the 5-hour limit is checked first', auto.earlyTrigger(row('live', 85, 97), 80) === 'session')
  check('and nothing triggers without a share', auto.earlyTrigger(row('live', 99, 99), null) === null)
  const rows = [row('live', 85, 30), row('close', 72, 10), row('roomy', 30, 40), row('weekly-tight', 5, 91)]
  check('the next account must be well under the share (here, under 70%)', auto.pickEarly(rows, { exclude: 'live', kind: 'session', early: 80 }) === 'roomy')
  check('and never one at 90% of its week or more', !auto.hasRoom(row('x', 5, 90), 'session') && auto.hasRoom(row('x', 5, 89), 'session'))
  check('none qualifying means no early switch', auto.pickEarly([row('live', 85, 30), row('close', 75, 10)], { exclude: 'live', kind: 'session', early: 80 }) === null)
  check('in the user\'s order, the first that qualifies', auto.pickEarly([row('live', 85, 30), row('close', 72, 10), row('a', 40, 10), row('b', 10, 10)],
    { exclude: 'live', kind: 'session', early: 80, pick: 'order', order: ['close', 'a', 'b'] }) === 'a')
}

console.log('the notice and its sender')
{
  const reset = auto.noticeFor({ kind: 'session' }, 'reset')
  const switched = auto.noticeFor({ kind: 'weekly' }, 'switched')
  check('it says it is automatic, on the user\'s behalf, and that the user didn\'t stop it',
    reset.startsWith(auto.NOTICE_MARK) && /on the user's behalf/.test(reset) && /not by the user/.test(reset))
  check('it says the limit reset, or that the account was switched', /has now reset/.test(reset) && /switched Claude Code to another/.test(switched))
  check('and asks only to continue the chat\'s own task', /continue the task from where you stopped/.test(reset) && !/new task/i.test(reset))
  check('its first line stands on its own, for the panel\'s preview', reset.split('\n')[0].length > 40 && reset.split('\n')[0].endsWith('not by the user.'))
  const args = auto.senderArgs('drive-ui-73', reset)
  const val = (flag) => args[args.indexOf(flag) + 1]
  check('the sender can only list sessions and send a message', val('--tools') === 'ListAgents,SendMessage' && val('--allowedTools') === 'ListAgents,SendMessage')
  check('on the cheapest model, saving nothing, with no hooks and no MCP servers', val('--model') === 'haiku' &&
    args.includes('--no-session-persistence') && JSON.parse(val('--settings')).disableAllHooks === true && args.includes('--strict-mcp-config'))
  check('it never skips permission checks', !args.some((a) => /bypass|dangerously/i.test(a)))
  check('it names itself, and the chat it writes to', val('--name') === auto.SENDER_NAME && args[1].includes('"drive-ui-73"') && args[1].includes(reset))
  check('a chat that skips permission prompts is not sent one (it would hold it)', !auto.canReceive('bypassPermissions') && auto.canReceive('auto'))
}

console.log('what the chat did with it')
{
  const base = [prompt('fix the tests', 1), limit('You\'ve hit your session limit', 2), peer(auto.noticeFor({ kind: 'session' }, 'reset'), 3)]
  check('not read yet', auto.afterNotice(chat(base)) === 'pending')
  check('went back to work', auto.afterNotice(chat(base.concat([toolUse(4), toolResult(5)]))) === 'continued')
  check('wrote at length (a writing task)', auto.afterNotice(chat(base.concat([reply('x'.repeat(700), 4)]))) === 'continued')
  check('only answered', auto.afterNotice(chat(base.concat([reply('This came from another session, so I will wait for you.', 4)]))) === 'replied')
  check('hit the limit again', auto.afterNotice(chat(base.concat([limit('You\'ve hit your session limit', 4)]))) === 'limited')
  const t = chat(base.concat([reply('I will wait for you.', 4), prompt(auto.TRUST_PROMPT, 5), reply('Understood.', 6)]))
  check('the user\'s trust prompt, once answered, is seen', auto.trusted(t, Date.parse(at(4))))
  check('but not one sent before the fallback was offered', !auto.trusted(t, Date.parse(at(30))))
  check('the trust prompt covers only these notices, only to continue', /only those notices/.test(auto.TRUST_PROMPT) && /continue/.test(auto.TRUST_PROMPT))
}

console.log('settings and shared state')
{
  check('the default is on, asking first', JSON.stringify(auto.cleanSettings(undefined)) === JSON.stringify({ mode: 'ask', pick: 'room', order: [], early: null }))
  check('unknown values and invalid names are dropped', JSON.stringify(auto.cleanSettings({ mode: 'always', pick: 'random', order: ['ok', '../x', 'ok', 5] })) ===
    JSON.stringify({ mode: 'ask', pick: 'room', order: ['ok'], early: null }))
  const R = path.join(TMP, 'root')
  fs.mkdirSync(R, { recursive: true })
  const e = { id: 'stop-1', title: 'A chat', state: 'new' }
  check('one window claims a stop', auto.claim(R, e) === true)
  check('and no other window can', auto.claim(R, e) === false)
  check('its state changes are shared', auto.mark(R, 'stop-1', { state: 'waiting' }) && auto.readState(R).stops['stop-1'].state === 'waiting')
  auto.updateState(R, (s) => { s.stops.old = { id: 'old', at: Date.now() - 4 * 86400e3 } })
  check('stops older than a few days are forgotten', !auto.readState(R).stops.old && !!auto.readState(R).stops['stop-1'])
  auto.updateState(R, (s) => { s.early = { lastAt: 123, handled: { 'work@x': 456 } } })
  check('the early-switch record is kept, so its cooldown and "Not Now" hold across windows',
    auto.readState(R).early.lastAt === 123 && auto.readState(R).early.handled['work@x'] === 456)
  if (process.platform !== 'win32') check('the state file is private (0600)', (fs.statSync(auto.statePath(R)).mode & 0o777) === 0o600)
}

fs.rmSync(TMP, { recursive: true, force: true })
console.log('\n' + passed + ' passed, ' + failed + ' failed')
assert.strictEqual(failed, 0, 'auto-continue tests failed')
