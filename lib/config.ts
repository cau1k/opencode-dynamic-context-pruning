import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "fs"
import { join, dirname } from "path"
import { homedir } from "os"
import { parse } from "jsonc-parser"
import type { PluginInput } from "@opencode-ai/plugin"

export interface Deduplication {
    enabled: boolean
    protectedTools: string[]
}

export interface DiscardTool {
    enabled: boolean
}

export interface ExtractTool {
    enabled: boolean
    showDistillation: boolean
}

export interface ToolSettings {
    nudgeEnabled: boolean
    nudgeFrequency: number
    protectedTools: string[]
}

export interface Tools {
    settings: ToolSettings
    discard: DiscardTool
    extract: ExtractTool
}

export interface SupersedeWrites {
    enabled: boolean
}

export interface PurgeErrors {
    enabled: boolean
    turns: number
    protectedTools: string[]
}

export interface TurnProtection {
    enabled: boolean
    turns: number
}

export interface PluginConfig {
    enabled: boolean
    debug: boolean
    showUpdateToasts?: boolean
    pruneNotification: "off" | "minimal" | "detailed"
    turnProtection: TurnProtection
    protectedFilePatterns: string[]
    tools: Tools
    strategies: {
        deduplication: Deduplication
        supersedeWrites: SupersedeWrites
        purgeErrors: PurgeErrors
    }
    overrides?: ProviderOverrides
}

// Override types for per-provider/model configuration
// Deeply partial - all nested properties are optional
export interface PartialPluginConfig {
    enabled?: boolean
    debug?: boolean
    showUpdateToasts?: boolean
    pruneNotification?: "off" | "minimal" | "detailed"
    turnProtection?: {
        enabled?: boolean
        turns?: number
    }
    protectedFilePatterns?: string[]
    tools?: {
        settings?: {
            nudgeEnabled?: boolean
            nudgeFrequency?: number
            protectedTools?: string[]
        }
        discard?: {
            enabled?: boolean
        }
        extract?: {
            enabled?: boolean
            showDistillation?: boolean
        }
    }
    strategies?: {
        deduplication?: {
            enabled?: boolean
            protectedTools?: string[]
        }
        supersedeWrites?: {
            enabled?: boolean
        }
        purgeErrors?: {
            enabled?: boolean
            turns?: number
            protectedTools?: string[]
        }
    }
}

export interface ModelOverride extends PartialPluginConfig {
    models?: Record<string, PartialPluginConfig>
}

export interface ProviderOverrides {
    provider?: Record<string, ModelOverride>
}

const DEFAULT_PROTECTED_TOOLS = [
    "task",
    "todowrite",
    "todoread",
    "discard",
    "extract",
    "batch",
    "write",
    "edit",
    "plan_enter",
    "plan_exit",
]

// Valid config keys for validation against user config
export const VALID_CONFIG_KEYS = new Set([
    // Top-level keys
    "$schema",
    "enabled",
    "debug",
    "showUpdateToasts", // Deprecated but kept for backwards compatibility
    "pruneNotification",
    "turnProtection",
    "turnProtection.enabled",
    "turnProtection.turns",
    "protectedFilePatterns",
    "tools",
    "tools.settings",
    "tools.settings.nudgeEnabled",
    "tools.settings.nudgeFrequency",
    "tools.settings.protectedTools",
    "tools.discard",
    "tools.discard.enabled",
    "tools.extract",
    "tools.extract.enabled",
    "tools.extract.showDistillation",
    "strategies",
    // strategies.deduplication
    "strategies.deduplication",
    "strategies.deduplication.enabled",
    "strategies.deduplication.protectedTools",
    // strategies.supersedeWrites
    "strategies.supersedeWrites",
    "strategies.supersedeWrites.enabled",
    // strategies.purgeErrors
    "strategies.purgeErrors",
    "strategies.purgeErrors.enabled",
    "strategies.purgeErrors.turns",
    "strategies.purgeErrors.protectedTools",
    // Provider/model overrides
    "overrides",
    "overrides.provider",
])

export const VALID_OVERRIDE_KEYS = new Set(
    Array.from(VALID_CONFIG_KEYS).filter(
        (key) => !key.startsWith("overrides") && key !== "$schema",
    ),
)
VALID_OVERRIDE_KEYS.add("models")

