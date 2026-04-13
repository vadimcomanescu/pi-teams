const CODE_FENCE_RE = /^```[\w-]*$/;
const BRACE_ONLY_RE = /^[\[\]{}()]+$/;
const SEPARATOR_RE = /^[-=*_]{3,}$/;

const LOW_SIGNAL_TOKENS = new Set([
	"{}",
	"[]",
	"{",
	"}",
	"[",
	"]",
	"()",
	"```",
	"null",
	"undefined",
]);

export function isLowSignalSummaryLine(line: string): boolean {
	const trimmed = line.trim();
	if (!trimmed) return true;
	const lower = trimmed.toLowerCase();
	if (LOW_SIGNAL_TOKENS.has(lower)) return true;
	if (CODE_FENCE_RE.test(trimmed)) return true;
	if (BRACE_ONLY_RE.test(trimmed)) return true;
	if (SEPARATOR_RE.test(trimmed)) return true;
	return false;
}

export function summarizeMeaningfulLine(text: string | undefined, maxLength: number): string | undefined {
	if (!text) return undefined;
	const normalized = text.replace(/\s+/g, " ").trim();
	if (!normalized || isLowSignalSummaryLine(normalized)) return undefined;
	return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

export function summarizeMeaningfulRecentOutput(lines: string[] | undefined, maxLength: number): string | undefined {
	if (!lines || lines.length === 0) return undefined;
	for (let index = lines.length - 1; index >= 0; index--) {
		const summarized = summarizeMeaningfulLine(lines[index], maxLength);
		if (summarized) return summarized;
	}
	return undefined;
}
