// DiscordでInteractionsを使うために必要な検証用関数
import { verifyKey } from 'discord-interactions';
import { formatJstFromEpoch } from './utils/time';

// JSONを扱うための型
type JsonValue = string | number | boolean | null | { [key: string]: JsonValue } | JsonValue[];
type reqCf = {
	asn?: number;
	country?: string;
	colo?: string;
	timezone?: string;
 }

const json = (data: JsonValue, init?: ResponseInit) =>
	new Response(JSON.stringify(data), {
		status: 200,
		headers: { 'content-type': 'application/json; charset=utf-8' },
		...init,
	});

export default {
    async fetch(request, env, ctx): Promise<Response> {
		const requestStart = Date.now();
		const url = new URL(request.url);

		// Health check / default route to keep existing tests passing
		if (request.method === 'GET' && url.pathname === '/') {
			return new Response('Hello World!');
		}

		// Discord Interactions endpoint
		if (url.pathname === '/interactions' && request.method === 'POST') {
			try {
				const signature = request.headers.get('x-signature-ed25519') ?? '';
				const timestamp = request.headers.get('x-signature-timestamp') ?? '';
				const publicKey = (env as any).DISCORD_PUBLIC_KEY as string;
				if (!publicKey) return new Response('Missing public key', { status: 500 });

				const rawBody = await request.arrayBuffer();
				const isValid = await verifyKey(new Uint8Array(rawBody), signature, timestamp, publicKey).catch(() => false);
				if (!isValid) return new Response('Bad request signature', { status: 401 });

				const interaction = JSON.parse(new TextDecoder().decode(rawBody)) as {
					type: number;
					application_id: string;
					token: string;
					data?: { name?: string; options?: Array<Record<string, unknown>> };
				};

				// PING -> PONG
				//死活監視＋初回ハンドシェイク 必須処理
				if (interaction.type === 1) {
					return json({ type: 1 });
				}

            // APPLICATION_COMMAND
            if (interaction.type === 2) {
                const name = interaction.data?.name?.toLowerCase();
                if (name === 'hello') {
                    // New hello: usage/help in English
                    const lines = [
                        '** 👋 Hello! **',
                        '🔰 Usage',
                        '- `/set mtg YYYY/MM/DD HH:MM` (JST) — schedule a meeting (everyone will be notified).',
                        '- `/set todo text:<content>` — save a TODO memo.',
                        '- `/get mtg` — show the next meeting.',
                        '- `/get todo` — show the saved TODO.',
                        '- `/clear mtg | todo` — delete saved items.',
                        '- `/debug` — show debug information.',
                    ].join('\n');
                    return json({ type: 4, data: { content: lines, flags: 64 } });
                }

                if (name === 'debug') {
                    // Moved diagnostics from hello to debug
                    const now = Date.now();
                    const ageMs = timestamp ? Math.max(0, now - Number(timestamp) * 1000) : undefined;
                    const latency = Math.max(0, now - requestStart);
                    type RequestWithCf = Request & {cf?: reqCf};
                    const reqWithCf = request as RequestWithCf;
                    const cf: reqCf = reqWithCf.cf || {};

                    const colo = cf.colo ?? 'n/a';
                    const country = cf.country ?? 'n/a';
                    const ua = request.headers.get('user-agent') || 'n/a';
                    const traceId = Array.from(crypto.getRandomValues(new Uint8Array(8)))
                        .map((b) => b.toString(16).padStart(2, '0'))
                        .join('');

                    const lines = [
                        '🧪 Debug Info',
                        `⏱️ Latency: ${latency}ms`,
                        `🕒 Age: ${ageMs ?? 'n/a'}ms`,
                        `🗺️ Colo: ${colo}`,
                        `🖥️ UA: ${ua.substring(0, 120)}`,
                        `🔖 Trace ID: ${traceId}`,
                    ].join('\n');

                    // Defer to ensure quick ACK
                    const appId = interaction.application_id;
                    const token = interaction.token;
                    ctx.waitUntil(
                        fetch(`https://discord.com/api/v10/webhooks/${appId}/${token}/messages/@original`, {
                            method: 'PATCH',
                            headers: { 'content-type': 'application/json' },
                            body: JSON.stringify({ content: lines }),
                        }),
                    );
                    return json({ type: 5, data: { flags: 64 } });
                }

                if (name === 'set') {
                    // subcommand: mtg | todo
                    const options = (interaction.data?.options as Array<Record<string, unknown>>) || [];
                    const sub = (options.find((o) => o['type'] === 1) || options[0]) as { name?: string; options?: Array<Record<string, unknown>> } | undefined;
                    const subName = sub?.name;
                    const guildId = (interaction as any).guild_id ?? 'global';
                    const channelId = (interaction as any).channel_id as string | undefined;
                    const user = (interaction as any).member?.user ?? (interaction as any).user ?? {};
                    const userId = (user.id as string | undefined) ?? 'unknown';
                    // const userName = (user.global_name as string | undefined) || (user.username as string | undefined) || 'unknown';

						if (subName === 'mtg') {
							const whenOpt = sub?.options?.find((o) => o['name'] === 'when') as { value?: unknown } | undefined;
							const whenStr = typeof whenOpt?.value === 'string' ? whenOpt.value : undefined;
                        const usage = 'Usage: /set mtg when:YYYY/MM/DD HH:MM (JST)';
                        if (!whenStr) {
                            return json({ type: 4, data: { content: `❗ Invalid arguments. ${usage}`, flags: 64 } });
                        }
                        const m = whenStr.match(/^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})$/);
                        if (!m) {
                            return json({ type: 4, data: { content: `❗ Invalid format. ${usage}`, flags: 64 } });
                        }
                        const [_, y, mo, d, h, mi] = m;
                        // JSTとして解釈 → UTC ms へ
                        const tsMs = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), 0, 0) - 9 * 60 * 60 * 1000;
                        const id = env.SCHEDULER_DO.idFromName(`${guildId}:${channelId}`);
                        const stub = env.SCHEDULER_DO.get(id);
                        await stub.fetch("https://do/schedule", {
                            method: "POST",
                            headers: { 'content-type': 'application/json' },
                            body: JSON.stringify({ guildId, channelId, userId, whenUtc: tsMs, mention: 'everyone' }),
                        });
                        const jstStr = formatJstFromEpoch(Math.floor(tsMs / 1000));
                        return json({ type: 4, data: { content: `🗓️ Meeting scheduled: ${jstStr} (JST)`, flags: 64 } });
                    }

						if (subName === 'todo') {
							const textOpt = sub?.options?.find((o) => o['name'] === 'text') as { value?: unknown } | undefined;
                        const text = typeof textOpt?.value === 'string' ? textOpt.value.trim() : '';
                        if (!text) {
                            return json({ type: 4, data: { content: '❗ Invalid arguments. Usage: /set todo text:<content>', flags: 64 } });
                        }
                        const id = env.SCHEDULER_DO.idFromName(`${guildId}:${channelId}`);
                        const stub = env.SCHEDULER_DO.get(id);
                        await stub.fetch("https://do/todo", {
                            method: "POST",
                            headers: { 'content-type': 'application/json' },
                            body: JSON.stringify({ text, userId, userName: (user.global_name as string | undefined) || (user.username as string | undefined) }),
                        });
                        return json({ type: 4, data: { content: '📝 TODO saved.', flags: 64 } });
                    }
                }

                if (name === 'get') {
                    // subcommand: mtg | todo
                    const options = (interaction.data?.options as Array<Record<string, unknown>>) || [];
                    const sub = (options.find((o) => o['type'] === 1) || options[0]) as { name?: string } | undefined;
                    const subName = sub?.name;
                    const guildId = (interaction as any).guild_id ?? 'global';
                    const channelId = (interaction as any).channel_id as string | undefined;
                    const user = (interaction as any).member?.user ?? (interaction as any).user ?? {};
                    const displayName = (user.global_name as string | undefined) || (user.username as string | undefined) || 'unknown';
                    const id = env.SCHEDULER_DO.idFromName(`${guildId}:${channelId}`);
                    const stub = env.SCHEDULER_DO.get(id);
                    const res = await stub.fetch("https://do/state", { method: 'GET' });
                    let content = '';
                    if (!res.ok) {
                        content = '⚠️ Failed to get state.';
                    } else {
                        const state = await res.json() as { size: number; head?: any; todo?: any };
                        if (subName === 'todo') {
                            if (!state.todo) {
                                content = '📝 No TODO is set.';
                            } else if (Array.isArray(state.todo)) {
                                const lines = (state.todo as Array<{ text: string; userId?: string; userName?: string }>)
                                    .map((t) => `- ${t.userName || t.userId || 'unknown'}: ${t.text}`);
                                content = `📝 TODO\n${lines.join('\n')}`;
                            } else if (typeof state.todo === 'string') {
                                content = `📝 TODO\n- ${displayName}: ${state.todo}`;
                            } else {
                                const author = state.todo.userName || state.todo.userId || displayName;
                                content = `📝 TODO\n- ${author}: ${state.todo.text}`;
                            }
                        } else {
                            const head = state.head;
                            if (!head) content = '🗓️ No meeting scheduled.';
                            else {
                                const jstStr = formatJstFromEpoch(Math.floor(head.whenUtc / 1000));
                                content = `🗓️ Next meeting\n- when: ${jstStr}\n- stage: ${head.stage}`;
                            }
                        }
                    }
                    return json({ type: 4, data: { content, flags: 64 } });
                }

                if (name === 'clear') {
                    // subcommand: mtg | todo
                    const options = (interaction.data?.options as Array<Record<string, unknown>>) || [];
                    const sub = (options.find((o) => o['type'] === 1) || options[0]) as { name?: string } | undefined;
                    const subName = sub?.name;
                    const guildId = (interaction as any).guild_id ?? 'global';
                    const channelId = (interaction as any).channel_id as string | undefined;
                    const id = env.SCHEDULER_DO.idFromName(`${guildId}:${channelId}`);
                    const stub = env.SCHEDULER_DO.get(id);
                    const what = subName === 'todo' ? 'todo' : subName === 'mtg' ? 'mtg' : 'all';
                    const res = await stub.fetch('https://do/clear', {
                        method: 'POST',
                        headers: { 'content-type': 'application/json' },
                        body: JSON.stringify({ what }),
                    });
                    if (!res.ok) return json({ type: 4, data: { content: '⚠️ Failed to clear.', flags: 64 } });
                    return json({ type: 4, data: { content: '🧹 Deleted.', flags: 64 } });
                }
                return json({ type: 4, data: { content: '❓ Unknown command', flags: 64 } });
            }

                return json({ type: 4, data: { content: '❓ Unhandled interaction type', flags: 64 } });
            } catch (err) {
                const traceId = Array.from(crypto.getRandomValues(new Uint8Array(8)))
                    .map((b) => b.toString(16).padStart(2, '0'))
                    .join('');
                console.error('interaction_error', traceId, err);
                return json({ type: 4, data: { content: `⚠️ Internal error. trace:${traceId}`, flags: 64 } });
            }
        }

        return new Response('Not Found', { status: 404 });
    },
    // No-op scheduled handler to avoid cron errors if triggers remain on the deployment
    async scheduled(controller, env, ctx) {
        // intentionally empty
    },
} satisfies ExportedHandler<Env>;

// Export Durable Object class so Wrangler can bind it
export { SchedulerDO } from './scheduler_do';