export const VALID_MODEL_OVERRIDE_KEYS = new Set(VALID_OVERRIDE_KEYS)
VALID_MODEL_OVERRIDE_KEYS.delete("models")

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value)
}

// Extract all key paths from a config object for validation
// Skips traversal for keys listed in skipChildrenOf
function getConfigKeyPaths(
    obj: Record<string, unknown>,
    prefix = "",
    skipChildrenOf: string[] = [],
): string[] {
    const keys: string[] = []
    for (const [key, value] of Object.entries(obj)) {
        const fullKey = prefix ? `${prefix}.${key}` : key
        keys.push(fullKey)
        if (skipChildrenOf.includes(fullKey)) {
            continue
        }
        if (isPlainObject(value)) {
            keys.push(...getConfigKeyPaths(value, fullKey, skipChildrenOf))
        }
    }
    return keys
}

export function getInvalidKeysWithPrefix(
    obj: Record<string, unknown>,
    prefix: string,
    validKeys: Set<string>,
    skipChildrenOf: string[] = [],
): string[] {
    const keys = getConfigKeyPaths(obj, prefix, skipChildrenOf)
    return keys.filter((fullKey) => {
        const normalized = fullKey.startsWith(`${prefix}.`)
            ? fullKey.slice(prefix.length + 1)
            : fullKey
        return !validKeys.has(normalized)
    })
}

export function getInvalidOverrideKeys(userConfig: Record<string, unknown>): string[] {
    const overrides = userConfig.overrides
    if (!isPlainObject(overrides)) {
        return []
    }

    const providerOverrides = overrides.provider
    if (!isPlainObject(providerOverrides)) {
        return []
    }

    const invalidKeys: string[] = []

    for (const [providerId, providerOverride] of Object.entries(providerOverrides)) {
        const providerPrefix = `overrides.provider.${providerId}`
        if (!isPlainObject(providerOverride)) {
            continue
        }

        invalidKeys.push(
            ...getInvalidKeysWithPrefix(providerOverride, providerPrefix, VALID_OVERRIDE_KEYS, [
                `${providerPrefix}.models`,
            ]),
        )

        const models = providerOverride.models
        if (!isPlainObject(models)) {
            continue
        }

        for (const [modelId, modelOverride] of Object.entries(models)) {
            if (!isPlainObject(modelOverride)) {
                continue
            }
            const modelPrefix = `${providerPrefix}.models.${modelId}`
            invalidKeys.push(
                ...getInvalidKeysWithPrefix(
                    modelOverride,
                    modelPrefix,
                    VALID_MODEL_OVERRIDE_KEYS,
                ),
            )
        }
    }

    return invalidKeys
}

export function getOverrideTypeErrors(userConfig: Record<string, unknown>): ValidationError[] {
    const overrides = userConfig.overrides
    if (!isPlainObject(overrides)) {
        return []
    }

    const providerOverrides = overrides.provider
    if (!isPlainObject(providerOverrides)) {
        return []
    }

    const errors: ValidationError[] = []

    for (const [providerId, providerOverride] of Object.entries(providerOverrides)) {
        if (!isPlainObject(providerOverride)) {
            continue
        }
        const providerPrefix = `overrides.provider.${providerId}`
        errors.push(...applyValidationPrefix(validateConfigTypes(providerOverride), providerPrefix))

        const models = providerOverride.models
        if (!isPlainObject(models)) {
            continue
        }

        for (const [modelId, modelOverride] of Object.entries(models)) {
            if (!isPlainObject(modelOverride)) {
                continue
            }
            const modelPrefix = `${providerPrefix}.models.${modelId}`
            errors.push(...applyValidationPrefix(validateConfigTypes(modelOverride), modelPrefix))
        }
    }

    return errors
}

// Returns invalid keys found in user config
export function getInvalidConfigKeys(userConfig: Record<string, unknown>): string[] {
    const userKeys = getConfigKeyPaths(userConfig, "", ["overrides.provider"])
    return userKeys
        .filter((key) => !VALID_CONFIG_KEYS.has(key))
        .concat(getInvalidOverrideKeys(userConfig))
}

// Type validators for config values
export interface ValidationError {
    key: string
    expected: string
    actual: string
}

function applyValidationPrefix(errors: ValidationError[], prefix: string): ValidationError[] {
    if (!prefix) {
        return errors
    }
    return errors.map((error) => ({
        ...error,
        key: `${prefix}.${error.key}`,
    }))
}

