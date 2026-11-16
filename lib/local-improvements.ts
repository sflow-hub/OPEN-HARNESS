export type LocalImprovement = {
  id: string;
  agentId: string;
  request: string;
  runId: string | null;
  state: 'editing' | 'building' | 'review' | 'applied' | 'undone' | 'failed';
  changes: { path: string; kind: 'added' | 'modified' | 'deleted'; diff: string }[];
  check: string;
  error?: string;
  createdAt: string;
};

export type LocalImprovementList = { items: LocalImprovement[]; activeId: string | null };
