require('./fake-security')

const assert = require('assert')
const fs = require('fs')
const path = require('path')

const page = require('../ui/page.js')
const store = require('../lib/store.js')

let passed = 0
let failed = 0
function check(what, ok, extra) {
  if (ok) { passed++; console.log('  ok   ' + what) } else { failed++; console.log('  FAIL ' + what + (extra ? '  <- ' + extra : '')) }
}

const base = { cspSource: 'vscode-resource://x', cssUri: 'vscode-resource://x/media/accounts.css', jsUri: 'vscode-resource://x/media/accounts.js' }
const csp = (html) => (html.match(/Content-Security-Policy" content="([^"]+)"/) || [])[1] || ''

console.log('\n-- security policy --')
const tab = page.render(base)
const pol = csp(tab).replace(/&amp;/g, '&')
check('everything is denied by default', /default-src 'none'/.test(pol), pol)
check('scripts only with this render\'s nonce', /script-src 'nonce-[A-Za-z0-9]{16,}'/.test(pol) && !/unsafe/.test(pol))
check('styles only from the extension (and the nonce\'d font rule)', /style-src vscode-resource:\/\/x 'nonce-/.test(pol))
check('fonts and images only from the extension', /font-src vscode-resource:\/\/x/.test(pol) && /img-src vscode-resource:\/\/x data:/.test(pol))
check('no http(s) anywhere in the page', !/https?:\/\//.test(tab))
check('both script tags carry the nonce', (tab.match(/<script nonce="[A-Za-z0-9]+"/g) || []).length === 2)
const nonce = (pol.match(/'nonce-([A-Za-z0-9]+)'/) || [])[1]
check('and it is the policy\'s nonce', tab.split('nonce="' + nonce + '"').length - 1 === 2)
check('a fresh nonce for every render', csp(page.render(base)) !== csp(page.render(base)))

console.log('\n-- layouts --')
check('tab by default', tab.includes('<body class="layout-tab">') && tab.includes('__LAYOUT__="tab"'))
const side = page.render({ ...base, layout: 'sidebar' })
check('sidebar on request', side.includes('<body class="layout-sidebar">') && side.includes('__LAYOUT__="sidebar"'))
check('anything else falls back to the tab', page.render({ ...base, layout: '"><script>' }).includes('layout-tab'))

console.log('\n-- the codicon font --')
check('no font rule when VS Code offers none', !tab.includes('@font-face') && tab.includes('__HAS_FONT__=false'))
const withFont = page.render({ ...base, fontUri: 'vscode-resource://x/out/media/codicon.ttf' })
check('a nonce\'d @font-face when it does', /<style nonce="[A-Za-z0-9]+">@font-face/.test(withFont) && withFont.includes('__HAS_FONT__=true'))
check('attribute values are escaped', page.render({ ...base, cssUri: 'a"><script>x</script>' }).includes('a&quot;&gt;') === false &&
  !page.render({ ...base, cssUri: 'a"><script>x</script>' }).includes('"><script>x'))

console.log('\n-- the icon picker --')
const ids = Object.keys(page.ICONS)
check('every icon is valid for the status bar', ids.every((i) => store.validIcon(i)), ids.filter((i) => !store.validIcon(i)).join(','))
check('every glyph code is a codicon code point',
  ids.every((i) => [].concat(page.ICONS[i]).every((c) => Number.isInteger(c) && c >= 0xe000 && c <= 0xf8ff)))
check('gaming is offered', page.ICONS.game === 60439)
check('cloud + lightning is offered as a pair', JSON.stringify(page.ICONS['cloud+zap']) === '[60330,60038]')
check('the pair renders as two codicons in the status bar', store.iconText('cloud+zap') === '$(cloud)$(zap)')
check('a single icon renders as one', store.iconText('game') === '$(game)')
check('friendly names only for icons that exist', Object.keys(page.ICON_NAMES).every((k) => k in page.ICONS))
check('a pair of more than two is refused', !store.validIcon('cloud+zap+flame') && !store.validIcon('cloud+') && !store.validIcon('+zap'))

console.log('\n-- the client script --')
const js = fs.readFileSync(path.join(__dirname, '..', 'media', 'accounts.js'), 'utf8')
check('innerHTML is used once, for the built-in SVG icons only', (js.match(/innerHTML/g) || []).length === 1 &&
  /span\.innerHTML = '<svg class="i '/.test(js))
check('account names, emails and folders go in as text', /text: a\.label/.test(js) && /text: p\.folder/.test(js))
check('no eval, no Function, no network', !/\beval\(|new Function|fetch\(|XMLHttpRequest|WebSocket/.test(js))
console.log('\n-- the activity log --')
const logBlock = js.slice(js.indexOf("let view = 'accounts'"), js.indexOf('function logButton'))
const logCss = fs.readFileSync(path.join(__dirname, '..', 'media', 'accounts.css'), 'utf8')
check('the log words every kind of entry the extension can send', ['switch', 'stop', 'wait', 'waitend', 'continue', 'phone', 'phonestart', 'keepalive', 'lastday', 'roomagain']
  .every((k) => new RegExp("case '" + k + "'").test(logBlock)))
check('chat titles, accounts and message words in the log go in as text', /text: w\.title/.test(logBlock) && /text: w\.why/.test(logBlock) &&
  /text: w\.sub/.test(logBlock) && !/innerHTML/.test(logBlock))
check('the away notice is drawn by noticeEl, so its buttons sit in a row under the words, at the right, like every notice',
  /noticeEl\(\{ tone: 'info', icon: 'history', cls: 'banner away'/.test(js) && !/h\('(?:div|section)', \{ class: 'notice(?:[ ']|-actions)/.test(logBlock) &&
  /\.notice-actions \{[^}]*justify-content: flex-end/.test(logCss))
check('the log draws a few days at a time and asks for older ones', /logShow/.test(logBlock) && /send\('logMore'/.test(logBlock) && /content-visibility: auto/.test(logCss))
check('the log has no subtitle under its title', !/What Switcher did, which chats stopped/.test(js))
check('narrow, the log filters become one pill that opens a menu of the five filters, drawn as text',
  (logBlock.match(/class: 'lg-chip lg-pill'/g) || []).length === 1 && /toggleMenu\('log-filter'/.test(logBlock) && /kind === 'log-filter' \? logFilterMenu\(\)/.test(js) &&
  /function logFilterMenu[\s\S]*LOG_FILTERS\.map[\s\S]*role: 'menuitemradio'[\s\S]*aria-checked/.test(logBlock) && /function logFilterMenu[\s\S]*icon\('check'/.test(logBlock) &&
  /'aria-haspopup': 'menu'/.test(logBlock) && !/innerHTML/.test(logBlock))
check('the pill replaces the chips only when the one-row chips are wider than the room, measured', /chips\.offsetWidth > box\.clientWidth/.test(logBlock) &&
  /fitLogFilter\(\)/.test(js.slice(js.indexOf('function drawLog()'))) && /\.lg-chips \{[^}]*flex-wrap: nowrap/.test(logCss) && /\.lg-filter\.pilled \.lg-chips \{[^}]*visibility: hidden/.test(logCss))
{
  const src = (js.match(/function gotAway\(a[^)]*\) \{[\s\S]*?\n  \}/) || [''])[0]
  const make = () => {
    const env = { away: null, awayDots: null, view: 'accounts', rendered: true, stack: [], opened: 0, drawn: 0,
      openLog() { env.opened++; env.view = 'log' }, renderSafely() { env.drawn++ } }
    const fn = src ? new Function('env', 'with (env) { ' + src + '; return gotAway }')(env) : () => {}
    return { env, fn }
  }
  const payload = { from: 1000, to: 5000, entries: [{ at: 2000, kind: 'stop', chat: 'x' }] }
  const a = make()
  a.fn(payload)
  check('the summary sent to a page (no notice before) is shown as a card, as before', a.env.away && a.env.away.hidden === false && a.env.opened === 0 && a.env.drawn === 1)
  const b = make()
  b.fn(payload, true)
  check('"See the full log" pressed on the editor\'s notice goes straight to the log screen: no second card, the log opened once', !!b.env.away && b.env.away.hidden === true && b.env.opened === 1 && b.env.view === 'log')
  check('and the entries since the absence keep their dots', b.env.awayDots === 1000)
  const c = make()
  c.env.view = 'log'
  c.fn(payload, true)
  check('with the log screen already open, nothing is opened again', c.env.opened === 0 && c.env.away.hidden === true)
  check('the page tells the extension when the log screen is closed, and reads the open flag of the message',
    /function closeLog\(\) \{[^}]*send\('logClose'\)/.test(js) && /gotAway\(msg\.away, msg\.open === true\)/.test(js))
  check('a phone run that began before the absence and went on after it counts in the card, as in the notice', /\(e\.until \|\| e\.at\) >= a\.from/.test(js))
}
console.log('\n-- the update notices --')
const updBlock = (js.match(/const u = s\.update[\s\S]*?\n    if \(s\.registryError\)/) || [''])[0]
check('"Switcher X is available. You have Y." at the top of the page, before every other notice',
  /text: 'Switcher ' \+ u\.version \+ ' is available\. You have ' \+ u\.current \+ '\.'/.test(updBlock) &&
  js.indexOf('const u = s.update') < js.indexOf('if (s.registryError)'))
check('its notes go in as text, never as HTML or a link', /text: String\(u\.notes\)/.test(updBlock) && !/href|innerHTML|u\.url/.test(updBlock))
check('already on disk: one quiet line, "Restart extensions to finish updating to X.", with no buttons',
  /u\.restart\) \{\s*(?:\/\/[^\n]*\n\s*)?out\.push\(h\('div', \{ class: 'muted upd-restart', text: 'Restart extensions to finish updating to ' \+ u\.version \+ '\.' \}\)\)\s*\} else if/.test(updBlock))
check('three choices: Update, What\'s new, Later', ["{ label: 'Update',", "{ label: 'What’s new',", "{ label: 'Later',", "choice: 'later' }) }"].every((s) => updBlock.includes(s)), updBlock.slice(0, 200))
check('"Updated to X" with its headlines as text, See all changes and a close button',
  /text: 'Updated to ' \+ w\.version/.test(updBlock) && /h\('li', \{ text: t(, title: t)? \}\)/.test(updBlock) &&
  updBlock.includes("{ label: 'See all changes',") && updBlock.includes("choice: 'close' })") && /onClose:/.test(updBlock))
check('not while the welcome dialog shows its own what\'s new', /w && typeof w\.version === 'string' && !s\.welcome/.test(updBlock))
check('it never stores anything itself', !/localStorage|sessionStorage|indexedDB|setState\(/.test(js))
const css = fs.readFileSync(path.join(__dirname, '..', 'media', 'accounts.css'), 'utf8')
const noticeCls = ((updBlock.match(/cls: '(banner [\w -]+)', icon: 'sparkle'/) || [])[1] || '').split(' ')
const welcomeList = (js.match(/h\('ul', \{ class: '([\w-]+)' \}, items\.map/) || [])[1]
check('the "Updated to" notice has a class of its own, not the one the welcome dialog\'s list is styled by',
  noticeCls.length === 2 && noticeCls[0] === 'banner' && !!welcomeList && !noticeCls.includes(welcomeList) &&
  css.includes('.' + welcomeList + ' {'), noticeCls.join(' ') + ' / ' + welcomeList)
check('the stylesheet loads nothing from outside', !/url\(\s*['"]?https?:/.test(css) && !/@import/.test(css))
const durations = (css.match(/[\s,(](\d*\.?\d+)(m?s)\b/g) || [])
  .map((d) => d.trim().replace(/^[,(]/, '')).map((d) => d.endsWith('ms') ? parseFloat(d) : parseFloat(d) * 1000)
const loopMs = [...css.matchAll(/animation: [\w-]+ (\d*\.?\d+)s [^;]*infinite/g)].map((m) => parseFloat(m[1]) * 1000)
const longest = Math.max(...durations.filter((ms) => !loopMs.includes(ms)))
check('every transition and animation is 350ms or less (the shared slide is 350ms) (endless loops like the spinner aside)',
  longest <= 350, 'longest ' + longest + 'ms')
check('motion is switched off for people who ask for reduced motion', /prefers-reduced-motion: reduce/.test(css))

console.log('\n-- the design rules --')
const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .map((m) => [m[1].trim(), m[2]])
console.log('\n-- one element for every notice --')
const noticeFn = (js.match(/function noticeEl\(o\) \{[\s\S]*?\n  \}\n/) || [''])[0]
check('one builder, noticeEl, draws every notice', !!noticeFn && (js.match(/function noticeEl\(/g) || []).length === 1)
check('no notice is built by hand: nothing makes an element with the class banner, note, alert, wait-strip or the old text and button classes',
  !/h\('div', \{ class: '(?:banner|note(?!-stack)|alert|wait-strip|note-text|note-actions|banner-actions)\b/.test(js))
check('the corner notices, the sign-in alert, the Reopen now strip, every notice at the top of the page and While you were away all call it',
  (js.match(/noticeEl\(\{/g) || []).length === 13 && /noticeEl\(\{[^\n]*cls: 'note'/.test(js) && /noticeEl\(\{ tone: 'bad', cls: 'float alert'/.test(js) &&
  /noticeEl\(\{ cls: 'inline wait-strip'/.test(js) && (js.match(/cls: 'banner/g) || []).length === 10)
const stackFn = (js.match(/function usageNotes\(a\) \{[\s\S]*?\n  \}\n/) || [''])[0]
check('the sign-in alert is a strip in the usage strips stack (last, nearest the toggles, no X); the Reopen now strip stays inline',
  !!stackFn && stackFn.indexOf("cls: 'float alert'") > 0 && !/float alert[^\n]*onClose/.test(stackFn) && /showX \? strip\('u-extra'[\s\S]*,\n\s+signIn\)/.test(stackFn) &&
  !/inline alert|stripRoom/.test(js) && /noticeEl\(\{ cls: 'inline wait-strip'/.test(js))
check('an ended login keeps an empty room where its meters would be, so the stack of strips never reaches the header',
  /h\('div', \{ class: 'strip-room' \+ \(extraShown\(a\) \? ' with-extra' : ''\)/.test(js) && /\.strip-room \{ flex: none; height: calc\(var\(--stack-h\) - 26px - var\(--card-gap\)\)/.test(css))
check('the sign-in strip has the usage strips look (the 80% fill, black text, radius, shadow), 8px inside on every side, the same in the compact view, solid in high contrast',
  /\.u-notes > \.notice\.float \{[^}]*padding: 8px;[^}]*box-shadow: 0 2px 8px[^}]*color: #000/.test(css) && !/compact-view[^{]*\.notice\.float/.test(css) &&
  /vscode-high-contrast \.u-notes > \.notice\.float/.test(css) && !/\.btn\.signin-btn \.btn-text \{ display: none/.test(css))
check('its buttons come after the text and the X, and the first one is primary',
  noticeFn.indexOf('notice-body') < noticeFn.indexOf('notice-x') && noticeFn.indexOf('notice-x') < noticeFn.indexOf('notice-actions') &&
  /i === 0 \? 'primary' : 'ghost'/.test(noticeFn))
check('its text goes in as text', /text: String\(o\.text \|\| ''\)/.test(noticeFn) && !/innerHTML/.test(noticeFn))
const ruleOf = (sel) => (rules.find((r) => r[0] === sel) || ['', ''])[1]
check('the stylesheet puts the buttons on the second row, from the text to the right edge, aligned right',
  /grid-row:\s*2/.test(ruleOf('.notice-actions')) && /grid-column:\s*2 \/ -1/.test(ruleOf('.notice-actions')) && /justify-content:\s*flex-end/.test(ruleOf('.notice-actions')))
check('and the text on the first row', /grid-row:\s*1/.test(ruleOf('.notice-body')))
check('the old separate button rows are gone from the stylesheet', !/banner-actions|note-actions|\.note-text|\.note-x|\.note > \.grow/.test(css))
const borders = []
for (const [sel, body] of rules) {
  for (const m of body.matchAll(/(?:^|;)\s*(border(?:-(?:top|right|bottom|left))?(?:-color)?)\s*:\s*([^;]+)/g)) {
    borders.push({ sel, prop: m[1], val: m[2].trim() })
  }
}
const strokes = borders.filter((b) => !(b.val === '0' || /transparent/.test(b.val) || /var\(--hc-border\)/.test(b.val) ||
  ((b.sel === '.card.live' || b.sel === '.lrow.live') && /var\(--live-stroke\)/.test(b.val)) ||
  ((b.sel === '.menu hr' || b.sel === '.foot') && /var\(--divider\)/.test(b.val))))
check('no strokes on anything — only the live account has one', strokes.length === 0,
  strokes.map((b) => b.sel + ' ' + b.prop + ': ' + b.val).join(' | '))
check('outside high contrast, that outline is invisible', /--hc-border: transparent;/.test(css) &&
  /body\.vscode-high-contrast[\s\S]{0,80}--hc-border: var\(--vscode-contrastBorder\)/.test(css))
const blurRule = 'body:not(.vscode-high-contrast):not(.vscode-high-contrast-light) .overlay { -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px); }'
check('the page behind a pop-up is blurred as well as dimmed, except in high contrast and with reduced transparency',
  css.includes('background: rgb(0 0 0 / 0.5); }') && css.includes(blurRule) &&
  !/^\.overlay[^{]*\{[^}]*backdrop-filter/m.test(css) &&
  /@media \(prefers-reduced-transparency: reduce\) \{\s*body:not\(\.vscode-high-contrast\):not\(\.vscode-high-contrast-light\) \.overlay \{[^}]*backdrop-filter: none/.test(css))
check('boxes have 16px corners, buttons 8px', /--radius: 16px;/.test(css) && /--radius-sm: 8px;/.test(css))
const ruleFor = (sel) => (rules.find(([s]) => s === sel) || [])[1] || ''
check('pinned folders: 8px rows, 16px on the top of the first and the bottom of the last',
  /border-radius: var\(--radius-sm\)/.test(ruleFor('.pin-row')) &&
  /border-top-left-radius: var\(--radius\);\s*border-top-right-radius: var\(--radius\)/.test(ruleFor('.pin-row:first-child')) &&
  /border-bottom-left-radius: var\(--radius\);\s*border-bottom-right-radius: var\(--radius\)/.test(ruleFor('.pin-row:last-child')))
check('cards and buttons use those radii', /var\(--radius\)/.test(ruleFor('.card')) && /var\(--radius-sm\)/.test(ruleFor('.btn')))
check('Update usage is a ghost icon-only button, and the Pin buttons (end of the tools line) say "Pin" then an icon',
  /class: 'btn ghost icon-only', disabled: updating[^\n]*'data-fk': 'update'/.test(js) && /h\('span', \{ class: 'hp-word', text: 'Pin' \}\), icon\(ic, 'sm'\)/.test(js))
check('no status pills on the cards (the plan badge is the only pill)', !/text: 'Most room'|'Live'|In use/.test(js) && /class: 'plan-badge'/.test(js))
check('menus live in a layer of their own, above every card', /document\.body\.append\(layer\)/.test(js) &&
  /\.menu-layer \{ position: fixed;[^}]*z-index: 40/.test(css))
check('menus are built with h(), which skips empty items, never with a bare append (that printed "null")',
  !/\bmenu\.append\(/.test(js))
check('an unchanged state is not redrawn, so an open menu survives a focus change', /const same = json === lastJson/.test(js))

console.log('\n-- toggles and narrow cards --')
const px = (body, prop) => { const m = body.match(new RegExp('(?:^|[;{\\s])' + prop + ':\\s*(-?[\\d.]+)px')); return m ? Number(m[1]) : NaN }
const track = ruleFor('.switch'), knob = ruleFor('.switch::after'), on = ruleFor('.switch[aria-checked="true"]::after')
const shift = Number((on.match(/translateX\(([\d.]+)px\)/) || [])[1])
check('the switch has no border to push its knob off centre', /border: 0;/.test(track))
check('its knob sits the same distance from the top and bottom',
  px(track, 'height') - px(knob, 'height') === 2 * px(knob, 'top'), px(track, 'height') + ' / ' + px(knob, 'height') + ' / ' + px(knob, 'top'))
check('and from the left when off as from the right when on',
  px(track, 'width') - px(knob, 'width') - px(knob, 'left') === px(knob, 'left') + shift)
check('on whole pixels', [px(track, 'width'), px(track, 'height'), px(knob, 'width'), shift].every(Number.isInteger))
check('the weekly reset is a countdown, with no date', !/dateText|MONTHS|ordinal/.test(js) && /'Resets in ' \+ u/.test(js))
check('cards are 300px or wider, three to a row at most on a wide page, 8px apart',
  /minmax\(min\(100%, 300px\), 1fr\)/.test(css) && /\.page \{ max-width: 1180px;/.test(css) && /\.grid \{ display: grid; gap: 8px;/.test(css))
check('and may shrink to 250px only to keep two abreast (under 608px: two 300px cards and the gap)',
  /@container accounts \(width < 608px\) \{\s*\.grid \{ grid-template-columns: repeat\(auto-fill, minmax\(min\(100%, 250px\), 1fr\)\); \}/.test(css))
check('text eases from 12.5px to 11.5px as a card goes from 300px to 250px',
  /\.card > \* \{ font-size: clamp\(11\.5px, calc\(11\.5px \+ \(100cqi - 220px\) \/ 50\), var\(--fs-max\)\); \}/.test(css))
check('a card short of room shortens Remote Control first, then shows the Switch icon alone, keeping their full names',
  /\.card-foot\.foot-short \.toggle \.tl\.has-short \.long \{ display: none; \}/.test(css) && /\.card-foot\.foot-icon \.btn\.switch-btn \.btn-text \{ display: none; \}/.test(css) &&
  /f\.classList\.add\('foot-short'\)[\s\S]{0,80}f\.classList\.add\('foot-icon'\)/.test(js) &&
  /toggle\('Remote Control', 'Remote'/.test(js) && /'aria-label': \(switching \? 'Switching to ' : 'Switch to '\) \+ a\.label/.test(js))
check('a label without a short form is never hidden', !/\.toggle \.tl \.long \{ display: none/.test(css))
check('the head\'s Pin buttons keep their whole names (tooltip and screen readers), and there is no Beta tag anywhere',
  /headPinButton\('pinChat', 'Pin a chat to an account', 'chat'/.test(js) && /headPinButton\('pinFolder', 'Pin a folder to an account', 'folder'/.test(js) &&
  /'aria-label': title/.test(js) && !/betaTag|class: 'beta'/.test(js) && !/\.beta \{/.test(css))

console.log('\n-- the compact view --')
check('an icon-only button in the tools line, after Search, Filter and Sort and before List or cards (the Pin buttons last), with aria-pressed',
  /compactButton\(\), viewButton\(\),\s*h\('div', \{ class: 't-pins' \}/.test(js) && /menuBtn\('t-filter'[\s\S]*?icon-only t-sort'/.test(js) &&
  /class: 'btn soft tool-btn icon-only cv-toggle'/.test(js) && /btn\.setAttribute\('aria-pressed', String\(on\)\)/.test(js))
check('its tooltip says what pressing it does, with the matching drawing; its name stays "Compact view" (pressed when on)',
  /const what = on \? 'Comfortable view' : 'Compact view'/.test(js) && /btn\.title = what/.test(js) &&
  /btn\.setAttribute\('aria-label', 'Compact view'\)/.test(js) && !/setAttribute\('aria-label', what\)/.test(js) &&
  /icon\(on \? 'unfold' : 'fold', 'sm'\)/.test(js) &&
  /\n    fold: '<path/.test(js) && /\n    unfold: '<path/.test(js))
check('off by default, and saved as a page setting', /askSecondLogin: true, compact: false, validity: true \}/.test(js) &&
  /send\('setting', \{ key: 'compact', value: on \}\)/.test(js))
check('reduced motion (the system\'s or VS Code\'s) changes the view at once',
  /matchMedia\('\(prefers-reduced-motion: reduce\)'\)\.matches/.test(js) && /vscode-reduce-motion/.test(js) &&
  /if \(!reducedMotion\(\) && pref\('listView'\) !== true\) \{ cvStart\(on\); return \}/.test(js))
check('a redraw waits for the change, and otherwise shows the saved view without animating',
  /if \(cvAnim\) \{ cvPending = true; return \}\n    docEl\.classList\.toggle\('compact-view', compactWanted\(\)\)/.test(js))
const cvTime = Number((js.match(/const CV_TIME = (\d+)/) || [])[1])
check('the change lasts 300-350ms: contents out over 100ms, in over 200ms',
  /const CV_OUT = 100\n/.test(js) && /const CV_IN = 200\n/.test(js) && cvTime >= 300 && cvTime <= 350, cvTime)
check('compact keeps text the same size (the font rule moves by the room the padding gives back: 13px, 12px in the sidebar)',
  /html\.compact-view \.card > \* \{ font-size: clamp\(11\.5px, calc\(11\.5px \+ \(100cqi - 233px\) \/ 50\), var\(--fs-max\)\); \}/.test(css) &&
  /html\.compact-view body\.narrow \.card > \* \{ font-size: clamp\(11\.5px, calc\(11\.5px \+ \(100cqi - 232px\) \/ 50\), var\(--fs-max\)\); \}/.test(css) &&
  2 * (px(ruleFor('.card'), 'padding') - px(ruleFor('html.compact-view .card'), 'padding')) === 13 &&
  2 * (px(ruleFor('body.narrow .card'), 'padding') - px(ruleFor('html.compact-view body.narrow .card'), 'padding')) === 12)
check('rows keep equal room on every side', /html\.compact-view \{ --cvo: 1; --row-pad: 4\.5px; \}/.test(css) &&
  /html\.compact-view \.ac-steps \{ padding: var\(--row-pad\); \}/.test(css))
check('compact: one line at the top (the picture is the pin button\'s 28px, no email line), and the email in the name\'s tooltip',
  /html\.compact-view \.card-head \.avatar, html\.compact-view body\.narrow \.card-head \.avatar \{ width: 28px; height: 28px; \}/.test(css) &&
  /html\.compact-view \.card-head \.ident \.sub \{ display: none; \}/.test(css) &&
  /h\('div', \{ class: 'name', text: a\.label, 'data-who': who \|\| null, title: \[who, days\]/.test(js) &&
  /nm\.title = \[nm\.dataset\.who \|\| '', days \|\| ''\]/.test(js))
check('compact: label, bar and reset line half as far apart, the same either side of the bar; the toggles closer',
  /html\.compact-view \.track \{ margin: -0\.9px 0 -0\.1px; \}/.test(css) && /html\.compact-view body\.narrow \.track \{ margin: -0\.5px 0 -0\.5px; \}/.test(css) &&
  /html\.compact-view \.card \.meters:has\(\+ \.card-foot\) \{ margin-bottom: -4px; \}/.test(css))
check('a narrow card keeps its Switch button on the toggles\' line (the footer\'s rules outweigh the sidebar\'s)',
  /@container card \(max-width: 300px\) \{\s*\.card-foot, html body\.narrow \.card-foot \{ column-gap: 8px; \}/.test(css) &&
  /\.card-foot, html body\.narrow \.card-foot \{ gap: 6px 8px; \}/.test(css))

console.log('\n-- colours and avatars --')
const clientColors = Object.keys(eval('(' + (js.match(/const COLORS = (\{[\s\S]*?\n  \})/) || [])[1] + ')'))
check('the page offers exactly the colours the extension accepts', clientColors.join(',') === store.COLORS.join(','), clientColors.join(','))
check('every colour is a theme colour, with VS Code\'s default as a fallback',
  [...js.matchAll(/\['\w+', 'var\(--vscode-[\w-]+, #[0-9a-f]{6}\)'\]/g)].length === store.COLORS.length)
check('and "Automatic" keeps the colour picked from the name', /function autoColor\(name\)/.test(js) &&
  /a\.color && COLORS\[a\.color\]\) \? a\.color : autoColor\(a\.name\)/.test(js))
check('only known colours are stored', store.validColor('teal') && !store.validColor('neon') && !store.validColor('') && !store.validColor(undefined))
check('pinned folders show the account\'s avatar, a circle like everywhere else',
  /avatar\(a, 'avatar sm'\)/.test(js) && !/'square'/.test(js) && /border-radius: 50%/.test(ruleFor('.avatar')))
check('an expired login shows no empty meters', /a\.needsLogin \? null : h\('div', \{ class: 'meters' \}/.test(js))

check('set to Do nothing, a waiting chat says it won\'t continue, not when it will',
  js.includes("ac.mode === 'off' ? 'won\\'t continue at ' + w.at + ' while this is set to Do nothing'"))

console.log('\n-- wording --')
const root = path.join(__dirname, '..')
const userFacing = ['extension.js', 'media/accounts.js', 'ui/page.js', ...fs.readdirSync(path.join(root, 'lib')).map((f) => 'lib/' + f),
  'package.json', 'README.md', 'docs/experimental.md']
const dashes = []
for (const f of userFacing) {
  const lines = fs.readFileSync(path.join(root, f), 'utf8').split('\n')
  lines.forEach((l, i) => {
    if (/\.js$/.test(f) && /^\s*(\/\/|\*|\/\*)/.test(l)) return
    if (l.includes('—')) dashes.push(f + ':' + (i + 1))
  })
}
check('no em dashes in anything a user reads', dashes.length === 0, dashes.join(', '))

console.log('\n-- icons --')
const media = (f) => fs.readFileSync(path.join(__dirname, '..', 'media', f), 'utf8')
const stroke = (svg) => (svg.match(/(?:stroke|fill)="(#[0-9a-fA-F]{3,6})"/) || [])[1]
const lum = (hex) => { const v = hex.length === 4 ? hex.slice(1).split('').map((c) => c + c) : hex.slice(1).match(/../g)
  return v.map((x) => parseInt(x, 16)).reduce((a, b) => a + b, 0) / 3 }
const light = media('tab-light.svg'), dark = media('tab-dark.svg'), bar = media('activity.svg')
check('the light-theme tab icon is dark, the dark-theme one is light', lum(stroke(light)) < 110 && lum(stroke(dark)) > 150)
check('all three are the same drawing', light.replace(stroke(light), '') === dark.replace(stroke(dark), '') &&
  bar.replace(stroke(bar), '') === light.replace(stroke(light), ''))

console.log('\n-- the phone button --')
const pageJs = fs.readFileSync(path.join(root, 'media', 'accounts.js'), 'utf8')
check('the phone button sits in the header beside the settings gear, and only when the extension sent the phone state',
  /phoneButton\(\),\s*h\('button', \{ class: 'btn ghost icon-only', 'data-menu': 'settings:x'/.test(pageJs) && /if \(!state \|\| !state\.phone\) return null/.test(pageJs))
check('its pop-up has Connect a phone, Get Awaydesk, Coming soon and the Mac and Linux line, and the action is the extension\'s to run',
  ['Connect a phone', 'Get Awaydesk', 'Coming soon', 'Coming to Mac and Linux later.'].every((t) => pageJs.includes("'" + t + "'")) && pageJs.includes("send('phoneAction')") && pageJs.includes("send('phoneOpen')"))
check('the page does no pairing of its own: no QR code, no device list, no connected dot', !/qrPicture|phone-dot|phoneDevices|phoneConnect|phoneReset/.test(pageJs))
{
  const extJs = fs.readFileSync(path.join(root, 'extension.js'), 'utf8')
  const withArt = page.render({ ...base, awaydeskUri: 'https://file.test/media/awaydesk.jpg' })
  check('the pop-up shows Awaydesk\'s picture: media/awaydesk.jpg is shipped, the extension gives the page its address, and the page draws it as an image',
    fs.existsSync(path.join(root, 'media', 'awaydesk.jpg')) && /awaydeskUri: String\(webview\.asWebviewUri\(vscode\.Uri\.file\(path\.join\(mediaDir\(\), 'awaydesk\.jpg'\)\)\)\)/.test(extJs) &&
    withArt.includes('window.__AWAYDESK__="https://file.test/media/awaydesk.jpg"') && /function phoneArt\(\)[\s\S]{0,400}h\('img', \{ src, alt: ''/.test(pageJs) &&
    !/createElementNS\(NS, 'svg'\)[\s\S]{0,200}pa-/.test(pageJs))
  check('without an address the page draws no picture and no empty box', page.render(base).includes('window.__AWAYDESK__=null') && /return src \? h\('div', \{ class: 'phone-art' \}/.test(pageJs))
}

console.log('\n-- the log: Open chat on a chat entry --')
{
  const m = /const openable = \(e\) => (\[[^\]]*\]\.includes\(e\.kind\) && [^\n]+)\n/.exec(pageJs)
  const openable = m ? new Function('e', 'return ' + m[1]) : () => null
  check('the page decides from the entry alone: a chat kind with a chat id gets the button', !!m && openable({ kind: 'stop', chatId: 'abc-123' }) === true &&
    openable({ kind: 'continue', chatId: 'c1' }) === true && openable({ kind: 'phone', chatId: 'c1' }) === true && openable({ kind: 'wait', chatId: 'c1' }) === true)
  check('an entry with no chat id, or not about a chat, or with an odd id, does not', openable({ kind: 'stop' }) === false && openable({ kind: 'switch', chatId: 'c1' }) === false &&
    openable({ kind: 'stop', chatId: '../x y' }) === false && openable({ kind: 'keepalive', chatId: 'c1' }) === false)
  check('the button says Open chat, uses the shared button styles, and sends only the chat id', /h\('button', \{ class: 'btn soft sm', 'data-fk': 'log:open:' \+ e\.id,/.test(pageJs) &&
    pageJs.includes("send('openChat', { id: e.chatId })") && pageJs.includes("'Open chat'"))
  check('it sits in the row (the tags line), not in the log\'s header or filters', /lg-tags' \}, tag, openable\(e\)/.test(pageJs) && !/openChat/.test(pageJs.slice(pageJs.indexOf('function logPage'), pageJs.indexOf('function logPage') + 1200)))
}

console.log('\n' + passed + ' passed, ' + failed + ' failed')
assert.strictEqual(failed, 0, 'page tests failed')
