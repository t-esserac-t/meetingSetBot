// Register a minimal /ping slash command
// Usage:
//   APPLICATION_ID=xxxxx BOT_TOKEN=xxxxx node scripts/register-commands.mjs
// Optionally restrict to a guild:
//   APPLICATION_ID=xxxxx BOT_TOKEN=xxxxx GUILD_ID=yyyyy node scripts/register-commands.mjs
import dotenv from 'dotenv';
import { setTimeout as sleep } from 'timers/promises';
dotenv.config({ override: true });
console.log('DUMMY_ID:',process.env.DUMMY_ID);

const APP_ID = process.env.APPLICATION_ID;
const BOT_TOKEN = process.env.BOT_TOKEN;
const GUILD_ID = process.env.GUILD_ID; // optional
// Purge policy configuration
const ENV_PURGE_GLOBAL = (process.env.PURGE_GLOBAL || '').toLowerCase() === 'true';
const ENV_PURGE_GUILD = (process.env.PURGE_GUILD || '').toLowerCase() === 'true';
const EXCLUSIVE = (process.env.EXCLUSIVE || 'true').toLowerCase() === 'true'; // default on
const REGISTER_TARGET = (process.env.REGISTER_TARGET || '').toLowerCase(); // 'global' | 'guild' | ''
const SKIP_REGISTER = (process.env.SKIP_REGISTER || '').toLowerCase() === 'true';

if (!APP_ID || !BOT_TOKEN) {
  console.error('Missing APPLICATION_ID or BOT_TOKEN');
  process.exit(1);
}

const BASE = 'https://discord.com/api/v10';
const globalRoute = `${BASE}/applications/${APP_ID}/commands`;
const guildRoute = GUILD_ID ? `${BASE}/applications/${APP_ID}/guilds/${GUILD_ID}/commands` : null;
let route = guildRoute || globalRoute;
if (REGISTER_TARGET === 'global') route = globalRoute;
if (REGISTER_TARGET === 'guild') {
  if (!guildRoute) {
    console.error('REGISTER_TARGET=guild requires GUILD_ID to be set');
    process.exit(1);
  }
  route = guildRoute;
}

// Decide purging policy: by default, ensure exclusive scope
let PURGE_GLOBAL = ENV_PURGE_GLOBAL;
let PURGE_GUILD = ENV_PURGE_GUILD;
if (EXCLUSIVE && !ENV_PURGE_GLOBAL && !ENV_PURGE_GUILD) {
  if (guildRoute) PURGE_GLOBAL = true; // registering to guild -> purge global to avoid duplicates
  else PURGE_GUILD = true; // registering to global -> purge guild
}

// Debug configuration logging
console.log('Config:', JSON.stringify({
  appId: APP_ID?.toString(),
  hasGuildId: !!GUILD_ID,
  guildId: GUILD_ID || null,
  exclusive: EXCLUSIVE,
  envPurgeGlobal: ENV_PURGE_GLOBAL,
  envPurgeGuild: ENV_PURGE_GUILD,
  purgeGlobal: PURGE_GLOBAL,
  purgeGuild: PURGE_GUILD,
  target: route === globalRoute ? 'global' : 'guild',
  registerTarget: REGISTER_TARGET || '(auto)',
  skipRegister: SKIP_REGISTER
}));
console.log('Config:','app id: ', APP_ID, 'env global: ', PURGE_GLOBAL);

