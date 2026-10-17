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
1. Read PRESET.md at {{path}}.
2. If the user has not recorded yet, follow ## Shoot and show {{path}}/shoot-plan.svg; otherwise follow ## Edit on their footage.
3. Run ## Check with node {{kitPath}}/measure.mjs and node {{kitPath}}/check.mjs until every line is ok.
`;

export const LIST_INSTRUCTIONS_TEMPLATE = `
1. Choose the preset whose description matches the request and call yap preset.get with its id.
`;

