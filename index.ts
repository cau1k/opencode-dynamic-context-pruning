import type { Plugin } from "@opencode-ai/plugin"
import { getConfig, resolveActiveConfig, computeConfigSignature } from "./lib/config"
import { Logger } from "./lib/logger"
import { createSessionState } from "./lib/state"
import { createDiscardTool, createExtractTool } from "./lib/strategies"
import {
    createChatMessageTransformHandler,
    createCommandExecuteHandler,
    createSystemPromptHandler,
} from "./lib/hooks"
import { sendConfigChangeToast } from "./lib/ui/notification"

const plugin: Plugin = (async (ctx) => {
    const baseConfig = getConfig(ctx)

    if (!baseConfig.enabled) {
        return {}
    }

    const logger = new Logger(baseConfig.debug)
    const state = createSessionState()

    logger.info("DCP initialized", {
        strategies: baseConfig.strategies,
        hasOverrides: !!baseConfig.overrides?.provider,
    })

    return {
        "experimental.chat.system.transform": createSystemPromptHandler(state, logger, baseConfig),

        "experimental.chat.messages.transform": createChatMessageTransformHandler(
            ctx.client,
            state,
            logger,
            baseConfig,
        ),
        "chat.message": async (
            input: {
                sessionID: string
                agent?: string
                model?: { providerID: string; modelID: string }
                messageID?: string
                variant?: string
            },
            _output: any,
        ) => {
            // Cache variant from real user messages (not synthetic)
            state.variant = input.variant

            // Cache provider/model for config override resolution
            const newProviderId = input.model?.providerID
            const newModelId = input.model?.modelID

            const providerChanged = state.providerId !== newProviderId
            const modelChanged = state.modelId !== newModelId

            state.providerId = newProviderId
            state.modelId = newModelId

            // Check if effective config changed and show toast if needed
            if ((providerChanged || modelChanged) && baseConfig.overrides?.provider) {
                const effectiveConfig = resolveActiveConfig(baseConfig, newProviderId, newModelId)
                const newSignature = computeConfigSignature(effectiveConfig)

                if (state.lastConfigSignature && state.lastConfigSignature !== newSignature) {
                    await sendConfigChangeToast(ctx.client, {
                        providerId: newProviderId,
                        modelId: newModelId,
                        effectiveConfig: effectiveConfig,
                        baseConfig: baseConfig,
                    })
                }
                state.lastConfigSignature = newSignature
            }

            logger.debug("Cached provider/model from chat.message hook", {
                variant: input.variant,
                providerId: newProviderId,
                modelId: newModelId,
                providerChanged,
                modelChanged,
            })
        },
        tool: {
            ...(baseConfig.tools.discard.enabled && {
                discard: createDiscardTool({
                    client: ctx.client,
                    state,
                    logger,
                    config: baseConfig,
                    workingDirectory: ctx.directory,
                }),
            }),
            ...(baseConfig.tools.extract.enabled && {
                extract: createExtractTool({
                    client: ctx.client,
                    state,
                    logger,
                    config: baseConfig,
                    workingDirectory: ctx.directory,
                }),
            }),
        },
        config: async (opencodeConfig) => {
            opencodeConfig.command ??= {}
            opencodeConfig.command["dcp-stats"] = {
                template: "",
                description: "Show DCP pruning statistics",
            }
            opencodeConfig.command["dcp-context"] = {
                template: "",
                description: "Show token usage breakdown for current session",
            }
            logger.info("Registered /dcp-stats and /dcp-context commands")

            const toolsToAdd: string[] = []
            if (baseConfig.tools.discard.enabled) toolsToAdd.push("discard")
            if (baseConfig.tools.extract.enabled) toolsToAdd.push("extract")

            if (toolsToAdd.length > 0) {
                const existingPrimaryTools = opencodeConfig.experimental?.primary_tools ?? []
                opencodeConfig.experimental = {
                    ...opencodeConfig.experimental,
                    primary_tools: [...existingPrimaryTools, ...toolsToAdd],
                }
                logger.info(
                    `Added ${toolsToAdd.map((t) => `'${t}'`).join(" and ")} to experimental.primary_tools via config mutation`,
                )
            }
        },
        "command.execute.before": createCommandExecuteHandler(ctx.client, state, logger),
    }
}) satisfies Plugin

export default plugin
