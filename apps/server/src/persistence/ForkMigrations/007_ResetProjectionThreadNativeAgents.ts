import * as Effect from "effect/Effect";

// Historical ledger identity. V2 does not use the V1 native-agent cache;
// leave the copied evidence intact instead of resetting it during cutover.
export default Effect.void;
