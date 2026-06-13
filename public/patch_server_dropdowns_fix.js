const fs = require('fs');
const files = [
  'public/inventory.html',
  'public/leaderboards.html',
  'public/jewels.html',
  'public/cart.html',
  'public/store.html'
];
const desktopReplacement = `<div class="server-dropdown" id="serverDropdown">
            <div class="server-dropdown-item" onclick="selectServer('Spirals RCE — NA 6x','na3x',this,'desktop')">Spirals RCE — NA 6x <span class="server-player-count" id="nav-pop-na3x">--/--</span></div>
        </div>`;
const mobileReplacement = `<div class="mobile-server-dropdown" id="mobileServerDropdown">
          <div class="server-dropdown-item" onclick="selectServer('Spirals RCE — NA 6x','na3x',this,'mobile')">Spirals RCE — NA 6x <span class="server-player-count" id="mob-nav-pop-na3x">--/--</span></div>
        </div>`;

function replaceDropdownBlock(text, selector, replacement) {
  const startIndex = text.indexOf(selector);
  if (startIndex === -1) return text;
  let index = startIndex + selector.length;
  let depth = 1;
  while (index < text.length) {
    const open = text.indexOf('<div', index);
    const close = text.indexOf('</div>', index);
    if (close === -1) break;
    if (open !== -1 && open < close) {
      depth += 1;
      index = open + 4;
    } else {
      depth -= 1;
      index = close + 6;
      if (depth === 0) {
        return text.slice(0, startIndex) + replacement + text.slice(index);
      }
    }
  }
  return text;
}

for (const filePath of files) {
  let text = fs.readFileSync(filePath, 'utf8');
  const original = text;
  text = text.replace(/<span id="serverSelectorLabel">Select Server<\/span>/g, '<span id="serverSelectorLabel">Spirals RCE — NA 6x<\/span>');
  text = replaceDropdownBlock(text, '<div class="server-dropdown" id="serverDropdown">', desktopReplacement);
  text = replaceDropdownBlock(text, '<div class="mobile-server-dropdown" id="mobileServerDropdown">', mobileReplacement);
  if (text !== original) {
    fs.writeFileSync(filePath, text, 'utf8');
    console.log('patched', filePath);
  }
}
