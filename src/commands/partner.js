/**
 * /partner — Personal partner manager
 *
 * Subcommands:
 *   /partner setup  guild_id channel_id [label]  — Register your first guild
 *   /partner add    guild_id channel_id [label]  — Add another guild
 *   /partner remove guild_id                     — Remove a guild
 *   /partner list                                — List all your guilds
 *   /partner random                              — Pick 2 random eligible guilds to partner
 *
 * How /partner random works:
 *   1. Load all guilds the user has registered.
 *   2. Shuffle them randomly.
 *   3. Find the first pair where neither guild has been partnered with the other
 *      by this user in the last 2 days.
 *   4. Send an ephemeral message with jump links to both partner channels
 *      + a "✅ Mark as Partnered" button.
 *   5. When the user clicks the button, record the pair in pm_pairs.
 */

const {
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} = require('discord.js');

const pmStore = require('../utils/pmStore');

// ─── Shuffle helper ───────────────────────────────────────────────────────────

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ─── Find first eligible pair from a shuffled list ───────────────────────────

function findEligiblePair(userId, guilds) {
  // Try every combination in shuffled order
  const shuffled = shuffle(guilds);
  for (let i = 0; i < shuffled.length; i++) {
    for (let j = i + 1; j < shuffled.length; j++) {
      const a = shuffled[i];
      const b = shuffled[j];
      if (!pmStore.pairedRecently(userId, a.guild_id, b.guild_id)) {
        return [a, b];
      }
    }
  }
  return null; // all pairs on cooldown
}

// ─── Build the match embed ────────────────────────────────────────────────────

function buildMatchEmbed(g1, g2) {
  const jumpA = `https://discord.com/channels/${g1.guild_id}/${g1.channel_id}`;
  const jumpB = `https://discord.com/channels/${g2.guild_id}/${g2.channel_id}`;

  return new EmbedBuilder()
    .setColor(0x7c5cfc)
    .setTitle('🎲 Partner Match')
    .setDescription('Post in both partner channels, then click **✅ Mark as Partnered** to record it.')
    .addFields(
      {
        name: `🏠 ${g1.label || `Guild \`${g1.guild_id}\``}`,
        value: `📢 Partner channel: [Jump →](${jumpA})\n\`${g1.channel_id}\``,
        inline: true,
      },
      {
        name: `🏠 ${g2.label || `Guild \`${g2.guild_id}\``}`,
        value: `📢 Partner channel: [Jump →](${jumpB})\n\`${g2.channel_id}\``,
        inline: true,
      },
    )
    .setFooter({ text: 'These two guilds have not been partnered in the last 2 days.' })
    .setTimestamp();
}

// ─── Build confirm button ─────────────────────────────────────────────────────

function buildConfirmRow(userId, guildAId, guildBId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`pm_confirm:${userId}:${guildAId}:${guildBId}`)
      .setLabel('✅ Mark as Partnered')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`pm_reroll:${userId}`)
      .setLabel('🔄 Re-roll')
      .setStyle(ButtonStyle.Secondary),
  );
}

// ─── Command ─────────────────────────────────────────────────────────────────

