// Pluggable notification channels (spec §8).
//
// In-app is the system of record: the Notification row itself IS the in-app
// notification (the 消息通知 center reads the table). External channels
// (Feishu / email / SMS) are pluggable — implement NotifyChannel and add its id
// to NOTIFY_CHANNELS. Only no-op external stubs ship today: the interface is
// defined and dispatch is wired, but nothing is actually sent externally until
// a real channel is implemented. Default NOTIFY_CHANNELS=in_app → dispatchExternal
// is a no-op.

export interface NotifyTarget {
  id: string;
  severity: string;
  category: string;
  source: string;
  title: string;
  body: string;
  runId: string | null;
}

export interface NotifyChannel {
  readonly id: string;
  send(n: NotifyTarget): Promise<void>;
}

/** Placeholder external channel — logs intent, sends nothing. Replace with a
 *  real implementation (Feishu webhook, SMTP, …) when external delivery lands. */
class NoopExternalChannel implements NotifyChannel {
  constructor(public readonly id: string) {}
  async send(n: NotifyTarget): Promise<void> {
    // eslint-disable-next-line no-console
    console.log(`[notify:${this.id}] would send · ${n.severity} · ${n.title}`);
  }
}

const EXTERNAL_REGISTRY: Record<string, NotifyChannel> = {
  feishu: new NoopExternalChannel('feishu'),
  email: new NoopExternalChannel('email'),
  sms: new NoopExternalChannel('sms'),
};

/** External channels enabled via NOTIFY_CHANNELS (csv). 'in_app' is implicit
 *  (the row) and never appears here. Unknown ids are ignored. */
export function enabledExternalChannels(env = process.env.NOTIFY_CHANNELS): NotifyChannel[] {
  return (env ?? 'in_app')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s && s !== 'in_app')
    .map((id) => EXTERNAL_REGISTRY[id])
    .filter((c): c is NotifyChannel => Boolean(c));
}

/** Fan a notification out to every enabled external channel. No-op by default
 *  (in_app only). Never throws — a channel failure must not break ingestion. */
export async function dispatchExternal(n: NotifyTarget): Promise<void> {
  for (const ch of enabledExternalChannels()) {
    try {
      await ch.send(n);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[notify:${ch.id}] send failed: ${(e as Error).message}`);
    }
  }
}
