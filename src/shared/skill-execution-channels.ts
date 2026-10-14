export const SKILL_EXECUTION_CHANNELS = {
  scripts: "skills-execution:scripts", executionGrants: "skills-execution:grants", grantExecution: "skills-execution:grant",
  revokeExecution: "skills-execution:revoke", runScript: "skills-execution:run", scriptExecution: "skills-execution:get",
} as const;
export const SKILL_EXECUTION_CHANGED_CHANNEL = "skills-execution:changed";
export const SKILL_EXECUTION_EVENTS = { changed: SKILL_EXECUTION_CHANGED_CHANNEL } as const;
