/**
 * Computer MCA (mca.teros.computer) — Tool Call Renderer
 *
 * The agent's own desktop. Every card describes the action in plain words
 * and offers "Open computer": the live view where the user can watch and take
 * over (e.g. to log into a site the agent asked for).
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Text, XStack, YStack } from 'tamagui';
import { useTilingStore } from '../../../store/tilingStore';
import { FallbackBody, getShortToolName, tenseByStatus, ToolCallCard, useColors } from '../primitives';
import { MonitorPlay } from '../primitives';
import type { ToolCallRendererProps } from '../types';
import { withPermissionSupport } from '../withPermissionSupport';

/** Plain-language forms per tool (future / present / past). */
const TOOL_PHRASES: Record<string, [string, string, string]> = {
  'get-state': ['look at the screen', 'Looking at the screen', 'Looked at the screen'],
  screenshot: ['take a screenshot', 'Taking a screenshot', 'Took a screenshot'],
  click: ['click', 'Clicking', 'Clicked'],
  'type-text': ['type text', 'Typing', 'Typed text'],
  'press-key': ['press keys', 'Pressing keys', 'Pressed keys'],
  scroll: ['scroll', 'Scrolling', 'Scrolled'],
  drag: ['drag', 'Dragging', 'Dragged'],
  'open-url': ['open a page', 'Opening a page', 'Opened a page'],
  tabs: ['manage tabs', 'Managing tabs', 'Managed tabs'],
  wait: ['wait', 'Waiting', 'Waited'],
  'run-command': ['run a command', 'Running a command', 'Ran a command'],
  'control-status': ['check who is in control', 'Checking control', 'Checked control'],
};

export function describeComputerCall(toolName: string, input?: Record<string, unknown>): {
  future: string;
  present: string;
  past: string;
} {
  const short = getShortToolName(toolName);
  const [future, present, past] = TOOL_PHRASES[short] ?? [short, short, short];
  const target =
    short === 'open-url' && typeof input?.url === 'string'
      ? ` · ${input.url}`
      : short === 'press-key' && typeof input?.keys === 'string'
        ? ` · ${input.keys}`
        : '';
  return { future: future + target, present: present + target, past: past + target };
}

function ComputerToolCallRendererBase(props: ToolCallRendererProps) {
  const { toolName, input, status, output, error, appIcon, attachments, appId } = props;
  const { t } = useTranslation();
  const c = useColors();
  const openWindow = useTilingStore((s) => s.openWindow);

  return (
    <ToolCallCard
      status={status}
      description={tenseByStatus(status, describeComputerCall(toolName, input))}
      iconUri={appIcon}
      animateExpand
    >
      <YStack gap={8}>
        {appId && (
          <XStack>
            <Button
              size="$2"
              icon={<MonitorPlay size={12} color={c.text2} />}
              onPress={() => openWindow('computer', { appId }, true)}
            >
              <Text fontSize={11} color={c.text2}>
                {t('computer.openLiveView')}
              </Text>
            </Button>
          </XStack>
        )}
        <FallbackBody status={status} input={input} output={output} error={error} attachments={attachments} />
      </YStack>
    </ToolCallCard>
  );
}

export const ComputerToolCallRenderer = withPermissionSupport(ComputerToolCallRendererBase);
