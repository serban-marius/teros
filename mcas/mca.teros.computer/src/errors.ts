/**
 * Error codes the agent can act on. The code is the first token of the
 * message (`human_has_control: ...`) so it survives the MCA → backend → LLM
 * path, which only keeps the error text. AGENT.md tells the agent what to do
 * for each one.
 */
export type ComputerErrorCode =
  | 'human_has_control'
  | 'element_not_found'
  | 'browser_not_running'
  | 'invalid_argument'
  | 'action_timeout'
  | 'navigation_failed'
  | 'screenshot_failed'
  | 'command_failed';

export class ComputerError extends Error {
  constructor(
    readonly code: ComputerErrorCode,
    detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = 'ComputerError';
  }
}

export function invalidArgument(detail: string): ComputerError {
  return new ComputerError('invalid_argument', detail);
}
