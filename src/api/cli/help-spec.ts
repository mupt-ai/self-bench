/** The shapes `help.ts` draws, and the flag rows several commands share. */

export type Flag = [usage: string, summary: string];

export interface Verb {
  name: string;
  /** Positionals and required flags, after `self-bench NOUN VERB`. */
  args?: string;
  summary: string;
  long?: string;
  flags?: Flag[];
}

export interface Noun {
  name: string;
  summary: string;
  long?: string;
  /** For a noun that runs on its own (`login`, `results`): what follows `self-bench NOUN`. */
  args?: string;
  flags?: Flag[];
  verbs?: Verb[];
  /** `NOUN SUBNOUN VERB`: nouns nested under this one, such as `repo batch`. */
  nouns?: Noun[];
}

export interface Group {
  title: string;
  nouns: Noun[];
}

export const S = "--repo OWNER/NAME | --custom NAME | --public ORG/NAME | --group SLUG";
export const B = "--repo OWNER/NAME | --custom NAME";
export const R = "--repo OWNER/NAME";

export const WRITER_FLAGS: Flag[] = [
  ["--model ID", "the model that writes the task (default: managed)"],
  ["--verifier-model ID", "the model that checks it"],
  ["--reasoning LEVEL", "the writer's reasoning level"],
  ["--model-credential ID", "a saved model credential to pay with"],
  ["--sandbox KIND", "where it builds: managed, e2b, modal, daytona, or vercel"],
  ["--sandbox-credential ID", "a saved sandbox credential"],
  ["--harbor ENV --harbor-credential ID", "a Harbor environment and its credential"],
  ["--generation JSON|@FILE", "all of the above as one object"],
];

export const WAIT: Flag = ["--wait", "wait and print the answer"];
