"use client";

import React from "react";
import { GlobalChatPanel } from "./GlobalChatPanel";
import { useGlobalChat, type ChatSession, type GlobalChatController } from "@/lib/chat/use-global-chat";
import { usePageContext } from "@/lib/chat/page-context";
import { Ic } from "@/components/shared/Ic";
import { buildAgentLoopSnapshot, eventTitle } from "@/lib/chat/agent-loop";
import type { ChatMessage, PageContext } from "@/lib/chat/types";
import type { CopilotRuntimeEvent } from "@/lib/chat/agent-loop";

type SidebarMode = "sessions" | "search" | "routines" | "context";

const COPILOT_ROUTINES = [
  {
    title: "失败 run 诊断",
    detail: "按 agent / 根因 / 恢复建议归类",
    prompt: "请帮我找出最近 24 小时失败的 runs，并按 agent、根因和可恢复性归类。",
    icon: <Ic.alert />,
  },
  {
    title: "规则检查复盘",
    detail: "rule-check audit / fail-closed / 人工复核",
    prompt: "请分析最近一周规则检查失败的 audit，找出高频失败规则、信息不足原因和需要人工复核的候选人。",
    icon: <Ic.shield />,
  },
  {
    title: "事件链追踪",
    detail: "event → workflow → agent → output",
    prompt: "请追踪最近触发 MATCH_FAILED 的事件链，说明上游事件、工作流节点、失败 agent 和可操作下一步。",
    icon: <Ic.branch />,
  },
  {
    title: "运行健康摘要",
    detail: "队列、DLQ、慢 run、异常趋势",
    prompt: "请生成当前 Agentic Operator 运行健康摘要，覆盖队列、DLQ、慢 run、异常趋势和建议处理顺序。",
    icon: <Ic.pulse />,
  },
] as const;

export function GlobalChatFullContent() {
  const chat = useGlobalChat();
  const pageContext = usePageContext();
  const [events, setEvents] = React.useState<CopilotRuntimeEvent[]>([]);
  const [compacting, setCompacting] = React.useState(false);
  const [leftCollapsed, setLeftCollapsed] = usePersistentBoolean("ao:copilot:left-collapsed", false);
  const [rightCollapsed, setRightCollapsed] = usePersistentBoolean("ao:copilot:right-collapsed", false);
  const [sidebarMode, setSidebarMode] = React.useState<SidebarMode>("sessions");
  const [draftPrompt, setDraftPrompt] = React.useState<string | null>(null);

  const onRuntimeEvent = React.useCallback((event: CopilotRuntimeEvent) => {
    setEvents((prev) => [...prev, event].slice(-160));
  }, []);

  const consumeDraft = React.useCallback(() => setDraftPrompt(null), []);

  const compactCurrent = React.useCallback(async () => {
    if (compacting || chat.currentSession.messages.length <= 8) return;
    setCompacting(true);
    try {
      const res = await fetch("/api/chat/compact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: chat.currentSession.id,
          messages: chat.currentSession.messages,
          pageContext,
        }),
      });
      const body = (await res.json()) as { summary?: string; removedMessages?: number };
      const summary = body.summary || fallbackCompactSummary(chat.currentSession.messages);
      const removedMessages = body.removedMessages ?? Math.max(0, chat.currentSession.messages.length - 8);
      chat.compactCurrent(summary);
      onRuntimeEvent({
        type: "compact",
        sessionId: chat.currentSession.id,
        at: new Date().toISOString(),
        summary,
        removedMessages,
      });
    } finally {
      setCompacting(false);
    }
  }, [chat, compacting, onRuntimeEvent, pageContext]);

  return (
    <div
      className={[
        "copilot-desktop h-full min-w-0 overflow-hidden",
        leftCollapsed ? "is-left-collapsed" : "",
        rightCollapsed ? "is-right-collapsed" : "",
      ].filter(Boolean).join(" ")}
    >
      <CopilotSidebar
        chat={chat}
        compacting={compacting}
        collapsed={leftCollapsed}
        mode={sidebarMode}
        pageContext={pageContext}
        onCompact={compactCurrent}
        onModeChange={setSidebarMode}
        onToggleCollapsed={() => setLeftCollapsed((v) => !v)}
        onUsePrompt={setDraftPrompt}
      />
      <main className="copilot-main min-w-0">
        <GlobalChatPanel
          scope="full"
          chat={chat}
          draftPrompt={draftPrompt}
          onDraftConsumed={consumeDraft}
          onRuntimeEvent={onRuntimeEvent}
        />
      </main>
      <CopilotInspector
        collapsed={rightCollapsed}
        events={events}
        messages={chat.currentSession.messages}
        onToggleCollapsed={() => setRightCollapsed((v) => !v)}
      />
    </div>
  );
}

