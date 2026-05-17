/**
 * pmStore.js — Partner Manager store
 *
 * Manages the guilds a user is a partner manager in,
 * and tracks when they last partnered two of those guilds together.
 */

const db = require('./db');

const PM_COOLDOWN_MS = 2 * 24 * 60 * 60 * 1000; // 2 days

// ─── Canonical pair key (always smaller ID first) ────────────────────────────

function pairKey(a, b) {
  return a < b ? [a, b] : [b, a];
}

// ─── Prepared statements ─────────────────────────────────────────────────────

const stmtUpsertGuild = db.prepare(`
  INSERT INTO pm_guilds (user_id, guild_id, channel_id, label, added_at)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT (user_id, guild_id) DO UPDATE SET
    channel_id = excluded.channel_id,
    label      = excluded.label,
    added_at   = excluded.added_at
`);

const stmtDeleteGuild = db.prepare(
  'DELETE FROM pm_guilds WHERE user_id = ? AND guild_id = ?'
);

const stmtGetGuild = db.prepare(
  'SELECT * FROM pm_guilds WHERE user_id = ? AND guild_id = ?'
);

const stmtGetAllGuilds = db.prepare(
  'SELECT * FROM pm_guilds WHERE user_id = ? ORDER BY added_at ASC'
);

const stmtUpsertPair = db.prepare(`
  INSERT INTO pm_pairs (user_id, guild_a, guild_b, last_paired_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT (user_id, guild_a, guild_b) DO UPDATE SET last_paired_at = excluded.last_paired_at
`);

const stmtGetPair = db.prepare(
  'SELECT last_paired_at FROM pm_pairs WHERE user_id = ? AND guild_a = ? AND guild_b = ?'
);

// ─── Guild management ─────────────────────────────────────────────────────────

function addGuild(userId, guildId, channelId, label = null) {
  stmtUpsertGuild.run(userId, guildId, channelId, label, Date.now());
}

function removeGuild(userId, guildId) {
  const exists = stmtGetGuild.get(userId, guildId);
  if (!exists) return false;
  stmtDeleteGuild.run(userId, guildId);
  return true;
}

function getGuilds(userId) {
  return stmtGetAllGuilds.all(userId);
}

function hasGuild(userId, guildId) {
  return !!stmtGetGuild.get(userId, guildId);
}

// ─── Pair cooldown ────────────────────────────────────────────────────────────

function recordPair(userId, guildA, guildB) {
  const [a, b] = pairKey(guildA, guildB);
  stmtUpsertPair.run(userId, a, b, Date.now());
}

function pairedRecently(userId, guildA, guildB) {
  const [a, b] = pairKey(guildA, guildB);
  const row = stmtGetPair.get(userId, a, b);
  if (!row) return false;
  return Date.now() - row.last_paired_at < PM_COOLDOWN_MS;
}

module.exports = {
  addGuild,
  removeGuild,
  getGuilds,
  hasGuild,
  recordPair,
  pairedRecently,
  PM_COOLDOWN_MS,
};
