// nanoclaw-fork: product-owned per-group runner env (e.g. the per-tenant turn time limit).
// A leaf module so the product layer can register without importing the container runner.
type SessionEnvProvider = (agentGroup: { id: string }) => Record<string, string>;

let provider: SessionEnvProvider | undefined;

export function setSessionEnvProvider(fn: SessionEnvProvider | undefined): void {
  provider = fn;
}

export function sessionEnvFor(agentGroup: { id: string }): Record<string, string> {
  return provider?.(agentGroup) ?? {};
}