export function validateConfigTypes(config: Record<string, unknown>): ValidationError[] {
    const errors: ValidationError[] = []

    // Top-level validators
    if (config.enabled !== undefined && typeof config.enabled !== "boolean") {
        errors.push({ key: "enabled", expected: "boolean", actual: typeof config.enabled })
    }
    if (config.debug !== undefined && typeof config.debug !== "boolean") {
        errors.push({ key: "debug", expected: "boolean", actual: typeof config.debug })
    }
    if (config.showUpdateToasts !== undefined && typeof config.showUpdateToasts !== "boolean") {
        errors.push({
            key: "showUpdateToasts",
            expected: "boolean",
            actual: typeof config.showUpdateToasts,
        })
    }
    if (config.pruneNotification !== undefined) {
        const validValues = ["off", "minimal", "detailed"]
        if (typeof config.pruneNotification !== "string") {
            errors.push({
                key: "pruneNotification",
                expected: '"off" | "minimal" | "detailed"',
                actual: typeof config.pruneNotification,
            })
        } else if (!validValues.includes(config.pruneNotification)) {
            errors.push({
                key: "pruneNotification",
                expected: '"off" | "minimal" | "detailed"',
                actual: JSON.stringify(config.pruneNotification),
            })
        }
    }

    if (config.protectedFilePatterns !== undefined) {
        if (!Array.isArray(config.protectedFilePatterns)) {
            errors.push({
                key: "protectedFilePatterns",
                expected: "string[]",
                actual: typeof config.protectedFilePatterns,
            })
        } else if (!config.protectedFilePatterns.every((v) => typeof v === "string")) {
            errors.push({
                key: "protectedFilePatterns",
                expected: "string[]",
                actual: "non-string entries",
            })
        }
    }

    // Top-level turnProtection validator
    if (isPlainObject(config.turnProtection)) {
        if (
            config.turnProtection.enabled !== undefined &&
            typeof config.turnProtection.enabled !== "boolean"
        ) {
            errors.push({
                key: "turnProtection.enabled",
                expected: "boolean",
                actual: typeof config.turnProtection.enabled,
            })
        }
        if (
            config.turnProtection.turns !== undefined &&
            typeof config.turnProtection.turns !== "number"
        ) {
            errors.push({
                key: "turnProtection.turns",
                expected: "number",
                actual: typeof config.turnProtection.turns,
            })
        }
    }

    // Tools validators
    if (isPlainObject(config.tools)) {
        if (isPlainObject(config.tools.settings)) {
            if (
                config.tools.settings.nudgeEnabled !== undefined &&
                typeof config.tools.settings.nudgeEnabled !== "boolean"
            ) {
                errors.push({
                    key: "tools.settings.nudgeEnabled",
                    expected: "boolean",
                    actual: typeof config.tools.settings.nudgeEnabled,
                })
            }
            if (
                config.tools.settings.nudgeFrequency !== undefined &&
                typeof config.tools.settings.nudgeFrequency !== "number"
            ) {
                errors.push({
                    key: "tools.settings.nudgeFrequency",
                    expected: "number",
                    actual: typeof config.tools.settings.nudgeFrequency,
                })
            }
            if (
                config.tools.settings.protectedTools !== undefined &&
                !Array.isArray(config.tools.settings.protectedTools)
            ) {
                errors.push({
                    key: "tools.settings.protectedTools",
                    expected: "string[]",
                    actual: typeof config.tools.settings.protectedTools,
                })
            }
        }
        if (isPlainObject(config.tools.discard)) {
            if (
                config.tools.discard.enabled !== undefined &&
                typeof config.tools.discard.enabled !== "boolean"
            ) {
                errors.push({
                    key: "tools.discard.enabled",
                    expected: "boolean",
                    actual: typeof config.tools.discard.enabled,
                })
            }
        }
        if (isPlainObject(config.tools.extract)) {
            if (
                config.tools.extract.enabled !== undefined &&
                typeof config.tools.extract.enabled !== "boolean"
            ) {
                errors.push({
                    key: "tools.extract.enabled",
                    expected: "boolean",
                    actual: typeof config.tools.extract.enabled,
                })
            }
            if (
                config.tools.extract.showDistillation !== undefined &&
                typeof config.tools.extract.showDistillation !== "boolean"
            ) {
                errors.push({
                    key: "tools.extract.showDistillation",
                    expected: "boolean",
                    actual: typeof config.tools.extract.showDistillation,
                })
            }
        }
    }

    // Strategies validators
    if (isPlainObject(config.strategies)) {
        if (isPlainObject(config.strategies.deduplication)) {
            if (
                config.strategies.deduplication.enabled !== undefined &&
                typeof config.strategies.deduplication.enabled !== "boolean"
            ) {
                errors.push({
                    key: "strategies.deduplication.enabled",
                    expected: "boolean",
                    actual: typeof config.strategies.deduplication.enabled,
                })
            }
            if (
                config.strategies.deduplication.protectedTools !== undefined &&
                !Array.isArray(config.strategies.deduplication.protectedTools)
            ) {
                errors.push({
                    key: "strategies.deduplication.protectedTools",
                    expected: "string[]",
                    actual: typeof config.strategies.deduplication.protectedTools,
                })
            }
        }

        if (isPlainObject(config.strategies.supersedeWrites)) {
            if (
                config.strategies.supersedeWrites.enabled !== undefined &&
                typeof config.strategies.supersedeWrites.enabled !== "boolean"
            ) {
                errors.push({
                    key: "strategies.supersedeWrites.enabled",
                    expected: "boolean",
                    actual: typeof config.strategies.supersedeWrites.enabled,
                })
            }
        }

        if (isPlainObject(config.strategies.purgeErrors)) {
            if (
                config.strategies.purgeErrors.enabled !== undefined &&
                typeof config.strategies.purgeErrors.enabled !== "boolean"
            ) {
                errors.push({
                    key: "strategies.purgeErrors.enabled",
                    expected: "boolean",
                    actual: typeof config.strategies.purgeErrors.enabled,
                })
            }
            if (
                config.strategies.purgeErrors.turns !== undefined &&
                typeof config.strategies.purgeErrors.turns !== "number"
            ) {
                errors.push({
                    key: "strategies.purgeErrors.turns",
                    expected: "number",
                    actual: typeof config.strategies.purgeErrors.turns,
                })
            }
            if (
                config.strategies.purgeErrors.protectedTools !== undefined &&
                !Array.isArray(config.strategies.purgeErrors.protectedTools)
            ) {
                errors.push({
                    key: "strategies.purgeErrors.protectedTools",
                    expected: "string[]",
                    actual: typeof config.strategies.purgeErrors.protectedTools,
                })
            }
        }
    }

    return errors
}

