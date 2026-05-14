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
  assignees: number;
  lastActivityAt: string;
  ageDays: number;
  isStale: boolean;
  participantCount: number;
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
  avgAgeDays: number;
  avgParticipants: number;
  velocityScore: number;
}

export interface IssueSearchResult {
  issues: IssueData[];
  totalFound: number;
  language: string;
  reposSearched: number;
  filters: {
    keyword?: string;
    minAgeDays?: number;
    maxAgeDays?: number;
    isStale?: boolean;
    label?: string;
    maxParticipants?: number;
    minReactions?: number;
  };
}

export interface RepoAnalysis {
  repo: string;
  stars: number;
  openIssues: number;
  topIssues: IssueData[];
  staleIssues: IssueData[];
  gaps: Gap[];
  labelBreakdown: { label: string; count: number }[];
  ageDistribution: { bucket: string; count: number }[];
}
