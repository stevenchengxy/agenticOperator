// Public types for /api/agents/[short]/versions and the VersionsTab UI.
// AgentVersion DB row → AgentVersionRow (serialized over JSON).

export type AgentConfigSnapshot = {
  enabled: boolean;
  temperature: number | null;
  maxRetries: number | null;
  tier: string | null;
  maxOutputTokens: number | null;
  promptAppend: string | null;
  skillOverrides: string | null;
  description: string | null;
};

export type AgentVersionRow = {
  id: string;
  short: string;
  slug: string;
  versionLabel: string;
  status: 'draft' | 'active' | 'archived';
  configJson: AgentConfigSnapshot | null;
  configHash: string | null;
  capturedFrom: string | null;
  notes: string | null;
  generatedBy: string;
  createdAt: string;
  deployedAt: string | null;
};

export type VersionsListResponse = {
  versions: AgentVersionRow[];
  activeVersionId: string | null;
  meta: { generatedAt: string };
};

export type CaptureVersionRequest = {
  versionLabel?: string; // optional override; else auto-generated
  notes?: string;
  /**
   * Optional codegen payload. When present, the version row carries the
   * generated artifacts (code / spec / prompt) and is marked
   * capturedFrom='codegen'. When absent, the route snapshots the current
   * AgentConfig as before (capturedFrom='current-config').
   */
  codegen?: {
    codeBlob: string;
    specJson: string;
    promptText: string;
    modelUsed: string;
  };
};

export type CaptureVersionResponse =
  | {
      ok: true;
      version: AgentVersionRow;
    }
  | {
      ok: false;
      error: 'CONFLICT' | 'NO_CONFIG' | 'AGENT_NOT_FOUND' | 'INTERNAL';
      message: string;
    };

export type DeployVersionResponse =
  | {
      ok: true;
      version: AgentVersionRow;
      previousActiveId: string | null;
    }
  | {
      ok: false;
      error: 'NOT_FOUND' | 'AGENT_NOT_FOUND' | 'INTERNAL';
      message: string;
    };
