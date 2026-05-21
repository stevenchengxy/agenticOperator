"use client";
import React from "react";
import Link from "next/link";
import { useApp } from "@/lib/i18n";
import { useGlobalChat } from "@/lib/chat/use-global-chat";
import { usePageContext } from "@/lib/chat/page-context";
import { Markdown } from "@/components/shared/Markdown";
import { Badge, Btn } from "@/components/shared/atoms";
import { Ic } from "@/components/shared/Ic";
import type { ChatMessage, ChatSource, GlobalChatRequest, GlobalChatResponse } from "@/lib/chat/types";

export function GlobalChatPanel({ scope = "bubble" }: { scope?: "bubble" | "full" }) {
  const { t } = useApp();
  const suggestions = [
    t("chat_suggestion_1"),
    t("chat_suggestion_2"),
    t("chat_suggestion_3"),
    t("chat_suggestion_4"),
  ];
  const chat = useGlobalChat();
  const pageContext = usePageContext();
  const [input, setInput] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const [sourcesPerMessage, setSourcesPerMessage] = React.useState<Record<number, ChatSource[]>>({});
  const scrollRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [chat.currentSession.messages.length]);

  const send = React.useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || busy) return;
      const userMsg: ChatMessage = { role: "user", content: trimmed };
      const historyBeforeAppend = chat.currentSession.messages;
      chat.appendMessage(userMsg);
      setInput("");
      setBusy(true);
      setErr(null);
      try {
        const reqBody: GlobalChatRequest = {
          messages: [...historyBeforeAppend, userMsg],
          pageContext,
        };
        const res = await fetch("/api/chat/trace", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(reqBody),
        });
        const data = (await res.json()) as GlobalChatResponse & { error?: string; message?: string };
        if (!res.ok || data.error) throw new Error(data.message ?? data.error ?? `HTTP ${res.status}`);
        chat.appendMessage({ role: "assistant", content: data.reply.content });
        // Sources keyed by the assistant message's index (after both user + assistant appended)
        const assistantIdx = historyBeforeAppend.length + 1;
        if (data.sources?.length) {
          setSourcesPerMessage((s) => ({ ...s, [assistantIdx]: data.sources }));
        }
      } catch (e) {
        setErr((e as Error).message ?? t("chat_send_fail"));
      } finally {
        setBusy(false);
      }
    },
    [busy, chat, pageContext, t],
  );

  const messages = chat.currentSession.messages;

  return (
    <div className="flex flex-col h-full bg-surface">
      {scope === "bubble" && pageContext.route !== "/" && (
        <div className="border-b border-line" style={{ padding: "8px 12px" }}>
          <span className="text-[10.5px] text-ink-3" style={{ letterSpacing: "0.04em" }}>
            {t("chat_context_label")}
          </span>
          <div className="mono text-[11px] text-ink-2 truncate" title={pageContext.route}>
            {pageContext.route}
            {pageContext.runId ? ` · run ${pageContext.runId.slice(0, 10)}` : ""}
            {pageContext.auditId ? ` · audit ${pageContext.auditId.slice(0, 10)}` : ""}
            {pageContext.entityType ? ` · ${pageContext.entityType} ${pageContext.entityId?.slice(0, 10)}` : ""}
            {pageContext.agentShort ? ` · agent ${pageContext.agentShort}` : ""}
          </div>
        </div>
      )}

      <div ref={scrollRef} className="flex-1 overflow-auto" style={{ padding: "10px 12px" }}>
        {messages.length === 0 && (
          <div>
            <div className="text-[12px] text-ink-3 mb-2">{t("chat_empty_hint")}</div>
            <div className="flex flex-col gap-1">
              {suggestions.map((s) => (
                <button
                  key={s}
                  type="button"
                  className="text-left bg-panel border border-line rounded-sm hover:bg-surface text-[11.5px] text-ink-2 cursor-pointer"
                  style={{ padding: "6px 8px" }}
                  onClick={() => void send(s)}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m, i) => (
          <Bubble key={i} message={m} sources={sourcesPerMessage[i]} userLabel={t("chat_role_user")} />
        ))}
        {busy && (
          <div className="text-[11px] text-ink-3 mt-2 flex items-center gap-1.5">
            <span className="animate-pulse">●</span> {t("chat_thinking")}
          </div>
        )}
        {err && (
          <div
            className="mt-2 border rounded-sm text-[11px]"
            style={{
              padding: "6px 8px",
              background: "var(--c-warn-bg)",
              borderColor: "color-mix(in oklab, var(--c-warn) 35%, transparent)",
              color: "oklch(0.45 0.14 75)",
            }}
          >
            ⚠ {err}
          </div>
        )}
      </div>

      <div className="border-t border-line bg-panel" style={{ padding: "8px 10px" }}>
        <div className="flex gap-1.5">
          <input
            className="flex-1 bg-surface border border-line rounded-sm px-2 py-1 text-[12.5px] outline-none focus:border-[color:var(--c-accent)]"
            placeholder={t("chat_input_placeholder")}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send(input);
              }
            }}
            disabled={busy}
          />
          <Btn size="sm" variant="primary" onClick={() => void send(input)} disabled={busy || !input.trim()} title={t("chat_send")}>
            <Ic.arrowR />
          </Btn>
          {messages.length > 0 && (
            <Btn size="sm" variant="ghost" onClick={chat.newSession} title={t("chat_new_session")}>
              +
            </Btn>
          )}
        </div>
      </div>
    </div>
  );
}

function Bubble({ message, sources, userLabel }: { message: ChatMessage; sources?: ChatSource[]; userLabel: string }) {
  const isUser = message.role === "user";
  return (
    <div className="mb-2.5 last:mb-0">
      <div className="text-[10px] mono mb-0.5" style={{ color: isUser ? "var(--c-ink-3)" : "var(--c-accent)" }}>
        {isUser ? userLabel : "AI"}
      </div>
      <div
        className={`rounded-md text-[12.5px] leading-relaxed ${
          isUser ? "bg-panel border border-line" : "bg-accent-bg border border-accent-line"
        }`}
        style={{ padding: "6px 10px" }}
      >
        {isUser ? <div className="whitespace-pre-wrap">{message.content}</div> : <Markdown compact>{message.content}</Markdown>}
      </div>
      {sources && sources.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1">
          {sources.map((s, i) =>
            s.url ? (
              s.url.startsWith("/") ? (
                <Link key={i} href={s.url} className="no-underline">
                  <Badge variant="info" className="text-[9.5px]">{s.tool} · {s.label}</Badge>
                </Link>
              ) : (
                <a key={i} href={s.url} className="no-underline" target="_blank" rel="noreferrer">
                  <Badge variant="info" className="text-[9.5px]">{s.tool} · {s.label}</Badge>
                </a>
              )
            ) : (
              <Badge key={i} variant="info" className="text-[9.5px]">{s.tool} · {s.label}</Badge>
            ),
          )}
        </div>
      )}
    </div>
  );
}
