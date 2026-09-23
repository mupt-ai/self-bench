const COMMAND = "/pitchforks";

/**
 * The /pitchforks trigger rule. It fires when the text newly contains the command, so a space
 * typed after it and deleted again does nothing, while deleting into the word and retyping it
 * fires again. `previous` is the text before the edit.
 */
export function summonsMob(previous: string, next: string): boolean {
  return next.includes(COMMAND) && !previous.includes(COMMAND);
}
