"use client";

// OpenPrDialog — helper modal for shipping a codegen-saved AgentVersion
// to production.
//
// AO does NOT push from the server (see memory: pushes go to kenny/steven
// remotes only, never main, never auto). This dialog produces:
//   1. the exact file path the codeBlob should land at
//   2. a code preview (collapsible)
//   3. a single copy-able block of shell commands the operator runs locally
//
// Operator copies the block, pastes into their terminal in the AO repo
// root, runs it. The commands check out a fresh branch, write the file,
// commit, push to a configurable remote, and open a PR via gh.

import React from "react";
import type { AgentVersionRow } from "@/lib/agent-versions/types";
import { useApp } from "@/lib/i18n";

export function OpenPrDialog({
  version,
  onClose,
}: {
  version: AgentVersionRow;
  onClose: () => void;
}) {
  const { t } = useApp();
  const [previewOpen, setPreviewOpen] = React.useState(false);
  const [copied, setCopied] = React.useState(false);

  if (!version.codeBlob || version.capturedFrom !== "codegen") {
    return (
      <Backdrop onClose={onClose}>
        <div className="text-[12.5px] text-ink-2 p-6">
          {t("pr_not_codegen_version")}
        </div>
      </Backdrop>
    );
  }

  const filePath = `server/inngest/agents/${version.slug}.ts`;
  const branchName = `codegen/${version.slug}-${version.versionLabel}`;
  const commitMessage = `feat(codegen): regen ${version.slug} from AO codegen ${version.versionLabel}\n\nGenerated via AO Codegen on ${new Date(version.createdAt).toISOString().slice(0, 10)}.\nReplaces hand-written agent body; operator-reviewed via Save-as-Version + Evaluation gate.`;

  const commands = buildCommands({ filePath, branchName, commitMessage, version });

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(commands);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard may not be available — fall back to manual select
    }
  };

  return (
    <Backdrop onClose={onClose}>
      <div
        className="rounded-lg border border-line bg-surface flex flex-col"
        style={{
          width: "min(880px, 92vw)",
          maxHeight: "82vh",
          boxShadow: "0 20px 60px rgba(0,0,0,0.18)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <header className="flex items-center gap-3 px-5 py-4 border-b border-line">
          <div className="flex-1 min-w-0">
            <div
              className="text-ink-1"
              style={{
                fontFamily:
                  'ui-serif, Charter, "Iowan Old Style", Palatino, "Times New Roman", serif',
                fontWeight: 500,
                fontSize: 20,
                letterSpacing: "-0.01em",
              }}
            >
              {t("pr_title")}
            </div>
            <div className="text-[11.5px] text-ink-4 mt-1">
              {version.short} · {version.versionLabel}
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-7 h-7 rounded-md grid place-items-center cursor-pointer border-0 bg-transparent text-ink-3 hover:text-ink-1 hover:bg-panel"
            title="close"
          >
            ×
          </button>
        </header>

        {/* Scrollable body */}
        <div className="overflow-auto p-5 flex flex-col gap-5 flex-1 min-h-0">
          {/* File path */}
          <Section title={t("pr_section_file")}>
            <code
              className="text-[12px] mono px-2 py-1.5 rounded border border-line bg-panel text-ink-1 inline-block"
              style={{ wordBreak: "break-all" }}
            >
              {filePath}
            </code>
            <p className="text-[11px] text-ink-4 m-0 mt-2 leading-relaxed">
              {t("pr_file_warning")}
            </p>
          </Section>

          {/* Code preview */}
          <Section title={t("pr_section_preview")}>
            <button
              onClick={() => setPreviewOpen((o) => !o)}
              className="text-[11.5px] text-ink-3 cursor-pointer border-0 bg-transparent inline-flex items-center gap-1.5 mb-2 hover:text-ink-1"
            >
              <span className="mono text-[10px]">{previewOpen ? "▼" : "▶"}</span>
              {previewOpen ? t("pr_preview_hide") : t("pr_preview_show")}
              <span className="text-ink-4">
                · {version.codeBlob.split("\n").length} lines
              </span>
            </button>
            {previewOpen && (
              <pre
                className="m-0 p-3 rounded border border-line bg-panel text-[11px] leading-[1.5] mono overflow-auto"
                style={{ maxHeight: 280 }}
              >
                {version.codeBlob}
              </pre>
            )}
          </Section>

          {/* Commands */}
          <Section
            title={t("pr_section_commands")}
            action={
              <button
                onClick={copy}
                className="h-7 px-3 rounded-md text-[11px] font-medium border-0 cursor-pointer"
                style={{
                  background: copied ? "var(--c-ok)" : "var(--c-accent)",
                  color: "white",
                }}
              >
                {copied ? t("pr_copied") : t("pr_copy")}
              </button>
            }
          >
            <pre
              className="m-0 p-3 rounded border border-line bg-panel text-[11px] leading-[1.55] mono overflow-auto"
              style={{ maxHeight: 360, whiteSpace: "pre" }}
            >
              {commands}
            </pre>
            <p className="text-[10.5px] text-ink-4 m-0 mt-2 leading-relaxed">
              {t("pr_commands_note")}
            </p>
          </Section>
        </div>

        {/* Footer */}
        <footer className="px-5 py-3 border-t border-line flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            className="h-8 px-4 rounded-md text-[12px] font-medium border-0 cursor-pointer bg-panel text-ink-2 hover:bg-surface"
          >
            {t("pr_done")}
          </button>
        </footer>
      </div>
    </Backdrop>
  );
}

// ────────────────────────────────────────────────────────────────────────

function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <header className="flex items-center justify-between gap-3">
        <span className="text-[10px] uppercase tracking-[0.08em] text-ink-4 font-medium">
          {title}
        </span>
        {action}
      </header>
      <div>{children}</div>
    </section>
  );
}

