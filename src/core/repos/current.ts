import { configPath, loadConfigFile } from '../config/load';
import { ActionError, errorMessage } from '../errors';
import { expandHome } from '../paths';
import { loadRepoMap, type RepoMap } from './map';

/** The repo map named by the current config. Used by the web app and CLI (a local file read only). */
export function loadCurrentRepoMap(): RepoMap {
  const result = loadConfigFile(configPath());
  if (!result.ok) throw new ActionError(result.error);
  try {
    return loadRepoMap(expandHome(result.config.agent.meetingpackageSkillDir));
  } catch (err) {
    throw new ActionError(errorMessage(err));
  }
}

export function knownRepoKeys(): string[] {
  try {
    return loadCurrentRepoMap().repos.map((r) => r.key);
  } catch {
    return [];
  }
}
