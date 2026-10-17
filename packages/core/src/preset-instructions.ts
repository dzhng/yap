/** Render an ordered instruction template with the supplied path values. */
export function render(template: string, vars: Record<string, string>): string[] {
  for (const [, rawName] of template.matchAll(/\{\{([^{}]+)\}\}/g)) {
    const name = rawName!.trim();
    if (!(name in vars)) throw new Error(`Unknown placeholder: ${name}`);
  }
  const steps = template
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*\d+[.)]\s+(.*)$/)?.[1])
    .filter((step): step is string => step !== undefined);
  return steps.map((step) =>
    step.replace(/\{\{([^{}]+)\}\}/g, (whole, rawName: string) => {
      const name = rawName.trim();
      if (!(name in vars)) throw new Error(`Unknown placeholder: ${name}`);
      return vars[name]!;
    }),
  );
}

export const GET_INSTRUCTIONS_TEMPLATE = `
1. Read PRESET.md at {{path}}, starting with the one idea and ## Any footage.
2. If the user gave footage, follow ## Edit on it, whatever it is: never reject it or ask for a reshoot, and carry the preset's mood onto it.
3. Only if the user asks what to film, or has not recorded yet, give the ## Shoot advice and show {{path}}/shoot-plan.svg.
4. Run ## Check with node {{kitPath}}/measure.mjs and node {{kitPath}}/check.mjs: fix each FAIL (mood), or tell the user why it stands when the footage can't reach it without breaking it (a low-key range on bright footage); note lines (form) depend on the footage and never fail.
`;

export const LIST_INSTRUCTIONS_TEMPLATE = `
1. Choose the preset whose description matches the request and call yap preset.get with its id.
`;