function usePersistentBoolean(key: string, initial: boolean) {
  const [value, setValue] = React.useState(initial);

  React.useEffect(() => {
    try {
      const raw = window.localStorage.getItem(key);
      if (raw === "1") setValue(true);
      if (raw === "0") setValue(false);
    } catch {
      // localStorage can be disabled; the UI still works with in-memory state.
    }
  }, [key]);

  React.useEffect(() => {
    try {
      window.localStorage.setItem(key, value ? "1" : "0");
    } catch {
      // ignore persistence failures
    }
  }, [key, value]);

  return [value, setValue] as const;
}

function CopilotSidebar({
  chat,
  compacting,
  collapsed,
  mode,
  pageContext,
  onCompact,
  onModeChange,
  onToggleCollapsed,
  onUsePrompt,
}: {
  chat: GlobalChatController;
  compacting: boolean;
  collapsed: boolean;
  mode: SidebarMode;
  pageContext: PageContext;
  onCompact: () => void;
  onModeChange: (mode: SidebarMode) => void;
  onToggleCollapsed: () => void;
  onUsePrompt: (prompt: string) => void;
}) {
  const canCompact = chat.currentSession.messages.length > 8;
  const [query, setQuery] = React.useState("");
  const sessions = chat.sessions.slice(0, 16);
  const allSessions = [chat.currentSession, ...sessions.filter((session) => session.id !== chat.currentSession.id)];
  const filteredSessions = allSessions.filter((session) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return session.title.toLowerCase().includes(q) || session.messages.some((m) => m.content.toLowerCase().includes(q));
  });
  return (
    <aside className={`copilot-sidebar ${collapsed ? "is-collapsed" : ""}`}>
      <div className="copilot-feature-mark">
        <span><Ic.chat /></span>
        <strong>AO Copilot</strong>
        <button
          type="button"
          className="copilot-pane-toggle"
          onClick={onToggleCollapsed}
          title={collapsed ? "展开会话栏" : "收起会话栏"}
          aria-label={collapsed ? "展开会话栏" : "收起会话栏"}
        >
          <Ic.chev />
        </button>
      </div>

      <div className="copilot-side-nav">
        <SideAction icon={<Ic.edit />} label="新对话" onClick={chat.newSession} />
        <SideAction icon={<Ic.chat />} label="会话" active={mode === "sessions"} onClick={() => onModeChange("sessions")} />
        <SideAction icon={<Ic.search />} label="搜索" active={mode === "search"} onClick={() => onModeChange("search")} />
        <SideAction icon={<Ic.bolt />} label="Routines" active={mode === "routines"} onClick={() => onModeChange("routines")} />
        <SideAction icon={<Ic.book />} label="上下文" active={mode === "context"} onClick={() => onModeChange("context")} />
      </div>

      <div className="copilot-sidebar-body">
        {mode === "sessions" && (
          <>
            <ProjectBlock />
            <SessionList
              currentId={chat.currentSession.id}
              sessions={allSessions}
              onSwitch={chat.switchSession}
            />
          </>
        )}

        {mode === "search" && (
          <div className="copilot-side-section flex-1 min-h-0">
            <div className="copilot-section-title">Search sessions</div>
            <label className="copilot-search-box">
              <Ic.search />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索标题 / 对话内容"
              />
            </label>
            <div className="copilot-session-list">
              {filteredSessions.map((session) => (
                <SessionRow
                  key={session.id}
                  session={session}
                  active={session.id === chat.currentSession.id}
                  subtitle={session.id === chat.currentSession.id ? `${session.messages.length} messages` : formatRelative(session.updatedAt)}
                  onClick={() => chat.switchSession(session.id)}
                />
              ))}
              {filteredSessions.length === 0 ? <div className="copilot-empty-note px-3 py-2">没有匹配的会话。</div> : null}
            </div>
          </div>
        )}

        {mode === "routines" && (
          <div className="copilot-side-section flex-1 min-h-0">
            <div className="copilot-section-title">Routines</div>
            <div className="copilot-routine-list">
              {COPILOT_ROUTINES.map((routine) => (
                <button
                  key={routine.title}
                  type="button"
                  className="copilot-routine-card"
                  onClick={() => onUsePrompt(routine.prompt)}
                >
                  <span className="copilot-routine-icon">{routine.icon}</span>
                  <span className="min-w-0">
                    <strong>{routine.title}</strong>
                    <small>{routine.detail}</small>
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        {mode === "context" && (
          <div className="copilot-side-section flex-1 min-h-0">
            <div className="copilot-section-title">Context harness</div>
            <div className="copilot-context-card">
              <span>Route</span>
              <strong>{pageContext.route || "/"}</strong>
            </div>
            {contextRows(pageContext).map((row) => (
              <div key={row.label} className="copilot-context-card">
                <span>{row.label}</span>
                <strong>{row.value}</strong>
              </div>
            ))}
            <button
              type="button"
              className="copilot-context-action"
              onClick={() => onUsePrompt("请基于当前页面上下文，解释这里最值得关注的 run、event 或 audit 风险。")}
            >
              <Ic.sparkle />
              <span>基于当前页面提问</span>
            </button>
          </div>
        )}
      </div>

      <div className="copilot-sidebar-footer">
        <button type="button" className="copilot-quiet-action" onClick={onCompact} disabled={!canCompact || compacting}>
          <Ic.book />
          <span>{compacting ? "Compacting" : "Compact memory"}</span>
        </button>
        <button type="button" className="copilot-user-pill">
          <span>YC</span>
          <strong>yuhan cheng</strong>
        </button>
      </div>
    </aside>
  );
}

function ProjectBlock() {
  return (
    <div className="copilot-side-section">
      <div className="copilot-section-title">Project</div>
      <div className="copilot-project-row">
        <Ic.book />
        <span>agenticOperator</span>
      </div>
    </div>
  );
}

function SessionList({
  currentId,
  sessions,
  onSwitch,
}: {
  currentId: string;
  sessions: ChatSession[];
  onSwitch: (id: string) => void;
}) {
  return (
    <div className="copilot-side-section flex-1 min-h-0">
      <div className="copilot-section-title">Recents</div>
      <div className="copilot-session-list">
        {sessions.map((session) => (
          <SessionRow
            key={session.id}
            session={session}
            active={session.id === currentId}
            subtitle={session.id === currentId ? `${session.messages.length} messages` : formatRelative(session.updatedAt)}
            onClick={() => session.id !== currentId && onSwitch(session.id)}
          />
        ))}
      </div>
    </div>
  );
}

function SideAction({ icon, label, active, onClick }: { icon: React.ReactNode; label: string; active?: boolean; onClick?: () => void }) {
  return (
    <button type="button" className={`copilot-side-action ${active ? "is-active" : ""}`} onClick={onClick}>
      {icon}
      <span>{label}</span>
    </button>
  );
}

function SessionRow({
  session,
  subtitle,
  active,
  onClick,
}: {
  session: ChatSession;
  subtitle: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" className={`copilot-session-row ${active ? "is-active" : ""}`} onClick={onClick}>
      <span className="copilot-session-dot" />
      <span className="min-w-0 flex-1">
        <span className="copilot-session-title">{session.title}</span>
        <span className="copilot-session-subtitle">{subtitle}</span>
      </span>
    </button>
  );
}

function contextRows(pageContext: PageContext): Array<{ label: string; value: string }> {
  return [
    pageContext.runId ? { label: "Run", value: pageContext.runId } : null,
    pageContext.auditId ? { label: "Audit", value: pageContext.auditId } : null,
    pageContext.entityType && pageContext.entityId ? { label: pageContext.entityType, value: pageContext.entityId } : null,
    pageContext.agentShort ? { label: "Agent", value: pageContext.agentShort } : null,
  ].filter((row): row is { label: string; value: string } => Boolean(row));
}

function CopilotInspector({
  collapsed,
  events,
  messages,
  onToggleCollapsed,
}: {
  collapsed: boolean;
  events: CopilotRuntimeEvent[];
  messages: ChatMessage[];
  onToggleCollapsed: () => void;
}) {
  const snapshot = React.useMemo(() => buildAgentLoopSnapshot(events, messages), [events, messages]);
  const { running, skills, toolRuns } = snapshot;
  return (
    <aside className={`copilot-inspector ${collapsed ? "is-collapsed" : ""}`}>
      <div className="copilot-inspector-header">
        <div>
          <div className="copilot-inspector-title">Agent trace</div>
          <div className="copilot-inspector-subtitle">{running ? "Loop running" : "Background reasoning · visible summary"}</div>
        </div>
        <button
          type="button"
          className="copilot-pane-toggle"
          onClick={onToggleCollapsed}
          title={collapsed ? "展开推理栏" : "收起推理栏"}
          aria-label={collapsed ? "展开推理栏" : "收起推理栏"}
        >
          <Ic.chev />
        </button>
      </div>
      <div className="copilot-rail-label">
        <span className="copilot-status-dot" style={{ color: running ? "var(--c-warn)" : "var(--c-ink-4)", background: running ? "var(--c-warn)" : "var(--c-ink-4)" }} />
        <span>Trace</span>
      </div>

      <div className="copilot-inspector-scroll">
        <section className="copilot-inspector-summary">
          <span className="copilot-status-dot" style={{ color: running ? "var(--c-warn)" : "var(--c-ok)", background: running ? "var(--c-warn)" : "var(--c-ok)" }} />
          <div>
            <strong>{running ? "正在执行 agent loop" : "等待下一次指令"}</strong>
            <span>{snapshot.next}</span>
          </div>
        </section>

        <SoftCard title="Current task" meta="harness">
          <TaskLine dot="dark" title="Goal" detail={snapshot.goal} />
          <TaskLine dot="muted" title="Context" detail={snapshot.context} />
        </SoftCard>

        <SoftCard title="Reasoning path" meta={snapshot.reasoningSteps.at(-1)?.status ?? "idle"}>
          <div className="copilot-reasoning-list">
            {snapshot.reasoningSteps.map((row, index) => (
              <ReasoningStep key={row.id} index={index + 1} title={row.title} detail={row.detail} status={row.status} />
            ))}
          </div>
        </SoftCard>

        <SoftCard title="Tools & evidence" meta={toolRuns.length ? `${toolRuns.length} runs` : "no tools"}>
          {toolRuns.length === 0 ? (
            <div className="copilot-empty-note">如果问题需要查 run、event、audit 或 entity，工具调用会在这里实时出现。</div>
          ) : (
            <div className="copilot-tool-list">
              {toolRuns.map((run) => (
                <div key={run.id} className="copilot-tool-row">
                  <span className={`copilot-task-dot ${run.done ? "is-ok" : "is-warn"}`} />
                  <div className="min-w-0">
                    <strong>{run.name}</strong>
                    <span>{run.done ? `${run.done.ms}ms · ${run.done.preview ?? "done"}` : "running"}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </SoftCard>

        <SoftCard title="Skills" meta={`${skills.length}`}>
          <div className="flex flex-col gap-2">
            {skills.map((skill) => (
              <TaskLine key={skill.title} dot={skill.generated ? "ok" : "muted"} title={skill.title} detail={skill.detail} />
            ))}
          </div>
        </SoftCard>

        <SoftCard title="Logs" meta={`${messages.filter((m) => m.role === "user").length} prompts`}>
          <div className="copilot-empty-note">
            每次 user prompt、assistant reply 和 compact 操作都会写入 ChatbotSession 与 AgentActivity。
          </div>
          <div className="copilot-log-stack">
            {[...events].reverse().slice(0, 10).map((event, i) => (
              <div key={`${event.type}-${event.at}-${i}`} className="copilot-log-row">
                <span>{new Date(event.at).toLocaleTimeString()}</span>
                <strong>{eventTitle(event)}</strong>
              </div>
            ))}
          </div>
        </SoftCard>

        <SoftCard title="Review" meta={snapshot.evaluation.state.replace("_", " ")}>
          <ScoreLine label="Completeness" score={snapshot.evaluation.completeness} />
          <ScoreLine label="Groundedness" score={snapshot.evaluation.groundedness} />
          <ScoreLine label="Loop control" score={snapshot.evaluation.loopControl} />
        </SoftCard>
      </div>
    </aside>
  );
}

function SoftCard({ title, meta, children }: { title: string; meta?: string; children: React.ReactNode }) {
  return (
    <section className="copilot-soft-card">
      <div className="copilot-soft-card-head">
        <h3>{title}</h3>
        {meta ? <span>{meta}</span> : null}
      </div>
      {children}
    </section>
  );
}

function TaskLine({ dot, title, detail }: { dot: "dark" | "muted" | "ok" | "warn" | "err"; title: string; detail: string }) {
  return (
    <div className="copilot-task-line">
      <span className={`copilot-task-dot is-${dot}`} />
      <div className="min-w-0">
        <div className="copilot-task-title">{title}</div>
        <div className="copilot-task-detail">{detail}</div>
      </div>
    </div>
  );
}

function ReasoningStep({
  index,
  title,
  detail,
  status,
}: {
  index: number;
  title: string;
  detail: string;
  status: "idle" | "running" | "done" | "failed";
}) {
  return (
    <div className={`copilot-reasoning-step is-${status}`}>
      <span className="copilot-step-index">{index}</span>
      <div className="min-w-0">
        <div className="copilot-task-title">{title}</div>
        <div className="copilot-task-detail">{detail}</div>
      </div>
    </div>
  );
}

function ScoreLine({ label, score }: { label: string; score: number }) {
  return (
    <div className="copilot-score-line">
      <div>
        <span>{label}</span>
        <strong>{score}/100</strong>
      </div>
      <div className="copilot-scorebar"><span style={{ width: `${score}%` }} /></div>
    </div>
  );
}

function fallbackCompactSummary(messages: ChatMessage[]): string {
  const prompts = messages.filter((m) => m.role === "user").slice(-6).map((m) => m.content);
  return `【已压缩的历史上下文】\n用户近期目标: ${prompts.join(" / ")}\n后续回答应延续这些上下文，并在需要事实时继续调用工具核验。`;
}

function formatRelative(iso: string): string {
  const diffMin = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH}h ago`;
  return `${Math.floor(diffH / 24)}d ago`;
}
