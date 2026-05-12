const {
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ApplicationIntegrationType,
  InteractionContextType,
} = require('discord.js');
const waveStore = require('../utils/waveStore');
const waveSessions = require('../utils/waveSessions');
const { checkAdsForDeadLinks, extractInviteCodes, getValidAdsForGuild } = require('../utils/inviteChecker');

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// Strip [label](url) masked links to plain URLs — applied at both save AND send time
// so old ads stored before this feature was added are also fixed
function stripMaskedLinks(text) {
  return text.replace(/\[([^\]]*?)\]\(([^)]+)\)/g, '$2');
}

const AD_DELAY = 8000;

// Packs ads into ≤maxLen char messages without splitting any single ad
function buildChunks(ads, maxLen = 2000) {
  const chunks = [];
  let current = '';
  for (const ad of ads) {
    const joined = current ? current + '\n\n' + ad : ad;
    if (joined.length > maxLen) {
      if (current) chunks.push(current);
      current = ad;
    } else {
      current = joined;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

// ── Dead link validator (DM only, no deletion) ───────────────────────────────
async function validateAfterSend(interaction, wave, waveKey) {
  const ads = wave.ads ?? wave.links ?? [];
  const deadLinks = await checkAdsForDeadLinks(interaction.client, ads);
  if (deadLinks.length === 0) return;

  try {
    const dmChannel = await interaction.user.createDM();
    const first = deadLinks[0];
    const adPreview = ads[first.adIndex].slice(0, 200);

    await dmChannel.send([
      `⚠️ **Dead invite link(s) found in your wave!**`,
      '',
      `**${deadLinks.length}** server(s) have expired/invalid links:`,
      ...deadLinks.map(dl => `• Server **${dl.adIndex + 1}** — invalid code: \`${dl.code}\``),
      '',
      `**Server ${first.adIndex + 1}** current ad:`,
      `> ${adPreview}${ads[first.adIndex].length > 200 ? '...' : ''}`,
      '',
      `Send the **new ad** for Server ${first.adIndex + 1} here to fix it:`,
    ].join('\n'));

    waveSessions.startDmFixSession(interaction.user.id, waveKey, wave.displayName, deadLinks);
  } catch (err) {
    console.error('Dead link DM failed:', err.message);
  }
}

// Filters out the ad whose invite link points to the current guild
async function filterAdsForGuild(client, ads, guildId) {
  if (!guildId) return ads; // In DMs — show all

  const filtered = [];
  for (const ad of ads) {
    const codes = extractInviteCodes(ad);
    let isCurrentServer = false;

    for (const code of codes) {
      try {
        const invite = await client.fetchInvite(code);
        if (invite.guild?.id === guildId) {
          isCurrentServer = true;
          break;
        }
      } catch { /* dead or inaccessible invite — include the ad */ }
    }

    if (!isCurrentServer) filtered.push(ad);
  }

  return filtered;
}

// ── Main paste: filter current server, send each ad with 8s delay ─────────────
async function sendWaveMessages(interaction, wave, useChannel = false, waveKey = null) {
  // Defer immediately — filterAdsForGuild can take several seconds (invite API calls)
  // Without this, Discord kills the interaction with "Unknown interaction" after 3s
  if (!useChannel && !interaction.replied && !interaction.deferred) {
    await interaction.deferReply();
  }

  const allAds = wave.ads ?? wave.links ?? [];

  // Strip any residual masked links at send time (catches old stored ads)
  const ads = (await filterAdsForGuild(interaction.client, allAds, interaction.guildId))
    .map(stripMaskedLinks);

  if (ads.length === 0) {
    const msg = allAds.length > 0
      ? '⚠️ All ads in this wave belong to this server — nothing to send!'
      : '⚠️ This wave has no ads.';
    const reply = { content: msg, ephemeral: true };
    return useChannel ? interaction.channel?.send(reply.content) : interaction.reply(reply);
  }

  const sendOne = async (chunk, isFirst) => {
    if (useChannel && interaction.channel) return interaction.channel.send(chunk);
    if (isFirst && interaction.deferred) return interaction.editReply({ content: chunk });
    if (isFirst && !interaction.replied) return interaction.reply({ content: chunk });
    return interaction.followUp({ content: chunk });
  };

  // Pack as many ads as possible into ≤2000 char chunks, send one chunk per 8s
  const chunks = buildChunks(ads);
  await sendOne(chunks[0], true);
  for (let i = 1; i < chunks.length; i++) {
    await new Promise(r => setTimeout(r, AD_DELAY));
    await sendOne(chunks[i], false);
  }

  // DM "done" + channel jump link
  try {
    const dmChannel = await interaction.user.createDM();
    const jumpLink = interaction.guildId
      ? `https://discord.com/channels/${interaction.guildId}/${interaction.channelId}`
      : null;

    await dmChannel.send([
      `✅ **Wave fully sent! (${ads.length} server(s))**`,
      jumpLink ? `\n🔗 Jump back to ping members:\n${jumpLink}` : '',
    ].join(''));
  } catch { /* DM closed */ }

  if (waveKey) validateAfterSend(interaction, wave, waveKey).catch(console.error);
}

// ── DM each ad with label so user can copy-paste manually ────────────────────
async function dmWaveToUser(interaction, waveKey, wave) {
  const ads = wave.ads ?? wave.links ?? [];

  if (ads.length === 0) {
    return interaction.reply({ content: '⚠️ This wave has no ads.', ephemeral: true });
  }

  try {
    const dmChannel = await interaction.user.createDM();
    const strippedAds = ads.map(stripMaskedLinks);

    await dmChannel.send(
      `📋 **Wave ready to paste — ${strippedAds.length} server(s)**\nCopy each ad below and paste it manually.\n\u200b`
    );

    for (let i = 0; i < strippedAds.length; i++) {
      await dmChannel.send(`**Server ${i + 1}:**\n${strippedAds[i]}`);
    }

    await dmChannel.send(`✅ Done! All ${strippedAds.length} ad(s) sent. Copy and paste each one above.`);

    return interaction.reply({
      content: `📬 Check your DMs — sent **${ads.length}** ad(s) for you to copy-paste!`,
      ephemeral: true,
    });
  } catch {
    return interaction.reply({
      content: '❌ Could not DM you. Make sure your DMs are open.',
      ephemeral: true,
    });
  }
}

// ── /wave copy: button-paged chunk flow ───────────────────────────────────────
// Sessions stored in memory; keyed by userId; TTL 10 minutes
const copySessions = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of copySessions) if (s.expiresAt < now) copySessions.delete(id);
}, 30 * 60 * 1000);

