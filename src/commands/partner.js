/**
 * /partner — Personal partner manager
 *
 * Subcommands:
 *   /partner setup  — Register first guild
 *   /partner add    — Add another guild
 *   /partner remove — Remove a guild
 *   /partner list   — List all guilds
 *   /partner random — Pick 2 random eligible guilds
 *   /partner wave   — Pair ALL guilds together in one session
 *                     If odd count → pick which server gets 2 partners
 */

const {
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');

const pmStore = require('../utils/pmStore');

// ─── In-memory wave sessions ──────────────────────────────────────────────────
// Keyed by userId; stores finalized pairs and the leftover guild (if odd count)
// TTL: 15 minutes

const waveSessions = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of waveSessions) {
    if (s.expiresAt < now) waveSessions.delete(id);
  }
}, 5 * 60 * 1000);

function setWaveSession(userId, data) {
  waveSessions.set(userId, { ...data, expiresAt: Date.now() + 15 * 60 * 1000 });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function guildName(g) {
  return g.label || `Guild \`${g.guild_id}\``;
}

function jumpLink(g) {
  return `https://discord.com/channels/${g.guild_id}/${g.channel_id}`;
}

// ─── Build wave summary embed ─────────────────────────────────────────────────

function buildWaveEmbed(pairs, guildsMap, extra = null, doubleGuild = null) {
  const lines = pairs.map((pair, i) => {
    const a  = guildsMap[pair[0]];
    const b  = guildsMap[pair[1]];
    const nameA = guildName(a);
    const nameB = guildName(b);
    return `**${i + 1}.** [${nameA}](${jumpLink(a)}) ↔ [${nameB}](${jumpLink(b)})`;
  });

  const embed = new EmbedBuilder()
    .setColor(0x7c5cfc)
    .setTitle(`🌊 Wave Session — ${Object.keys(guildsMap).length} servers, ${pairs.length} pair(s)`)
    .setDescription(lines.join('\n') || '*No pairs yet.*')
    .setTimestamp();

  if (extra) {
    const extraG = guildsMap[extra];
    embed.addFields({
      name: '⚠️ Leftover Server',
      value: `**${guildName(extraG)}** has no partner yet — choose which server gets the extra partnership.`,
    });
  }

  if (doubleGuild) {
    const dg = guildsMap[doubleGuild];
    embed.setFooter({ text: `${guildName(dg)} will handle 2 partnerships this wave.` });
  }

  return embed;
}

// ─── Find eligible pair for /partner random ───────────────────────────────────

function findEligiblePair(userId, guilds) {
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
  return null;
}

// ─── Build random match embed ─────────────────────────────────────────────────

function buildMatchEmbed(g1, g2) {
  return new EmbedBuilder()
    .setColor(0x7c5cfc)
    .setTitle('🎲 Partner Match')
    .setDescription('Post in both partner channels, then click **✅ Mark as Partnered** to record it.')
    .addFields(
      {
        name: `🏠 ${guildName(g1)}`,
        value: `📢 Partner channel: [Jump →](${jumpLink(g1)})\n\`${g1.channel_id}\``,
        inline: true,
      },
      {
        name: `🏠 ${guildName(g2)}`,
        value: `📢 Partner channel: [Jump →](${jumpLink(g2)})\n\`${g2.channel_id}\``,
        inline: true,
      },
    )
    .setFooter({ text: 'These two guilds have not been partnered in the last 2 days.' })
    .setTimestamp();
}

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

// ─── Command definition ───────────────────────────────────────────────────────

module.exports = {
  data: new SlashCommandBuilder()
    .setName('partner')
    .setDescription('Personal partner manager — track and randomise your server partnerships')

    .addSubcommand(sub =>
      sub.setName('setup')
        .setDescription('Register the first guild you manage partnerships for')
        .addStringOption(opt => opt.setName('guild_id').setDescription('Guild ID').setRequired(true))
        .addStringOption(opt => opt.setName('channel_id').setDescription('Partner channel ID').setRequired(true))
        .addStringOption(opt => opt.setName('label').setDescription('Nickname (optional)').setRequired(false).setMaxLength(40))
    )

    .addSubcommand(sub =>
      sub.setName('add')
        .setDescription('Add another guild to your list')
        .addStringOption(opt => opt.setName('guild_id').setDescription('Guild ID').setRequired(true))
        .addStringOption(opt => opt.setName('channel_id').setDescription('Partner channel ID').setRequired(true))
        .addStringOption(opt => opt.setName('label').setDescription('Nickname (optional)').setRequired(false).setMaxLength(40))
    )

    .addSubcommand(sub =>
      sub.setName('remove')
        .setDescription('Remove a guild from your list')
        .addStringOption(opt => opt.setName('guild_id').setDescription('Guild ID to remove').setRequired(true))
    )

    .addSubcommand(sub =>
      sub.setName('list')
        .setDescription('Show all guilds in your partner manager list')
    )

    .addSubcommand(sub =>
      sub.setName('random')
        .setDescription('Pick 2 random guilds that haven\'t partnered in 2 days')
    )

    .addSubcommand(sub =>
      sub.setName('wave')
        .setDescription('Pair ALL your guilds together in one big session')
    )

    .addSubcommand(sub =>
      sub.setName('edit')
        .setDescription('Edit the channel ID or label of a registered guild')
    ),

  // ─── Execute ─────────────────────────────────────────────────────────────────

  async execute(interaction) {
    const sub    = interaction.options.getSubcommand();
    const userId = interaction.user.id;

    // ── /partner setup & add ──────────────────────────────────────────────────
    if (sub === 'setup' || sub === 'add') {
      const guildId   = interaction.options.getString('guild_id');
      const channelId = interaction.options.getString('channel_id');
      const label     = interaction.options.getString('label') ?? null;

      if (!/^\d{17,19}$/.test(guildId))   return interaction.reply({ content: '❌ Invalid guild ID.', ephemeral: true });
      if (!/^\d{17,19}$/.test(channelId)) return interaction.reply({ content: '❌ Invalid channel ID.', ephemeral: true });

      const isUpdate    = pmStore.hasGuild(userId, guildId);
      pmStore.addGuild(userId, guildId, channelId, label);
      const displayName = label ?? `Guild \`${guildId}\``;
      const total       = pmStore.getGuilds(userId).length;

      return interaction.reply({
        content: [
          isUpdate ? `✅ Updated **${displayName}**.` : `✅ Added **${displayName}** to your list.`,
          `📢 Partner channel: \`${channelId}\``,
          `📋 You now have **${total}** guild(s) registered.`,
          total < 2 ? `\n💡 Add at least one more guild to use \`/partner random\` or \`/partner wave\`.` : '',
        ].join('\n'),
        ephemeral: true,
      });
    }

    // ── /partner remove ───────────────────────────────────────────────────────
    if (sub === 'remove') {
      const guildId = interaction.options.getString('guild_id');
      if (!pmStore.removeGuild(userId, guildId)) {
        return interaction.reply({ content: `❌ Guild \`${guildId}\` is not in your list.`, ephemeral: true });
      }
      return interaction.reply({ content: `🗑️ Removed guild \`${guildId}\`.`, ephemeral: true });
    }

    // ── /partner list ─────────────────────────────────────────────────────────
    if (sub === 'list') {
      const guilds = pmStore.getGuilds(userId);
      if (guilds.length === 0) {
        return interaction.reply({ content: '📭 No guilds registered. Use `/partner setup` to add your first one.', ephemeral: true });
      }
      const lines = guilds.map((g, i) =>
        `**${i + 1}.** ${g.label ? `**${g.label}**` : `Guild \`${g.guild_id}\``} — <#${g.channel_id}> (\`${g.guild_id}\`)`
      );
      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x7c5cfc)
            .setTitle(`🤝 Your Partner Guilds (${guilds.length})`)
            .setDescription(lines.join('\n'))
            .setFooter({ text: 'Use /partner wave to pair them all at once' }),
        ],
        ephemeral: true,
      });
    }

    // ── /partner random ───────────────────────────────────────────────────────
    if (sub === 'random') {
      const guilds = pmStore.getGuilds(userId);
      if (guilds.length < 2) {
        return interaction.reply({ content: `❌ Need at least **2 guilds**. You have **${guilds.length}**.\nUse \`/partner add\` to register more.`, ephemeral: true });
      }
      const pair = findEligiblePair(userId, guilds);
      if (!pair) {
        return interaction.reply({
          content: `⏳ **All pairs are on cooldown!** Every combination of your ${guilds.length} guilds was partnered in the last 2 days.\nTry again later or add more guilds.`,
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

    // ── /partner edit ─────────────────────────────────────────────────────────
    if (sub === 'edit') {
      const guilds = pmStore.getGuilds(userId);

      if (guilds.length === 0) {
        return interaction.reply({ content: '📭 No guilds registered. Use `/partner setup` to add your first one.', ephemeral: true });
      }

      const select = new StringSelectMenuBuilder()
        .setCustomId(`pm_edit_select:${userId}`)
        .setPlaceholder('Choose a guild to edit...')
        .addOptions(
          guilds.slice(0, 25).map(g =>
            new StringSelectMenuOptionBuilder()
              .setLabel(guildName(g).replace(/`/g, '').slice(0, 100))
              .setDescription(`Channel: ${g.channel_id}`.slice(0, 100))
              .setValue(g.guild_id)
          )
        );

      return interaction.reply({
        content: '✏️ Which guild do you want to edit?',
        components: [new ActionRowBuilder().addComponents(select)],
        ephemeral: true,
      });
    }

    // ── /partner wave ─────────────────────────────────────────────────────────
    if (sub === 'wave') {
      const guilds = pmStore.getGuilds(userId);

      if (guilds.length < 2) {
        return interaction.reply({ content: `❌ Need at least **2 guilds** to run a wave. You have **${guilds.length}**.`, ephemeral: true });
      }

      // Shuffle and pair up sequentially
      const shuffled = shuffle(guilds);
      const pairs    = [];
      for (let i = 0; i + 1 < shuffled.length; i += 2) {
        pairs.push([shuffled[i].guild_id, shuffled[i + 1].guild_id]);
      }

      const isOdd  = shuffled.length % 2 !== 0;
      const extra  = isOdd ? shuffled[shuffled.length - 1] : null;

      // Build a lookup map for the embed builder
      const guildsMap = Object.fromEntries(guilds.map(g => [g.guild_id, g]));

      // Store session
      setWaveSession(userId, { pairs, extra: extra?.guild_id ?? null, guildsMap });

      if (!isOdd) {
        // Even count — show all pairs + confirm button
        return interaction.reply({
          embeds: [buildWaveEmbed(pairs, guildsMap)],
          components: [
            new ActionRowBuilder().addComponents(
              new ButtonBuilder()
                .setCustomId(`pm_wave_confirm:${userId}`)
                .setLabel('✅ Mark All as Partnered')
                .setStyle(ButtonStyle.Success)
            ),
          ],
          ephemeral: true,
        });
      }

      // Odd count — ask which server gets the extra partnership
      // Any server except the leftover can volunteer
      const candidates = guilds.filter(g => g.guild_id !== extra.guild_id);

      const select = new StringSelectMenuBuilder()
        .setCustomId(`pm_wave_double_select:${userId}`)
        .setPlaceholder('Choose which server gets 2 partners...')
        .addOptions(
          candidates.map(g =>
            new StringSelectMenuOptionBuilder()
              .setLabel(guildName(g).slice(0, 100))
              .setDescription(`Will also partner with ${guildName(extra)}`.slice(0, 100))
              .setValue(g.guild_id)
          ).slice(0, 25) // Discord select max 25
        );

      return interaction.reply({
        embeds: [buildWaveEmbed(pairs, guildsMap, extra.guild_id)],
        components: [new ActionRowBuilder().addComponents(select)],
        ephemeral: true,
      });
    }
  },

  // ─── Button handlers ──────────────────────────────────────────────────────────

  async handleButton(interaction) {
    const parts  = interaction.customId.split(':');
    const action = parts[0];
    const userId = parts[1];

    if (interaction.user.id !== userId) {
      return interaction.reply({ content: '❌ This is not your session.', ephemeral: true });
    }

    // /partner random — confirm single pair
    if (action === 'pm_confirm') {
      const [, , guildAId, guildBId] = parts;
      pmStore.recordPair(userId, guildAId, guildBId);
      const guilds = pmStore.getGuilds(userId);
      const g1 = guilds.find(g => g.guild_id === guildAId);
      const g2 = guilds.find(g => g.guild_id === guildBId);
      return interaction.update({
        embeds: [
          new EmbedBuilder()
            .setColor(0x22c55e)
            .setTitle('✅ Partnership Recorded!')
            .setDescription(`**${guildName(g1 ?? { guild_id: guildAId })}** ↔ **${guildName(g2 ?? { guild_id: guildBId })}** marked as partnered.\nWon't be matched again for **2 days**.`)
            .setTimestamp(),
        ],
        components: [],
      });
    }

    // /partner random — re-roll
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

    // /partner wave — confirm all pairs
    if (action === 'pm_wave_confirm') {
      const session = waveSessions.get(userId);
      if (!session || session.expiresAt < Date.now()) {
        return interaction.update({ content: '❌ Session expired. Run `/partner wave` again.', embeds: [], components: [] });
      }

      for (const [a, b] of session.pairs) {
        pmStore.recordPair(userId, a, b);
      }

      waveSessions.delete(userId);

      return interaction.update({
        embeds: [
          new EmbedBuilder()
            .setColor(0x22c55e)
            .setTitle(`✅ Wave Complete! ${session.pairs.length} pair(s) recorded.`)
            .setDescription(
              session.pairs.map(([a, b], i) => {
                const gA = session.guildsMap[a];
                const gB = session.guildsMap[b];
                return `**${i + 1}.** ${guildName(gA ?? { guild_id: a })} ↔ ${guildName(gB ?? { guild_id: b })}`;
              }).join('\n')
            )
            .setFooter({ text: 'All pairs are on 2-day cooldown.' })
            .setTimestamp(),
        ],
        components: [],
      });
    }
  },

  // ─── Select menu handler ──────────────────────────────────────────────────────

  async handleSelect(interaction) {
    const [action, userId] = interaction.customId.split(':');

    if (interaction.user.id !== userId) {
      return interaction.reply({ content: '❌ This is not your session.', ephemeral: true });
    }

    // /partner wave — user picked which server gets double
    if (action === 'pm_wave_double_select') {
      const session = waveSessions.get(userId);
      if (!session || session.expiresAt < Date.now()) {
        return interaction.update({ content: '❌ Session expired. Run `/partner wave` again.', embeds: [], components: [] });
      }

      const doubleGuildId = interaction.values[0];
      const extraGuildId  = session.extra;

      // Add the extra pair
      const updatedPairs = [...session.pairs, [doubleGuildId, extraGuildId]];
      setWaveSession(userId, { ...session, pairs: updatedPairs, extra: null });

      return interaction.update({
        embeds: [buildWaveEmbed(updatedPairs, session.guildsMap, null, doubleGuildId)],
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`pm_wave_confirm:${userId}`)
              .setLabel('✅ Mark All as Partnered')
              .setStyle(ButtonStyle.Success)
          ),
        ],
      });
    }
  },

  // ─── Modal handler ────────────────────────────────────────────────────────────

  async handleModal(interaction) {
    // pm_edit_modal:<userId>:<guildId>
    const parts   = interaction.customId.split(':');
    const userId  = parts[1];
    const guildId = parts[2];

    if (interaction.user.id !== userId) {
      return interaction.reply({ content: '\u274c This is not your session.', ephemeral: true });
    }

    const newChannelId = interaction.fields.getTextInputValue('pm_edit_channel').trim();
    const newLabel     = interaction.fields.getTextInputValue('pm_edit_label').trim() || null;

    if (!/^\d{17,19}$/.test(newChannelId)) {
      return interaction.reply({ content: '\u274c Invalid channel ID — must be a 17-19 digit number.', ephemeral: true });
    }

    pmStore.addGuild(userId, guildId, newChannelId, newLabel);

    return interaction.reply({
      content: [
        `\u2705 Updated guild \`${guildId}\`.`,
        `\ud83d\udce2 Partner channel: \`${newChannelId}\``,
        newLabel ? `\ud83c\udff7\ufe0f Label: **${newLabel}**` : '\ud83c\udff7\ufe0f Label: *(cleared)*',
      ].join('\n'),
      ephemeral: true,
    });
  },
};

