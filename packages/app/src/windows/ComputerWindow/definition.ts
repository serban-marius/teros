/**
 * ComputerWindow Type Definition
 *
 * Live view of an agent's own Linux computer (mca.teros.computer), with
 * take-over: the user can log into any site in the agent's browser and the
 * session stays there for the agent.
 */

import { Monitor } from '@tamagui/lucide-icons';
import i18n from '../../i18n';
import type { WindowTypeDefinition } from '../../services/windowRegistry';
import { ComputerWindowContent } from './ComputerWindowContent';

export interface ComputerWindowProps {
  /** Agent whose computer to show (created on first open). */
  agentId?: string;
  /** Or a specific computer app (e.g. from a tool-call card). */
  appId?: string;
  /** Active workspace (needed for superagents). */
  workspaceId?: string;
  /** Agent name for the title, when known. */
  agentName?: string;
}

export const computerWindowDefinition: WindowTypeDefinition<ComputerWindowProps> = {
  type: 'computer',
  displayName: 'Computer',
  icon: Monitor,
  color: '#6366f1',

  component: ComputerWindowContent,

  defaultSize: { width: 1280, height: 860 },
  minSize: { width: 640, height: 420 },

  getKey: (props) => props.appId ?? props.agentId ?? 'computer',

  getTitle: (props) =>
    props.agentName
      ? i18n.t('computer.titleFor', { name: props.agentName })
      : i18n.t('windows.computer'),
  getSubtitle: () => i18n.t('computer.subtitle'),

  // The view URL is a short-lived ticket: never persist it, re-open on restore.
  serialize: (props) => ({
    agentId: props.agentId,
    appId: props.appId,
    workspaceId: props.workspaceId,
    agentName: props.agentName,
  }),

  deserialize: (data) => ({
    agentId: data.agentId as string | undefined,
    appId: data.appId as string | undefined,
    workspaceId: data.workspaceId as string | undefined,
    agentName: data.agentName as string | undefined,
  }),
};