async function apiFetch(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bot ${BOT_TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': 'meetingSetBot/1.0 (+https://discord.com)'
    },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  return res;
}

async function reqWithRetry(method, url, body, tries = 3) {
  for (let i = 0; i < tries; i++) {
    const res = await apiFetch(method, url, body);
    if (res.ok || i === tries - 1) return res;
    const text = await res.text().catch(() => '');
    const retryAfterMsDef = 1000;
    if (res.status === 429) {
      
      let retryAfterMs = retryAfterMsDef;
      try {
        const data = JSON.parse(text);
        if (typeof data.retry_after === 'number') retryAfterMs = Math.ceil(data.retry_after * 1000);
      } catch {}

      await sleep(retryAfterMs + 100); //一応100ms伸ばしておく
      continue;
    }
    // 何秒待てばいいかわからないエラーの場合は固定値秒待機して再送
    if (res.status >= 500 || text.includes('40333')) {
      await sleep(retryAfterMsDef);
      continue;
    }
    const out = new Response(text, { status: res.status });
    out.debugText = text;
    return out;
  }
}

const commands = [
  {
    name: 'hello',
    description: 'Show usage instructions',
    type: 1, // CHAT_INPUT
  },
  {
    name: 'set',
    description: 'Set configurations',
    type: 1, // CHAT_INPUT
    options: [
      {
        type: 1, // SUB_COMMAND
        name: 'mtg',
        description: 'Set a meeting time (JST)',
        options: [
          {
            type: 3, // STRING
            name: 'when',
            description: 'Meeting time (YYYY/MM/DD HH:MM)',
            required: true,
          },
        ],
      },
      {
        type: 1, // SUB_COMMAND
        name: 'todo',
        description: 'Set a TODO memo',
        options: [
          {
            type: 3, // STRING
            name: 'text',
            description: 'TODO text',
            required: true,
          },
        ],
      },
    ],
  },
  {
    name: 'get',
    description: 'Get saved data',
    type: 1, // CHAT_INPUT
    options: [
      {
        type: 1, // SUB_COMMAND
        name: 'mtg',
        description: 'Get the next meeting',
      },
      {
        type: 1, // SUB_COMMAND
        name: 'todo',
        description: 'Get the TODO memo',
      },
    ],
  },
  {
    name: 'clear',
    description: 'Clear saved data',
    type: 1, // CHAT_INPUT
    options: [
      {
        type: 1, // SUB_COMMAND
        name: 'todo',
        description: 'Clear TODO',
      },
      {
        type: 1, // SUB_COMMAND
        name: 'mtg',
        description: 'Clear meeting',
      },
    ],
  },
  {
    name: 'debug',
    description: 'Show debug information',
    type: 1, // CHAT_INPUT
  },
];

async function main() {
  // Optional purge to avoid duplicated commands appearing (global vs guild)
  if (PURGE_GLOBAL) {
    console.log('Purging global commands via PUT [] ...');
    const pr = await reqWithRetry('PUT', globalRoute, []);
    if (!pr.ok) {
      const t = (await pr.text().catch(() => '')) || pr.debugText || '';
      console.error('Failed to purge global commands', pr.status, t);
      process.exit(1);
    } else {
      console.log('Purged global commands');
    }
  }
  if (PURGE_GUILD && guildRoute) {
    console.log('Purging guild commands via PUT [] ...');
    const pr = await reqWithRetry('PUT', guildRoute, []);
    if (!pr.ok) {
      const t = (await pr.text().catch(() => '')) || pr.debugText || '';
      console.error('Failed to purge guild commands', pr.status, t);
      process.exit(1);
    } else {
      console.log('Purged guild commands');
    }
  } else if (PURGE_GUILD && !guildRoute) {
    console.warn('Requested to purge guild commands, but GUILD_ID is not set. Skipping guild purge.');
  }
  // Small delay to avoid hitting same bucket when purging and registering
  await sleep(500);
  if (SKIP_REGISTER) {
    console.log('Skip registering commands (SKIP_REGISTER=true)');
  } else {
    console.log('Registering to', route === globalRoute ? 'global' : 'guild', 'route...');
    const res = await reqWithRetry('PUT', route, commands);
    if (!res.ok) {
      const text = (await res.text().catch(() => '')) || res.debugText || '';
      console.error('Failed to register commands', res.status, text);
      process.exit(1);
    }
    const data = await res.json();
    console.log('Registered commands:', data.map((c) => c.name).join(', '));
  }

  // Fetch and print current global/guild command lists to compare with Discord UI
  try {
    const g = await reqWithRetry('GET', globalRoute);
    if (g.ok) {
      const arr = await g.json();
      console.table(arr.map((c) => c.name));
      console.log('Global commands:', arr.map((c) => c.name).join(', '));
    } else {
      const t = (await g.text().catch(() => '')) || g.debugText || '';
      console.log('Global commands fetch failed', g.status, t);
    }
  } catch (e) {
    console.log('Global commands fetch error', e?.message || e);
  }

  if (guildRoute) {
    try {
      const gg = await reqWithRetry('GET', guildRoute);
      if (gg.ok) {
        const arr = await gg.json();
        console.log('Guild commands:', arr.map((c) => c.name).join(', '));
      } else {
        const t = (await gg.text().catch(() => '')) || gg.debugText || '';
        console.log('Guild commands fetch failed', gg.status, t);
      }
    } catch (e) {
      console.log('Guild commands fetch error', e?.message || e);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