// Show validation warnings for a config file
function showConfigValidationWarnings(
    ctx: PluginInput,
    configPath: string,
    configData: Record<string, unknown>,
    isProject: boolean,
): void {
    const invalidKeys = getInvalidConfigKeys(configData)
    const typeErrors = validateConfigTypes(configData).concat(getOverrideTypeErrors(configData))

    if (invalidKeys.length === 0 && typeErrors.length === 0) {
        return
    }

    const configType = isProject ? "project config" : "config"
    const messages: string[] = []

    if (invalidKeys.length > 0) {
        const keyList = invalidKeys.slice(0, 3).join(", ")
        const suffix = invalidKeys.length > 3 ? ` (+${invalidKeys.length - 3} more)` : ""
        messages.push(`Unknown keys: ${keyList}${suffix}`)
    }

    if (typeErrors.length > 0) {
        for (const err of typeErrors.slice(0, 2)) {
            messages.push(`${err.key}: expected ${err.expected}, got ${err.actual}`)
        }
        if (typeErrors.length > 2) {
            messages.push(`(+${typeErrors.length - 2} more type errors)`)
        }
    }

    setTimeout(() => {
        try {
            ctx.client.tui.showToast({
                body: {
                    title: `DCP: Invalid ${configType}`,
                    message: `${configPath}\n${messages.join("\n")}`,
                    variant: "warning",
                    duration: 7000,
                },
            })
        } catch {}
    }, 7000)
}

