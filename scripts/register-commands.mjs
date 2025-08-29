// Register a minimal /ping slash command
// Usage:
//   APPLICATION_ID=xxxxx BOT_TOKEN=xxxxx node scripts/register-commands.mjs
// Optionally restrict to a guild:
//   APPLICATION_ID=xxxxx BOT_TOKEN=xxxxx GUILD_ID=yyyyy node scripts/register-commands.mjs

const APP_ID = process.env.APPLICATION_ID;
const BOT_TOKEN = process.env.BOT_TOKEN;
const GUILD_ID = process.env.GUILD_ID; // optional

if (!APP_ID || !BOT_TOKEN) {
  console.error('Missing APPLICATION_ID or BOT_TOKEN');
  process.exit(1);
}

const BASE = 'https://discord.com/api/v10';
const route = GUILD_ID
  ? `${BASE}/applications/${APP_ID}/guilds/${GUILD_ID}/commands`
  : `${BASE}/applications/${APP_ID}/commands`;

const commands = [
  {
    name: 'hello',
    description: 'Say hello with debug info',
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
        description: 'Set a meeting time',
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
    description: 'Get configurations',
    type: 1, // CHAT_INPUT
    options: [
      {
        type: 1, // SUB_COMMAND
        name: 'mtg',
        description: 'Get the last meeting time',
      },
      {
        type: 1, // SUB_COMMAND
        name: 'todo',
        description: 'Get the last TODO memo',
      },
    ],
  },
  {
    name: 'list',
    description: 'List saved data',
    type: 1, // CHAT_INPUT
    options: [
      {
        type: 1, // SUB_COMMAND
        name: 'todo',
        description: 'List last TODO (latest only)',
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
        description: 'Clear last TODO',
      },
      {
        type: 1, // SUB_COMMAND
        name: 'mtg',
        description: 'Clear last meeting',
      },
    ],
  },
];

async function main() {
  const res = await fetch(route, {
    method: 'PUT', // bulk overwrite for idempotency
    headers: {
      Authorization: `Bot ${BOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(commands),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.error('Failed to register commands', res.status, text);
    process.exit(1);
  }
  const data = await res.json();
  console.log('Registered commands:', data.map((c) => c.name).join(', '));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
