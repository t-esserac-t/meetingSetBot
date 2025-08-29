/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Bind resources to your worker in `wrangler.jsonc`. After adding bindings, a type definition for the
 * `Env` object can be regenerated with `npm run cf-typegen`.
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

import { verifyKey } from 'discord-interactions';

type JsonValue = string | number | boolean | null | { [key: string]: JsonValue } | JsonValue[];

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
				const publicKey = (env as Record<string, string>)['DISCORD_PUBLIC_KEY'];
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
				if (interaction.type === 1) {
					return json({ type: 1 });
				}

				// APPLICATION_COMMAND
				if (interaction.type === 2) {
					const name = interaction.data?.name?.toLowerCase();
					if (name === 'hello') {
						// Debug info for diagnostics
						const now = Date.now();
						const ageMs = timestamp ? Math.max(0, now - Number(timestamp) * 1000) : undefined;
						const processMs = Math.max(0, now - requestStart);
						const cf = (request as unknown as { cf?: Record<string, unknown> }).cf || {};
						const colo = (cf['colo'] as string | undefined) || 'n/a';
						const country = (cf['country'] as string | undefined) || 'n/a';
						const rtt = (cf['clientTcpRtt'] as number | undefined) ?? 'n/a';
						const ua = request.headers.get('user-agent') || 'n/a';
						const traceId = Array.from(crypto.getRandomValues(new Uint8Array(8)))
							.map((b) => b.toString(16).padStart(2, '0'))
							.join('');

						console.log('pong', { traceId, ageMs, processMs, colo, country, rtt });

						const lines = [
							'👋 Hello!',
							`process: ${processMs}ms`,
							`age: ${ageMs ?? 'n/a'}ms`,
							`colo: ${colo} country: ${country} rtt: ${rtt}ms`,
							`ua: ${ua.substring(0, 60)}`,
							`trace: ${traceId}`,
						].join('\n');

						// Immediately defer (ephemeral) to guarantee fast ack, then edit original
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
						const appId = interaction.application_id;
						const token = interaction.token;
						const guildId = (interaction as any).guild_id ?? 'global';
						const channelId = (interaction as any).channel_id as string | undefined;
						const user = (interaction as any).member?.user ?? (interaction as any).user ?? {};
						const userId = (user.id as string | undefined) ?? 'unknown';
						const userName = (user.global_name as string | undefined) || (user.username as string | undefined) || 'unknown';

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
							// Interpret input as JST, convert to UTC epoch ms
							const tsMs = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), 0, 0) - 9 * 60 * 60 * 1000;
							const date = new Date(tsMs);
							if (Number.isNaN(date.getTime())) {
								return json({ type: 4, data: { content: '❗ Failed to parse time.', flags: 64 } });
							}
							const iso = date.toISOString();
							const epoch = Math.floor(tsMs / 1000);
							const jstStr = formatJstFromEpoch(epoch);
							const baseContent = `🗓️ Meeting candidate noted\n- input: ${whenStr}\n- utc:   ${iso}\n- jst:   ${jstStr}\n- epoch: ${epoch}`;
							ctx.waitUntil((async () => {
								let saved = false;
								try {
									const kv = (env as any).MEETINGS as { put: (k: string, v: string) => Promise<void> } | undefined;
									if (kv) {
										const key = `last_mtg:${guildId}`;
										const payload = { whenStr, tsMs, iso, epoch, guildId, channelId, setBy: userId, setByName: userName, setAt: Math.floor(Date.now() / 1000), notify: { pre: false, at: false, preAt: epoch - 600, atAt: epoch } };
										await kv.put(key, JSON.stringify(payload));
										saved = true;
									}
								} catch (e) {
									console.error('kv_save_error', e);
								}
								const content = saved ? `${baseContent}\n- saved: yes` : `${baseContent}\n- saved: no (KV not configured)`;
								await fetch(`https://discord.com/api/v10/webhooks/${appId}/${token}/messages/@original`, {
									method: 'PATCH',
									headers: { 'content-type': 'application/json' },
									body: JSON.stringify({ content }),
								});
							})());
							return json({ type: 5, data: { flags: 64 } });
						}

						if (subName === 'todo') {
							const textOpt = sub?.options?.find((o) => o['name'] === 'text') as { value?: unknown } | undefined;
							const text = typeof textOpt?.value === 'string' ? textOpt.value.trim() : '';
							if (!text) {
								return json({ type: 4, data: { content: '❗ Invalid arguments. Usage: /set todo text:<content>', flags: 64 } });
							}
							const baseContent = `📝 TODO saved\n- text: ${text}\n- by:   ${userName} (${userId})`;
							ctx.waitUntil((async () => {
								let saved = false;
								try {
									const kv = (env as any).MEETINGS as { put: (k: string, v: string) => Promise<void> } | undefined;
									if (kv) {
										const key = `last_todo:${guildId}`;
										const payload = { text, guildId, channelId, setBy: userId, setByName: userName, setAt: Math.floor(Date.now() / 1000) };
										await kv.put(key, JSON.stringify(payload));
										saved = true;
									}
								} catch (e) {
									console.error('kv_save_error', e);
								}
								const content = saved ? `${baseContent}\n- saved: yes` : `${baseContent}\n- saved: no (KV not configured)`;
								await fetch(`https://discord.com/api/v10/webhooks/${appId}/${token}/messages/@original`, {
									method: 'PATCH',
									headers: { 'content-type': 'application/json' },
									body: JSON.stringify({ content }),
								});
							})());
							return json({ type: 5, data: { flags: 64 } });
						}

						return json({ type: 4, data: { content: '❗ Unknown subcommand for /set', flags: 64 } });
					}

					if (name === 'get') {
						// subcommand: mtg | todo
						const options = (interaction.data?.options as Array<Record<string, unknown>>) || [];
						const sub = (options.find((o) => o['type'] === 1) || options[0]) as { name?: string } | undefined;
						const subName = sub?.name;
						const appId = interaction.application_id;
						const token = interaction.token;
						const guildId = (interaction as any).guild_id ?? 'global';
						ctx.waitUntil(
							(async () => {
								const kv = (env as any).MEETINGS as { get: (k: string) => Promise<string | null> } | undefined;
								let content = '';
								if (!kv) {
									content = '📦 No storage configured (KV MEETINGS not bound).';
								} else {
									try {
										if (subName === 'todo') {
											const key = `last_todo:${guildId}`;
											const saved = await kv.get(key);
											content = saved
												? (() => { const p = JSON.parse(saved) as { text: string; setByName?: string; setBy?: string; setAt?: number }; const setAtIso = p.setAt ? new Date(p.setAt * 1000).toISOString() : 'n/a'; return `📝 Last TODO\n- text: ${p.text}\n- by:   ${p.setByName ?? p.setBy ?? 'n/a'}\n- at:   ${setAtIso}`; })()
												: '📝 No TODO set yet.';
										} else {
											const key = `last_mtg:${guildId}`;
											const saved = await kv.get(key);
											if (!saved) {
												content = '🗓️ No meeting set yet.';
											} else {
												const p = JSON.parse(saved) as { whenStr: string; iso: string; epoch: number; setByName?: string; setBy?: string; setAt?: number };
											const setAtIso = p.setAt ? new Date(p.setAt * 1000).toISOString() : 'n/a';
											const jstStr = formatJstFromEpoch(p.epoch);
											content = `🗓️ Last meeting\n- input: ${p.whenStr}\n- utc:   ${p.iso}\n- jst:   ${jstStr}\n- epoch: ${p.epoch}\n- by:    ${p.setByName ?? p.setBy ?? 'n/a'}\n- at:    ${setAtIso}`;
											}
										}
									} catch (e) {
										console.error('kv_get_error', e);
										content = '⚠️ Failed to read saved data.';
									}
								}
								await fetch(`https://discord.com/api/v10/webhooks/${appId}/${token}/messages/@original`, {
									method: 'PATCH',
									headers: { 'content-type': 'application/json' },
									body: JSON.stringify({ content }),
								});
							})(),
						);
						return json({ type: 5, data: { flags: 64 } });
					}

					if (name === 'list') {
						// Currently only the latest TODO is stored; list will show the latest.
						const appId = interaction.application_id;
						const token = interaction.token;
						const guildId = (interaction as any).guild_id ?? 'global';
						ctx.waitUntil(
							(async () => {
								const kv = (env as any).MEETINGS as { get: (k: string) => Promise<string | null> } | undefined;
								let content = '';
								if (!kv) {
									content = '📦 No storage configured (KV MEETINGS not bound).';
								} else {
									try {
										const key = `last_todo:${guildId}`;
										const saved = await kv.get(key);
										if (!saved) {
											content = '📝 No TODO set yet.';
										} else {
											const p = JSON.parse(saved) as { text: string; setByName?: string; setBy?: string; setAt?: number };
											const setAtIso = p.setAt ? new Date(p.setAt * 1000).toISOString() : 'n/a';
											content = `📝 TODO (latest only)\n- text: ${p.text}\n- by:   ${p.setByName ?? p.setBy ?? 'n/a'}\n- at:   ${setAtIso}`;
										}
									} catch (e) {
										console.error('kv_get_error', e);
										content = '⚠️ Failed to list TODO.';
									}
								}
								await fetch(`https://discord.com/api/v10/webhooks/${appId}/${token}/messages/@original`, {
									method: 'PATCH',
									headers: { 'content-type': 'application/json' },
									body: JSON.stringify({ content }),
								});
							})(),
						);
						return json({ type: 5, data: { flags: 64 } });
					}

					if (name === 'clear') {
						// subcommand: mtg | todo
						const options = (interaction.data?.options as Array<Record<string, unknown>>) || [];
						const sub = (options.find((o) => o['type'] === 1) || options[0]) as { name?: string } | undefined;
						const subName = sub?.name;
						const appId = interaction.application_id;
						const token = interaction.token;
						const guildId = (interaction as any).guild_id ?? 'global';
						ctx.waitUntil(
							(async () => {
								const kv = (env as any).MEETINGS as { delete: (k: string) => Promise<void> } | undefined;
								let content = '';
								if (!kv) {
									content = '📦 No storage configured (KV MEETINGS not bound).';
								} else {
									try {
										if (subName === 'todo') {
											await kv.delete(`last_todo:${guildId}`);
											content = '🧹 Cleared TODO (latest).';
										} else if (subName === 'mtg') {
											await kv.delete(`last_mtg:${guildId}`);
											content = '🧹 Cleared meeting (latest).';
										} else {
											content = '❗ Unknown subcommand for /clear';
										}
									} catch (e) {
										console.error('kv_delete_error', e);
										content = '⚠️ Failed to clear data.';
									}
							}
							await fetch(`https://discord.com/api/v10/webhooks/${appId}/${token}/messages/@original`, {
								method: 'PATCH',
								headers: { 'content-type': 'application/json' },
								body: JSON.stringify({ content }),
							});
						})(),
						);
						return json({ type: 5, data: { flags: 64 } });
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

	// Cron-triggered handler: check meetings and post reminders
	async scheduled(_event, env, ctx) {
		const kv = (env as any).MEETINGS as
			| { list: (opts: { prefix: string; cursor?: string }) => Promise<{ keys: Array<{ name: string }>; cursor?: string }>; get: (k: string) => Promise<string | null>; put: (k: string, v: string) => Promise<void> }
			| undefined;
		const botToken = (env as any).DISCORD_BOT_TOKEN as string | undefined;
		if (!kv || !botToken) {
			console.log('cron_skip_no_config', { hasKV: !!kv, hasBotToken: !!botToken });
			return; // Not configured; nothing to do
		}

		const now = Math.floor(Date.now() / 1000);
		console.log('cron_tick', { now });
		let cursor: string | undefined = undefined;
		do {
			const { keys, cursor: next } = await kv.list({ prefix: 'last_mtg:', cursor });
			console.log('cron_keys', { count: keys.length });
			for (const { name } of keys) {
				ctx.waitUntil((async () => {
					try {
						const raw = await kv.get(name);
						if (!raw) return;
						const p = JSON.parse(raw) as {
							whenStr: string;
							iso: string;
							epoch: number;
							guildId?: string;
							channelId?: string;
							notify?: { pre?: boolean; at?: boolean; preAt?: number; atAt?: number };
						};
						const channelId = p.channelId;
						if (!channelId || channelId === 'n/a') return;
						const preAt = (p.notify?.preAt ?? (p.epoch - 600));
						const atAt = (p.notify?.atAt ?? p.epoch);
						let pre = !!p.notify?.pre;
						let at = !!p.notify?.at;
						console.log('cron_mtg', { key: name, whenStr: p.whenStr, epoch: p.epoch, preAt, atAt, pre, at, now });

						// 10 minutes before
						if (!pre && now >= preAt && now < atAt) {
							const jstStr = formatJstFromEpoch(p.epoch);
							console.log('cron_post_pre', { key: name, channelId });
							await postChannelMessage(botToken, channelId, `⏰ 会議開始10分前です（開始: ${jstStr}）`);
							pre = true;
						}

						// At start time
						if (!at && now >= atAt) {
							const jstStr = formatJstFromEpoch(p.epoch);
							console.log('cron_post_at', { key: name, channelId });
							await postChannelMessage(botToken, channelId, `🟢 会議開始です（開始: ${jstStr}）`);
							at = true;
						}

						if (pre !== (p.notify?.pre ?? false) || at !== (p.notify?.at ?? false) || p.notify?.preAt === undefined || p.notify?.atAt === undefined) {
							p.notify = { pre, at, preAt, atAt };
							await kv.put(name, JSON.stringify(p));
						}
					} catch (e) {
						console.error('cron_error', name, e);
					}
				})());
			}
			cursor = next;
		} while (cursor);
	},
} satisfies ExportedHandler<Env>;

async function postChannelMessage(botToken: string, channelId: string, content: string) {
	const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			Authorization: `Bot ${botToken}`,
		},
		body: JSON.stringify({ content }),
	});
	if (!res.ok) {
		const text = await res.text().catch(() => '');
		console.error('post_error', { channelId, status: res.status, text });
	}
}

function formatJstFromEpoch(epochSeconds: number): string {
	const ms = epochSeconds * 1000;
	// Add 9 hours to UTC then format as YYYY/MM/DD HH:MM JST
	const d = new Date(ms + 9 * 60 * 60 * 1000);
	const y = d.getUTCFullYear();
	const m = String(d.getUTCMonth() + 1).padStart(2, '0');
	const day = String(d.getUTCDate()).padStart(2, '0');
	const hh = String(d.getUTCHours()).padStart(2, '0');
	const mm = String(d.getUTCMinutes()).padStart(2, '0');
	return `${y}/${m}/${day} ${hh}:${mm} JST`;
}
