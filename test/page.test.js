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
check('it never stores anything itself', !/localStorage|sessionStorage|indexedDB|setState\(/.test(js))
const css = fs.readFileSync(path.join(__dirname, '..', 'media', 'accounts.css'), 'utf8')
check('the stylesheet loads nothing from outside', !/url\(\s*['"]?https?:/.test(css) && !/@import/.test(css))
const durations = (css.match(/[\s,(](\d*\.?\d+)(m?s)\b/g) || [])
  .map((d) => d.trim().replace(/^[,(]/, '')).map((d) => d.endsWith('ms') ? parseFloat(d) : parseFloat(d) * 1000)
const spinLine = css.split('\n').find((l) => l.includes('animation: spin'))
const longest = Math.max(...durations.filter((ms) => !(spinLine && spinLine.includes(String(ms / 1000) + 's') && ms === 1000)))
check('every transition and animation is 250ms or less (the loading spinner is a loop, not a transition)',
  longest <= 250, 'longest ' + longest + 'ms')
check('motion is switched off for people who ask for reduced motion', /prefers-reduced-motion: reduce/.test(css))

console.log('\n-- the design rules --')
const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .map((m) => [m[1].trim(), m[2]])
const borders = []
for (const [sel, body] of rules) {
  for (const m of body.matchAll(/(?:^|;)\s*(border(?:-(?:top|right|bottom|left))?(?:-color)?)\s*:\s*([^;]+)/g)) {
    borders.push({ sel, prop: m[1], val: m[2].trim() })
  }
}
const strokes = borders.filter((b) => !(b.val === '0' || /transparent/.test(b.val) || /var\(--hc-border\)/.test(b.val) ||
  (b.sel === '.card.live' && /var\(--live-stroke\)/.test(b.val)) ||
  ((b.sel === '.menu hr' || b.sel === '.foot') && /var\(--divider\)/.test(b.val))))
check('no strokes on anything — only the live account has one', strokes.length === 0,
  strokes.map((b) => b.sel + ' ' + b.prop + ': ' + b.val).join(' | '))
check('outside high contrast, that outline is invisible', /--hc-border: transparent;/.test(css) &&
  /body\.vscode-high-contrast[\s\S]{0,80}--hc-border: var\(--vscode-contrastBorder\)/.test(css))
check('boxes have 8px corners, buttons 4px', /--radius: 8px;/.test(css) && /--radius-sm: 4px;/.test(css))
const ruleFor = (sel) => (rules.find(([s]) => s === sel) || [])[1] || ''
check('pinned folders: 4px rows, 8px on the top of the first and the bottom of the last',
  /border-radius: var\(--radius-sm\)/.test(ruleFor('.pin-row')) &&
  /border-top-left-radius: var\(--radius\);\s*border-top-right-radius: var\(--radius\)/.test(ruleFor('.pin-row:first-child')) &&
  /border-bottom-left-radius: var\(--radius\);\s*border-bottom-right-radius: var\(--radius\)/.test(ruleFor('.pin-row:last-child')))
check('cards and buttons use those radii', /var\(--radius\)/.test(ruleFor('.card')) && /var\(--radius-sm\)/.test(ruleFor('.btn')))
check('Update usage and Pin a folder are ghost buttons',
  /class: 'btn ghost'[^\n]*send\('update'/.test(js) && /class: 'btn ghost sm', onclick: \(\) => send\('pin'\) }, icon\('pin'/.test(js))
check('no status pills on the cards', !/badge/.test(js) && !/Most room|'Live'|In use/.test(js))
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
check('a narrow card shortens Remote Control and shows the Switch icon alone, keeping their full names',
  /@container card \(max-width: 310px\)[^}]*\.has-short \.long \{ display: none; \}[\s\S]*?\.btn-text \{ display: none; \}/.test(css) &&
  /toggle\('Remote Control', 'Remote'/.test(js) && /'aria-label': \(switching \? 'Switching to ' : 'Switch to '\) \+ a\.label/.test(js))
check('a label without a short form is never hidden', !/\.toggle \.tl \.long \{ display: none/.test(css))

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
const stroke = (svg) => (svg.match(/stroke="(#[0-9a-fA-F]{3,6})"/) || [])[1]
const lum = (hex) => { const v = hex.length === 4 ? hex.slice(1).split('').map((c) => c + c) : hex.slice(1).match(/../g)
  return v.map((x) => parseInt(x, 16)).reduce((a, b) => a + b, 0) / 3 }
const light = media('tab-light.svg'), dark = media('tab-dark.svg'), bar = media('activity.svg')
check('the light-theme tab icon is dark, the dark-theme one is light', lum(stroke(light)) < 110 && lum(stroke(dark)) > 150)
check('all three are the same drawing', light.replace(stroke(light), '') === dark.replace(stroke(dark), '') &&
  bar.replace(stroke(bar), '') === light.replace(stroke(light), ''))

console.log('\n' + passed + ' passed, ' + failed + ' failed')
assert.strictEqual(failed, 0, 'page tests failed')
