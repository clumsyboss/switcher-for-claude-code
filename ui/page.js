const crypto = require('crypto')

const ICONS = {
  account: 60313, person: 60007, organization: 60030, home: 60166, briefcase: 60076,
  rocket: 60228, beaker: 60025, 'star-full': 60249, heart: 60165, zap: 60038, flame: 60146,
  globe: 60161, tools: 60269, code: 60100, cloud: 60330, shield: 60243, key: 60177,
  'mortar-board': 60193, gift: 60153, bug: 60079, telescope: 60264, squirrel: 60248,
  game: 60439,
  'cloud+zap': [60330, 60038],
}

const ICON_NAMES = { game: 'gaming', 'cloud+zap': 'cloud + lightning', zap: 'lightning', 'star-full': 'star', 'mortar-board': 'graduation cap' }

function nonce() { return crypto.randomBytes(16).toString('base64').replace(/[^A-Za-z0-9]/g, '') }

function attr(v) { return String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;') }

function render(o) {
  const layout = o.layout === 'sidebar' ? 'sidebar' : 'tab'
  const n = o.nonce || nonce()
  const csp = [
    "default-src 'none'",
    'img-src ' + o.cspSource + ' data:',
    'font-src ' + o.cspSource,
    'style-src ' + o.cspSource + " 'nonce-" + n + "'",
    "script-src 'nonce-" + n + "'",
  ].join('; ')
  const font = o.fontUri
    ? '<style nonce="' + n + '">@font-face{font-family:"host-codicon";src:url("' + attr(o.fontUri) +
      '") format("truetype");font-display:block}</style>'
    : ''
  return '<!DOCTYPE html>\n<html lang="en">\n<head>\n' +
    '<meta charset="UTF-8">\n' +
    '<meta http-equiv="Content-Security-Policy" content="' + attr(csp) + '">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    '<title>Claude Accounts</title>\n' +
    '<link rel="stylesheet" href="' + attr(o.cssUri) + '">\n' + font + '\n' +
    '</head>\n<body class="layout-' + layout + '">\n' +
    '<main class="page" id="app" aria-live="polite"></main>\n' +
    '<script nonce="' + n + '">window.__ICONS__=' + JSON.stringify(ICONS) +
      ';window.__ICON_NAMES__=' + JSON.stringify(ICON_NAMES) +
      ';window.__HAS_FONT__=' + (o.fontUri ? 'true' : 'false') +
      ';window.__LAYOUT__=' + JSON.stringify(layout) + ';</script>\n' +
    '<script nonce="' + n + '" src="' + attr(o.jsUri) + '"></script>\n' +
    '</body>\n</html>\n'
}

module.exports = { render, ICONS, ICON_NAMES, nonce }
