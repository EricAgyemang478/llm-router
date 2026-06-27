export { createRouter } from "./router.js";
export type { Router } from "./router.js";

export { openai, openaiCompatible } from "./providers/openai.js";
export { anthropic } from "./providers/anthropic.js";
export { openRouter } from "./providers/openrouter.js";
export { mock } from "./providers/mock.js";
export type { MockProvider, MockBehavior } from "./providers/mock.js";

export { RouterError, AllProvidersFailed } from "./errors.js";
export { estimateCost } from "./lib/cost.js";

export * from "./types.js";
