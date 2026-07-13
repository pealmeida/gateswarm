/**
 * Remove credentials and common personal identifiers before local persistence.
 * The replacement text is deliberately stable so callers can still use the
 * resulting value for display and diagnostics without exposing the original.
 */
export function redactSensitive(text: string): string {
  return text
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_API_KEY]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED_EMAIL]')
    .replace(/\b(?:[A-Fa-f0-9]{32,}|[A-Za-z0-9+/_-]{32,}={0,2})\b/g, '[REDACTED_TOKEN]')
    .replace(/\d{9,}/g, '[REDACTED_NUMBER]');
}
