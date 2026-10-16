/**
 * Docker Container Backend factory
 *
 * Builds a DockerContainerBackend from environment configuration. Shared by
 * the backend (CONTAINER_PROVIDER=docker) and the standalone container agent
 * (src/container-agent.ts) so the two never drift on defaults: image, port
 * range, host gateway detection and per-container resource limits.
 */

import { DockerContainerBackend } from './docker-container-backend';

/**
 * Parse a resource-limit env var. Semantics:
 *   unset/empty → fallback, 0 → undefined (limit disabled), invalid → fallback.
 */
export function envLimit(name: string, fallback: number): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n === 0 ? undefined : n;
}

/**
 * Parse MCA_PORT_RANGE ("min-max"). Unset/invalid → the 13000-13999 default.
 * Lets two stacks on one host use disjoint ranges.
 */
export function parsePortRange(raw: string | undefined): { min: number; max: number } {
  const fallback = { min: 13000, max: 13999 };
  const m = raw?.trim().match(/^(\d+)-(\d+)$/);
  if (!m) return fallback;
  const min = Number(m[1]);
  const max = Number(m[2]);
  if (min < 1024 || max > 65535 || max <= min) return fallback;
  return { min, max };
}

/**
 * Host gateway IP for host.docker.internal resolution inside MCA containers.
 * MCA_HOST_GATEWAY overrides (empty string = none); macOS resolves natively.
 */
export function resolveHostGateway(): string | null {
  if (process.env.MCA_HOST_GATEWAY !== undefined) {
    return process.env.MCA_HOST_GATEWAY || null;
  }
  if (process.platform === 'darwin') return null;
  return '172.17.0.1';
}

export interface DockerBackendFactoryOptions {
  /** Absolute path to the mcas/ directory (mounted into containers). */
  mcaBasePath: string;
  /** Port where the Teros backend listens — used for MCA callback URLs. */
  backendPort: number;
}

export function createDockerContainerBackend(
  opts: DockerBackendFactoryOptions,
): DockerContainerBackend {
  return new DockerContainerBackend({
    mcaBasePath: opts.mcaBasePath,
    dockerImage: 'teros/mca-runtime',
    hostGateway: resolveHostGateway(),
    backendPort: opts.backendPort,
    portRange: parsePortRange(process.env.MCA_PORT_RANGE),
    // Default 1 CPU / 1 GiB per container so no single MCA can take down the
    // host. Override per-MCA via manifest runtime.resources, or globally via
    // env (0 = unlimited).
    defaultCpus: envLimit('MCA_CONTAINER_CPUS', 1),
    defaultMemoryMb: envLimit('MCA_CONTAINER_MEMORY_MB', 1024),
    // Remote-machine parameterization (phase 2, TWO-HOST-SEPARATION-PLAN.md):
    // both default to the same-machine behavior when unset.
    advertiseHost: process.env.CONTAINER_AGENT_ADVERTISE_HOST || undefined,
    callbackHost: process.env.MCA_CALLBACK_HOST || undefined,
  });
}
