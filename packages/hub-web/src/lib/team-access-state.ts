export const TEAM_ACCESS_STORAGE_KEY = "mex.hub.team-access.v1";

export interface TeamAccessLocalState {
  contactSent: true;
}

export function readTeamAccessState(storage: Pick<Storage, "getItem"> | null = defaultStorage()): TeamAccessLocalState | null {
  if (storage === null) return null;
  try {
    const raw = storage.getItem(TEAM_ACCESS_STORAGE_KEY);
    if (raw === null || raw === "") return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object"
      && parsed !== null
      && "contactSent" in parsed
      && parsed.contactSent === true
    ) {
      return { contactSent: true };
    }
    return null;
  } catch {
    return null;
  }
}

export function writeTeamAccessState(
  state: TeamAccessLocalState,
  storage: Pick<Storage, "setItem"> | null = defaultStorage(),
): void {
  if (storage === null) return;
  try {
    storage.setItem(TEAM_ACCESS_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Private mode or quota must not block the in-memory done state.
  }
}

function defaultStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
