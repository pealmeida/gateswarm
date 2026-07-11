export interface RubricInput {
  status: number;
  content: string;
  reasoning: string;
  timedOut?: boolean;
}

export function isProviderErrorContent(content: string): boolean {
  const text = content.replace(/\s+/g, ' ').trim();
  if (!text || text.length > 500) return false;

  const authError =
    /failed to authenticate/i.test(text) ||
    /invalid authentication credentials/i.test(text) ||
    /invalid api key/i.test(text) ||
    /\bunauthori[sz]ed\b/i.test(text) ||
    /authentication failed/i.test(text);
  if (!authError) return false;

  return (
    /^failed to authenticate\.?\s*api error:\s*\d+\s+invalid authentication credentials\.?$/i.test(text) ||
    /api error:\s*(401|403)\b/i.test(text) ||
    /^error:?\s*(invalid api key|unauthori[sz]ed|authentication failed)/i.test(text) ||
    (/failed to authenticate/i.test(text) && /(api error|credentials|api key)/i.test(text))
  );
}

export function rubricHardFail(input: RubricInput): { fail: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (input.timedOut) reasons.push('timeout');
  if (input.status !== 200) reasons.push(`http_${input.status}`);
  const content = (input.content || '').trim();
  const text = `${input.content || ''}${input.reasoning || ''}`.trim();
  if (!content) reasons.push('empty_content');
  if (!text) reasons.push('empty_body');
  if (isProviderErrorContent(content)) reasons.push('provider_error');
  const refusal = /i can'?t help with|i'?m unable to assist|against my guidelines/i.test(text);
  if (refusal) reasons.push('refusal');
  return { fail: reasons.length > 0, reasons };
}