const defaultConfig: PluginConfig = {
    enabled: true,
    debug: false,
    showUpdateToasts: true,
    pruneNotification: "detailed",
    turnProtection: {
        enabled: false,
        turns: 4,
    },
    protectedFilePatterns: [],
    tools: {
        settings: {
            nudgeEnabled: true,
            nudgeFrequency: 10,
            protectedTools: [...DEFAULT_PROTECTED_TOOLS],
        },
        discard: {
            enabled: true,
        },
        extract: {
            enabled: true,
            showDistillation: false,
        },
    },
    strategies: {
        deduplication: {
            enabled: true,
            protectedTools: [...DEFAULT_PROTECTED_TOOLS],
        },
        supersedeWrites: {
            enabled: false,
        },
        purgeErrors: {
            enabled: true,
            turns: 4,
            protectedTools: [...DEFAULT_PROTECTED_TOOLS],
        },
    },
}

const GLOBAL_CONFIG_DIR = join(homedir(), ".config", "opencode")
const GLOBAL_CONFIG_PATH_JSONC = join(GLOBAL_CONFIG_DIR, "dcp.jsonc")
const GLOBAL_CONFIG_PATH_JSON = join(GLOBAL_CONFIG_DIR, "dcp.json")

function findOpencodeDir(startDir: string): string | null {
    let current = startDir
    while (current !== "/") {
        const candidate = join(current, ".opencode")
        if (existsSync(candidate) && statSync(candidate).isDirectory()) {
            return candidate
        }
        const parent = dirname(current)
        if (parent === current) break
        current = parent
    }
    return null
}

function getConfigPaths(ctx?: PluginInput): {
    global: string | null
    configDir: string | null
    project: string | null
} {
    // Global: ~/.config/opencode/dcp.jsonc|json
    let globalPath: string | null = null
    if (existsSync(GLOBAL_CONFIG_PATH_JSONC)) {
        globalPath = GLOBAL_CONFIG_PATH_JSONC
    } else if (existsSync(GLOBAL_CONFIG_PATH_JSON)) {
        globalPath = GLOBAL_CONFIG_PATH_JSON
    }

    // Custom config directory: $OPENCODE_CONFIG_DIR/dcp.jsonc|json
    let configDirPath: string | null = null
    const opencodeConfigDir = process.env.OPENCODE_CONFIG_DIR
    if (opencodeConfigDir) {
        const configJsonc = join(opencodeConfigDir, "dcp.jsonc")
        const configJson = join(opencodeConfigDir, "dcp.json")
        if (existsSync(configJsonc)) {
            configDirPath = configJsonc
        } else if (existsSync(configJson)) {
            configDirPath = configJson
        }
    }

    // Project: <project>/.opencode/dcp.jsonc|json
    let projectPath: string | null = null
    if (ctx?.directory) {
        const opencodeDir = findOpencodeDir(ctx.directory)
        if (opencodeDir) {
            const projectJsonc = join(opencodeDir, "dcp.jsonc")
            const projectJson = join(opencodeDir, "dcp.json")
            if (existsSync(projectJsonc)) {
                projectPath = projectJsonc
            } else if (existsSync(projectJson)) {
                projectPath = projectJson
            }
        }
    }

    return { global: globalPath, configDir: configDirPath, project: projectPath }
}

function createDefaultConfig(): void {
    if (!existsSync(GLOBAL_CONFIG_DIR)) {
        mkdirSync(GLOBAL_CONFIG_DIR, { recursive: true })
    }

    const configContent = `{
  "$schema": "https://raw.githubusercontent.com/Opencode-DCP/opencode-dynamic-context-pruning/master/dcp.schema.json",
  // Enable or disable the plugin
  "enabled": true,
  // Enable debug logging to ~/.config/opencode/logs/dcp/
  "debug": false,
  // Notification display: "off", "minimal", or "detailed"
  "pruneNotification": "detailed",
  // Protect from pruning for <turns> message turns
  "turnProtection": {
    "enabled": false,
    "turns": 4
  },
  // Protect file operations from pruning via glob patterns
  // Patterns match tool parameters.filePath (e.g. read/write/edit)
  "protectedFilePatterns": [],
  // LLM-driven context pruning tools
  "tools": {
    // Shared settings for all prune tools
    "settings": {
      // Nudge the LLM to use prune tools (every <nudgeFrequency> tool results)
      "nudgeEnabled": true,
      "nudgeFrequency": 10,
      // Additional tools to protect from pruning
      "protectedTools": []
    },
    // Removes tool content from context without preservation (for completed tasks or noise)
    "discard": {
      "enabled": true
    },
    // Distills key findings into preserved knowledge before removing raw content
    "extract": {
      "enabled": true,
      // Show distillation content as an ignored message notification
      "showDistillation": false
    }
  },
  // Automatic pruning strategies
  "strategies": {
    // Remove duplicate tool calls (same tool with same arguments)
    "deduplication": {
      "enabled": true,
      // Additional tools to protect from pruning
      "protectedTools": []
    },
    // Prune write tool inputs when the file has been subsequently read
    "supersedeWrites": {
      "enabled": false
    },
    // Prune tool inputs for errored tools after X turns
    "purgeErrors": {
      "enabled": true,
      // Number of turns before errored tool inputs are pruned
      "turns": 4,
      // Additional tools to protect from pruning
      "protectedTools": []
    }
  }
}
`
    writeFileSync(GLOBAL_CONFIG_PATH_JSONC, configContent, "utf-8")
}

