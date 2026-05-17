/**
 * db.js — Central SQLite database initializer
 *
 * Creates/opens data/bot.db and defines ALL tables in one place.
 * Every store imports `db` from here — no store opens its own connection.
 *
 * Tables:
 *   guild_config   — per-guild settings (setup + auto-wave)
 *   auto_wave      — auto-wave cooldown timestamps
 *   waves          — user partner-ad waves (ads stored as JSON array)
 *   partner_links  — partner link tracking per user
 *   partner_daily  — daily link records (child of partner_links)
 *   tickets        — open ticket channels
 *   ticket_configs — per-guild ticket panel config
 *   giveaways      — active giveaways
 */

const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');

const DB_DIR  = path.join(__dirname, '../../data');
const DB_PATH = path.join(DB_DIR, 'bot.db');

fs.mkdirSync(DB_DIR, { recursive: true });

const db = new Database(DB_PATH);

// Enable WAL mode for much better concurrent read performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ─── Schema ──────────────────────────────────────────────────────────────────

db.exec(`
  -- Per-guild configuration (setup + auto-wave merged)
  CREATE TABLE IF NOT EXISTS guild_config (
    guild_id            TEXT PRIMARY KEY,
    welcome_channel_id  TEXT,
    welcome_message     TEXT,
    autorole_id         TEXT,
    partner_channel_id  TEXT,
    ad_channel_id       TEXT,
    log_channel_id      TEXT,
    member_role_id      TEXT,
    partner_ping_role_id TEXT,
    partner_delay_hours  INTEGER DEFAULT 24
  );

  -- Auto-wave cooldown tracking
  CREATE TABLE IF NOT EXISTS auto_wave (
    guild_id          TEXT PRIMARY KEY,
    last_received_at  INTEGER NOT NULL DEFAULT 0
  );

  -- User partner-ad waves
  CREATE TABLE IF NOT EXISTS waves (
    user_id      TEXT NOT NULL,
    name_key     TEXT NOT NULL,  -- lowercased display name (lookup key)
    display_name TEXT NOT NULL,
    ads          TEXT NOT NULL,  -- JSON array of ad strings
    updated_at   INTEGER NOT NULL,
    PRIMARY KEY (user_id, name_key)
  );

  -- Partner link tracking — per user totals
  CREATE TABLE IF NOT EXISTS partner_links (
    user_id        TEXT PRIMARY KEY,
    username       TEXT,
    total_partners INTEGER NOT NULL DEFAULT 0
  );

  -- Daily partner links — one row per user+date+link
  CREATE TABLE IF NOT EXISTS partner_daily (
    user_id  TEXT NOT NULL,
    date_key TEXT NOT NULL,  -- YYYY-MM-DD
    link     TEXT NOT NULL,
    PRIMARY KEY (user_id, date_key, link),
    FOREIGN KEY (user_id) REFERENCES partner_links(user_id) ON DELETE CASCADE
  );

  -- Open ticket channels
  CREATE TABLE IF NOT EXISTS tickets (
    channel_id TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    guild_id   TEXT NOT NULL,
    number     INTEGER NOT NULL DEFAULT 0
  );

  -- Per-guild ticket panel config
  CREATE TABLE IF NOT EXISTS ticket_configs (
    guild_id    TEXT PRIMARY KEY,
    channel_id  TEXT,
    message_id  TEXT,
    category_id TEXT,
    staff_role_id TEXT
  );

  -- Active giveaways
  CREATE TABLE IF NOT EXISTS giveaways (
    message_id    TEXT PRIMARY KEY,
    channel_id    TEXT NOT NULL,
    guild_id      TEXT NOT NULL,
    prize         TEXT NOT NULL,
    description   TEXT,
    winners_count INTEGER NOT NULL DEFAULT 1,
    ends_at       INTEGER NOT NULL,
    host_id       TEXT NOT NULL
  );

  -- Bot error log (last 200 entries kept)
  CREATE TABLE IF NOT EXISTS bot_errors (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    occurred_at INTEGER NOT NULL,
    source     TEXT NOT NULL,
    guild_id   TEXT,
    message    TEXT NOT NULL,
    stack      TEXT
  );

  -- Tracks when two guilds last partnered together (bidirectional lookup)
  CREATE TABLE IF NOT EXISTS partner_pairs (
    guild_a       TEXT NOT NULL,   -- always the lexicographically smaller ID
    guild_b       TEXT NOT NULL,   -- always the lexicographically larger ID
    last_paired_at INTEGER NOT NULL,
    PRIMARY KEY (guild_a, guild_b)
  );

  -- Persistent shuffled queue for source guild rotation
  CREATE TABLE IF NOT EXISTS wave_queue (
    id    INTEGER PRIMARY KEY DEFAULT 1,
    queue TEXT NOT NULL DEFAULT '[]'
  );

  -- Guilds permanently banned from the Auto-Wave network
  CREATE TABLE IF NOT EXISTS blacklisted_guilds (
    guild_id       TEXT PRIMARY KEY,
    reason         TEXT NOT NULL,
    blacklisted_at INTEGER NOT NULL
  );

  -- Extra domains allowed in ads beyond discord.gg invite links
  CREATE TABLE IF NOT EXISTS link_whitelist (
    domain    TEXT PRIMARY KEY,   -- e.g. 'twitch.tv', 'youtube.com'
    added_at  INTEGER NOT NULL
  );

  -- Partner Manager: guilds each user manages (/partner setup, /partner add)
  CREATE TABLE IF NOT EXISTS pm_guilds (
    user_id    TEXT NOT NULL,
    guild_id   TEXT NOT NULL,
    channel_id TEXT NOT NULL,   -- partner channel in that guild
    label      TEXT,            -- optional display name
    added_at   INTEGER NOT NULL,
    PRIMARY KEY (user_id, guild_id)
  );

  -- Partner Manager: tracks when user paired two of their guilds
  CREATE TABLE IF NOT EXISTS pm_pairs (
    user_id        TEXT NOT NULL,
    guild_a        TEXT NOT NULL,   -- lexicographically smaller guild ID
    guild_b        TEXT NOT NULL,
    last_paired_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, guild_a, guild_b)
  );
`);

module.exports = db;
