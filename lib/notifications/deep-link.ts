export function notificationHref(linkKind: string | null, linkId: string | null): string | null {
  if (!linkId) return null;
  switch (linkKind) {
    case 'rule_check':
      return `/rule-check/audits/${encodeURIComponent(linkId)}?focus=${encodeURIComponent(`rule:${linkId}`)}`;
    case 'run':
      return /^[0-9A-HJKMNP-TV-Z]{26}$/.test(linkId)
        ? `/monitor?run=${encodeURIComponent(linkId)}&focus=${encodeURIComponent(`run:${linkId}`)}`
        : `/monitor/runs/${encodeURIComponent(linkId)}?focus=${encodeURIComponent(`run:${linkId}`)}`;
    case 'trace':
      return `/correlations/${encodeURIComponent(linkId)}?focus=${encodeURIComponent(`trace:${linkId}`)}`;
    case 'event':
      return `/events/instances/${encodeURIComponent(linkId)}?focus=${encodeURIComponent(`event:${linkId}`)}`;
    case 'infra':
      return `/monitor?infra=${encodeURIComponent(linkId)}&focus=${encodeURIComponent(`infra:${linkId}`)}`;
    default:
      return null;
  }
}