function buildPageContent(chunk, pageNum, totalPages, totalAds) {
  const adNote = totalAds != null ? ` (${totalAds} ads total)` : '';
  return `📋 **Page ${pageNum}/${totalPages}${adNote} — copy below:**\n\n${chunk}`;
}

function buildNextRow(userId, nextIdx, totalPages) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`wave_copy_next:${userId}:${nextIdx}`)
      .setLabel(`Next ads ➡️  (${nextIdx + 1}/${totalPages})`)
      .setStyle(ButtonStyle.Primary)
  );
}

async function executeCopy(interaction, wave) {
  const allAds = wave.ads ?? wave.links ?? [];
  // Strip masked links at display time + filter by guild/dead links
  const ads = (await getValidAdsForGuild(interaction.client, allAds, interaction.guildId))
    .map(stripMaskedLinks);

  if (ads.length === 0) {
    const msg = allAds.length > 0
      ? '⚠️ No ads to show — all are from this server or have dead links.'
      : '⚠️ This wave has no ads.';
    if (interaction.deferred) return interaction.editReply({ content: msg, components: [] });
    return interaction.followUp({ content: msg, ephemeral: true, components: [] });
  }

  // Pack ads into chunks — use 1940 max to leave room for the page header
  const chunks = buildChunks(ads, 1940);
  copySessions.set(interaction.user.id, { chunks, expiresAt: Date.now() + 10 * 60 * 1000 });

  const totalPages = chunks.length;
  const content = buildPageContent(chunks[0], 1, totalPages, ads.length);
  const components = totalPages > 1 ? [buildNextRow(interaction.user.id, 1, totalPages)] : [];

  if (interaction.deferred) return interaction.editReply({ content, components });
  return interaction.followUp({ content, ephemeral: true, components });
}

