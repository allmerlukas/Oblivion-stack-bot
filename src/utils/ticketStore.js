const fs = require('fs');
const path = require('path');
const DATA_FILE = path.join(__dirname, '../../data/tickets.json');

function load() {
  if (!fs.existsSync(DATA_FILE)) {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify({ configs: {}, tickets: {} }));
    return { configs: {}, tickets: {} };
  }
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8')); }
  catch { return { configs: {}, tickets: {} }; }
}

function save(data) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function setConfig(guildId, config) {
  const data = load();
  data.configs[guildId] = config;
  save(data);
}

function getConfig(guildId) {
  return load().configs[guildId] ?? null;
}

function addTicket(channelId, userId, guildId, number) {
  const data = load();
  data.tickets[channelId] = { userId, guildId, number };
  save(data);
}

function removeTicket(channelId) {
  const data = load();
  delete data.tickets[channelId];
  save(data);
}

function getTicket(channelId) {
  return load().tickets[channelId] ?? null;
}

function getAllTicketsForGuild(guildId) {
  const data = load();
  return Object.entries(data.tickets)
    .filter(([, t]) => t.guildId === guildId)
    .map(([channelId, t]) => ({ channelId, ...t }));
}

function nextTicketNumber(guildId) {
  const data = load();
  const nums = Object.values(data.tickets)
    .filter(t => t.guildId === guildId)
    .map(t => t.number ?? 0);
  return (nums.length ? Math.max(...nums) : 0) + 1;
}

module.exports = { setConfig, getConfig, addTicket, removeTicket, getTicket, getAllTicketsForGuild, nextTicketNumber };
