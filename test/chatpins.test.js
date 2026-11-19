require('./fake-security')
const assert = require('assert')
const cp = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const pins = require('../lib/chatpins')
const pinkeys = require('../lib/pinkeys')

let pass = 0
let fail = 0
function check(name, ok) {
  if (ok) { pass++; console.log('  PASS  ' + name) } else { fail++; console.log('  FAIL  ' + name) }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chatpins-'))
const root = path.join(tmp, 'root')
fs.mkdirSync(root)
const ID = '6b8cbf67-1111-4222-8333-944455556666'
const ID2 = '0a1b2c3d-aaaa-4bbb-8ccc-ddddeeeeffff'
const KEY_W = 'sk-ant-oat01-' + 'W'.repeat(40)
const KEY_H = 'sk-ant-oat01-' + 'H'.repeat(40)

;(async () => {
  console.log('-- chat pins --')
  check('no file, no pins', pins.read(root).length === 0)
  pins.set(root, ID, 'Work')
  pins.set(root, ID2, 'Home', 'Fix\tthe\nlogin tests')
  check('a pin is kept as chat and account', JSON.stringify(pins.read(root)[0]) === JSON.stringify({ id: ID, name: 'Work', title: null }))
  check('a title is kept on one line, for the page', pins.read(root).find((p) => p.id === ID2).title === 'Fix the login tests')
  pins.set(root, ID, 'Home')
  check('pinning a chat again moves its pin (one line per chat)', pins.read(root).filter((p) => p.id === ID).length === 1 && pins.read(root).find((p) => p.id === ID).name === 'Home')
  let threw = false
  try { pins.set(root, '../../etc', 'Work') } catch { threw = true }
  check('only real chat ids can be pinned', threw)
  threw = false
  try { pins.set(root, ID, 'bad\tname') } catch { threw = true }
  check('only real account names', threw)
  check('unpinning removes just that chat', pins.remove(root, ID2) && pins.read(root).length === 1 && !pins.remove(root, ID2))
  pins.set(root, ID2, 'Home')
  pins.forget(root, 'Home')
  check('forgetting an account drops its pins', pins.read(root).length === 0)
  fs.writeFileSync(pins.file(root), 'garbage\n' + ID + '\tWork\tA title\n\tno id\tWork\n')
  check('lines it can\'t read are skipped', pins.read(root).length === 1)

  console.log('-- pin keys --')
  check('a pin key looks like Claude Code\'s', pinkeys.validKey(KEY_W) && !pinkeys.validKey('sk-ant-api03-' + 'x'.repeat(40)) && !pinkeys.validKey('hello'))
  check('none saved yet', !pinkeys.has(root, 'Work') && pinkeys.info(root, 'Work') === null)
  const made = Date.now() - 10 * 86400e3
  pinkeys.set(root, 'Work', '  ' + KEY_W + '\n', made)
  check('saved, trimmed, for that account only', pinkeys.has(root, 'Work') && !pinkeys.has(root, 'Home') &&
    fs.readFileSync(pinkeys.keyFile(root, 'Work'), 'utf8').trim() === KEY_W)
  const inf = pinkeys.info(root, 'Work')
  check('it runs out about a year after it was made', inf && Math.abs(inf.expiresAt - (made + pinkeys.YEAR_MS)) < 1000)
  threw = false
  try { pinkeys.set(root, 'Work', 'not a key') } catch { threw = true }
  check('anything that isn\'t a pin key is refused', threw && fs.readFileSync(pinkeys.keyFile(root, 'Work'), 'utf8').trim() === KEY_W)
  threw = false
  try { pinkeys.keyFile(root, '../evil') } catch { threw = true }
  check('account names can\'t point outside the keys folder', threw)
  pinkeys.set(root, 'Home', KEY_H)
  check('the accounts with keys', pinkeys.names(root).sort().join() === 'Home,Work')
  check('checked for free: a pin key gets "not enough permission" from the usage page',
    await pinkeys.check(KEY_W, { request: async () => ({ status: 403, body: '{"error":{"message":"OAuth token does not meet scope requirement user:profile"}}' }) }) === 'ok')
  check('a wrong or revoked one gets "not signed in"', await pinkeys.check(KEY_W, { request: async () => ({ status: 401, body: '' }) }) === 'rejected')
  check('no answer: unknown, not wrong', await pinkeys.check(KEY_W, { request: async () => { throw new Error('offline') } }) === 'unknown')

  console.log('-- what the wrapper is given --')
  const site = path.join(tmp, 'work', 'site')
  const deeper = path.join(site, 'api')
  const other = path.join(tmp, 'other')
  for (const d of [site, deeper, other]) fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(pins.file(root), '')
  pins.set(root, ID, 'Home', 'Chat title')
  pins.set(root, ID2, 'NoLogin')
  const DAY = 86400e3
  const soon = Date.now() + 20 * DAY
  const loginsFor = {
    Work: { expiresAt: soon, dir: path.join(root, 'pinning', 'Work') },
    Home: { expiresAt: soon + 0.4, dir: path.join(root, 'pinning', 'Home') },
  }
  const asked = []
  const n = pins.writeWrapperFile(root, [{ folder: site, name: 'Work' }, { folder: deeper, name: 'Home' }, { folder: other, name: 'NoLogin' }],
    (name) => { asked.push(name); return loginsFor[name] || null })
  const lines = fs.readFileSync(pins.wrapperFile(root), 'utf8').trim().split('\n')
  check('chat and folder pins, only for accounts with a pinning login', n === 3 && lines.filter((l) => !l.startsWith('login\t')).length === 3 && !lines.some((l) => l.includes('NoLogin')))
  check('one login line per pinned account: name, end date in ms, its folder verbatim',
    lines.filter((l) => l.startsWith('login\t')).sort().join('|') ===
      ['login\tHome\t' + Math.floor(soon + 0.4) + '\t' + loginsFor.Home.dir, 'login\tWork\t' + soon + '\t' + loginsFor.Work.dir].join('|'))
  check('login lines come first, and each account is asked about once', lines[0].startsWith('login\t') && lines[1].startsWith('login\t') &&
    asked.slice().sort().join() === 'Home,NoLogin,Work')
  const odd = { Yes: true, Str: { expiresAt: '123', dir: 'x' }, Tab: { expiresAt: soon, dir: 'a\tb' }, Nan: { expiresAt: NaN, dir: 'x' }, Boom: null }
  pins.writeWrapperFile(root, Object.keys(odd).map((k) => ({ folder: path.join(other, k), name: k })),
    (name) => { if (name === 'Boom') throw new Error('no'); return odd[name] })
  check('anything that isn\'t a usable login (true, bad dates, tabs, an error) writes nothing for that account',
    fs.readFileSync(pins.wrapperFile(root), 'utf8') === '')
  check('nothing pinned: an empty list, and 0', pins.writeWrapperFile(root, [], () => null) === 0 && fs.readFileSync(pins.wrapperFile(root), 'utf8') === '')
  pins.writeWrapperFile(root, [{ folder: site, name: 'Work' }, { folder: deeper, name: 'Home' }], (name) => loginsFor[name] || null)
  check('a chat\'s own pin wins over its folder\'s', pins.pinFor(lines, ID, site) === 'Home')
  check('otherwise the deepest pinned folder it starts in', pins.pinFor(lines, null, site) === 'Work' &&
    pins.pinFor(lines, null, path.join(deeper, 'src')) === 'Home' && pins.pinFor(lines, null, path.join(site, 'docs')) === 'Work')
  check('not a folder that only starts with the same letters', pins.pinFor(lines, null, site + 'shop') === null && pins.pinFor(lines, null, other) === null)

  console.log('-- Claude Code\'s wrapper setting --')
  const ours = path.join(root, 'bin', 'claude-wrapper.exe')
  check('pins and no wrapper: turn ours on', pins.wrapperAction(undefined, ours, true) === 'on')
  check('pins and ours already on: keep', pins.wrapperAction(ours, ours, true) === 'keep')
  check('no pins left and ours on: turn it off', pins.wrapperAction(ours, ours, false) === 'off')
  check('no pins and nothing set: leave it', pins.wrapperAction('', ours, false) === 'keep')
  check('someone else\'s wrapper is never replaced', pins.wrapperAction('C:\\tools\\mine.exe', ours, true) === 'foreign' && pins.wrapperAction('/x/mine', ours, false) === 'foreign')

  console.log('-- the chat id in Claude Code\'s arguments --')
  check('--resume=<id> in one piece (how the extension passes it)', pins.sessionIdOf(['claude', '--output-format=stream-json', '--resume=' + ID]) === ID)
  check('--session-id=<id>', pins.sessionIdOf(['claude', '--session-id=' + ID]) === ID)
  check('the two-part forms', pins.sessionIdOf(['claude', '--resume', ID]) === ID && pins.sessionIdOf(['claude', '--session-id', ID]) === ID)
  check('a new chat has none', pins.sessionIdOf(['claude', '--output-format=stream-json']) === null)
  check('nothing that isn\'t an id', pins.sessionIdOf(['claude', '--resume=$(rm -rf ~)']) === null)

  console.log('-- finding the chat\'s tab by its title --')
  check('a short title: the same label', pins.tabMatches('Fix the login tests', 'Fix the login tests'))
  check('a long one: Claude Code\'s 24 characters and "\u2026"', pins.tabMatches('CLAUDE_CONFIG_DIR enviro\u2026', 'CLAUDE_CONFIG_DIR environment variable'))
  check('but not another chat, or a shorter title that only starts the same', !pins.tabMatches('CLAUDE_CONFIG_DIR enviro\u2026', 'CLAUDE_CONFIG_DIR is weird') &&
    !pins.tabMatches('CLAUDE_CONFIG_DIR', 'CLAUDE_CONFIG_DIR environment variable'))
  check('spaces evened out; nothing matches an empty title', pins.tabMatches('Fix  the   tests', 'Fix the tests') && !pins.tabMatches('', 'x') && !pins.tabMatches('x', ''))

  console.log('-- the folder\'s chats --')
  check('Claude Code\'s folder name for a project', pins.projectSlug('z:\\work\\my-shop') === 'z--work-my-shop' &&
    pins.projectSlug('/Users/me/my app') === '-Users-me-my-app')
  const projects = path.join(tmp, 'projects')
  const proj = path.join(projects, pins.projectSlug('/work/site'))
  fs.mkdirSync(proj, { recursive: true })
  const line = (o) => JSON.stringify(o) + '\n'
  fs.writeFileSync(path.join(proj, ID + '.jsonl'), line({ type: 'user' }) + line({ type: 'ai-title', aiTitle: 'Fix the "login" tests', sessionId: ID }))
  fs.writeFileSync(path.join(proj, ID2 + '.jsonl'), line({ type: 'ai-title', aiTitle: 'Old title' }) + line({ type: 'custom-title', customTitle: 'Renamed chat' }))
  fs.writeFileSync(path.join(proj, 'not-a-chat.txt'), 'x')
  const later = new Date(Date.now() + 5000)
  fs.utimesSync(path.join(proj, ID2 + '.jsonl'), later, later)
  const chats = pins.listChats(projects, '/work/site')
  check('newest first, chats only', chats.map((c) => c.id).join() === [ID2, ID].join())
  check('a rename wins over Claude\'s title, and quotes survive', chats[0].title === 'Renamed chat' && chats[1].title === 'Fix the "login" tests')
  const f3 = path.join(proj, 'c3c3c3c3-0000-4000-8000-000000000003.jsonl')
  fs.writeFileSync(f3, line({ type: 'queue-operation', operation: 'enqueue' }) +
    line({ type: 'user', isMeta: true, message: { role: 'user', content: 'Caveat: messages below were generated by the user' } }) +
    line({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '<ide_selection>some code</ide_selection>' }, { type: 'text', text: 'hi\n  there' }] } }) +
    line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Hello!' }] } }) +
    line({ type: 'last-prompt', lastPrompt: 'hi there' }))
  check('no title: its latest prompt, as its tab shows it', pins.titleOf(f3) === 'hi there', String(pins.titleOf(f3)))
  fs.appendFileSync(f3, line({ type: 'last-prompt', lastPrompt: 'What account\n are you on?' }))
  check('a later prompt renames it', pins.titleOf(f3) === 'What account are you on?', String(pins.titleOf(f3)))
  check('its file is found from its id alone', pins.chatFile(projects, 'c3c3c3c3-0000-4000-8000-000000000003') === f3 &&
    pins.chatFile(projects, 'dddddddd-0000-4000-8000-000000000009') === null && pins.chatFile(projects, '../x') === null)
  const f3b = path.join(proj, 'c3c3c3c3-0000-4000-8000-00000000003b.jsonl')
  fs.writeFileSync(f3b, line({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '<ide_selection>some code</ide_selection>' }, { type: 'text', text: 'hi\n  there' }] } }))
  check('no prompt record yet: the first prompt, without tagged parts, spaces evened out', pins.titleOf(f3b) === 'hi there', String(pins.titleOf(f3b)))
  fs.rmSync(f3b)
  const f4 = path.join(proj, 'c4c4c4c4-0000-4000-8000-000000000004.jsonl')
  fs.writeFileSync(f4, line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'x' }] } }) +
    line({ type: 'user', message: { role: 'user', content: '<command-name>/compact</command-name>' } }) +
    line({ type: 'user', message: { role: 'user', content: 'Fix the build' } }))
  check('tool results and commands are skipped', pins.titleOf(f4) === 'Fix the build', String(pins.titleOf(f4)))
  fs.appendFileSync(f4, line({ type: 'ai-title', aiTitle: 'Build fixes' }))
  check('a title, once Claude gives one, wins over the prompt', pins.titleOf(f4) === 'Build fixes')
  const f5 = path.join(proj, 'c5c5c5c5-0000-4000-8000-000000000005.jsonl')
  fs.writeFileSync(f5, line({ type: 'queue-operation', operation: 'enqueue' }))
  check('no prompt yet: no title', pins.titleOf(f5) === null)
  for (const f of [f3, f4, f5]) fs.rmSync(f)
  check('a folder with no chats: none', pins.listChats(projects, '/nowhere').length === 0)

  console.log('-- installing the wrapper --')
  const ext = path.join(tmp, 'ext')
  fs.mkdirSync(path.join(ext, 'wrapper'), { recursive: true })
  fs.writeFileSync(path.join(ext, 'wrapper', 'claude-wrapper.sh'), '#!/bin/sh\nexec "$@"\n')
  const installed = pins.installWrapper(root, ext, 'linux')
  check('copied into the switcher\'s own folder, where its path never changes', installed === path.join(root, 'bin', 'claude-wrapper.sh') && fs.existsSync(installed))
  check('a platform it has no wrapper for: none', pins.installWrapper(root, ext, 'win32') === null)
  check('the build packages the wrapper folder', /const PAYLOAD = \[[^\]]*'wrapper'/.test(fs.readFileSync(path.join(__dirname, '..', 'build.js'), 'utf8')))

  const inuse = path.join(root, 'pinning', '.inuse')
  const fake = path.join(tmp, 'fake-claude.js')
  fs.writeFileSync(fake, "const fs=require('fs');const d=process.env.FAKE_INUSE;let notes=[];try{notes=fs.readdirSync(d).map((n)=>({file:n,note:JSON.parse(fs.readFileSync(d+'/'+n,'utf8'))}))}catch{}" +
    "let i='';process.stdin.on('data',(c)=>i+=c).on('end',()=>{process.stdout.write(JSON.stringify({key:process.env.CLAUDE_CODE_OAUTH_TOKEN||null," +
    "dir:process.env.CLAUDE_CONFIG_DIR||null,store:process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR||null,args:process.argv.slice(2),input:i,notes}));process.exitCode=7})")
  const FAKE_TOKEN = 'sk-ant-oat01-' + 'T'.repeat(40)
  const baseEnv = Object.assign({}, process.env, { CLAUDE_CONFIG_DIR: 'C:\\keep\\me', CLAUDE_SECURESTORAGE_CONFIG_DIR: 'shared',
    CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN, FAKE_INUSE: inuse })

  function wrapperChecks(label, cmd, pre, P, extraEnv) {
    const env = Object.assign({}, baseEnv, extraEnv, { [pins.ENV]: P.root + P.sep + 'pins.tsv' })
    const dirOf = (name) => P.root + P.sep + 'pinning' + P.sep + name
    const later = Date.now() + 20 * DAY
    function writePins(over) {
      const o = Object.assign({ Home: { at: later, dir: dirOf('Home') }, Work: { at: later, dir: dirOf('Work') }, extra: [] }, over)
      const out = []
      for (const k of ['Home', 'Work']) if (o[k]) out.push(['login', k, String(o[k].at), o[k].dir].join('\t'))
      out.push('chat\t' + ID + '\tHome', 'folder\t' + P.site + '\tWork', 'folder\t' + P.deeper + '\tHome')
      fs.writeFileSync(pins.wrapperFile(root), out.concat(o.extra).join('\n') + '\n')
    }
    function run(args, cwd, input) {
      fs.rmSync(inuse, { recursive: true, force: true })
      const r = cp.spawnSync(cmd, pre.concat([process.execPath, fake]).concat(args), { env, cwd: cwd || other, input: input === undefined ? 'hello chat' : input, encoding: 'utf8', timeout: 20000 })
      let out = null
      try { out = JSON.parse(r.stdout) } catch {  }
      let left = []
      try { left = fs.readdirSync(inuse) } catch {  }
      return { out, status: r.status, stdout: r.stdout, left }
    }
    const asAsked = (r) => r.out && r.out.store === 'shared' && r.out.key === FAKE_TOKEN && r.out.notes.length === 0
    const on = (r, name) => r.out && r.out.store === dirOf(name) && r.out.key === null

    writePins()
    const pinned = run(['--output-format=stream-json', '--resume=' + ID])
    check(label + ': a pinned chat starts on its account\'s pinning login (that exact folder), without any token', on(pinned, 'Home'))
    check(label + ': nothing else about it changes (same config folder)', pinned.out && pinned.out.dir === 'C:\\keep\\me')
    check(label + ': arguments, input, output and exit code pass straight through', pinned.out &&
      JSON.stringify(pinned.out.args) === JSON.stringify(['--output-format=stream-json', '--resume=' + ID]) && pinned.out.input === 'hello chat' && pinned.status === 7)
    const note = pinned.out && pinned.out.notes.length === 1 ? pinned.out.notes[0] : null
    check(label + ': while it runs, an in-use note says which login it is on', note && note.file === note.note.pid + '.json' && note.note.v === 1 &&
      note.note.name === 'Home' && note.note.sessionId === ID && typeof note.note.cwd === 'string' && note.note.cwd.length > 0 &&
      Math.abs(note.note.startedAt - Date.now()) < 120000)
    if (P.removesNote) check(label + ': and the note is gone when the chat ends', pinned.left.length === 0)
    const inSite = run(['--output-format=stream-json'], P.siteCwd)
    check(label + ': a new chat in a pinned folder gets the folder\'s account', on(inSite, 'Work') && inSite.out.notes[0].note.sessionId === null)
    check(label + ': the deepest pinned folder wins', on(run([], P.deeperCwd), 'Home'))
    check(label + ': a chat\'s own pin wins over its folder\'s', on(run(['--resume', ID], P.siteCwd), 'Home'))
    check(label + ': no pin at all: starts exactly as Claude Code asked', asAsked(run(['--resume=' + ID2], other)))

    writePins({ Home: { at: Date.now() + 30 * 60e3, dir: dirOf('Home') } })
    check(label + ': a login ending within the hour: the active account instead', asAsked(run(['--resume=' + ID])))
    writePins({ Home: { at: Date.now() - DAY, dir: dirOf('Home') } })
    check(label + ': an expired login: the active account', asAsked(run(['--resume=' + ID])))
    writePins({ Home: { at: 'soon', dir: dirOf('Home') } })
    check(label + ': an end date that isn\'t a number: the active account', asAsked(run(['--resume=' + ID])))
    writePins({ Home: { at: later, dir: P.root + P.sep + 'elsewhere' + P.sep + 'Home' } })
    check(label + ': a login folder outside the pinning folder is never used', asAsked(run(['--resume=' + ID])))
    writePins({ Home: { at: later, dir: dirOf('Work') } })
    check(label + ': nor another account\'s folder', asAsked(run(['--resume=' + ID])))
    writePins({ Home: { at: later, dir: dirOf('..' + P.sep + 'pinning' + P.sep + 'Home') } })
    check(label + ': nor a path that climbs out and back', asAsked(run(['--resume=' + ID])))
    writePins({ Home: null })
    check(label + ': a pinned account with no login line: the active account', asAsked(run(['--resume=' + ID])))
    writePins({ Home: null, extra: ['login\t.hidden\t' + later + '\t' + dirOf('.hidden'), 'chat\t' + ID + '\t.hidden'] })
    check(label + ': an account name the switcher never makes is ignored', asAsked(run(['--resume=' + ID])))

    writePins()
    const sf = path.join(root, 'pinning', 'Home.settings.json')
    fs.writeFileSync(sf, '{ "disableRemoteControl": true }\n')
    const withSettings = run(['--resume=' + ID])
    check(label + ': the account\'s own settings file is added with --settings', on(withSettings, 'Home') &&
      JSON.stringify(withSettings.out.args) === JSON.stringify(['--resume=' + ID, '--settings', dirOf('Home.settings.json')]))
    const theirs = run(['--settings={"a":1}', '--resume=' + ID])
    check(label + ': never when Claude Code passes its own --settings', on(theirs, 'Home') &&
      JSON.stringify(theirs.out.args) === JSON.stringify(['--settings={"a":1}', '--resume=' + ID]))
    check(label + ': never for a chat that isn\'t pinned', asAsked(run(['--resume=' + ID2], other)) &&
      run(['--resume=' + ID2], other).out.args.length === 1)
    fs.writeFileSync(sf, 'not json')
    check(label + ': nor a settings file that isn\'t a JSON object', on(run(['--resume=' + ID]), 'Home') &&
      run(['--resume=' + ID]).out.args.length === 1)
    fs.rmSync(sf)

    const bom = run(['--resume=' + ID], other, '\u00e9t\u00e9 {"type":"user"}\n')
    check(label + ': input reaches claude as sent, with no byte-order mark', bom.out && bom.out.input === '\u00e9t\u00e9 {"type":"user"}\n')
    const self = cp.spawnSync(cmd, pre.concat(['--switcher-selftest', process.execPath, fake]), { env, cwd: other, input: 'x', encoding: 'utf8', timeout: 20000 })
    check(label + ': --switcher-selftest says it\'s ours and its version, and starts nothing', self.status === 0 &&
      /^claudeswitcher-wrapper ok \d+\.\d+\.\d+\r?\n$/.test(self.stdout))
  }

  const exe = path.join(__dirname, '..', 'wrapper', 'claude-wrapper.exe')
  if (process.platform === 'win32') {
    check('the Windows wrapper is built and in the package', fs.existsSync(exe))
    wrapperChecks('Windows wrapper', exe, [], { root, sep: '\\', site, deeper, siteCwd: site, deeperCwd: deeper, removesNote: true })
    const env = Object.assign({}, baseEnv, { [pins.ENV]: pins.wrapperFile(root) })
    const pidFile = path.join(tmp, 'child.pid')
    const sleeper = path.join(tmp, 'sleeper.js')
    fs.writeFileSync(sleeper, 'require("fs").writeFileSync(process.argv[2], String(process.pid)); setInterval(() => {}, 1000)')
    const w = cp.spawn(exe, [process.execPath, sleeper, pidFile], { env, stdio: ['pipe', 'ignore', 'ignore'] })
    const until = Date.now() + 10000
    while (!fs.existsSync(pidFile) && Date.now() < until) cp.spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},100)'])
    const childPid = Number(fs.readFileSync(pidFile, 'utf8'))
    w.kill()
    const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
    const gone = Date.now() + 10000
    while (alive(childPid) && Date.now() < gone) cp.spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},150)'])
    check('Windows wrapper: when the wrapper is ended, the claude it started ends with it', !alive(childPid))
    if (alive(childPid)) try { process.kill(childPid) } catch {  }
  }
  const shWrapper = path.join(__dirname, '..', 'wrapper', 'claude-wrapper.sh')
  const sh = cp.spawnSync('sh', ['-c', 'echo ok'], { encoding: 'utf8' })
  if (sh.status === 0 && sh.stdout.trim() === 'ok' && process.platform !== 'win32') {
    const real = (p) => fs.realpathSync(p)
    wrapperChecks('macOS/Linux wrapper', 'sh', [shWrapper], { root: real(root), sep: '/', site: real(site), deeper: real(deeper), siteCwd: site, deeperCwd: deeper })
  } else if (sh.status === 0 && sh.stdout.trim() === 'ok') {
    const posix = (p) => cp.spawnSync('sh', ['-c', 'pwd -P'], { cwd: p, encoding: 'utf8' }).stdout.trim()
    wrapperChecks('macOS/Linux wrapper', 'sh', [shWrapper], { root: posix(root), sep: '/', site: posix(site), deeper: posix(deeper), siteCwd: site, deeperCwd: deeper },
      { MSYS2_ARG_CONV_EXCL: '*', MSYS2_ENV_CONV_EXCL: '*' })
  } else console.log('  (no sh here: the macOS/Linux wrapper is checked on those systems)')

  fs.rmSync(tmp, { recursive: true, force: true })
  console.log(pass + ' passed, ' + fail + ' failed')
  assert.strictEqual(fail, 0, 'chat pin tests failed')
})().catch((e) => { console.error(e); process.exit(1) })