function Backdrop({
  children,
  onClose,
}: {
  children: React.ReactNode;
  onClose: () => void;
}) {
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.45)" }}
      onClick={onClose}
    >
      {children}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Command builder
// ────────────────────────────────────────────────────────────────────────

function buildCommands({
  filePath,
  branchName,
  commitMessage,
  version,
}: {
  filePath: string;
  branchName: string;
  commitMessage: string;
  version: AgentVersionRow;
}): string {
  // We use a heredoc to write the codeBlob safely (no escaping landmines).
  // Pushing target is left as `<remote>` so the operator chooses (kenny/steven/etc.)
  // per AO convention; never default to origin/main.
  return [
    `# 1. Branch off main`,
    `git checkout main && git pull --ff-only`,
    `git checkout -b ${branchName}`,
    ``,
    `# 2. Write codegen output to the agent file`,
    `cat > ${filePath} <<'CODEGEN_END_OF_FILE'`,
    version.codeBlob ?? '',
    `CODEGEN_END_OF_FILE`,
    ``,
    `# 3. Commit with pathspec so unrelated changes don't get swept in`,
    `git add ${filePath}`,
    `git commit -m ${quoteShell(commitMessage)} -- ${filePath}`,
    ``,
    `# 4. Push to YOUR review remote (replace <remote> with kenny / steven / your-fork)`,
    `git push <remote> ${branchName}`,
    ``,
    `# 5. Open the PR (gh CLI; replace <remote-org/repo> with the right slug)`,
    `gh pr create \\`,
    `  --base main \\`,
    `  --head <remote>:${branchName} \\`,
    `  --title ${quoteShell(`feat(codegen): regen ${version.slug} from AO codegen`)} \\`,
    `  --body ${quoteShell(`Generated via AO Codegen + Evaluation gate (version ${version.versionLabel}).\\n\\nReplaces hand-written agent body. Operator already passed structural + behavioral evaluation on the version row before opening this PR.`)}`,
  ].join('\n');
}

function quoteShell(s: string): string {
  // Single-quote with embedded single-quote escape for POSIX shell.
  return `'${s.replace(/'/g, "'\\''")}'`;
}
