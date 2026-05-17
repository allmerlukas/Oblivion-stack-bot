/**
 * deploy-global.js
 * Deploys user-installable commands globally.
 * These commands work in ANY server without the bot being invited,
 * as long as the user has installed the bot to their account.
 *
 * Run once: node deploy-global.js
 * Global commands take up to 1 hour to propagate everywhere.
 */

require('dotenv').config();
const { REST, Routes } = require('discord.js');
const fs = require('fs');
const path = require('path');

// Deploy all commands globally:
// - wave.js      → user-installable, works in any server
// - giveaway.js  → guild-only (bcreate), requires bot in server
// - partners.js  → guild-only, requires bot in server
const GLOBAL_COMMANDS = [
  'wave.js', 'giveaway.js', 'partners.js', 'partner.js', 'bend.js', 'brig.js',
  'purge.js', 'kick.js', 'ban.js', 'unban.js',
  'timeout.js', 'userinfo.js', 'serverinfo.js', 'avatar.js', 'ping.js',
  'ticket.js', 'setup.js', 'lock.js', 'slowmode.js',
  'announce.js', 'poll.js', 'role.js',
  'config.js',   // Auto-Wave configuration
  'credits.js',  // Public credits command
];

const commands = [];
const commandsPath = path.join(__dirname, 'src', 'commands');

for (const file of GLOBAL_COMMANDS) {
  const filePath = path.join(commandsPath, file);
  if (!fs.existsSync(filePath)) {
    console.warn(`⚠️  Command file not found: ${file}`);
    continue;
  }
  const command = require(filePath);
  if (command.data) {
    commands.push(command.data.toJSON());
    console.log(`📌 Preparing global command: /${command.data.name}`);
  }
}

const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);

(async () => {
  try {
    console.log(`\n🌍 Deploying ${commands.length} global command(s)...`);
    const data = await rest.put(
      Routes.applicationCommands(process.env.CLIENT_ID),
      { body: commands }
    );
    console.log(`✅ Successfully deployed ${data.length} global command(s)!`);
    console.log(`⏳ Note: Global commands may take up to 1 hour to appear everywhere.`);
    console.log(`\n📲 User install link:`);
    console.log(`https://discord.com/oauth2/authorize?client_id=${process.env.CLIENT_ID}&scope=applications.commands&integration_type=1\n`);
  } catch (error) {
    console.error('❌ Global deploy failed:', error);
  }
})();
