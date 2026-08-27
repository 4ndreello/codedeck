export interface AgentCapabilities {
  streaming: boolean;
  resume: boolean;
  fork: boolean;
  approvals: boolean;
  usage: boolean;
  cost: boolean;
  modelSelection: boolean;
  nativeDiff: boolean;
  interrupt: boolean;
}

export type CapabilityKey = keyof AgentCapabilities;

export function defaultCapabilities(): AgentCapabilities {
  return {
    streaming: false,
    resume: false,
    fork: false,
    approvals: false,
    usage: false,
    cost: false,
    modelSelection: false,
    nativeDiff: false,
    interrupt: false,
  };
}
