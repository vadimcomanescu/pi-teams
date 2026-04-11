const FUN_ADJECTIVES = [
	"nimble",
	"sparkly",
	"cosmic",
	"curious",
	"zesty",
	"plucky",
	"brisk",
	"witty",
	"fuzzy",
	"snappy",
] as const;

const FUN_NOUNS = [
	"otter",
	"falcon",
	"panda",
	"gecko",
	"badger",
	"lemur",
	"yak",
	"ferret",
	"orca",
	"raccoon",
] as const;

const GENERIC_AGENT_LABELS = new Set(["worker", "raw-worker", "unknown"]);

function fnv1aHash(input: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < input.length; i++) {
		hash ^= input.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
}

export function createFunAgentAlias(seed: string): string {
	const hash = fnv1aHash(seed);
	const adjective = FUN_ADJECTIVES[hash % FUN_ADJECTIVES.length] ?? "nimble";
	const noun = FUN_NOUNS[Math.floor(hash / FUN_ADJECTIVES.length) % FUN_NOUNS.length] ?? "otter";
	return `${adjective}-${noun}`;
}

export function getAgentDisplayName(input: {
	id?: string | null;
	agent?: string | null;
	name?: string;
}): string {
	const explicitName = input.name?.trim();
	if (explicitName) return explicitName;

	const agent = input.agent?.trim();
	if (agent && !GENERIC_AGENT_LABELS.has(agent.toLowerCase())) {
		return agent;
	}

	if (input.id) {
		return createFunAgentAlias(input.id);
	}

	return agent || "unknown";
}
