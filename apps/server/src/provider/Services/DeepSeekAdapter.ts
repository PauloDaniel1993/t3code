/**
 * DeepSeekAdapter - per-instance DeepSeek adapter contract.
 *
 * DeepSeek is implemented as a local Chat Completions loop. It has no native
 * session id, so the adapter persists successful chat history in its resume
 * cursor and rebuilds provider context from that cursor on resume.
 *
 * @module DeepSeekAdapter
 */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface DeepSeekAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
