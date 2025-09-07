import { formatJstFromEpoch } from './utils/time';

export interface AlarmPayload {
  guildId: string;
  channelId: string;
  userId: string;
  whenUtc: number;   // UTCミリ秒
  mention?: string;  // "here" | "everyone" | "role:<ID>" | "user:<ID>"
  todo?: string;     // 任意（旧形式互換）
}
type QueueItem = AlarmPayload & { stage: "T-10" | "T"; runAt: number };

type TodoEntry = { text: string; userId?: string; userName?: string };

export class SchedulerDO {
  constructor(private state: DurableObjectState, private env: Env) {}

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/schedule" && req.method === "POST") {
      const p = await req.json<AlarmPayload>();

      const list = await this.getQueue();
      list.push({ ...p, stage: "T-10", runAt: Math.max(Date.now(), p.whenUtc - 10 * 60 * 1000) });
      list.push({ ...p, stage: "T",    runAt: Math.max(Date.now(), p.whenUtc) });
      list.sort((a, b) => a.runAt - b.runAt);

      await this.putQueue(list);
      await this.armNext(list);
      return new Response("scheduled");
    }

    if (url.pathname === "/todo" && req.method === "POST") {
      const ct = req.headers.get("content-type") || "";
      let entry: TodoEntry | null = null;
      if (ct.includes("application/json")) {
        const data = await req.json<any>().catch(() => ({}));
        if (typeof data?.text === 'string' && data.text.trim().length > 0) {
          entry = { text: data.text.trim(), userId: data.userId, userName: data.userName };
        }
      } else {
        const text = (await req.text()).trim();
        if (text.length > 0) entry = { text };
      }
      if (!entry) return new Response("bad request", { status: 400 });
      // Merge/update into per-user TODO list
      const raw = await this.state.storage.get<any>("todo");
      const list = this.normalizeTodos(raw);
      // Prefer userId match when available; fallback to userName
      let idx = -1;
      if (entry.userId) idx = list.findIndex((t) => t.userId && t.userId === entry!.userId);
      if (idx < 0 && entry.userName) idx = list.findIndex((t) => !t.userId && t.userName && t.userName === entry!.userName);
      if (idx >= 0) {
        // Overwrite text; refresh userName if provided
        const cur = list[idx];
        list[idx] = { ...cur, text: entry.text, userName: entry.userName ?? cur.userName };
      } else {
        list.push(entry);
      }
      await this.state.storage.put("todo", list);
      return new Response("ok");
    }

    if (url.pathname === "/clear" && req.method === "POST") {
      type ClearBody = { what?: "todo" | "mtg" | "all" };
      const body = await req.json<ClearBody>().catch(() => ({} as ClearBody));
      const what = body.what ?? "all";
      if (what === "todo" || what === "all") {
        await this.state.storage.delete("todo");
      }
      if (what === "mtg" || what === "all") {
        await this.state.storage.put("queue", [] as QueueItem[]);
        // Cancel any pending alarm cleanly when clearing meeting schedule
        const anyState = this.state as any;
        if (this.state.storage.deleteAlarm) {
          await this.state.storage.deleteAlarm();
        } else if (anyState.deleteAlarm) {
          await anyState.deleteAlarm();
        }
      }
      return new Response("cleared");
    }

    if (url.pathname === "/state" && req.method === "GET") {
      const list = await this.getQueue();
      const rawTodo = await this.state.storage.get<any>("todo");
      const todos = this.normalizeTodos(rawTodo);
      const todo = todos.length > 0 ? todos : undefined;
      return new Response(JSON.stringify({ size: list.length, head: list[0], todo }), {
        headers: { "content-type": "application/json" },
      });
    }

    return new Response("not found", { status: 404 });
  }

  async alarm(): Promise<void> {
    const list = await this.getQueue();
    if (list.length === 0) return;

    const head = list.shift()!;
    const rawTodo = await this.state.storage.get<any>("todo");
    let todos = this.normalizeTodos(rawTodo);
    // Backward compatibility: include payload.todo if present and no list saved
    if ((todos.length === 0) && head.todo && typeof head.todo === 'string') {
      todos = [{ text: head.todo }];
    }

    await this.sendDiscord(head, todos);

    await this.putQueue(list);
    await this.armNext(list);
  }

  private async armNext(list: QueueItem[]) {
    if (list.length > 0) {
      await this.state.storage.setAlarm(new Date(list[0].runAt));
    }
  }
  private async getQueue(): Promise<QueueItem[]> {
    return (await this.state.storage.get<QueueItem[]>("queue")) || [];
  }
  private async putQueue(list: QueueItem[]) {
    await this.state.storage.put("queue", list);
  }

  private normalizeTodos(raw: any): TodoEntry[] {
    const list: TodoEntry[] = [];
    if (!raw) return list;
    try {
      if (Array.isArray(raw)) {
        for (const it of raw) {
          if (it && typeof it === 'object' && typeof it.text === 'string' && it.text.trim().length > 0) {
            const t: TodoEntry = { text: it.text.trim() };
            if (typeof it.userId === 'string') t.userId = it.userId;
            if (typeof it.userName === 'string') t.userName = it.userName;
            list.push(t);
          }
        }
      } else if (typeof raw === 'string') {
        if (raw.trim().length > 0) list.push({ text: raw.trim() });
      } else if (raw && typeof raw === 'object' && typeof raw.text === 'string') {
        const t: TodoEntry = { text: raw.text.trim() };
        if (typeof raw.userId === 'string') t.userId = raw.userId;
        if (typeof raw.userName === 'string') t.userName = raw.userName;
        if (t.text.length > 0) list.push(t);
      }
    } catch {}
    return list;
  }

  private async sendDiscord(p: QueueItem, todos: TodoEntry[] | undefined) {
    let mentionText = "";
    let allowed: any = { parse: [] as string[], users: [] as string[], roles: [] as string[] };
    if (p.mention === "here") { mentionText = "@here "; allowed.parse.push("everyone"); }
    else if (p.mention === "everyone") { mentionText = "@everyone "; allowed.parse.push("everyone"); }
    else if (p.mention?.startsWith("role:")) { const id = p.mention.split(":")[1]; mentionText = `<@&${id}> `; allowed.roles.push(id); }
    else if (p.mention?.startsWith("user:")) { const id = p.mention.split(":")[1]; mentionText = `<@${id}> `; allowed.users.push(id); }
    else { mentionText = `<@${p.userId}> `; allowed.users.push(p.userId); }

    const stageText = p.stage === "T-10" ? "⏰ The meeting starts in 10 minutes!" : "🟢 The meeting is starting!";
    const jst = formatJstFromEpoch(Math.floor(p.whenUtc / 1000));
    let todoBlock = "";
    if (todos && todos.length > 0) {
      const lines = todos.map((t) => `- ${t.userName || t.userId || 'unknown'}: ${t.text}`);
      todoBlock = `\n📝 TODO:\n${lines.join("\n")}`;
    }
    const content = `${mentionText}${stageText} (Start: ${jst})${todoBlock}`;

    const res = await fetch(`https://discord.com/api/v10/channels/${p.channelId}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Authorization": `Bot ${this.env.DISCORD_BOT_TOKEN}`,
      },
      body: JSON.stringify({ content, allowed_mentions: allowed }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error("discord_send_failed", { status: res.status, text });
    }
  }
}
