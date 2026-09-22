export function joinPromptSections(...sections: (string | false | undefined)[]): string {
  return sections.filter((section): section is string => Boolean(section)).join("\n\n");
}
