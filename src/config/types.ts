export interface Machine {
  name: string;
  transport: "ssh" | "local";
  host?: string;
  user?: string;
  port?: number;
  identityFile?: string;
  proxyJump?: string;
  proxyCommand?: string;
}

export interface Config {
  machines: Record<string, Omit<Machine, "name">>;
}

export interface ResolvedMachine extends Machine {
  status: "available" | "connected" | "error";
}
