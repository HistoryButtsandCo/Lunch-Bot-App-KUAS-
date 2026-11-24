/**
 * src/commands/dashboard.js
 *
 * `/dashboard` — Role-gated Discord slash command that gives authorized server
 * admins a private 1-click sign-in link to the Web Control Center dashboard,
 * plus a live snapshot of bot & database health right inside Discord.
 *
 * Access is controlled by `DASHBOARD_ADMIN_ROLE_ID` in `.env` (or Discord's
 * built-in Administrator permission if `DASHBOARD_ADMIN_ROLE_ID` is unset).
 */

const {
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} = require('discord.js');
const db = require('../db');
const logger = require('../utils/logger');
const auth = require('../dashboard/auth');
const publishRunner = require('../dashboard/publishRunner');
const menuPublisher = require('../publishers/menuPublisher');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('dashboard')
    .setDescription('Get a private admin login link to the Control Center dashboard'),

  async execute(interaction) {
    if (!interaction.inGuild()) {
      return interaction.reply({
        content: '❌ Run `/dashboard` inside your Discord server so your admin role can be verified.',
        flags: MessageFlags.Ephemeral,
      });
    }

    if (!auth.memberHasDashboardAccess(interaction.member)) {
      const configuredRoles = auth.getAllowedRoleIds();
      const roleHint = configuredRoles.length
        ? `Requires one of the configured admin role(s): ${configuredRoles.map((id) => `<@&${id}>`).join(', ')}.`
        : 'Requires Discord **Administrator** permission.';

      logger.warn(`🔒 Denied /dashboard access for ${interaction.user.tag} (${interaction.user.id}) in ${interaction.guild?.name}`);
      return interaction.reply({
        content: `🔒 **Access Denied**\n${roleHint}`,
        flags: MessageFlags.Ephemeral,
      });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const roleIds = interaction.member?.roles?.cache
      ? [...interaction.member.roles.cache.keys()]
      : [];

    const username =
      interaction.member?.displayName ||
      interaction.user?.globalName ||
      interaction.user?.username ||
      'Admin';

    const { url } = auth.createLoginTicket({
      userId: interaction.user.id,
      username,
      guildId: interaction.guildId,
      roleIds,
    });

    // Live quick-health snapshot for the Discord reply
    let dbStatus = '🟢 Connected';
    try {
      const ping = await db.ping();
      if (ping?.latencyMs != null) dbStatus = `🟢 Connected (${ping.latencyMs} ms)`;
    } catch {
      dbStatus = '🔴 Unreachable';
    }

    const wsPing = interaction.client?.ws?.ping;
    const dcStatus =
      typeof wsPing === 'number' && Number.isFinite(wsPing) && wsPing >= 0
        ? `🟢 Online (${Math.round(wsPing)} ms WS)`
        : '🟢 Online';

    const sched = typeof menuPublisher.getSchedulerInfo === 'function'
      ? menuPublisher.getSchedulerInfo()
      : null;

    const writeEnabled = publishRunner.isEnabled() || auth.isRoleAuthEnabled();
    const isLocalhost = /^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(url);

    const lines = [
      '🍱 **What\'s for Lunch — Admin Control Center**',
      '',
      `• **PostgreSQL:** ${dbStatus}`,
      `• **Discord Gateway:** ${dcStatus}`,
      `• **Auto-Post Schedule:** ${sched?.postingTime || '06:00 JST'}`,
      `• **Admin Write Commands:** ${writeEnabled ? '✅ Enabled (Manual Send, Repair, Diagnostics)' : 'ℹ️ Read-only (set `DASHBOARD_ADMIN_ROLE_ID` or `DASHBOARD_TOKEN` in `.env`)'}`,
      '',
      '🔐 Your personal **1-click sign-in link** is below (expires in **5 minutes**, single-use, keeps you signed in for **24 hours**):',
    ];

    if (isLocalhost) {
      lines.push(
        '',
        '> ⚠️ `DASHBOARD_PUBLIC_URL` is not set in `.env` yet, so the link points to `localhost`. Ask the host owner to set `DASHBOARD_PUBLIC_URL` (e.g. via Cloudflare Tunnel or domain) so all admins can open it from anywhere.'
      );
    }

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel('Open Control Center Dashboard')
        .setStyle(ButtonStyle.Link)
        .setURL(url)
    );

    logger.info(`🔑 Issued dashboard login link to admin ${username} (${interaction.user.id})`);

    return interaction.editReply({
      content: lines.join('\n'),
      components: [row],
    });
  },
};