module.exports = {
  sendWaveMessages,
  dmWaveToUser,
  executeCopy,
  ordinal,
  copySessions,
  buildPageContent,
  buildNextRow,

  data: new SlashCommandBuilder()
    .setName('wave')
    .setDescription('Create and paste partner waves in any server')
    .setIntegrationTypes([
      ApplicationIntegrationType.GuildInstall,
      ApplicationIntegrationType.UserInstall,
    ])
    .setContexts([
      InteractionContextType.Guild,
      InteractionContextType.BotDM,
      InteractionContextType.PrivateChannel,
    ])
    // ── create ──
    .addSubcommand(sub =>
      sub.setName('create')
        .setDescription('Create a new partner wave — bot asks for ads one by one')
        .addStringOption(opt =>
          opt.setName('name').setDescription('Name for this wave (only you see this)')
            .setRequired(true).setMaxLength(50)
        )
    )
    // ── add ──
    .addSubcommand(sub =>
      sub.setName('add')
        .setDescription('Add more server ads to an existing wave')
        .addStringOption(opt =>
          opt.setName('name').setDescription('Name of the wave to add to')
            .setRequired(true).setMaxLength(50)
        )
    )
    // ── dm ──
    .addSubcommand(sub =>
      sub.setName('dm')
        .setDescription('Send wave ads to your DMs so you can copy-paste them manually')
    )
    // ── copy ──
    .addSubcommand(sub =>
      sub.setName('copy')
        .setDescription('Show wave ads privately so you can copy-paste them (skips this server + dead links)')
    )
    // ── paste ──
    .addSubcommand(sub =>
      sub.setName('paste')
        .setDescription('Send a saved wave in this channel (each ad sent with delay)')
    )
    // ── insert ──
    .addSubcommand(sub =>
      sub.setName('insert')
        .setDescription('Insert a new ad between two existing servers')
        .addStringOption(opt =>
          opt.setName('name').setDescription('Wave name').setRequired(true).setMaxLength(50)
        )
        .addIntegerOption(opt =>
          opt.setName('after').setDescription('Insert after server number (0 = insert before server 1)')
            .setRequired(true).setMinValue(0)
        )
    )
    // ── edit ──
    .addSubcommand(sub =>
      sub.setName('edit')
        .setDescription('Replace one server\'s ad in a wave')
        .addStringOption(opt =>
          opt.setName('name').setDescription('Wave name').setRequired(true).setMaxLength(50)
        )
        .addIntegerOption(opt =>
          opt.setName('server').setDescription('Which server number to replace (e.g. 2)')
            .setRequired(true).setMinValue(1)
        )
    )
    // ── rename ──
    .addSubcommand(sub =>
      sub.setName('rename')
        .setDescription('Rename a saved wave')
        .addStringOption(opt =>
          opt.setName('name').setDescription('Current wave name').setRequired(true).setMaxLength(50)
        )
        .addStringOption(opt =>
          opt.setName('newname').setDescription('New name').setRequired(true).setMaxLength(50)
        )
    )
    // ── list ──
    .addSubcommand(sub =>
      sub.setName('list')
        .setDescription('List all your saved waves')
    )
    // ── delete ──
    .addSubcommand(sub =>
      sub.setName('delete')
        .setDescription('Delete a saved wave')
        .addStringOption(opt =>
          opt.setName('name').setDescription('Name of the wave to delete')
            .setRequired(true).setMaxLength(50)
        )
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    // ── /wave create ──────────────────────────────────────────────────────────
    if (sub === 'create') {
      const name = interaction.options.getString('name');
      const existing = waveStore.getWave(interaction.user.id, name);
      const editNote = existing
        ? ` Overwriting existing wave (had ${existing.ads?.length ?? 0} servers).`
        : '';

      waveSessions.startSession(interaction.user.id, name);

      return interaction.reply({
        content: [
          `🌊 <@${interaction.user.id}> is building a wave!${editNote}`,
          '',
          `<@${interaction.user.id}> — send your **1st server** ad now (paste the full ad text with link).`,
          `Type \`done\` when finished, or \`cancel\` to discard.`,
        ].join('\n'),
      });
    }

    // ── /wave add ─────────────────────────────────────────────────────────────
    if (sub === 'add') {
      const name = interaction.options.getString('name');
      const wave = waveStore.getWave(interaction.user.id, name);

      if (!wave) {
        return interaction.reply({
          content: `❌ No wave named **${name}** found. Use \`/wave create\` to make a new one.`,
          ephemeral: true,
        });
      }

      const existingAds = wave.ads ?? wave.links ?? [];
      const nextNum = existingAds.length + 1;

      waveSessions.startAddSession(interaction.user.id, name, existingAds);

      return interaction.reply({
        content: [
          `🌊 <@${interaction.user.id}> is adding to a wave! (currently ${existingAds.length} server(s))`,
          '',
          `<@${interaction.user.id}> — send your **${ordinal(nextNum)} server** ad now.`,
          `Type \`done\` when finished, or \`cancel\` to discard.`,
        ].join('\n'),
      });
    }

    // ── /wave dm ──────────────────────────────────────────────────────────────
    if (sub === 'dm') {
      const userWaves = waveStore.getUserWaves(interaction.user.id);
      const entries = Object.entries(userWaves);

      if (entries.length === 0) {
        return interaction.reply({
          content: '📫 You have no saved waves. Use `/wave create` to make one!',
          ephemeral: true,
        });
      }

      if (entries.length === 1) {
        return dmWaveToUser(interaction, entries[0][0], entries[0][1]);
      }

      const select = new StringSelectMenuBuilder()
        .setCustomId('wave_dm_select')
        .setPlaceholder('Choose a wave to DM...')
        .addOptions(
          entries.map(([key, wave]) =>
            new StringSelectMenuOptionBuilder()
              .setLabel(wave.displayName)
              .setDescription(`${wave.ads?.length ?? 0} server(s)`)
              .setValue(key)
          )
        );

      return interaction.reply({
        content: '📬 Which wave do you want sent to your DMs?',
        components: [new ActionRowBuilder().addComponents(select)],
        ephemeral: true,
      });
    }

    // ── /wave copy ──────────────────────────────────────────────────────────
    if (sub === 'copy') {
      const userWaves = waveStore.getUserWaves(interaction.user.id);
      const entries = Object.entries(userWaves);

      if (entries.length === 0) {
        return interaction.reply({ content: '📫 No saved waves.', ephemeral: true });
      }

      if (entries.length === 1) {
        // Single wave — defer and validate immediately
        await interaction.deferReply({ ephemeral: true });
        const [waveKey, wave] = entries[0];
        return executeCopy(interaction, wave);
      }

      // Multiple waves — show private picker
      const select = new StringSelectMenuBuilder()
        .setCustomId('wave_copy_select')
        .setPlaceholder('Choose a wave to copy...')
        .addOptions(
          entries.map(([key, wave]) =>
            new StringSelectMenuOptionBuilder()
              .setLabel(wave.displayName)
              .setDescription(`${wave.ads?.length ?? 0} server(s)`)
              .setValue(key)
          )
        );

      return interaction.reply({
        content: '📋 Which wave do you want to copy from?',
        components: [new ActionRowBuilder().addComponents(select)],
        ephemeral: true,
      });
    }

    // ── /wave paste ───────────────────────────────────────────────────────────
    if (sub === 'paste') {
      const userWaves = waveStore.getUserWaves(interaction.user.id);
      const entries = Object.entries(userWaves);

      if (entries.length === 0) {
        return interaction.reply({
          content: '📭 You have no saved waves. Use `/wave create` to make one!',
          ephemeral: true,
        });
      }

      if (entries.length === 1) {
        return sendWaveMessages(interaction, entries[0][1], false, entries[0][0]);
      }

      const select = new StringSelectMenuBuilder()
        .setCustomId('wave_paste_select')
        .setPlaceholder('Choose a wave...')
        .addOptions(
          entries.map(([key, wave]) =>
            new StringSelectMenuOptionBuilder()
              .setLabel(wave.displayName)
              .setDescription(`${wave.ads?.length ?? wave.links?.length ?? 0} server(s)`)
              .setValue(key)
          )
        );

      return interaction.reply({
        content: '🌊 Which wave do you want to paste?',
        components: [new ActionRowBuilder().addComponents(select)],
        ephemeral: true,
      });
    }

    // ── /wave insert ──────────────────────────────────────────────────────────
    if (sub === 'insert') {
      const name = interaction.options.getString('name');
      const afterNum = interaction.options.getInteger('after');
      const wave = waveStore.getWave(interaction.user.id, name);

      if (!wave) {
        return interaction.reply({ content: `❌ No wave named **${name}** found.`, ephemeral: true });
      }

      const ads = wave.ads ?? wave.links ?? [];

      if (afterNum > ads.length) {
        return interaction.reply({
          content: `❌ Can't insert after server **${afterNum}** — this wave only has **${ads.length}** server(s). Use \`/wave add\` to append to the end.`,
          ephemeral: true,
        });
      }

      // spliceIndex = afterNum (splice(0) = before first, splice(2) = after second)
      waveSessions.startInsertSession(interaction.user.id, name, afterNum);

      const positionDesc = afterNum === 0
        ? 'at the **beginning** (before server 1)'
        : `between **server ${afterNum}** and **server ${afterNum + 1}**`;

      return interaction.reply({
        content: [
          `➕ <@${interaction.user.id}> Inserting a new ad ${positionDesc}.`,
          `Send the **new ad** now, or type \`cancel\` to abort.`,
        ].join('\n'),
        ephemeral: true,
      });
    }

    // ── /wave edit ────────────────────────────────────────────────────────────
    if (sub === 'edit') {
      const name = interaction.options.getString('name');
      const serverNum = interaction.options.getInteger('server');
      const wave = waveStore.getWave(interaction.user.id, name);

      if (!wave) {
        return interaction.reply({ content: `❌ No wave named **${name}** found.`, ephemeral: true });
      }

      const ads = wave.ads ?? wave.links ?? [];
      const serverIndex = serverNum - 1;

      if (serverIndex >= ads.length) {
        return interaction.reply({
          content: `❌ Server **${serverNum}** doesn't exist. This wave only has ${ads.length} server(s).`,
          ephemeral: true,
        });
      }

      waveSessions.startEditSession(interaction.user.id, name, serverIndex);

      return interaction.reply({
        content: [
          `✏️ <@${interaction.user.id}> Editing **server ${serverNum}** of your wave.`,
          `Current ad:`,
          `> ${ads[serverIndex].slice(0, 200)}${ads[serverIndex].length > 200 ? '...' : ''}`,
          '',
          `Send the **new ad** now to replace it.`,
        ].join('\n'),
        ephemeral: true,
      });
    }

    // ── /wave rename ──────────────────────────────────────────────────────────
    if (sub === 'rename') {
      const name = interaction.options.getString('name');
      const newName = interaction.options.getString('newname');

      if (!waveStore.renameWave(interaction.user.id, name, newName)) {
        return interaction.reply({ content: `❌ No wave named **${name}** found.`, ephemeral: true });
      }

      return interaction.reply({ content: `✅ Wave renamed to **${newName}**.`, ephemeral: true });
    }

    // ── /wave list ────────────────────────────────────────────────────────────
    if (sub === 'list') {
      const userWaves = waveStore.getUserWaves(interaction.user.id);
      const entries = Object.values(userWaves);

      if (entries.length === 0) {
        return interaction.reply({ content: '📭 No saved waves. Use `/wave create` to make one!', ephemeral: true });
      }

      const lines = entries.map((w, i) => {
        const count = w.ads?.length ?? w.links?.length ?? 0;
        const updated = `<t:${Math.floor(w.updatedAt / 1000)}:R>`;
        return `**${i + 1}.** ${w.displayName} — ${count} server(s) · updated ${updated}`;
      });

      return interaction.reply({
        content: `🌊 **Your Waves (${entries.length})**\n\n${lines.join('\n')}`,
        ephemeral: true,
      });
    }

    // ── /wave delete ──────────────────────────────────────────────────────────
    if (sub === 'delete') {
      const name = interaction.options.getString('name');
      if (!waveStore.deleteWave(interaction.user.id, name)) {
        return interaction.reply({ content: `❌ No wave named **${name}** found.`, ephemeral: true });
      }
      return interaction.reply({ content: `🗑️ Wave **${name}** deleted.`, ephemeral: true });
    }
  },
};
