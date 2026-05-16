/**
 * autoWaveEngine.js — Auto-partner wave engine (v3)
 *
 * Algorithm (every 30 min):
 *
 *  1. Collect all configured guilds. Need at least 2.
 *
 *  2. SOURCE — pop next from persistent shuffled queue (random, no repeats
 *     until all guilds have gone).
 *
 *  3. Cache the ad: find the most recent message in the ad_channel that
 *     contains a discord.gg invite link. Strip all @mentions from the text.
 *     Validate the ad for non-whitelisted external links.
 *
 *  4. TARGET — shuffle remaining guilds, iterate until we find one that:
 *       a. Has ≥ 25 members
 *       b. Per-server receive cooldown has passed
 *       c. Source↔target pair hasn't partnered in the last 3 days
 *       d. Neither guild is blacklisted
 *       e. Target channel is accessible
 *
 *  5. Build ping (based on member count tier), send, record pair, log.
 *
 * Validation failures are logged to the guild's log_channel silently.
 * We intentionally don't expose the exact checks to end users.
 */

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');

const setupStore                                   = require('./setupStore');
const autoWaveStore                                = require('./autoWaveStore');
const { recordPair, pairedRecently, nextSource }   = require('./pairStore');
const { isBlacklisted, getWhitelistedDomains }     = require('./blacklistStore');
const { logError }                                 = require('./errorStore');

const TICK_MS         = 30 * 60 * 1000;
const MIN_MEMBERS     = 25;
const MIN_COOLDOWN_MS = 30 * 60 * 1000;

// Invite patterns that are always allowed in ads
const INVITE_RE     = /discord\.gg\/[a-zA-Z0-9-]+|discord\.com\/invite\/[a-zA-Z0-9-]+/gi;
// Any URL in the message
const ANY_URL_RE    = /https?:\/\/[^\s<>"]+|www\.[^\s<>"]+/gi;
// Ping patterns to strip before sending
const PING_RE       = /@everyone|@here|<@&\d+>/g;
// Require at least one discord.gg link in the ad
const NEEDS_INVITE  = /discord\.gg\/[a-zA-Z0-9-]+|discord\.com\/invite\/[a-zA-Z0-9-]+/i;

// ─── Shuffle ──────────────────────────────────────────────────────────────────

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ─── Log to guild ─────────────────────────────────────────────────────────────

async function logToGuild(guild, cfg, message) {
  try {
    if (!cfg?.logChannelId) return;
    const ch = guild.channels.cache.get(cfg.logChannelId);
    if (ch?.isTextBased()) await ch.send(message);
  } catch { /* swallow */ }
}

// ─── Ad caching ───────────────────────────────────────────────────────────────
// Takes the most recent message in ad_channel that contains a discord.gg link.
// Strips all pings from the content before returning.

async function fetchAndCacheAd(guild, cfg) {
  const ch = guild.channels.cache.get(cfg.adChannelId);
  if (!ch?.isTextBased()) return null;

  let messages;
  try {
    messages = await ch.messages.fetch({ limit: 50 });
  } catch {
    return null;
  }

  // Find most recent message with a discord.gg invite
  const adMsg = [...messages.values()].find(m =>
    m.content?.trim().length > 0 && NEEDS_INVITE.test(m.content)
  );

  if (!adMsg) return null;

  // Strip all @pings before caching
  const stripped = adMsg.content.replace(PING_RE, '').replace(/\s{2,}/g, ' ').trim();
  return stripped || null;
}

// ─── Ad validation ────────────────────────────────────────────────────────────
// Returns null if valid, or an internal reason string if invalid.
// Reasons are logged to the owner; generic message shown to guild.

