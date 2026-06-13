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
for (const filePath of files) {
  const fullPath = filePath;
  let text = fs.readFileSync(fullPath, 'utf8');
  const original = text;
  text = text.replace(/<span id="serverSelectorLabel">Select Server<\/span>/g, '<span id="serverSelectorLabel">Spirals RCE — NA 6x<\/span>');
  text = text.replace(/<div class="server-dropdown" id="serverDropdown">[\s\S]*?<\/div>/, desktopReplacement);
  text = text.replace(/<div class="mobile-server-dropdown" id="mobileServerDropdown">[\s\S]*?<\/div>/, mobileReplacement);
  if (text !== original) {
    fs.writeFileSync(fullPath, text, 'utf8');
    console.log('patched', fullPath);
  }
}
