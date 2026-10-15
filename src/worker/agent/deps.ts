import type { GitHubClient, LinearClient } from '@/core/clients/types';
import type { Config } from '@/core/config/schema';
import type { Db } from '@/core/db/client';
import type { Job } from '@/core/db/schema';
import type { RepoMap } from '@/core/repos/map';
import type { CodeArtifactTokens } from './codeartifact';
import type { ContainerEngine } from './engine';
import type { HostTools } from './host';

export type AgentDeps = {
  db: Db;
  config: Config;
  engine: ContainerEngine;
  github: GitHubClient;
  linear: LinearClient;
  repoMap: () => RepoMap;
  codeArtifact: CodeArtifactTokens;
  host: HostTools;
  secrets: { claudeToken: string; ghToken: string };
  skillDirs: { github: string; meetingpackage: string };
  imageContextDir: string;
  runsDir: string;
  promptsDir: string;
  now: () => number;
};

export type AgentHandler = (deps: AgentDeps, job: Job) => Promise<void>;
