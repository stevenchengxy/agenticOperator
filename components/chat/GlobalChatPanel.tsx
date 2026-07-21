"use client";
import React from "react";
import Link from "next/link";
import { useApp } from "@/lib/i18n";
import { useGlobalChat } from "@/lib/chat/use-global-chat";
import { usePageContext } from "@/lib/chat/page-context";
import { Markdown } from "@/components/shared/Markdown";
import { Ic } from "@/components/shared/Ic";
import type { CopilotRuntimeEvent } from "./copilot-types";
import type {
  ChatMessage,
  ChatSource,
  GlobalChatRequest,
  StreamEvent,
} from "@/lib/chat/types";
import type { GlobalChatController } from "@/lib/chat/use-global-chat";

export function GlobalChatPanel({
  scope = "bubble",
  onClose,
  chat: chatProp,
  draftPrompt,
  onDraftConsumed,
  onRuntimeEvent,
}: {
  scope?: "bubble" | "full";
  onClose?: () => void;
  chat?: GlobalChatController;
  draftPrompt?: string | null;
  onDraftConsumed?: () => void;
  onRuntimeEvent?: (event: CopilotRuntimeEvent) => void;
}) {
  const { t } = useApp();
  const suggestions = [
    t("chat_suggestion_1"),
    t("chat_suggestion_2"),
    t("chat_suggestion_3"),
    t("chat_suggestion_4"),
  ];
  const internalChat = useGlobalChat();
  const chat = chatProp ?? internalChat;
  const pageContext = usePageContext();
  const [input, setInput] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const [justSent, setJustSent] = React.useState(false);
  const [sourcesPerMessage, setSourcesPerMessage] = React.useState<Record<number, ChatSource[]>>({});
  const [activeTool, setActiveTool] = React.useState<{ name: string; startedAt: number } | null>(null);
  const scrollRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [chat.currentSession.messages.length, busy]);

  React.useEffect(() => {
    if (!draftPrompt) return;
    setInput(draftPrompt);
    onDraftConsumed?.();
  }, [draftPrompt, onDraftConsumed]);

  const send = React.useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || busy) return;
      const userMsg: ChatMessage = { role: "user", content: trimmed };
      const historyBeforeAppend = chat.currentSession.messages;
      const sessionId = chat.currentSession.id;
      chat.appendMessage(userMsg);
      onRuntimeEvent?.({ type: "prompt", sessionId, content: trimmed, at: new Date().toISOString() });
      setInput("");
      setBusy(true);
      setErr(null);
      setJustSent(true);
      setTimeout(() => setJustSent(false), 400);

      try {
        const reqBody: GlobalChatRequest = {
          sessionId,
          messages: [...historyBeforeAppend, userMsg],
          pageContext,
        };
        const res = await fetch("/api/chat/trace", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(reqBody),
        });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let assistantStarted = false;
        let assistantIdx = -1;
        let assistantText = "";
        let modelUsed: string | undefined;
        let toolCallsExecuted = 0;
        let collectedSources: ChatSource[] | null = null;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            const trimmedLine = line.trim();
            if (!trimmedLine.startsWith("data:")) continue;
            const payload = trimmedLine.slice(5).trim();
            if (!payload) continue;
            let evt: StreamEvent;
            try { evt = JSON.parse(payload) as StreamEvent; } catch { continue; }

            switch (evt.type) {
              case "text_chunk":
                if (!assistantStarted) {
                  assistantStarted = true;
                  assistantIdx = historyBeforeAppend.length + 1;
                  onRuntimeEvent?.({ type: "assistant_start", sessionId, at: new Date().toISOString() });
                }
                assistantText += evt.content;
                chat.appendToLastAssistant(evt.content);
                break;
              case "tool_call_start":
                onRuntimeEvent?.({
                  type: "tool_start",
                  sessionId,
                  at: new Date().toISOString(),
                  name: evt.name,
                  args: evt.args,
                });
                setActiveTool({ name: evt.name, startedAt: Date.now() });
                break;
              case "tool_call_done":
                onRuntimeEvent?.({
                  type: "tool_done",
                  sessionId,
                  at: new Date().toISOString(),
                  name: evt.name,
                  ms: evt.ms,
                  preview: evt.resultPreview,
                });
                setActiveTool(null);
                break;
              case "sources":
                collectedSources = evt.items;
                break;
              case "done":
                modelUsed = evt.modelUsed;
                toolCallsExecuted = evt.toolCallsExecuted;
                if (collectedSources && assistantIdx >= 0) {
                  setSourcesPerMessage((s) => ({ ...s, [assistantIdx]: collectedSources! }));
                }
                onRuntimeEvent?.({
                  type: "assistant_done",
                  sessionId,
                  at: new Date().toISOString(),
                  content: assistantText,
                  modelUsed,
                  toolCallsExecuted,
                  sources: collectedSources ?? undefined,
                });
                break;
              case "error":
                onRuntimeEvent?.({
                  type: "error",
                  sessionId,
                  at: new Date().toISOString(),
                  message: evt.message,
                });
                throw new Error(evt.message);
            }
          }
        }
      } catch (e) {
        onRuntimeEvent?.({
          type: "error",
          sessionId: chat.currentSession.id,
          at: new Date().toISOString(),
          message: (e as Error).message ?? t("chat_send_fail"),
        });
        setErr((e as Error).message ?? t("chat_send_fail"));
      } finally {
        setBusy(false);
        setActiveTool(null);
      }
    },
    [busy, chat, onRuntimeEvent, pageContext, t],
  );

  const messages = chat.currentSession.messages;
  const isFull = scope === "full";
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
    <div
      className={isFull ? "copilot-chat-panel" : "flex flex-col h-full"}
      style={{
        background: isFull
          ? "var(--c-bg)"
          : "linear-gradient(180deg, var(--c-surface) 0%, color-mix(in oklab, var(--c-surface) 92%, var(--c-accent) 8%) 100%)",
      }}
    >
      {/* Header */}
      {isFull ? (
        <div className="copilot-chat-topbar">
          <div className="min-w-0">
            <div className="copilot-chat-title">{chat.currentSession.title}</div>
            <div className="copilot-chat-subtitle">AO Copilot · tools, memory, review and evaluation</div>
          </div>
          {messages.length > 0 ? (
            <button
              type="button"
              onClick={chat.newSession}
              className="copilot-icon-button"
              title={t("chat_new_session")}
              aria-label={t("chat_new_session")}
            >
              <Ic.plus />
            </button>
          ) : null}
        </div>
      ) : (
        <div
          className="flex items-center gap-3 border-b border-line"
          style={{ padding: "12px 14px" }}
        >
          <div
            className="rounded-full grid place-items-center text-white"
            style={{
              width: 32,
              height: 32,
              background: "linear-gradient(135deg, var(--c-accent) 0%, var(--c-accent-2) 100%)",
              boxShadow: "0 2px 8px color-mix(in oklab, var(--c-accent) 28%, transparent)",
              flexShrink: 0,
            }}
          >
            <Ic.chat />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[13px] font-semibold text-ink-1 leading-tight">{t("chat_header_title")}</div>
            <div className="text-[10.5px] text-ink-3 leading-tight mt-0.5">{t("chat_header_subtitle")}</div>
          </div>
          <div className="flex items-center gap-0.5">
            {messages.length > 0 && (
              <button
                type="button"
                onClick={chat.newSession}
                className="rounded-md cursor-pointer transition-colors flex items-center justify-center"
                style={{
                  width: 28,
                  height: 28,
                  background: "transparent",
                  color: "var(--c-ink-3)",
                  border: "none",
                }}
                title={t("chat_new_session")}
                aria-label={t("chat_new_session")}
              >
                <Ic.plus />
              </button>
            )}
            {onClose && (
              <button
                type="button"
                onClick={onClose}
                className="rounded-md cursor-pointer transition-colors flex items-center justify-center"
                style={{
                  width: 28,
                  height: 28,
                  background: "transparent",
                  color: "var(--c-ink-3)",
                  border: "none",
                }}
                title={t("chat_close")}
                aria-label={t("chat_close")}
              >
                <Ic.cross />
              </button>
            )}
          </div>
        </div>
      )}

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
      <div
        ref={scrollRef}
        className={isFull ? "copilot-thread flex-1 overflow-auto" : "flex-1 overflow-auto"}
        style={{ padding: isFull ? "28px 0 18px" : "16px 14px" }}
      >
        {messages.length === 0 && <EmptyState suggestions={suggestions} onSelect={send} t={t} variant={scope} />}
        {messages.map((m, i) => (
          <MessageRow
            key={i}
            message={m}
            sources={sourcesPerMessage[i]}
            variant={scope}
            flyIn={i === messages.length - 1 && m.role === "user" && justSent}
            streaming={busy && i === messages.length - 1 && m.role === "assistant"}
          />
        ))}
        {busy && (
          activeTool ? (
            <ToolCallIndicator name={activeTool.name} t={t} />
          ) : !messages.some((m, i) => i === messages.length - 1 && m.role === "assistant") ? (
            <TypingIndicator label={t("chat_thinking")} />
          ) : null
        )}
        {err && (
          <div
            className="mt-3 rounded-lg flex items-start gap-2"
            style={{
              padding: "8px 10px",
              background: "var(--c-warn-bg)",
              border: "1px solid color-mix(in oklab, var(--c-warn) 35%, transparent)",
              color: "var(--c-warn)",
              fontSize: 11.5,
            }}
          >
            <Ic.alert />
            <span className="flex-1">{err}</span>
          </div>
        )}
      </div>

      {/* Input */}
      <div
        className={isFull ? "copilot-composer-wrap" : "border-t border-line bg-surface"}
        style={{ padding: isFull ? "14px 28px 22px" : "10px 12px" }}
      >
        <div
          className={`${isFull ? "copilot-composer" : "flex items-center gap-1 rounded-full"} ${justSent ? "chat-input-sending" : ""}`}
          style={{
            border: "1px solid var(--c-line)",
            background: isFull ? "var(--c-surface)" : "var(--c-panel)",
            padding: isFull ? "12px 12px 10px 16px" : "4px 4px 4px 14px",
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
          <textarea
            rows={1}
            className={isFull ? "copilot-composer-input" : "flex-1 bg-transparent outline-none text-[13px] text-ink-1 placeholder:text-ink-4"}
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
  variant = "bubble",
}: {
  suggestions: string[];
  onSelect: (s: string) => void;
  t: (k: string) => string;
  variant?: "bubble" | "full";
}) {
  if (variant === "full") {
    return (
      <div className="copilot-empty-state chat-message-in">
        <div className="copilot-empty-kicker">AO Copilot</div>
        <h1>今天处理什么？</h1>
        <div className="copilot-empty-prompts">
          {suggestions.map((s, i) => (
            <button
              key={s}
              type="button"
              onClick={() => onSelect(s)}
              className="copilot-empty-prompt"
              style={{ animationDelay: `${45 * i}ms` }}
            >
              <span>{s}</span>
              <Ic.arrowR />
            </button>
          ))}
        </div>
      </div>
    );
  }

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

function MessageRow({
  message,
  sources,
  variant = "bubble",
  flyIn,
  streaming,
}: {
  message: ChatMessage;
  sources?: ChatSource[];
  variant?: "bubble" | "full";
  flyIn?: boolean;
  streaming?: boolean;
}) {
  const isUser = message.role === "user";
  const isCompact = message.kind === "compact";
  const isFull = variant === "full";
  if (isCompact) {
    return (
      <div className="chat-message-in" style={{ margin: "6px auto 18px", maxWidth: isFull ? 860 : 620, padding: isFull ? "0 24px" : undefined }}>
        <div
          className={isFull ? "copilot-compact-note" : "rounded-lg"}
          style={{
            padding: "10px 12px",
            background: isFull ? undefined : "var(--c-panel)",
            border: isFull ? undefined : "1px dashed var(--c-line)",
            color: "var(--c-ink-2)",
            fontSize: 12,
            lineHeight: 1.55,
          }}
        >
          <div className="flex items-center gap-2 text-ink-1" style={{ fontWeight: 560, marginBottom: 5 }}>
            <Ic.book />
            <span>历史已压缩</span>
          </div>
          <Markdown compact>{message.content}</Markdown>
        </div>
      </div>
    );
  }
  if (isFull) {
    return (
      <div className={`copilot-message-row chat-message-in ${isUser ? "is-user" : "is-assistant"} ${flyIn ? "chat-send-fly" : ""}`}>
        {!isUser ? (
          <div className="copilot-message-meta">
            <span className="copilot-assistant-mark"><Ic.sparkle /></span>
            <span>AO Copilot</span>
          </div>
        ) : null}
        <div className={isUser ? "copilot-user-message" : "copilot-assistant-message"}>
          {isUser ? (
            <div className="whitespace-pre-wrap">{message.content}</div>
          ) : (
            <>
              <Markdown compact>{message.content}</Markdown>
              {streaming && <span className="chat-streaming-cursor" />}
            </>
          )}
        </div>
        {sources && sources.length > 0 && (
          <div style={{ marginTop: 8 }}>
            <SourcesList sources={sources} />
          </div>
        )}
      </div>
    );
  }
  return (
    <div className={`flex gap-2 mb-4 ${flyIn ? "chat-send-fly" : "chat-message-in"} ${isUser ? "flex-row-reverse" : "flex-row"}`}>
      {!isUser && (
        <div
          className="rounded-full grid place-items-center flex-shrink-0"
          style={{
            width: 28,
            height: 28,
            background: "linear-gradient(135deg, var(--c-accent) 0%, var(--c-accent-2) 100%)",
            color: "white",
            fontSize: 11,
            marginTop: 2,
            boxShadow: "0 2px 6px color-mix(in oklab, var(--c-accent) 22%, transparent)",
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
            <>
              <Markdown compact>{message.content}</Markdown>
              {streaming && <span className="chat-streaming-cursor" />}
            </>
          )}
        </div>
        {sources && sources.length > 0 && (
          <SourcesList sources={sources} />
        )}
      </div>
    </div>
  );
}

function SourcesList({ sources }: { sources: ChatSource[] }) {
  const { t } = useApp();
  const [expanded, setExpanded] = React.useState(false);
  const VISIBLE = 4;
  const visibleItems = expanded ? sources : sources.slice(0, VISIBLE);
  const hidden = sources.length - VISIBLE;
  return (
    <div className="flex flex-wrap gap-1" style={{ marginTop: 2 }}>
      {visibleItems.map((s, i) => (
        <SourcePill key={i} source={s} />
      ))}
      {!expanded && hidden > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="inline-flex items-center rounded-full cursor-pointer transition-colors"
          style={{
            padding: "2px 9px",
            background: "var(--c-panel)",
            color: "var(--c-ink-3)",
            border: "1px solid var(--c-line)",
            fontSize: 10.5,
            fontFamily: "var(--font-mono)",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "var(--c-accent-bg)";
            e.currentTarget.style.color = "var(--c-accent)";
            e.currentTarget.style.borderColor = "var(--c-accent-line)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "var(--c-panel)";
            e.currentTarget.style.color = "var(--c-ink-3)";
            e.currentTarget.style.borderColor = "var(--c-line)";
          }}
          title={t("chat_sources_expand_tip")}
        >
          {t("chat_sources_more").replace("{n}", String(hidden))}
        </button>
      )}
      {expanded && sources.length > VISIBLE && (
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="inline-flex items-center rounded-full cursor-pointer text-ink-3 hover:text-ink-1"
          style={{
            padding: "2px 9px",
            background: "transparent",
            border: "1px solid transparent",
            fontSize: 10.5,
          }}
        >
          {t("chat_sources_collapse")}
        </button>
      )}
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
        className="rounded-full grid place-items-center flex-shrink-0"
        style={{
          width: 28,
          height: 28,
          background: "linear-gradient(135deg, var(--c-accent) 0%, var(--c-accent-2) 100%)",
          color: "white",
        }}
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

function ToolCallIndicator({ name, t }: { name: string; t: (k: string) => string }) {
  return (
    <div className="flex gap-2 mb-3 items-center chat-message-in">
      <div
        className="rounded-full grid place-items-center text-white flex-shrink-0"
        style={{
          width: 28,
          height: 28,
          background: "linear-gradient(135deg, var(--c-accent) 0%, var(--c-accent-2) 100%)",
          fontSize: 11,
        }}
        aria-hidden="true"
      >
        <Ic.sparkle />
      </div>
      <div
        className="rounded-2xl flex items-center gap-2 chat-message-in"
        style={{
          padding: "8px 12px",
          background: "var(--c-accent-bg)",
          border: "1px solid var(--c-accent-line)",
          borderTopLeftRadius: 4,
          color: "var(--c-accent)",
          fontSize: 11.5,
        }}
      >
        <span className="flex gap-1">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="chat-typing-dot rounded-full"
              style={{
                width: 4,
                height: 4,
                background: "var(--c-accent)",
                display: "inline-block",
                animationDelay: `${i * 160}ms`,
              }}
            />
          ))}
        </span>
        <span className="mono">{t("chat_tool_running").replace("{name}", name)}</span>
      </div>
    </div>
  );
}
