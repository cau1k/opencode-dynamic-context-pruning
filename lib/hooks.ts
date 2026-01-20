import type { SessionState, WithParts } from "./state"
import type { Logger } from "./logger"
import type { PluginConfig } from "./config"
import { resolveActiveConfig } from "./config"
import { syncToolCache } from "./state/tool-cache"
import { deduplicate, supersedeWrites, purgeErrors } from "./strategies"
import { prune, insertPruneToolContext } from "./messages"
import { checkSession } from "./state"
import { loadPrompt } from "./prompts"
import { handleStatsCommand } from "./commands/stats"
import { handleContextCommand } from "./commands/context"

const INTERNAL_AGENT_SIGNATURES = [
    "You are a title generator",
    "You are a helpful AI assistant tasked with summarizing conversations",
    "Summarize what was done in this conversation",
]

/**
 * Get the effective config for the current provider/model
 * Falls back to base config if no overrides match
 */
function getEffectiveConfig(state: SessionState, baseConfig: PluginConfig): PluginConfig {
    return resolveActiveConfig(baseConfig, state.providerId, state.modelId)
}

export function createSystemPromptHandler(
    state: SessionState,
    logger: Logger,
    baseConfig: PluginConfig,
) {
    return async (_input: unknown, output: { system: string[] }) => {
        if (state.isSubAgent) {
            return
        }

        const systemText = output.system.join("\n")
        if (INTERNAL_AGENT_SIGNATURES.some((sig) => systemText.includes(sig))) {
            logger.info("Skipping DCP system prompt injection for internal agent")
            return
        }

        // Get effective config based on current provider/model
        const config = getEffectiveConfig(state, baseConfig)

        // Skip injection if DCP is disabled for this provider/model
        if (!config.enabled) {
            logger.info("DCP disabled for provider/model, skipping system prompt injection", {
                providerId: state.providerId,
                modelId: state.modelId,
            })
            return
        }

        const discardEnabled = config.tools.discard.enabled
        const extractEnabled = config.tools.extract.enabled

        let promptName: string
        if (discardEnabled && extractEnabled) {
            promptName = "system/system-prompt-both"
        } else if (discardEnabled) {
            promptName = "system/system-prompt-discard"
        } else if (extractEnabled) {
            promptName = "system/system-prompt-extract"
        } else {
            logger.debug("No DCP tools enabled for this provider/model, skipping system prompt", {
                providerId: state.providerId,
                modelId: state.modelId,
            })
            return
        }

        const syntheticPrompt = loadPrompt(promptName)
        output.system.push(syntheticPrompt)
    }
}

export function createChatMessageTransformHandler(
    client: any,
    state: SessionState,
    logger: Logger,
    baseConfig: PluginConfig,
) {
    return async (input: {}, output: { messages: WithParts[] }) => {
        await checkSession(client, state, logger, output.messages)

        if (state.isSubAgent) {
            return
        }

        // Get effective config based on current provider/model
        const config = getEffectiveConfig(state, baseConfig)

        // Skip processing if DCP is disabled for this provider/model
        if (!config.enabled) {
            logger.debug("DCP disabled for provider/model, skipping message transform", {
                providerId: state.providerId,
                modelId: state.modelId,
            })
            return
        }

        syncToolCache(state, config, logger, output.messages)

        deduplicate(state, logger, config, output.messages)
        supersedeWrites(state, logger, config, output.messages)
        purgeErrors(state, logger, config, output.messages)

        prune(state, logger, config, output.messages)

        insertPruneToolContext(state, config, logger, output.messages)

        if (state.sessionId) {
            await logger.saveContext(state.sessionId, output.messages)
        }
    }
}

export function createCommandExecuteHandler(client: any, state: SessionState, logger: Logger) {
    return async (
        input: { command: string; sessionID: string; arguments: string },
        _output: { parts: any[] },
    ) => {
        if (input.command === "dcp-stats") {
            const messagesResponse = await client.session.messages({
                path: { id: input.sessionID },
            })
            const messages = (messagesResponse.data || messagesResponse) as WithParts[]
            await handleStatsCommand({
                client,
                state,
                logger,
                sessionId: input.sessionID,
                messages,
            })
            throw new Error("__DCP_STATS_HANDLED__")
        }
        if (input.command === "dcp-context") {
            const messagesResponse = await client.session.messages({
                path: { id: input.sessionID },
            })
            const messages = (messagesResponse.data || messagesResponse) as WithParts[]
            await handleContextCommand({
                client,
                state,
                logger,
                sessionId: input.sessionID,
                messages,
            })
            throw new Error("__DCP_CONTEXT_HANDLED__")
        }
    }
}
