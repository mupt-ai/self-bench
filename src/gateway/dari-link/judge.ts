import { errorResponse, HttpError } from "@mupt-ai/dari-gateway/http/errors";
import { LinkError, linkFetch } from "@mupt-ai/dari-gateway/link/client";
import type { CredentialSecret } from "../../db/credentials.js";
import type { TrialKey } from "../trial-key.js";
import {
  type DariLinkModels,
  dariModelId,
  dariRequestName,
  linkedModel,
  linkModelsOf,
  readDariLinkSecret,
} from "./connection.js";
import { DARI_JUDGE_TAG, type DariLinkApp, dariRefusal } from "./link.js";

// A task's LLM judge on a Dari connection. The judge's model is chosen by the task's code as it
// runs, and a child token must name its models up front, so the judge never holds a Dari token:
// it calls SelfBench's gateway on its trial key as any judge does, and the gateway, which holds
// the grant, forwards each call to the user's Dari for the model the call names. Dari refuses a
// model the grant cannot serve, a plan at its limit, or a revoked grant, and the judge gets that
// refusal as the call's error.

/** The credential kind (and a judge key's provider) of a Dari connection. */
export const DARI_LINK_JUDGE = "dari-link";

/**
 * Dari's id for the model a judge names as its provider's API would (`gpt-5-mini`), as a library
 * does (`openai/gpt-5-mini`), or as Dari does (`dari/model/openai/gpt-5-mini`): a model the
 * connection lists, preferring one it serves to any app, or a gateway key's model. A name it
 * matches nothing for goes to Dari as it is, which refuses it with its reason.
 */
export function dariJudgeModel(name: string, served: DariLinkModels | undefined): string {
  const id = dariModelId(name);
  if (linkedModel(served, id)) return id;
  const named = (served?.models ?? [])
    .filter((entry) => entry.id.slice(entry.id.indexOf("/") + 1) === id)
    .sort((a, b) => Number(!!a.only) - Number(!!b.only))[0];
  if (named) return named.id;
  const prefix = id.includes("/") ? served?.prefixes[0] : undefined;
  return prefix ? `${prefix}${id}` : id;
}

/** Request headers the judge's call keeps: never its SelfBench key, nor its own Dari tags. */
const DROPPED_REQUEST = new Set([
  "authorization",
  "x-api-key",
  "host",
  "cookie",
  "connection",
  "content-length",
  "transfer-encoding",
  "accept-encoding",
  "x-dari-tags",
]);
/** Response headers that described Dari's encoding of a body fetch has already decoded. */
const DROPPED_RESPONSE = new Set(["content-encoding", "content-length", "transfer-encoding"]);

/**
 * One judge call on a Dari connection, forwarded to the user's Dari on the grant: `path` is the
 * call's path under the gateway (`/v1/chat/completions`, `/v1/messages`, …), which Dari serves at
 * the same path. Resolves to Dari's answer, or to the reason it could not be asked.
 */
export async function forwardDariJudge(
  app: DariLinkApp | undefined,
  secret: (orgId: number, id: string) => Promise<Pick<CredentialSecret, "value"> | undefined>,
  key: TrialKey & { judge: NonNullable<TrialKey["judge"]> },
  call: {
    path: string;
    method: string;
    headers: readonly (readonly [string, string])[];
    body: Buffer | undefined;
    signal: AbortSignal;
  },
): Promise<Response> {
  if (!app)
    return errorResponse(
      new HttpError(503, "Dari Link is not configured on this gateway.", "dari_link_unavailable"),
    );
  const value = (await secret(key.orgId, key.judge.credentialId))?.value;
  const grant = value ? readDariLinkSecret(value) : undefined;
  if (!value || !grant)
    return errorResponse(
      new HttpError(
        401,
        "The judge's Dari connection is gone. Connect again under Credentials.",
        "dari_link_unavailable",
      ),
    );
  const headers = new Headers();
  for (const [name, entry] of call.headers)
    if (!DROPPED_REQUEST.has(name.toLowerCase())) headers.append(name, entry);
  headers.set("x-dari-tags", dariJudgeTags(key.tags));
  try {
    const answer = await linkFetch({ ...app, refreshToken: grant.refreshToken })(call.path, {
      method: call.method,
      headers,
      ...(call.body ? { body: judgeBody(call.body, linkModelsOf(value)) } : {}),
      signal: call.signal,
    });
    const kept = new Headers();
    for (const [name, entry] of answer.headers)
      if (!DROPPED_RESPONSE.has(name.toLowerCase())) kept.append(name, entry);
    return new Response(answer.body, { status: answer.status, headers: kept });
  } catch (error) {
    if (!(error instanceof LinkError)) throw error;
    const status = error.status >= 400 ? error.status : 502;
    return errorResponse(
      new HttpError(
        status,
        dariRefusal(error) ?? `Dari did not answer the judge: ${error.message}`,
        error.code,
      ),
    );
  }
}

/**
 * The judge call's body naming Dari's model: Dari serves a grant's models as
 * `dari/model/<id>`. A body that is not a JSON request goes as it is.
 */
function judgeBody(body: Buffer, served: DariLinkModels | undefined): string {
  const text = body.toString();
  try {
    const payload = JSON.parse(text);
    const model = payload?.model;
    // `dari/routing` and the like are Dari's own names already.
    if (
      typeof model !== "string" ||
      (model.startsWith("dari/") && !model.startsWith("dari/model/"))
    )
      return text;
    return JSON.stringify({ ...payload, model: dariRequestName(dariJudgeModel(model, served)) });
  } catch {
    return text;
  }
}

/** `run=…,judge-trial=…`: the trial key's tags, its trial under DARI_JUDGE_TAG. */
function dariJudgeTags(tags: Readonly<Record<string, string>>): string {
  const { trial, ...rest } = tags;
  return Object.entries({ ...rest, ...(trial ? { [DARI_JUDGE_TAG]: trial } : {}) })
    .filter(([, value]) => !value.includes(","))
    .map(([name, value]) => `${name}=${value}`)
    .join(",");
}
