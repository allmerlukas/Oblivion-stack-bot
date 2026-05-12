const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ban')
    .setDescription('Ban a user from the server')
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .addUserOption(opt =>
      opt.setName('user').setDescription('The user to ban').setRequired(true)
    )
    .addStringOption(opt =>
      opt.setName('reason').setDescription('Reason for the ban').setRequired(false)
    )
    .addIntegerOption(opt =>
      opt.setName('days').setDescription('Delete message history (days, 0–7)').setRequired(false).setMinValue(0).setMaxValue(7)
    ),

  async execute(interaction) {
    const target = interaction.options.getMember('user') ?? interaction.options.getUser('user');
    const reason = interaction.options.getString('reason') ?? 'No reason provided';
    const days = interaction.options.getInteger('days') ?? 0;

    if (!target) return interaction.reply({ content: '❌ User not found.', ephemeral: true });

    const member = interaction.guild.members.cache.get(target.id ?? target.user?.id);
    if (member && !member.bannable) return interaction.reply({ content: '❌ I cannot ban this user (missing permissions or higher role).', ephemeral: true });
    if ((target.id ?? target.user?.id) === interaction.user.id) return interaction.reply({ content: '❌ You cannot ban yourself.', ephemeral: true });

    try {
      const userToMsg = target.user ?? target;
      await userToMsg.send(`🔨 You have been **banned** from **${interaction.guild.name}**.\n**Reason:** ${reason}`).catch(() => {});
      await interaction.guild.members.ban(target, { reason, deleteMessageSeconds: days * 86400 });
      const tag = target.user?.tag ?? target.tag ?? target.user?.username ?? 'Unknown';
      return interaction.reply({ content: `✅ **${tag}** has been banned.\n**Reason:** ${reason}`, ephemeral: false });
    } catch {
      return interaction.reply({ content: '❌ Failed to ban the user.', ephemeral: true });
    }
  },
};
