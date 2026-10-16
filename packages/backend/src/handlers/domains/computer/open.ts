import type { WsHandlerContext } from '@teros/shared';
import { canAccessWorkspace } from '../../../auth/workspace-access';
import { COMPUTER_MCA_ID } from '../../../services/computer-view-service';
import { HandlerError } from '../../../ws-framework/WsRouter';
import type { ComputerDomainDeps } from './index';

interface OpenComputerData {
  /** Open (and create if needed) this agent's own computer. */
  agentId?: string;
  /** Or open a specific computer app (e.g. from a tool-call card). */
  appId?: string;
  /** Active workspace, required for superagents (they have no workspace of their own). */
  workspaceId?: string;
}

export function createOpenComputerHandler(deps: ComputerDomainDeps) {
  const { db, mcaService, computerViewService, warmUp, publicBaseUrl } = deps;

  return async function openComputer(ctx: WsHandlerContext, rawData: unknown) {
    const data = (rawData ?? {}) as OpenComputerData;
    let appId: string;
    let appName: string;
    let agentId: string | undefined = data.agentId;

    if (data.appId) {
      const app = await mcaService.getApp(data.appId);
      if (!app || app.mcaId !== COMPUTER_MCA_ID) {
        throw new HandlerError('COMPUTER_NOT_FOUND', `No computer ${data.appId}`);
      }
      if (!(await canAccessWorkspace(db, ctx.userId, app.ownerId))) {
        throw new HandlerError('FORBIDDEN_WORKSPACE', `No access to workspace ${app.ownerId}`);
      }
      appId = app.appId;
      appName = app.name;
      agentId = app.forAgentId ?? agentId;
    } else if (data.agentId) {
      const agent = await db.collection('agents').findOne({ agentId: data.agentId });
      if (!agent) throw new HandlerError('AGENT_NOT_FOUND', `Agent ${data.agentId} not found`);
      const workspaceId = (agent.workspaceId as string | null | undefined) ?? data.workspaceId;
      if (!workspaceId) {
        throw new HandlerError('MISSING_WORKSPACE_ID', 'workspaceId is required for this agent');
      }
      // A superagent belongs to its owner; a workspace agent to its workspace.
      if (!agent.workspaceId && agent.ownerId !== ctx.userId) {
        throw new HandlerError('FORBIDDEN_AGENT', `No access to agent ${data.agentId}`);
      }
      if (!(await canAccessWorkspace(db, ctx.userId, workspaceId))) {
        throw new HandlerError('FORBIDDEN_WORKSPACE', `No access to workspace ${workspaceId}`);
      }
      try {
        const app = await mcaService.ensurePerAgentApp(data.agentId, COMPUTER_MCA_ID, workspaceId);
        appId = app.appId;
        appName = app.name;
      } catch (error) {
        throw new HandlerError('COMPUTER_UNAVAILABLE', (error as Error).message);
      }
    } else {
      throw new HandlerError('MISSING_AGENT_ID', 'agentId or appId is required');
    }

    const user = await db
      .collection('users')
      .findOne({ userId: ctx.userId }, { projection: { 'profile.displayName': 1, email: 1 } });
    const userName = (user?.profile?.displayName as string | undefined) || (user?.email as string | undefined);

    // Start the desktop while the client loads the viewer (cold start ~2-4 s).
    void warmUp(appId).catch((error) => {
      console.warn(`[computer.open] warm-up of ${appId} failed: ${(error as Error).message}`);
    });

    const ticket = computerViewService.issueTicket({ userId: ctx.userId, appId, userName });
    const exp = computerViewService.verifyTicket(ticket)?.exp ?? Date.now();
    return {
      appId,
      appName,
      agentId,
      viewUrl: `${publicBaseUrl.replace(/\/+$/, '')}/computer/${ticket}/`,
      expiresAt: new Date(exp).toISOString(),
    };
  };
}
