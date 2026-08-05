import { renameSync, writeFileSync } from "node:fs";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const provenance = Type.Union([
	Type.Object(
		{
			kind: Type.Literal("file"),
			path: Type.String({ minLength: 1 }),
			format: Type.Optional(Type.String({ minLength: 1 })),
			message_index: Type.Optional(Type.Integer({ minimum: 0 })),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			kind: Type.Literal("url"),
			url: Type.String({ minLength: 1 }),
		},
		{ additionalProperties: false },
	),
]);

const worker = Type.Object(
	{
		worker_id: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" }),
		candidates: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 1 }),
		target_count: Type.Literal(1),
		source_pr: Type.Integer({ minimum: 1 }),
		base_commit: Type.String({ pattern: "^[0-9a-fA-F]{40}$" }),
		completed_commit: Type.String({ pattern: "^[0-9a-fA-F]{40}$" }),
		provenance,
		request: Type.String({ minLength: 1 }),
	},
	{ additionalProperties: false },
);

const parameters = Type.Object(
	{
		schema_version: Type.Literal(1),
		run_id: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" }),
		target_count: Type.Integer({ minimum: 1 }),
		source: Type.Object(
			{
				repo_url: Type.String({ minLength: 1 }),
				commit: Type.String({ pattern: "^[0-9a-fA-F]{40}$" }),
			},
			{ additionalProperties: false },
		),
		agent: Type.Object(
			{
				provider: Type.String({ minLength: 1 }),
				model: Type.String({ minLength: 1 }),
				thinking: Type.Optional(Type.String({ minLength: 1 })),
				profile: Type.Union([Type.Literal("default"), Type.Literal("hard")]),
				request: Type.Optional(Type.String({ minLength: 1 })),
			},
			{ additionalProperties: false },
		),
		workers: Type.Array(worker, { minItems: 1 }),
	},
	{ additionalProperties: false },
);

// TypeBox is supplied by the host extension runtime rather than this package's
// local dependencies, so Static<typeof parameters> cannot be imported reliably
// during extension loading. Keep this narrow runtime-facing type in sync with
// the schema above until the host exposes a supported Static type export.
type GenerationPlan = {
	target_count: number;
	workers: Array<{
		worker_id: string;
		target_count: number;
		candidates: string[];
		base_commit: string;
		completed_commit: string;
	}>;
};

function validatePlan(plan: GenerationPlan): void {
	const workerIds = new Set<string>();
	const candidates = new Set<string>();
	let capacity = 0;
	for (const worker of plan.workers) {
		if (workerIds.has(worker.worker_id)) throw new Error(`duplicate worker_id: ${worker.worker_id}`);
		workerIds.add(worker.worker_id);
		if (worker.base_commit.toLowerCase() === worker.completed_commit.toLowerCase()) {
			throw new Error(`worker ${worker.worker_id} has identical base and completed commits`);
		}
		for (const candidate of worker.candidates) {
			const normalized = candidate.replace(/\/+$/, "");
			if (candidates.has(normalized)) throw new Error(`duplicate candidate: ${candidate}`);
			candidates.add(normalized);
		}
		capacity += worker.target_count;
	}
	if (capacity < plan.target_count) {
		throw new Error(`worker capacity ${capacity} is below target_count ${plan.target_count}`);
	}
}

const submitGenerationPlan = defineTool({
	name: "submit_generation_plan",
	label: "Submit generation plan",
	description:
		"Submit the final ranked SelfBench candidate plan. This validates and saves the machine-readable plan, then ends discovery.",
	promptSnippet: "Submit the final candidate plan and terminate discovery",
	promptGuidelines: [
		"Call submit_generation_plan exactly once after candidate discovery and provenance verification.",
		"Do not author task directories in this parent session.",
		"Put workers in descending rank order: active candidates first, then reserves.",
	],
	parameters,
	async execute(_toolCallId, plan) {
		validatePlan(plan);
		const outputPath = process.env.SELFBENCH_PLAN_OUTPUT;
		if (!outputPath) {
			throw new Error("SELFBENCH_PLAN_OUTPUT is required");
		}
		const temporaryPath = `${outputPath}.tmp-${process.pid}`;
		writeFileSync(temporaryPath, `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600 });
		renameSync(temporaryPath, outputPath);
		return {
			content: [{ type: "text", text: `Saved ${plan.workers.length} ranked candidates.` }],
			details: {
				run_id: plan.run_id,
				target_count: plan.target_count,
				candidate_count: plan.workers.length,
			},
			terminate: true,
		};
	},
});

export default function (pi: ExtensionAPI) {
	pi.registerTool(submitGenerationPlan);
}
