/**
 * Per-instance adapter contract for the Kimi Code subscription provider.
 *
 * The concrete implementation is captured by the provider driver, so this
 * module intentionally exposes only the provider adapter shape.
 *
 * @module KimiAdapter
 */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface KimiAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
