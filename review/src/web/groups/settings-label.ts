import { findModel } from "../../../../src/contracts/models";
import type { GroupSettings } from "./api";

/** The models a group evaluation ran, as one line: "GPT-6 (Codex, Pi), my-model (Pi)". */
export function settingsLabel(settings: GroupSettings): string {
  return settings.models
    .map((model) => {
      const name =
        model.catalogId === "custom"
          ? (model.customModel ?? "Custom")
          : (findModel(model.catalogId)?.label ?? model.catalogId);
      return `${name} (${model.harnesses.join(", ")})`;
    })
    .join(", ");
}
