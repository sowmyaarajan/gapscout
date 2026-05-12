export interface IssueData {
  repo: string;
  number: number;
  title: string;
  body: string;
  labels: string[];
  reactions: number;
  comments: number;
  createdAt: string;
  url: string;
  isFeatureRequest: boolean;
}

export interface RepoSummary {
  fullName: string;
  stars: number;
  lastPushed: string;
  openIssues: number;
  isAbandoned: boolean;
}

export interface Gap {
  theme: string;
  keywords: string[];
  issueCount: number;
  totalReactions: number;
  totalComments: number;
  affectedRepos: string[];
  abandonedAlternatives: string[];
  sampleIssues: { repo: string; title: string; url: string; reactions: number }[];
  gapScore: number;
}