module.exports = {
  data: new SlashCommandBuilder()
    .setName('partner')
    .setDescription('Personal partner manager — track and randomise your server partnerships')

    // setup
    .addSubcommand(sub =>
      sub.setName('setup')
        .setDescription('Register the first guild you manage partnerships for')
        .addStringOption(opt =>
          opt.setName('guild_id')
            .setDescription('Guild ID of the server')
            .setRequired(true)
        )
        .addStringOption(opt =>
          opt.setName('channel_id')
            .setDescription('ID of the partner channel in that server')
            .setRequired(true)
        )
        .addStringOption(opt =>
          opt.setName('label')
            .setDescription('Optional nickname (e.g. "My Main Server")')
            .setRequired(false)
            .setMaxLength(40)
        )
    )

    // add
    .addSubcommand(sub =>
      sub.setName('add')
        .setDescription('Add another guild to your partner manager list')
        .addStringOption(opt =>
          opt.setName('guild_id')
            .setDescription('Guild ID of the server')
            .setRequired(true)
        )
        .addStringOption(opt =>
          opt.setName('channel_id')
            .setDescription('ID of the partner channel in that server')
            .setRequired(true)
        )
        .addStringOption(opt =>
          opt.setName('label')
            .setDescription('Optional nickname (e.g. "Partner Server #2")')
            .setRequired(false)
            .setMaxLength(40)
        )
    )

    // remove
    .addSubcommand(sub =>
      sub.setName('remove')
        .setDescription('Remove a guild from your partner manager list')
        .addStringOption(opt =>
          opt.setName('guild_id')
            .setDescription('Guild ID to remove')
            .setRequired(true)
        )
    )

    // list
    .addSubcommand(sub =>
      sub.setName('list')
        .setDescription('Show all guilds in your partner manager list')
    )

    // random
    .addSubcommand(sub =>
      sub.setName('random')
        .setDescription('Pick 2 random guilds that haven\'t partnered in 2 days')
    ),

  // ─── Execute ─────────────────────────────────────────────────────────────────

  async execute(interaction) {
    const sub    = interaction.options.getSubcommand();
    const userId = interaction.user.id;

    // ── /partner setup ─────────────────────────────────────────────────────────
    // Same logic as add — just a friendlier entry point
    if (sub === 'setup' || sub === 'add') {
      const guildId   = interaction.options.getString('guild_id');
      const channelId = interaction.options.getString('channel_id');
      const label     = interaction.options.getString('label') ?? null;

      // Basic ID validation (Discord IDs are 17-19 digit numbers)
      if (!/^\d{17,19}$/.test(guildId)) {
        return interaction.reply({ content: '❌ Invalid guild ID. Should be a 17-19 digit number.', ephemeral: true });
      }
      if (!/^\d{17,19}$/.test(channelId)) {
        return interaction.reply({ content: '❌ Invalid channel ID. Should be a 17-19 digit number.', ephemeral: true });
      }

      const isUpdate = pmStore.hasGuild(userId, guildId);
      pmStore.addGuild(userId, guildId, channelId, label);

      const displayName = label ?? `Guild \`${guildId}\``;
      const total       = pmStore.getGuilds(userId).length;

      return interaction.reply({
        content: [
          isUpdate
            ? `✅ Updated **${displayName}** in your partner list.`
            : `✅ Added **${displayName}** to your partner list.`,
          `📢 Partner channel: \`${channelId}\``,
          `📋 You now have **${total}** guild(s) registered.`,
          total < 2 ? `\n💡 Add at least one more guild to use \`/partner random\`.` : '',
        ].join('\n'),
        ephemeral: true,
      });
    }

    // ── /partner remove ────────────────────────────────────────────────────────
    if (sub === 'remove') {
      const guildId = interaction.options.getString('guild_id');
      if (!pmStore.removeGuild(userId, guildId)) {
        return interaction.reply({ content: `❌ Guild \`${guildId}\` is not in your list.`, ephemeral: true });
      }
      return interaction.reply({
        content: `🗑️ Removed guild \`${guildId}\` from your partner manager.`,
        ephemeral: true,
      });
    }

    // ── /partner list ──────────────────────────────────────────────────────────
    if (sub === 'list') {
      const guilds = pmStore.getGuilds(userId);

      if (guilds.length === 0) {
        return interaction.reply({
          content: '📭 No guilds registered yet. Use `/partner setup` to add your first one.',
          ephemeral: true,
        });
      }

      const lines = guilds.map((g, i) => {
        const name    = g.label ? `**${g.label}**` : `Guild \`${g.guild_id}\``;
        const channel = `<#${g.channel_id}>`;
        return `**${i + 1}.** ${name} — ${channel} (\`${g.guild_id}\`)`;
      });

      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x7c5cfc)
            .setTitle(`🤝 Your Partner Guilds (${guilds.length})`)
            .setDescription(lines.join('\n'))
            .setFooter({ text: 'Use /partner random to get a match' }),
        ],
        ephemeral: true,
      });
    }

    // ── /partner random ────────────────────────────────────────────────────────
    if (sub === 'random') {
      const guilds = pmStore.getGuilds(userId);

      if (guilds.length < 2) {
        return interaction.reply({
          content: `❌ You need at least **2 guilds** registered. You have **${guilds.length}**.\nUse \`/partner add\` to add more.`,
          ephemeral: true,
        });
      }

      const pair = findEligiblePair(userId, guilds);

      if (!pair) {
        return interaction.reply({
          content: [
            '⏳ **All pairs are on cooldown!**',
            `Every combination of your **${guilds.length}** guilds was partnered within the last 2 days.`,
            'Try again later or add more guilds with `/partner add`.',
          ].join('\n'),
          ephemeral: true,
        });
      }

      const [g1, g2] = pair;

      return interaction.reply({
        embeds: [buildMatchEmbed(g1, g2)],
        components: [buildConfirmRow(userId, g1.guild_id, g2.guild_id)],
        ephemeral: true,
      });
    }
  },

  // ─── Button handler (called from interactionCreate) ───────────────────────

  async handleButton(interaction) {
    const [action, userId, guildAId, guildBId] = interaction.customId.split(':');

    // Only the user who ran /partner random can click
    if (interaction.user.id !== userId) {
      return interaction.reply({ content: '❌ This is not your session.', ephemeral: true });
    }

    if (action === 'pm_confirm') {
      pmStore.recordPair(userId, guildAId, guildBId);

      const guilds  = pmStore.getGuilds(userId);
      const g1      = guilds.find(g => g.guild_id === guildAId);
      const g2      = guilds.find(g => g.guild_id === guildBId);
      const nameA   = g1?.label ?? `\`${guildAId}\``;
      const nameB   = g2?.label ?? `\`${guildBId}\``;

      return interaction.update({
        embeds: [
          new EmbedBuilder()
            .setColor(0x22c55e)
            .setTitle('✅ Partnership Recorded!')
            .setDescription(`**${nameA}** ↔ **${nameB}** have been marked as partnered.\nThey won't be matched again for **2 days**.`)
            .setTimestamp(),
        ],
        components: [],
      });
    }

    if (action === 'pm_reroll') {
      const guilds = pmStore.getGuilds(userId);
      const pair   = findEligiblePair(userId, guilds);

      if (!pair) {
        return interaction.update({
          embeds: [
            new EmbedBuilder()
              .setColor(0xfbbf24)
              .setTitle('⏳ No eligible pairs')
              .setDescription('All your guild combinations are on the 2-day cooldown. Try again later.'),
          ],
          components: [],
        });
      }

      const [g1, g2] = pair;
      return interaction.update({
        embeds: [buildMatchEmbed(g1, g2)],
        components: [buildConfirmRow(userId, g1.guild_id, g2.guild_id)],
      });
    }
  },
};
