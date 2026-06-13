const token = process.env.DISCORD_BOT_TOKEN;
let client = null;

try {
  if (token) {
    const { Client, GatewayIntentBits } = require('discord.js');
    client = new Client({ intents: [GatewayIntentBits.Guilds] });

    client.once('ready', () => {
      try {
        console.log(`✅ Discord client ready: ${client.user.tag}`);
      } catch (e) { console.log('✅ Discord client ready'); }
    });

    client.on('error', err => console.error('Discord client error:', err));

    client.login(token).catch(err => {
      console.error('Discord login failed:', err && err.message ? err.message : err);
    });
  } else {
    console.log('No DISCORD_BOT_TOKEN provided; skipping Discord client startup');
  }
} catch (err) {
  console.error('Failed to initialize discord client (is discord.js installed?):', err && err.message ? err.message : err);
}

module.exports = { client };
