import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Api, Model, SimpleStreamOptions } from "@mariozechner/pi-ai";
import { streamSimple } from "@mariozechner/pi-ai";

import type { MoltbotConfig } from "../../config/config.js";
import { log } from "./logger.js";

/**
 * Resolve provider-specific extra params from model config.
 * Used to pass through stream params like temperature/maxTokens.
 *
 * @internal Exported for testing only
 */
export function resolveExtraParams(params: {
  cfg: MoltbotConfig | undefined;
  provider: string;
  modelId: string;
}): Record<string, unknown> | undefined {
  const modelKey = `${params.provider}/${params.modelId}`;
  const modelConfig = params.cfg?.agents?.defaults?.models?.[modelKey];
  return modelConfig?.params ? { ...modelConfig.params } : undefined;
}

type CacheControlTtl = "5m" | "1h";

function resolveCacheControlTtl(
  extraParams: Record<string, unknown> | undefined,
  provider: string,
  modelId: string,
): CacheControlTtl | undefined {
  const raw = extraParams?.cacheControlTtl;
  if (raw !== "5m" && raw !== "1h") return undefined;
  if (provider === "anthropic") return raw;
  if (provider === "openrouter" && modelId.startsWith("anthropic/")) return raw;
  return undefined;
}

function createStreamFnWithExtraParams(
  baseStreamFn: StreamFn | undefined,
  extraParams: Record<string, unknown> | undefined,
  provider: string,
  modelId: string,
  sessionKey?: string,
): StreamFn | undefined {
  const streamParams: Partial<SimpleStreamOptions> & { cacheControlTtl?: CacheControlTtl } = {};
  if (extraParams) {
    if (typeof extraParams.temperature === "number") {
      streamParams.temperature = extraParams.temperature;
    }
    if (typeof extraParams.maxTokens === "number") {
      streamParams.maxTokens = extraParams.maxTokens;
    }
    const cacheControlTtl = resolveCacheControlTtl(extraParams, provider, modelId);
    if (cacheControlTtl) {
      streamParams.cacheControlTtl = cacheControlTtl;
    }
  }

  const hasSessionKeyHeader = typeof sessionKey === "string" && sessionKey.trim().length > 0;
  if (Object.keys(streamParams).length === 0 && !hasSessionKeyHeader) {
    return undefined;
  }

  if (Object.keys(streamParams).length > 0) {
    log.debug(`creating streamFn wrapper with params: ${JSON.stringify(streamParams)}`);
  }

  const underlying = baseStreamFn ?? streamSimple;
  const wrappedStreamFn: StreamFn = (model, context, options) => {
    const existingHeaders =
      options?.headers != null &&
      typeof options.headers === "object" &&
      !Array.isArray(options.headers)
        ? (options.headers as Record<string, string>)
        : {};
    const mergedHeaders: Record<string, string> = { ...existingHeaders };
    if (hasSessionKeyHeader && sessionKey) {
      mergedHeaders["X-Moltbot-Session-Key"] = String(sessionKey);
    }
    return underlying(model as Model<Api>, context, {
      ...streamParams,
      ...options,
      ...(Object.keys(mergedHeaders).length > 0 ? { headers: mergedHeaders } : {}),
    });
  };

  return wrappedStreamFn;
}

/**
 * Apply extra params (like temperature) to an agent's streamFn.
 *
 * @internal Exported for testing
 */
export function applyExtraParamsToAgent(
  agent: { streamFn?: StreamFn },
  cfg: MoltbotConfig | undefined,
  provider: string,
  modelId: string,
  extraParamsOverride?: Record<string, unknown>,
  sessionKey?: string,
): void {
  const extraParams = resolveExtraParams({
    cfg,
    provider,
    modelId,
  });
  const override =
    extraParamsOverride && Object.keys(extraParamsOverride).length > 0
      ? Object.fromEntries(
          Object.entries(extraParamsOverride).filter(([, value]) => value !== undefined),
        )
      : undefined;
  const merged = Object.assign({}, extraParams, override);
  const wrappedStreamFn = createStreamFnWithExtraParams(
    agent.streamFn,
    merged,
    provider,
    modelId,
    sessionKey,
  );

  if (wrappedStreamFn) {
    log.debug(`applying extraParams to agent streamFn for ${provider}/${modelId}`);
    agent.streamFn = wrappedStreamFn;
  }
}