interface ConfigLoadResult {
    data: Record<string, any> | null
    parseError?: string
}

function loadConfigFile(configPath: string): ConfigLoadResult {
    let fileContent: string
    try {
        fileContent = readFileSync(configPath, "utf-8")
    } catch {
        // File doesn't exist or can't be read - not a parse error
        return { data: null }
    }

    try {
        const parsed = parse(fileContent)
        if (parsed === undefined || parsed === null) {
            return { data: null, parseError: "Config file is empty or invalid" }
        }
        return { data: parsed }
    } catch (error: any) {
        return { data: null, parseError: error.message || "Failed to parse config" }
    }
}

function mergeStrategies(
    base: PluginConfig["strategies"],
    override?: Partial<PluginConfig["strategies"]>,
): PluginConfig["strategies"] {
    if (!override) return base

    return {
        deduplication: {
            enabled: override.deduplication?.enabled ?? base.deduplication.enabled,
            protectedTools: [
                ...new Set([
                    ...base.deduplication.protectedTools,
                    ...(override.deduplication?.protectedTools ?? []),
                ]),
            ],
        },
        supersedeWrites: {
            enabled: override.supersedeWrites?.enabled ?? base.supersedeWrites.enabled,
        },
        purgeErrors: {
            enabled: override.purgeErrors?.enabled ?? base.purgeErrors.enabled,
            turns: override.purgeErrors?.turns ?? base.purgeErrors.turns,
            protectedTools: [
                ...new Set([
                    ...base.purgeErrors.protectedTools,
                    ...(override.purgeErrors?.protectedTools ?? []),
                ]),
            ],
        },
    }
}

function mergeTools(
    base: PluginConfig["tools"],
    override?: Partial<PluginConfig["tools"]>,
): PluginConfig["tools"] {
    if (!override) return base

    return {
        settings: {
            nudgeEnabled: override.settings?.nudgeEnabled ?? base.settings.nudgeEnabled,
            nudgeFrequency: override.settings?.nudgeFrequency ?? base.settings.nudgeFrequency,
            protectedTools: [
                ...new Set([
                    ...base.settings.protectedTools,
                    ...(override.settings?.protectedTools ?? []),
                ]),
            ],
        },
        discard: {
            enabled: override.discard?.enabled ?? base.discard.enabled,
        },
        extract: {
            enabled: override.extract?.enabled ?? base.extract.enabled,
            showDistillation: override.extract?.showDistillation ?? base.extract.showDistillation,
        },
    }
}

function deepCloneConfig(config: PluginConfig): PluginConfig {
    return {
        ...config,
        turnProtection: { ...config.turnProtection },
        protectedFilePatterns: [...config.protectedFilePatterns],
        tools: {
            settings: {
                ...config.tools.settings,
                protectedTools: [...config.tools.settings.protectedTools],
            },
            discard: { ...config.tools.discard },
            extract: { ...config.tools.extract },
        },
        strategies: {
            deduplication: {
                ...config.strategies.deduplication,
                protectedTools: [...config.strategies.deduplication.protectedTools],
            },
            supersedeWrites: {
                ...config.strategies.supersedeWrites,
            },
            purgeErrors: {
                ...config.strategies.purgeErrors,
                protectedTools: [...config.strategies.purgeErrors.protectedTools],
            },
        },
        overrides: config.overrides ? JSON.parse(JSON.stringify(config.overrides)) : undefined,
    }
}

