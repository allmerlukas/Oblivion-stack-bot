const waveStore = require('../utils/waveStore');
const ticketStore = require('../utils/ticketStore');
const { sendWaveMessages, dmWaveToUser, executeCopy, copySessions, buildPageContent, buildNextRow } = require('../commands/wave');
const { STEPS, buildStepMessage, buildSummary } = require('../commands/config');
const setupStore = require('../utils/setupStore');
const partnerCmd = require('../commands/partner');
const {
  ChannelType, PermissionsBitField, ActionRowBuilder,
  ButtonBuilder, ButtonStyle, EmbedBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle,
} = require('discord.js');

module.exports = {
  name: 'interactionCreate',
  async execute(interaction, client) {

    // ── Config wizard: modal submit (delay hours) ─────────────────────────────
    if (interaction.isModalSubmit() && interaction.customId.startsWith('cfg_delay_modal:')) {
      const stepIndex = parseInt(interaction.customId.split(':')[1], 10);
      const raw       = interaction.fields.getTextInputValue('cfg_delay_input');
      const hours     = parseInt(raw, 10);

      if (isNaN(hours) || hours < 1) {
        await interaction.reply({ content: '❌ Please enter a valid number of hours (minimum 1).', ephemeral: true });
        return;
      }

      setupStore.set(interaction.guildId, 'partnerDelayHours', Math.max(hours, 1));

      const nextStep = stepIndex + 1;
      if (nextStep >= STEPS.length) {
        return interaction.update({ embeds: [buildSummary(interaction.guildId)], components: [] });
      }
      return interaction.update(buildStepMessage(interaction.guildId, nextStep));
    }

    // ── Partner edit: modal submit ────────────────────────────────────────────────
    if (interaction.isModalSubmit() && interaction.customId.startsWith('pm_edit_modal:')) {
      return partnerCmd.handleModal(interaction);
    }

    // ── Config wizard: channel select ─────────────────────────────────────────
    if (interaction.isChannelSelectMenu() && interaction.customId.startsWith('cfg_')) {
      const [stepId, stepIndexStr] = interaction.customId.split(':');
      const stepIndex = parseInt(stepIndexStr, 10);
      const step      = STEPS[stepIndex];
      const channelId = interaction.values[0];

      setupStore.set(interaction.guildId, step.storeKey, channelId);

      const nextStep = stepIndex + 1;
      if (nextStep >= STEPS.length) {
        return interaction.update({ embeds: [buildSummary(interaction.guildId)], components: [] });
      }
      return interaction.update(buildStepMessage(interaction.guildId, nextStep));
    }

    // ── Config wizard: role select ────────────────────────────────────────────
    if (interaction.isRoleSelectMenu() && interaction.customId.startsWith('cfg_')) {
      const [stepId, stepIndexStr] = interaction.customId.split(':');
      const stepIndex = parseInt(stepIndexStr, 10);
      const step      = STEPS[stepIndex];
      const roleId    = interaction.values[0];
      const role      = interaction.guild.roles.cache.get(roleId);

      // Run safety check if defined
      if (step.checkFn && role) {
        await interaction.deferUpdate();
        const err = await step.checkFn(role, interaction.guild);
        if (err) {
          // Re-show same step with error
          const msg = buildStepMessage(interaction.guildId, stepIndex);
          msg.embeds[0] = EmbedBuilder.from(msg.embeds[0]).addFields({ name: '❌ Error', value: err, inline: false });
          return interaction.editReply(msg);
        }
      }

      setupStore.set(interaction.guildId, step.storeKey, roleId);

      const nextStep = stepIndex + 1;
      if (nextStep >= STEPS.length) {
        if (interaction.deferred) {
          return interaction.editReply({ embeds: [buildSummary(interaction.guildId)], components: [] });
        }
        return interaction.update({ embeds: [buildSummary(interaction.guildId)], components: [] });
      }
      const nextMsg = buildStepMessage(interaction.guildId, nextStep);
      if (interaction.deferred) return interaction.editReply(nextMsg);
      return interaction.update(nextMsg);
    }

    // ── Config wizard: delay button (opens modal) ─────────────────────────────
    if (interaction.isButton() && interaction.customId.startsWith('cfg_delay_hours:')) {
      const stepIndex = interaction.customId.split(':')[1];
      const modal = new ModalBuilder()
        .setCustomId(`cfg_delay_modal:${stepIndex}`)
        .setTitle('Set Partner Delay');

      const input = new TextInputBuilder()
        .setCustomId('cfg_delay_input')
        .setLabel('Minimum hours between partner ads')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('e.g. 24')
        .setMinLength(1)
        .setMaxLength(4)
        .setRequired(true);

      modal.addComponents(new ActionRowBuilder().addComponents(input));
      return interaction.showModal(modal);
    }

    // ── Config wizard: skip step ──────────────────────────────────────────────
    if (interaction.isButton() && interaction.customId.startsWith('cfg_skip:')) {
      const stepIndex = parseInt(interaction.customId.split(':')[1], 10);
      const nextStep  = stepIndex + 1;
      if (nextStep >= STEPS.length) {
        return interaction.update({ embeds: [buildSummary(interaction.guildId)], components: [] });
      }
      return interaction.update(buildStepMessage(interaction.guildId, nextStep));
    }

    // ── Config wizard: finish early ───────────────────────────────────────────
    if (interaction.isButton() && interaction.customId === 'cfg_done') {
      return interaction.update({ embeds: [buildSummary(interaction.guildId)], components: [] });
    }

    // ── Select menu: wave paste picker ───────────────────────────────────────
    if (interaction.isStringSelectMenu()) {
      if (interaction.customId === 'wave_paste_select') {
        const waveKey = interaction.values[0];
        const wave = waveStore.getWave(interaction.user.id, waveKey);

        if (!wave) {
          return interaction.update({ content: '❌ Wave not found.', components: [] });
        }

        // Remove the select menu, then send each ad separately with validation
        await interaction.update({ content: '✅ Sending wave...', components: [] });
        await sendWaveMessages(interaction, wave, true, waveKey);
      }

      if (interaction.customId === 'wave_dm_select') {
        const waveKey = interaction.values[0];
        const wave = waveStore.getWave(interaction.user.id, waveKey);

        if (!wave) {
          return interaction.update({ content: '❌ Wave not found.', components: [] });
        }

        await interaction.update({ content: '📬 Sending to your DMs...', components: [] });
        await dmWaveToUser(interaction, waveKey, wave);
      }

      if (interaction.customId === 'wave_copy_select') {
        const waveKey = interaction.values[0];
        const wave = waveStore.getWave(interaction.user.id, waveKey);

        if (!wave) {
          return interaction.update({ content: '❌ Wave not found.', components: [] });
        }

        // deferUpdate keeps it ephemeral while we validate links
        await interaction.deferUpdate();
        await executeCopy(interaction, wave);
      }

      // ── Partner wave: pick which server gets double ───────────────────────
      if (interaction.customId.startsWith('pm_wave_double_select:')) {
        return partnerCmd.handleSelect(interaction);
      }

      // ── Partner edit: guild picker ──────────────────────────────────────────
      if (interaction.customId.startsWith('pm_edit_select:')) {
        const [, userId] = interaction.customId.split(':');
        if (interaction.user.id !== userId) {
          return interaction.reply({ content: '❌ This is not your session.', ephemeral: true });
        }

        const pmStore  = require('../utils/pmStore');
        const guildId  = interaction.values[0];
        const guild    = pmStore.getGuilds(userId).find(g => g.guild_id === guildId);

        const modal = new ModalBuilder()
          .setCustomId(`pm_edit_modal:${userId}:${guildId}`)
          .setTitle('Edit Guild');

        const channelInput = new TextInputBuilder()
          .setCustomId('pm_edit_channel')
          .setLabel('Partner Channel ID')
          .setStyle(TextInputStyle.Short)
          .setValue(guild?.channel_id ?? '')
          .setPlaceholder('e.g. 123456789012345678')
          .setRequired(true)
          .setMaxLength(19);

        const labelInput = new TextInputBuilder()
          .setCustomId('pm_edit_label')
          .setLabel('Nickname (leave blank to clear)')
          .setStyle(TextInputStyle.Short)
          .setValue(guild?.label ?? '')
          .setPlaceholder('e.g. My Main Server')
          .setRequired(false)
          .setMaxLength(40);

        modal.addComponents(
          new ActionRowBuilder().addComponents(channelInput),
          new ActionRowBuilder().addComponents(labelInput),
        );

        return interaction.showModal(modal);
      }

      return;
    }

    // ── Button interactions ───────────────────────────────────────────────────
    if (interaction.isButton()) {

      // ── Wave copy: page through ads one at a time ─────────────────────────
      if (interaction.customId.startsWith('wave_copy_next:')) {
        const parts = interaction.customId.split(':');
        const ownerId = parts[1];
        const nextIdx = parseInt(parts[2], 10);

        if (interaction.user.id !== ownerId) {
          return interaction.reply({ content: '❌ This is not your wave copy session.', ephemeral: true });
        }

        const session = copySessions.get(ownerId);
        if (!session || session.expiresAt < Date.now()) {
          return interaction.update({ content: '❌ Session expired (10 min limit). Run `/wave copy` again.', components: [] });
        }

        const { chunks } = session;
        const totalPages = chunks.length;
        const isLast = nextIdx >= totalPages - 1;
        const content = buildPageContent(chunks[nextIdx], nextIdx + 1, totalPages);

        // Strip the button from the old message so it stays where it is (no scrolling)
        // Then send the new chunk as a fresh message at the bottom
        await interaction.update({ components: [] });

        if (isLast) {
          copySessions.delete(ownerId);
          return interaction.followUp({ ephemeral: true, content: content + '\n\n✅ **Last page! That\'s all of them.**', components: [] });
        }

        return interaction.followUp({
          ephemeral: true,
          content,
          components: [buildNextRow(ownerId, nextIdx + 1, totalPages)],
        });
      }

      // ── Partner manager: all pm_ buttons ─────────────────────────────────
      if (interaction.customId.startsWith('pm_')) {
        return partnerCmd.handleButton(interaction);
      }

      // Open a new ticket
      if (interaction.customId === 'ticket_open') {
        const config = ticketStore.getConfig(interaction.guildId);
        if (!config) return interaction.reply({ content: '❌ Ticket system not configured.', ephemeral: true });

        // Prevent duplicate tickets — check if this user already has one open
        const allTickets = ticketStore.getAllTicketsForGuild(interaction.guildId);
        const existing = allTickets.find(t => t.userId === interaction.user.id);
        if (existing) {
          return interaction.reply({
            content: `❌ You already have an open ticket: <#${existing.channelId}>`,
            ephemeral: true,
          });
        }

        const num = ticketStore.nextTicketNumber(interaction.guildId);
        const channelName = `ticket-${String(num).padStart(4, '0')}-${interaction.user.username.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 16)}`;

        const overwrites = [
          { id: interaction.guild.roles.everyone, deny: [PermissionsBitField.Flags.ViewChannel] },
          { id: interaction.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] },
          { id: config.supportRoleId, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] },
        ];

        const ticketChannel = await interaction.guild.channels.create({
          name: channelName,
          type: ChannelType.GuildText,
          parent: config.categoryId ?? undefined,
          permissionOverwrites: overwrites,
        });

        ticketStore.addTicket(ticketChannel.id, interaction.user.id, interaction.guildId, num);

        const embed = new EmbedBuilder()
          .setColor('#5865F2')
          .setTitle(`🎫 Ticket #${num}`)
          .setDescription(`Hello <@${interaction.user.id}>! Support will be with you shortly.\nUse \`/ticket close\` to close this ticket.`)
          .setTimestamp();

        const closeBtn = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('ticket_close_btn').setLabel('Close Ticket').setStyle(ButtonStyle.Danger).setEmoji('🔒')
        );

        await ticketChannel.send({ content: `<@${interaction.user.id}> <@&${config.supportRoleId}>`, embeds: [embed], components: [closeBtn] });
        return interaction.reply({ content: `✅ Your ticket has been created: <#${ticketChannel.id}>`, ephemeral: true });
      }

      // Close ticket via button
      if (interaction.customId === 'ticket_close_btn') {
        const ticket = ticketStore.getTicket(interaction.channelId);
        if (!ticket) return interaction.reply({ content: '❌ This is not a ticket channel.', ephemeral: true });

        await interaction.reply(`🔒 Closing ticket in 5 seconds...`);
        setTimeout(async () => {
          ticketStore.removeTicket(interaction.channelId);
          await interaction.channel.delete().catch(() => {});
        }, 5000);
        return;
      }

      return;
    }

    // ── Slash commands ───────────────────────────────────────────────────────
    if (!interaction.isChatInputCommand()) return;

    const command = client.commands.get(interaction.commandName);
    if (!command) return;

    try {
      await command.execute(interaction);
    } catch (error) {
      console.error(`❌ Error in /${interaction.commandName}:`, error);
      const reply = { content: '❌ Something went wrong.', ephemeral: true };
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(reply).catch(() => {});
      } else {
        await interaction.reply(reply).catch(() => {});
      }
    }
  }
};
