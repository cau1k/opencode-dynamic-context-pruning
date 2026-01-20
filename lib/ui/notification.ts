import type { Logger } from "../logger"
import type { SessionState } from "../state"
import {
    formatExtracted,
    formatPrunedItemsList,
    formatStatsHeader,
    formatTokenCount,
} from "./utils"
import { ToolParameterEntry } from "../state"
import { PluginConfig } from "../config"

export type PruneReason = "completion" | "noise" | "extraction"

type ConfigChangeToastBody = {
    title: string
    message: string
    variant: "info" | "warning"
    duration: number
}

type ToastClient = {
    tui: {
        showToast: (params: { body: ConfigChangeToastBody }) => void
    }
}

export type ConfigChangeParams = {
    providerId: string | undefined
    modelId: string | undefined
    effectiveConfig: PluginConfig
    baseConfig: PluginConfig
}

export function describeConfigChange(
    baseConfig: PluginConfig,
    effectiveConfig: PluginConfig,
): string | null {
    const changes: string[] = []

    if (baseConfig.enabled !== effectiveConfig.enabled) {
        changes.push(effectiveConfig.enabled ? "DCP enabled" : "DCP disabled")
    }
    if (baseConfig.tools.discard.enabled !== effectiveConfig.tools.discard.enabled) {
        changes.push(effectiveConfig.tools.discard.enabled ? "discard enabled" : "discard disabled")
    }
    if (baseConfig.tools.extract.enabled !== effectiveConfig.tools.extract.enabled) {
        changes.push(effectiveConfig.tools.extract.enabled ? "extract enabled" : "extract disabled")
    }

    return changes.length > 0 ? changes.join(", ") : null
}

export async function sendConfigChangeToast(
    client: ToastClient,
    params: ConfigChangeParams,
): Promise<void> {
    const message = describeConfigChange(params.baseConfig, params.effectiveConfig)
    if (!message) {
        return
    }

    try {
        client.tui.showToast({
            body: {
                title: "DCP: Config changed",
                message: `Provider: ${params.providerId || "unknown"}\nModel: ${params.modelId || "unknown"}\n${message}`,
                variant: params.effectiveConfig.enabled ? "info" : "warning",
                duration: 5000,
            },
        })
    } catch {}
}

export const PRUNE_REASON_LABELS: Record<PruneReason, string> = {
    completion: "Task Complete",
    noise: "Noise Removal",
    extraction: "Extraction",
}

function buildMinimalMessage(
    state: SessionState,
    reason: PruneReason | undefined,
    distillation?: string[],
): string {
    const reasonSuffix = reason ? ` — ${PRUNE_REASON_LABELS[reason]}` : ""
    let message =
        formatStatsHeader(state.stats.totalPruneTokens, state.stats.pruneTokenCounter) +
        reasonSuffix

    return message + formatExtracted(distillation)
}

function buildDetailedMessage(
    state: SessionState,
    reason: PruneReason | undefined,
    pruneToolIds: string[],
    toolMetadata: Map<string, ToolParameterEntry>,
    workingDirectory?: string,
    distillation?: string[],
): string {
    let message = formatStatsHeader(state.stats.totalPruneTokens, state.stats.pruneTokenCounter)

    if (pruneToolIds.length > 0) {
        const pruneTokenCounterStr = `~${formatTokenCount(state.stats.pruneTokenCounter)}`
        const reasonLabel = reason ? ` — ${PRUNE_REASON_LABELS[reason]}` : ""
        message += `\n\n▣ Pruning (${pruneTokenCounterStr})${reasonLabel}`

        const itemLines = formatPrunedItemsList(pruneToolIds, toolMetadata, workingDirectory)
        message += "\n" + itemLines.join("\n")
    }

    return (message + formatExtracted(distillation)).trim()
}

export async function sendUnifiedNotification(
    client: any,
    logger: Logger,
    config: PluginConfig,
    state: SessionState,
    sessionId: string,
    pruneToolIds: string[],
    toolMetadata: Map<string, ToolParameterEntry>,
    reason: PruneReason | undefined,
    params: any,
    workingDirectory: string,
    distillation?: string[],
): Promise<boolean> {
    const hasPruned = pruneToolIds.length > 0
    if (!hasPruned) {
        return false
    }

    if (config.pruneNotification === "off") {
        return false
    }

    const showExtraction = config.tools.extract.showDistillation ? distillation : undefined

    const message =
        config.pruneNotification === "minimal"
            ? buildMinimalMessage(state, reason, showExtraction)
            : buildDetailedMessage(
                  state,
                  reason,
                  pruneToolIds,
                  toolMetadata,
                  workingDirectory,
                  showExtraction,
              )

    await sendIgnoredMessage(client, sessionId, message, params, logger)
    return true
}

export async function sendIgnoredMessage(
    client: any,
    sessionID: string,
    text: string,
    params: any,
    logger: Logger,
): Promise<void> {
    const agent = params.agent || undefined
    const variant = params.variant || undefined
    const model =
        params.providerId && params.modelId
            ? {
                  providerID: params.providerId,
                  modelID: params.modelId,
              }
            : undefined

    try {
        await client.session.prompt({
            path: {
                id: sessionID,
            },
            body: {
                noReply: true,
                agent: agent,
                model: model,
                variant: variant,
                parts: [
                    {
                        type: "text",
                        text: text,
                        ignored: true,
                    },
                ],
            },
        })
    } catch (error: any) {
        logger.error("Failed to send notification", { error: error.message })
    }
}