function validateAd(adContent) {
  if (!adContent || adContent.length < 10) return 'ad_too_short';

  // Must still contain an invite link after ping stripping
  if (!NEEDS_INVITE.test(adContent)) return 'no_invite_link';

  // Find all URLs in the ad
  const allUrls     = adContent.match(ANY_URL_RE) ?? [];
  const inviteUrls  = adContent.match(INVITE_RE)  ?? [];

  // Any URL that isn't a discord invite is suspicious unless whitelisted
  const whitelisted = getWhitelistedDomains();

  for (const url of allUrls) {
    // Already an invite link → fine
    if (inviteUrls.some(inv => url.includes(inv.replace(/https?:\/\//i, '')))) continue;

    // Check against whitelist
    const hostname = url.replace(/^https?:\/\//i, '').split('/')[0].toLowerCase();
    const allowed  =
      hostname.includes('discord.gg') ||
      hostname.includes('discord.com') ||
      hostname.includes('discordapp.com') ||
      whitelisted.some(d => hostname === d || hostname.endsWith('.' + d));

    if (!allowed) return `non_whitelisted_link:${hostname}`;
  }

  return null; // valid
}

// ─── Ping resolver ────────────────────────────────────────────────────────────
// Tiers: basic (no ping) | here | partnerhere | member

async function resolvePing(targetGuild, targetCfg) {
  const mc = targetGuild.memberCount;

  // Nano (<100) — basic, no ping
  if (mc < 100) return '';

  // Small (100–499) — @here
  if (mc < 500) return '@here';

  // Medium (500–999) — @here + partner ping role (if configured and ≥10%)
  if (mc < 1000) {
    const role = targetGuild.roles.cache.get(targetCfg.partnerPingRoleId);
    if (role) {
      const pct = role.members.size / mc;
      if (pct >= 0.10) return `@here <@&${role.id}>`;
    }
    return '@here';
  }

  // Large (1000+) — member role if ≥90%, else @here
  const role = targetGuild.roles.cache.get(targetCfg.memberRoleId);
  if (role) {
    const pct = role.members.size / mc;
    if (pct >= 0.90) return `<@&${role.id}>`;

    // Log the warning but don't expose details to other servers
    await logToGuild(targetGuild, targetCfg,
      `⚠️ **Auto-Wave ping warning:** member_role only covers ${Math.round(pct * 100)}% of members ` +
      `(needs ≥90%). Falling back to @here.`
    );
  }
  return '@here';
}

// ─── Add Oblivion button ──────────────────────────────────────────────────────

function buildAddBotRow(clientId) {
  const url =
    `https://discord.com/oauth2/authorize?client_id=${clientId}` +
    `&permissions=8&scope=bot%20applications.commands`;

  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel('➕ Add Oblivion')
      .setStyle(ButtonStyle.Link)
      .setURL(url)
  );
}

// ─── Runtime validation ───────────────────────────────────────────────────────
// Returns null if ok, or an internal failure code.
// Intentionally vague in guild-facing messages.

function validateGuild(guildId, guild, cfg) {
  if (!cfg.partnerChannelId) return 'no_partner_channel';
  if (!cfg.adChannelId)      return 'no_ad_channel';
  if (!guild.channels.cache.get(cfg.partnerChannelId)?.isTextBased()) return 'partner_channel_inaccessible';
  if (!guild.channels.cache.get(cfg.adChannelId)?.isTextBased())      return 'ad_channel_inaccessible';
  if (isBlacklisted(guildId))  return 'blacklisted';
  return null;
}

// ─── Main tick ────────────────────────────────────────────────────────────────

async function tick(client) {
  try {
    // 1. Collect all guilds passing runtime validation ─────────────────────────
    const configured = [];

    for (const [guildId, guild] of client.guilds.cache) {
      const cfg    = setupStore.get(guildId);
      const reason = validateGuild(guildId, guild, cfg);

      if (reason) {
        // Only log actionable failures (not blacklist, that's intentional)
        if (reason !== 'blacklisted' && reason !== 'no_partner_channel' && reason !== 'no_ad_channel') {
          await logToGuild(guild, cfg,
            `⚠️ **Auto-Wave:** This server was skipped this tick because a validation check failed. ` +
            `Please review your /config setup settings.`
          );
        }
        continue;
      }

      configured.push({ guild, cfg, guildId });
    }

    if (configured.length < 2) return;

    const activeIds = configured.map(e => e.guildId);

    // 2. Pick source from shuffled queue ──────────────────────────────────────
    const sourceId    = nextSource(activeIds);
    const sourceEntry = configured.find(e => e.guildId === sourceId);
    if (!sourceEntry) return;

    const { guild: sourceGuild, cfg: sourceCfg } = sourceEntry;

    // 3. Cache the ad ─────────────────────────────────────────────────────────
    const rawAd = await fetchAndCacheAd(sourceGuild, sourceCfg);

    if (!rawAd) {
      await logToGuild(sourceGuild, sourceCfg,
        `⚠️ **Auto-Wave:** No valid ad found in <#${sourceCfg.adChannelId}>. ` +
        `Make sure your most recent message contains a \`discord.gg\` invite link.`
      );
      return;
    }

    // Validate ad content (links, length)
    const adReason = validateAd(rawAd);
    if (adReason) {
      await logToGuild(sourceGuild, sourceCfg,
        `⚠️ **Auto-Wave:** Your ad was skipped this tick because it failed a content validation check. ` +
        `Check that it only contains server invite links. Non-invite links must be whitelisted.`
      );
      logError('AutoWave/AdValidation', new Error(adReason), sourceId);
      return;
    }

    // 4. Find a valid target ───────────────────────────────────────────────────
    const now     = Date.now();
    const targets = shuffle(configured.filter(e => e.guildId !== sourceId));
    let partnerSent = false;

    // Track skip reasons for the no-match log
    let skippedCooldown = 0;
    let skippedMembers  = 0;

    for (const { guild: targetGuild, cfg: targetCfg, guildId: targetId } of targets) {

      // a. Member minimum
      if (targetGuild.memberCount < MIN_MEMBERS) { skippedMembers++; continue; }

      // b. Per-server cooldown
      const delayMs  = Math.max((targetCfg.partnerDelayHours ?? 24) * 3_600_000, MIN_COOLDOWN_MS);
      const lastRecv = autoWaveStore.getLastReceived(targetId);
      if (now - lastRecv < delayMs) { skippedCooldown++; continue; }

      // c. 3-day pair cooldown
      if (pairedRecently(sourceId, targetId)) {
        console.log(`[AutoWave] ⏭  ${sourceGuild.name} → ${targetGuild.name}: pair cooldown active`);
        skippedCooldown++;
        continue;
      }

      // 5. Resolve ping and send ─────────────────────────────────────────────
      const ping        = await resolvePing(targetGuild, targetCfg);
      const finalContent = ping ? `${rawAd}\n\n${ping}` : rawAd;

      const partnerChannel = targetGuild.channels.cache.get(targetCfg.partnerChannelId);
      if (!partnerChannel?.isTextBased()) continue;

      try {
        await partnerChannel.send({
          content: finalContent,
          components: [buildAddBotRow(client.user.id)],
          allowedMentions: {
            parse: ping.includes('@everyone') ? ['everyone'] :
                   ping.includes('@here')     ? ['here']     : ['roles'],
          },
        });

        // 6. Record + log ──────────────────────────────────────────────────────
        recordPair(sourceId, targetId);
        autoWaveStore.setLastReceived(targetId);

        await logToGuild(sourceGuild, sourceCfg,
          `✅ **Auto-Wave sent:** Your ad was posted in **${targetGuild.name}** ` +
          `(<#${targetCfg.partnerChannelId}>) | Ping: \`${ping || 'none'}\``
        );
        await logToGuild(targetGuild, targetCfg,
          `📨 **Auto-Wave received:** Ad from **${sourceGuild.name}** was posted in <#${targetCfg.partnerChannelId}>.`
        );

        console.log(`[AutoWave] ✅ ${sourceGuild.name} → ${targetGuild.name} (ping: ${ping || 'none'})`);
        partnerSent = true;
      } catch (err) {
        await logToGuild(targetGuild, targetCfg,
          `⚠️ **Auto-Wave:** An ad was scheduled for your server but could not be delivered. ` +
          `Please check that Oblivion has permission to send messages in <#${targetCfg.partnerChannelId}>.`
        );
        logError('AutoWave/Send', err, targetId);
        console.error(`[AutoWave] ❌ Failed → ${targetGuild.name}:`, err.message);
      }

      break; // one pair per tick
    }

    // ── No partner found — notify source guild ────────────────────────────────
    if (!partnerSent) {
      const total = targets.length;

      let reason;
      if (total === 0) {
        reason = 'There are no other servers in the Auto-Wave network yet.';
      } else if (skippedMembers === total) {
        reason = `All ${total} network server(s) are below the 25-member minimum.`;
      } else if (skippedCooldown > 0 && skippedCooldown + skippedMembers >= total) {
        reason =
          `All available servers are currently on cooldown (3-day pair limit). ` +
          `The network will retry next tick. **${skippedCooldown}** server(s) on cooldown.`;
      } else {
        reason = `No eligible partner was found this tick (${total} server(s) checked).`;
      }

      await logToGuild(sourceGuild, sourceCfg,
        `⏳ **Auto-Wave:** No partner sent this tick.\n> ${reason}`
      );
      console.log(`[AutoWave] ⏳ No partner for ${sourceGuild.name} — ${reason}`);
    }

  } catch (err) {
    logError('AutoWave/Tick', err);
    console.error('[AutoWave] ❌ Tick error:', err);
  }
}

// ─── Start ────────────────────────────────────────────────────────────────────

function startAutoWave(client) {
  console.log(`🌊 Auto-Wave engine started — ticking every 30 minutes.`);
  setTimeout(() => {
    tick(client);
    setInterval(() => tick(client), TICK_MS);
  }, TICK_MS);
}

module.exports = { startAutoWave, tick };