/**
 * Convert a glob pattern with * and ? wildcards to a RegExp
 * @param pattern - Glob pattern (e.g., "claude-*", "gpt-4?")
 * @returns RegExp for matching
 */
export function globToRegex(pattern: string): RegExp {
    const escaped = pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&") // escape regex special chars except * and ?
        .replace(/\*/g, ".*") // * matches any characters
        .replace(/\?/g, ".") // ? matches single character
    return new RegExp(`^${escaped}$`, "i") // case-insensitive, full match
}

/**
 * Find the first matching model pattern for a given modelId
 * @param models - Map of model patterns to overrides
 * @param modelId - The model ID to match
 * @returns The matching pattern key or null
 */
export function findMatchingModelPattern(
    models: Record<string, PartialPluginConfig> | undefined,
    modelId: string,
): string | null {
    if (!models) return null
    // Check exact match first
    if (models[modelId]) return modelId
    // Check glob patterns
    for (const pattern of Object.keys(models)) {
        if (pattern.includes("*") || pattern.includes("?")) {
            if (globToRegex(pattern).test(modelId)) {
                return pattern
            }
        }
    }
    return null
}

/**
 * Merge a partial config override into a base config
 * @param base - The base config to merge into
 * @param override - The partial override to apply
 * @returns Merged config
 */
function mergePartialConfig(base: PluginConfig, override: PartialPluginConfig): PluginConfig {
    return {
        enabled: override.enabled ?? base.enabled,
        debug: override.debug ?? base.debug,
        showUpdateToasts: override.showUpdateToasts ?? base.showUpdateToasts,
        pruneNotification: override.pruneNotification ?? base.pruneNotification,
        turnProtection: {
            enabled: override.turnProtection?.enabled ?? base.turnProtection.enabled,
            turns: override.turnProtection?.turns ?? base.turnProtection.turns,
        },
        protectedFilePatterns: [
            ...new Set([...base.protectedFilePatterns, ...(override.protectedFilePatterns ?? [])]),
        ],
        tools: mergeTools(base.tools, override.tools as any),
        strategies: mergeStrategies(base.strategies, override.strategies as any),
        overrides: base.overrides,
    }
}

/**
 * Resolve the effective config for a specific provider/model combination
 * Merges: base → provider override → model override
 * @param baseConfig - The base configuration
 * @param providerId - The provider ID (e.g., "anthropic", "openai")
 * @param modelId - The model ID (e.g., "claude-3-5-sonnet", "gpt-4o")
 * @returns The resolved effective config for this provider/model
 */
export function resolveActiveConfig(
    baseConfig: PluginConfig,
    providerId: string | undefined,
    modelId: string | undefined,
): PluginConfig {
    let config = deepCloneConfig(baseConfig)

    if (!providerId || !baseConfig.overrides?.provider) {
        return config
    }

    // Apply provider override
    const providerOverride = baseConfig.overrides.provider[providerId]
    if (providerOverride) {
        const { models, ...providerConfig } = providerOverride
        config = mergePartialConfig(config, providerConfig)

        // Apply model override if modelId provided and matches
        if (modelId && models) {
            const matchingPattern = findMatchingModelPattern(models, modelId)
            if (matchingPattern) {
                config = mergePartialConfig(config, models[matchingPattern])
            }
        }
    }

    return config
}

/**
 * Compute a signature for the effective config to detect changes
 * Used for toast notifications when provider/model switches change DCP behavior
 */
export function computeConfigSignature(config: PluginConfig): string {
    return JSON.stringify({
        enabled: config.enabled,
        discardEnabled: config.tools.discard.enabled,
        extractEnabled: config.tools.extract.enabled,
        deduplicationEnabled: config.strategies.deduplication.enabled,
        supersedeWritesEnabled: config.strategies.supersedeWrites.enabled,
        purgeErrorsEnabled: config.strategies.purgeErrors.enabled,
    })
}

