export const TEAM_COLORS = ["sage", "blue", "amber", "violet", "rose", "teal"] as const;
export const TEAM_ICONS = ["people", "rocket", "briefcase", "flask", "writing", "code", "compass", "shield"] as const;

export type TeamColor = typeof TEAM_COLORS[number];
export type TeamIcon = typeof TEAM_ICONS[number];

export type Team = {
  id: string;
  revision: number;
  name: string;
  description: string;
  color: TeamColor;
  icon: TeamIcon;
  memberAgentIds: string[];
  retiredAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type TeamInput = Pick<Team, "name" | "description" | "color" | "icon" | "memberAgentIds"> & {
  revision?: number;
};

export function normalizeTeamInput(value: Partial<TeamInput>) {
  const name = typeof value.name === "string" ? value.name.trim() : "";
  const description = typeof value.description === "string" ? value.description.trim() : "";
  if (!name || name.length > 60) throw new Error("Team name is required and must be at most 60 characters.");
  if (description.length > 240) throw new Error("Team description must be at most 240 characters.");
  if (!TEAM_COLORS.includes(value.color as TeamColor)) throw new Error("Choose a valid team color.");
  if (!TEAM_ICONS.includes(value.icon as TeamIcon)) throw new Error("Choose a valid team icon.");
  if (!Array.isArray(value.memberAgentIds) || value.memberAgentIds.length > 50 || value.memberAgentIds.some(id => typeof id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(id))) {
    throw new Error("Team members must be valid agents.");
  }
  return { name, description, color: value.color as TeamColor, icon: value.icon as TeamIcon, memberAgentIds: [...new Set(value.memberAgentIds)] };
}
