export declare const REQUIRED_WORKFLOWS: string[]
export interface WorkflowRun {
  name: string
  head_sha: string
  status: string
  conclusion: string | null
  created_at: string
  html_url?: string
}
export declare function ciVerdict(
  runs: ReadonlyArray<Partial<WorkflowRun> & Record<string, unknown>>,
  sha: string,
  required?: string[]
): { state: 'success' } | { state: 'failure'; failed: string[] } | { state: 'pending'; pending: string[] }