export function getConfig(ctx: PluginInput): PluginConfig {
    let config = deepCloneConfig(defaultConfig)
    const configPaths = getConfigPaths(ctx)

    // Load and merge global config
    if (configPaths.global) {
        const result = loadConfigFile(configPaths.global)
        if (result.parseError) {
            setTimeout(async () => {
                try {
                    ctx.client.tui.showToast({
                        body: {
                            title: "DCP: Invalid config",
                            message: `${configPaths.global}\n${result.parseError}\nUsing default values`,
                            variant: "warning",
                            duration: 7000,
                        },
                    })
                } catch {}
            }, 7000)
        } else if (result.data) {
            // Validate config keys and types
            showConfigValidationWarnings(ctx, configPaths.global, result.data, false)
            config = {
                enabled: result.data.enabled ?? config.enabled,
                debug: result.data.debug ?? config.debug,
                showUpdateToasts: result.data.showUpdateToasts ?? config.showUpdateToasts,
                pruneNotification: result.data.pruneNotification ?? config.pruneNotification,
                turnProtection: {
                    enabled: result.data.turnProtection?.enabled ?? config.turnProtection.enabled,
                    turns: result.data.turnProtection?.turns ?? config.turnProtection.turns,
                },
                protectedFilePatterns: [
                    ...new Set([
                        ...config.protectedFilePatterns,
                        ...(result.data.protectedFilePatterns ?? []),
                    ]),
                ],
                tools: mergeTools(config.tools, result.data.tools as any),
                strategies: mergeStrategies(config.strategies, result.data.strategies as any),
                overrides: result.data.overrides ?? config.overrides,
            }
        }
    } else {
        // No config exists, create default
        createDefaultConfig()
    }

    // Load and merge $OPENCODE_CONFIG_DIR/dcp.jsonc|json (overrides global)
    if (configPaths.configDir) {
        const result = loadConfigFile(configPaths.configDir)
        if (result.parseError) {
            setTimeout(async () => {
                try {
                    ctx.client.tui.showToast({
                        body: {
                            title: "DCP: Invalid configDir config",
                            message: `${configPaths.configDir}\n${result.parseError}\nUsing global/default values`,
                            variant: "warning",
                            duration: 7000,
                        },
                    })
                } catch {}
            }, 7000)
        } else if (result.data) {
            // Validate config keys and types
            showConfigValidationWarnings(ctx, configPaths.configDir, result.data, true)
            config = {
                enabled: result.data.enabled ?? config.enabled,
                debug: result.data.debug ?? config.debug,
                showUpdateToasts: result.data.showUpdateToasts ?? config.showUpdateToasts,
                pruneNotification: result.data.pruneNotification ?? config.pruneNotification,
                turnProtection: {
                    enabled: result.data.turnProtection?.enabled ?? config.turnProtection.enabled,
                    turns: result.data.turnProtection?.turns ?? config.turnProtection.turns,
                },
                protectedFilePatterns: [
                    ...new Set([
                        ...config.protectedFilePatterns,
                        ...(result.data.protectedFilePatterns ?? []),
                    ]),
                ],
                tools: mergeTools(config.tools, result.data.tools as any),
                strategies: mergeStrategies(config.strategies, result.data.strategies as any),
                overrides: result.data.overrides ?? config.overrides,
            }
        }
    }

    // Load and merge project config (overrides global)
    if (configPaths.project) {
        const result = loadConfigFile(configPaths.project)
        if (result.parseError) {
            setTimeout(async () => {
                try {
                    ctx.client.tui.showToast({
                        body: {
                            title: "DCP: Invalid project config",
                            message: `${configPaths.project}\n${result.parseError}\nUsing global/default values`,
                            variant: "warning",
                            duration: 7000,
                        },
                    })
                } catch {}
            }, 7000)
        } else if (result.data) {
            // Validate config keys and types
            showConfigValidationWarnings(ctx, configPaths.project, result.data, true)
            config = {
                enabled: result.data.enabled ?? config.enabled,
                debug: result.data.debug ?? config.debug,
                showUpdateToasts: result.data.showUpdateToasts ?? config.showUpdateToasts,
                pruneNotification: result.data.pruneNotification ?? config.pruneNotification,
                turnProtection: {
                    enabled: result.data.turnProtection?.enabled ?? config.turnProtection.enabled,
                    turns: result.data.turnProtection?.turns ?? config.turnProtection.turns,
                },
                protectedFilePatterns: [
                    ...new Set([
                        ...config.protectedFilePatterns,
                        ...(result.data.protectedFilePatterns ?? []),
                    ]),
                ],
                tools: mergeTools(config.tools, result.data.tools as any),
                strategies: mergeStrategies(config.strategies, result.data.strategies as any),
                overrides: result.data.overrides ?? config.overrides,
            }
        }
    }

    return config
}
