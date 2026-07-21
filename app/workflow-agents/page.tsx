// /workflow-agents — kept as deep-link compatibility; redirects to unified /monitor?tab=agents.
//
// The standalone page was merged into /monitor as a tab. Anyone hitting this URL
// from a bookmark or external link gets sent to the new location automatically.

import { redirect } from 'next/navigation';

export default function Page() {
  redirect('/monitor?tab=agents');
}
