import React from "react";

// Wrap the entire /behavior subtree so all child pages inherit the Claude
// token group. The data-style attribute is the only way our scoped CSS
// rules in globals.css activate.
export default function BehaviorLayout({ children }: { children: React.ReactNode }) {
  return <div data-style="claude" className="min-h-full">{children}</div>;
}
