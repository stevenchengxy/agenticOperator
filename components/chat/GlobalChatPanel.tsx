"use client";
import React from "react";
import Link from "next/link";
import { useApp } from "@/lib/i18n";
import { useGlobalChat } from "@/lib/chat/use-global-chat";
import { usePageContext } from "@/lib/chat/page-context";
import { Markdown } from "@/components/shared/Markdown";
import { Ic } from "@/components/shared/Ic";
import type {
  ChatMessage,
  ChatSource,
  GlobalChatRequest,
  GlobalChatResponse,
} from "@/lib/chat/types";

export function GlobalChatPanel({
  scope = "bubble",
  onClose,
}: {
  scope?: "bubble" | "full";
  onClose?: () => void;
}) {
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
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [chat.currentSession.messages.length, busy]);

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
  const hasContext = pageContext.route !== "/" && (pageContext.runId || pageContext.auditId || pageContext.entityId || pageContext.agentShort);
  const contextSummary = hasContext
    ? [
        pageContext.runId ? `run ${pageContext.runId.slice(0, 10)}` : null,
        pageContext.auditId ? `audit ${pageContext.auditId.slice(0, 10)}` : null,
        pageContext.entityType ? `${pageContext.entityType} ${pageContext.entityId?.slice(0, 10)}` : null,
        pageContext.agentShort ? `agent ${pageContext.agentShort}` : null,
      ].filter(Boolean).join(" · ")
    : null;

  return (
    <div className="flex flex-col h-full bg-surface">
      {/* Header */}
      <div
        className="flex items-center gap-3 border-b border-line"
        style={{ padding: "12px 14px" }}
      >
        <div
          className="rounded-full grid place-items-center text-white"
          style={{
            width: 30,
            height: 30,
            background: "var(--c-accent)",
            boxShadow: "0 2px 6px color-mix(in oklab, var(--c-accent) 30%, transparent)",
            flexShrink: 0,
          }}
        >
          <Ic.chat />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-semibold text-ink-1 leading-tight">{t("chat_header_title")}</div>
          <div className="text-[10.5px] text-ink-3 leading-tight mt-0.5">{t("chat_header_subtitle")}</div>
        </div>
        {messages.length > 0 && (
          <button
            type="button"
            onClick={chat.newSession}
            className="text-ink-3 hover:text-ink-1 cursor-pointer bg-transparent border-0 rounded-md transition-colors"
            style={{ padding: "5px 8px", fontSize: 11 }}
            title={t("chat_new_session")}
          >
            <Ic.plus />
          </button>
        )}
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="text-ink-3 hover:text-ink-1 cursor-pointer bg-transparent border-0 rounded-md transition-colors"
            style={{ padding: "5px 6px" }}
            title={t("chat_close")}
            aria-label={t("chat_close")}
          >
            <Ic.cross />
          </button>
        )}
      </div>

      {/* Context pill */}
      {scope === "bubble" && contextSummary && (
        <div className="border-b border-line" style={{ padding: "8px 14px" }}>
          <div
            className="inline-flex items-center gap-1.5 rounded-full"
            style={{
              padding: "3px 9px",
              background: "var(--c-accent-bg)",
              color: "var(--c-accent)",
              fontSize: 10.5,
              border: "1px solid var(--c-accent-line)",
              maxWidth: "100%",
            }}
            title={pageContext.route}
          >
            <Ic.pin />
            <span className="truncate">{contextSummary}</span>
          </div>
        </div>
      )}

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-auto" style={{ padding: "16px 14px" }}>
        {messages.length === 0 && <EmptyState suggestions={suggestions} onSelect={send} t={t} />}
        {messages.map((m, i) => (
          <MessageRow
            key={i}
            message={m}
            sources={sourcesPerMessage[i]}
          />
        ))}
        {busy && <TypingIndicator label={t("chat_thinking")} />}
        {err && (
          <div
            className="mt-3 rounded-lg flex items-start gap-2"
            style={{
              padding: "8px 10px",
              background: "var(--c-warn-bg)",
              border: "1px solid color-mix(in oklab, var(--c-warn) 35%, transparent)",
              color: "oklch(0.45 0.14 75)",
              fontSize: 11.5,
            }}
          >
            <Ic.alert />
            <span className="flex-1">{err}</span>
          </div>
        )}
      </div>

      {/* Input */}
      <div className="border-t border-line bg-surface" style={{ padding: "10px 12px" }}>
        <div
          className="flex items-center gap-1 rounded-full"
          style={{
            border: "1px solid var(--c-line)",
            background: "var(--c-panel)",
            padding: "4px 4px 4px 14px",
            transition: "border-color 160ms ease-out, box-shadow 160ms ease-out",
          }}
          onFocus={(e) => {
            e.currentTarget.style.borderColor = "var(--c-accent)";
            e.currentTarget.style.boxShadow = "0 0 0 3px color-mix(in oklab, var(--c-accent) 18%, transparent)";
          }}
          onBlur={(e) => {
            e.currentTarget.style.borderColor = "var(--c-line)";
            e.currentTarget.style.boxShadow = "none";
          }}
        >
          <input
            className="flex-1 bg-transparent outline-none text-[13px] text-ink-1 placeholder:text-ink-4"
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
          <button
            type="button"
            onClick={() => void send(input)}
            disabled={busy || !input.trim()}
            className="rounded-full grid place-items-center cursor-pointer disabled:cursor-not-allowed"
            style={{
              width: 30,
              height: 30,
              background: !input.trim() || busy ? "var(--c-line)" : "var(--c-accent)",
              color: "white",
              border: "none",
              transition: "background 160ms ease-out, transform 160ms ease-out",
            }}
            onMouseEnter={(e) => { if (input.trim() && !busy) e.currentTarget.style.transform = "scale(1.06)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.transform = "scale(1)"; }}
            title={t("chat_send")}
            aria-label={t("chat_send")}
          >
            <Ic.arrowR />
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Sub-components ──────────────────────────────────────────────────

function EmptyState({
  suggestions,
  onSelect,
  t,
}: {
  suggestions: string[];
  onSelect: (s: string) => void;
  t: (k: string) => string;
}) {
  return (
    <div className="flex flex-col items-center text-center" style={{ paddingTop: 28, paddingBottom: 8 }}>
      <div
        className="rounded-full grid place-items-center"
        style={{
          width: 52,
          height: 52,
          background: "var(--c-accent-bg)",
          color: "var(--c-accent)",
          marginBottom: 12,
        }}
      >
        <Ic.sparkle />
      </div>
      <div className="text-[14px] font-semibold text-ink-1 mb-1">{t("chat_empty_greeting")}</div>
      <div className="text-[11.5px] text-ink-3" style={{ maxWidth: 280, marginBottom: 18, lineHeight: 1.5 }}>
        {t("chat_empty_hint")}
      </div>
      <div className="w-full flex flex-col gap-1.5">
        {suggestions.map((s, i) => (
          <button
            key={s}
            type="button"
            onClick={() => onSelect(s)}
            className="text-left rounded-lg cursor-pointer chat-message-in flex items-start gap-2"
            style={{
              padding: "9px 12px",
              background: "var(--c-panel)",
              border: "1px solid var(--c-line)",
              fontSize: 12,
              color: "var(--c-ink-2)",
              transition: "background 140ms ease-out, border-color 140ms ease-out, transform 140ms ease-out",
              animationDelay: `${60 * i}ms`,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "var(--c-accent-bg)";
              e.currentTarget.style.borderColor = "var(--c-accent-line)";
              e.currentTarget.style.transform = "translateY(-1px)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "var(--c-panel)";
              e.currentTarget.style.borderColor = "var(--c-line)";
              e.currentTarget.style.transform = "translateY(0)";
            }}
          >
            <span style={{ color: "var(--c-accent)", flexShrink: 0, marginTop: 1 }}>
              <Ic.sparkle />
            </span>
            <span className="flex-1">{s}</span>
            <span className="text-ink-4" style={{ flexShrink: 0 }}>
              <Ic.arrowR />
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function MessageRow({ message, sources }: { message: ChatMessage; sources?: ChatSource[] }) {
  const isUser = message.role === "user";
  return (
    <div className={`flex gap-2 mb-4 chat-message-in ${isUser ? "flex-row-reverse" : "flex-row"}`}>
      {!isUser && (
        <div
          className="rounded-full grid place-items-center text-white flex-shrink-0"
          style={{
            width: 26,
            height: 26,
            background: "var(--c-accent)",
            fontSize: 11,
            marginTop: 2,
          }}
          aria-hidden="true"
        >
          <Ic.sparkle />
        </div>
      )}
      <div className={`flex flex-col gap-1 ${isUser ? "items-end" : "items-start"}`} style={{ maxWidth: "82%" }}>
        <div
          className="rounded-2xl text-[13px] leading-relaxed"
          style={{
            padding: "9px 12px",
            background: isUser ? "var(--c-accent)" : "var(--c-panel)",
            color: isUser ? "white" : "var(--c-ink-1)",
            border: isUser ? "none" : "1px solid var(--c-line)",
            borderTopRightRadius: isUser ? 4 : undefined,
            borderTopLeftRadius: !isUser ? 4 : undefined,
            wordBreak: "break-word",
          }}
        >
          {isUser ? (
            <div className="whitespace-pre-wrap">{message.content}</div>
          ) : (
            <Markdown compact>{message.content}</Markdown>
          )}
        </div>
        {sources && sources.length > 0 && (
          <div className="flex flex-wrap gap-1" style={{ marginTop: 2 }}>
            {sources.map((s, i) => (
              <SourcePill key={i} source={s} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function SourcePill({ source }: { source: ChatSource }) {
  const inner = (
    <span
      className="inline-flex items-center gap-1 rounded-full transition-all"
      style={{
        padding: "2px 8px",
        background: "var(--c-accent-bg)",
        color: "var(--c-accent)",
        border: "1px solid var(--c-accent-line)",
        fontSize: 10.5,
        fontFamily: "var(--f-mono)",
      }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLSpanElement).style.transform = "translateY(-1px)"; }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLSpanElement).style.transform = "translateY(0)"; }}
    >
      <Ic.link />
      <span className="truncate" style={{ maxWidth: 160 }}>{source.tool} · {source.label}</span>
    </span>
  );

  if (!source.url) return inner;
  if (source.url.startsWith("/")) {
    return <Link href={source.url} className="no-underline">{inner}</Link>;
  }
  return <a href={source.url} className="no-underline" target="_blank" rel="noreferrer">{inner}</a>;
}

function TypingIndicator({ label }: { label: string }) {
  return (
    <div className="flex gap-2 mb-3 chat-message-in items-center">
      <div
        className="rounded-full grid place-items-center text-white flex-shrink-0"
        style={{ width: 26, height: 26, background: "var(--c-accent)" }}
        aria-hidden="true"
      >
        <Ic.sparkle />
      </div>
      <div
        className="rounded-2xl flex items-center gap-2"
        style={{
          padding: "10px 14px",
          background: "var(--c-panel)",
          border: "1px solid var(--c-line)",
          borderTopLeftRadius: 4,
        }}
      >
        <span className="flex gap-1">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="chat-typing-dot rounded-full"
              style={{
                width: 5,
                height: 5,
                background: "var(--c-accent)",
                display: "inline-block",
                animationDelay: `${i * 160}ms`,
              }}
            />
          ))}
        </span>
        <span className="text-[11px] text-ink-3">{label}</span>
      </div>
    </div>
  );
}
