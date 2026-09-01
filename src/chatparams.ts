/**
 * Sampling parameters for a chat-completion request.
 *
 * These live in their own module so the Supervisor and the catalog probe can
 * share them without importing each other. A probe that differs from production
 * can mark a route healthy that fails every real turn — which is how NVIDIA
 * stayed "healthy" while rejecting the real tool catalog.
 *
 * max_tokens is a ceiling, not a spend, so the probe matching production costs
 * nothing.
 */
export const CHAT_TEMPERATURE = 0.3;
export const CHAT_MAX_TOKENS = 2048;
