const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('userinfo')
    .setDescription('Show info about a user')
    .addUserOption(opt =>
      opt.setName('user').setDescription('User to look up (defaults to you)').setRequired(false)
    ),

  async execute(interaction) {
    const target = interaction.options.getMember('user') ?? interaction.member;
    const user = target.user ?? target;

    const joinedServer = target.joinedTimestamp
      ? `<t:${Math.floor(target.joinedTimestamp / 1000)}:D> (<t:${Math.floor(target.joinedTimestamp / 1000)}:R>)`
      : 'Unknown';

    const createdAt = `<t:${Math.floor(user.createdTimestamp / 1000)}:D> (<t:${Math.floor(user.createdTimestamp / 1000)}:R>)`;

    const roles = target.roles?.cache
      .filter(r => r.id !== interaction.guild.id)
      .sort((a, b) => b.position - a.position)
      .map(r => `<@&${r.id}>`)
      .join(', ') || 'None';

    const embed = new EmbedBuilder()
      .setColor(target.displayHexColor ?? '#5865F2')
      .setTitle(`👤 ${user.tag}`)
      .setThumbnail(user.displayAvatarURL({ size: 256 }))
      .addFields(
        { name: '🆔 User ID', value: user.id, inline: true },
        { name: '🤖 Bot?', value: user.bot ? 'Yes' : 'No', inline: true },
        { name: '📅 Account Created', value: createdAt, inline: false },
        { name: '📥 Joined Server', value: joinedServer, inline: false },
        { name: `🏷️ Roles (${(target.roles?.cache.size ?? 1) - 1})`, value: roles.slice(0, 1024), inline: false },
      )
      .setFooter({ text: `Requested by ${interaction.user.tag}` })
      .setTimestamp();

    return interaction.reply({ embeds: [embed] });
  },
};
