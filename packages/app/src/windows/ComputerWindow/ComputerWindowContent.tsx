/**
 * ComputerWindowContent
 *
 * Live view of an agent's own Linux computer. The page inside the iframe is
 * served by the computer itself through the backend proxy (signed, short-lived
 * URL from computer.open) and carries the take-over controls; this window
 * adds the Teros chrome and re-opens the view when the ticket expires.
 */

import { AlertCircle, ExternalLink, Monitor, RefreshCw } from "@tamagui/lucide-icons"
import { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Platform } from "react-native"
import { Button, Text, XStack, YStack } from "tamagui"
import { colors as semanticColors } from "../../components/mca/primitives/colors"
import { useColors } from "../../components/mca/primitives/useColors"
import { AppSpinner } from "../../components/ui"
import { getTerosClient } from "../../services/terosClientSingleton"
import { useWorkspaceStore } from "../../store/workspaceStore"
import type { ComputerWindowProps } from "./definition"

interface Props extends ComputerWindowProps {
  windowId: string
}

type ViewState =
  | { status: "opening" }
  | { status: "ready"; viewUrl: string; appName: string }
  | { status: "error"; message: string }

type Holder = "agent" | "human"

/** Messages the viewer page posts to its parent window. */
export function parseViewerMessage(data: unknown): { holder?: Holder; expired?: boolean } | null {
  if (!data || typeof data !== "object") return null
  const msg = data as { type?: string; holder?: string }
  if (msg.type === "teros-computer-control" && (msg.holder === "agent" || msg.holder === "human")) {
    return { holder: msg.holder }
  }
  if (msg.type === "teros-computer-expired") return { expired: true }
  return null
}

export function ComputerWindowContent({ agentId, appId, appName, workspaceId, agentName }: Props) {
  const { t } = useTranslation()
  const c = useColors()
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)
  const [state, setState] = useState<ViewState>({ status: "opening" })
  const [holder, setHolder] = useState<Holder>("agent")

  // A fresh ticket on every mount/refresh: view URLs are short-lived and never stored.
  const open = useCallback(async () => {
    setState({ status: "opening" })
    try {
      const res = await getTerosClient().computer.open({
        agentId,
        appId,
        appName,
        workspaceId: workspaceId ?? activeWorkspaceId ?? undefined,
      })
      setState({ status: "ready", viewUrl: res.viewUrl, appName: res.appName })
    } catch (error) {
      setState({ status: "error", message: (error as Error)?.message ?? String(error) })
    }
  }, [agentId, appId, appName, workspaceId, activeWorkspaceId])

  useEffect(() => {
    void open()
  }, [open])

  useEffect(() => {
    if (Platform.OS !== "web" || state.status !== "ready") return
    const origin = new URL(state.viewUrl).origin
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== origin) return
      const msg = parseViewerMessage(event.data)
      if (msg?.holder) setHolder(msg.holder)
      if (msg?.expired) void open()
    }
    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [state, open])

  const human = holder === "human"

  return (
    <YStack flex={1} backgroundColor={c.bgPage}>
      <XStack
        backgroundColor={c.bgCard}
        paddingHorizontal={12}
        paddingVertical={6}
        alignItems="center"
        gap={8}
        borderBottomWidth={1}
        borderBottomColor={c.border}
      >
        <Monitor size={13} color={semanticColors.indigo} />
        <Text color={c.text2} fontSize={11} fontFamily="$mono" numberOfLines={1}>
          {state.status === "ready" ? state.appName : (agentName ?? t("windows.computer"))}
        </Text>
        {state.status === "ready" && (
          <XStack
            backgroundColor={human ? "rgba(245,158,11,0.15)" : semanticColors.indigoGlow}
            paddingHorizontal={6}
            paddingVertical={2}
            borderRadius={4}
          >
            <Text
              color={human ? semanticColors.amber : semanticColors.indigo}
              fontSize={10}
              fontWeight="600"
            >
              {human ? t("computer.youAreInControl") : t("computer.agentDriving")}
            </Text>
          </XStack>
        )}
        <XStack flex={1} />
        <Button
          size="$2"
          chromeless
          icon={<RefreshCw size={12} color={c.text3} />}
          onPress={() => void open()}
          pressStyle={{ opacity: 0.6 }}
          aria-label={t("computer.reconnect")}
        />
        {Platform.OS === "web" && state.status === "ready" && (
          <Button
            size="$2"
            chromeless
            icon={<ExternalLink size={12} color={c.text3} />}
            onPress={() => window.open(state.viewUrl, "_blank", "noopener,noreferrer")}
            pressStyle={{ opacity: 0.6 }}
            aria-label={t("computer.openInNewTab")}
          />
        )}
      </XStack>

      {state.status === "opening" && (
        <YStack flex={1} alignItems="center" justifyContent="center" gap={12}>
          <AppSpinner />
          <Text color={c.text3} fontSize={12}>
            {t("computer.starting")}
          </Text>
        </YStack>
      )}

      {state.status === "error" && (
        <YStack flex={1} alignItems="center" justifyContent="center" gap={12} padding={24}>
          <AlertCircle size={32} color={semanticColors.red} />
          <Text color={c.text2} fontSize={13} textAlign="center">
            {t("computer.openFailed")}
          </Text>
          <Text color={c.text3} fontSize={11} fontFamily="$mono" textAlign="center">
            {state.message}
          </Text>
          <Button size="$3" onPress={() => void open()}>
            {t("computer.retry")}
          </Button>
        </YStack>
      )}

      {state.status === "ready" &&
        (Platform.OS === "web" ? (
          <iframe
            key={state.viewUrl}
            src={state.viewUrl}
            style={{ flex: 1, border: "none", width: "100%", height: "100%", display: "block" }}
            allow="clipboard-read; clipboard-write"
            title={t("computer.iframeTitle", { name: state.appName })}
          />
        ) : (
          <YStack flex={1} alignItems="center" justifyContent="center" gap={16} padding={24}>
            <Monitor size={48} color={semanticColors.indigo} opacity={0.6} />
            <Text color={c.text2} fontSize={14} textAlign="center">
              {t("computer.webOnly")}
            </Text>
          </YStack>
        ))}
    </YStack>
  )
}
