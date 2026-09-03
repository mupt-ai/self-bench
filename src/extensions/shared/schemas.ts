import { Type } from "@sinclair/typebox";

const environmentVariableName = Type.String({ pattern: "^[A-Za-z_][A-Za-z0-9_]*$" });
const environmentVariables = Type.Record(environmentVariableName, Type.String());

const service = Type.Object(
  {
    name: Type.String({ pattern: "^[a-z][a-z0-9_-]*$" }),
    image: Type.String({ minLength: 1 }),
    environmentVariables,
    command: Type.Optional(Type.Array(Type.String())),
    healthcheck: Type.Object(
      {
        test: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
        intervalSeconds: Type.Integer({ minimum: 1 }),
        timeoutSeconds: Type.Integer({ minimum: 1 }),
        retries: Type.Integer({ minimum: 1 }),
        startPeriodSeconds: Type.Integer({ minimum: 0 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const environmentContract = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    baseImage: Type.String({ minLength: 1 }),
    rootSetupCommand: Type.String({ minLength: 1 }),
    setupCommand: Type.String({ minLength: 1 }),
    smokeCommand: Type.String({ minLength: 1 }),
    environmentVariables,
    services: Type.Array(service),
    source: Type.Union([
      Type.Literal("repository-dockerfile"),
      Type.Literal("devcontainer"),
      Type.Literal("ci-adapted"),
      Type.Literal("generated"),
    ]),
    evidence: Type.Array(
      Type.Object(
        { path: Type.String({ minLength: 1 }), reason: Type.String({ minLength: 1 }) },
        { additionalProperties: false },
      ),
      { minItems: 1 },
    ),
  },
  { additionalProperties: false },
);

export const taskTimeouts = Type.Object(
  {
    setupSeconds: Type.Integer({ minimum: 1 }),
    agentSeconds: Type.Integer({ minimum: 1 }),
    testsSeconds: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);

export const taskResources = Type.Object(
  {
    cpus: Type.Number({ exclusiveMinimum: 0 }),
    memoryMb: Type.Integer({ minimum: 1 }),
    storageMb: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);

export const taskDefinition = Type.Object(
  {
    schemaVersion: Type.Literal(2),
    difficulty: Type.Union([Type.Literal("easy"), Type.Literal("medium"), Type.Literal("hard")]),
    taskId: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" }),
    repo: Type.String({ minLength: 1 }),
    baseCommit: Type.String({ pattern: "^[0-9a-fA-F]{40}$" }),
    workdir: Type.String({ minLength: 1 }),
    testCommand: Type.String({ minLength: 1 }),
    failToPass: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    passToPass: Type.Array(Type.String({ minLength: 1 })),
    testPaths: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    sourcePr: Type.Integer({ minimum: 1 }),
    sourceUrl: Type.String({ minLength: 1 }),
    prompt: Type.String({ minLength: 1 }),
    timeouts: taskTimeouts,
    resources: taskResources,
    environment: environmentContract,
  },
  { additionalProperties: false },
);

/** Definition fields a verification agent may change through /work/fix/definition.json. */
export const FIX_FIELDS = [
  "environment",
  "testCommand",
  "failToPass",
  "passToPass",
  "testPaths",
  "timeouts",
  "resources",
] as const;
