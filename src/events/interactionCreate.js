const waveStore = require('../utils/waveStore');
const ticketStore = require('../utils/ticketStore');
const { sendWaveMessages, dmWaveToUser, executeCopy } = require('../commands/wave');
const {
  ChannelType, PermissionsBitField, ActionRowBuilder,
  ButtonBuilder, ButtonStyle, EmbedBuilder,
} = require('discord.js');

module.exports = {
  name: 'interactionCreate',
  async execute(interaction, client) {

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
      return;
    }

    // ── Button interactions ───────────────────────────────────────────────────
    if (interaction.isButton()) {
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
