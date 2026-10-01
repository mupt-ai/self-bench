import { models } from "../../src/contracts/models.js";
import { gatewayIds, setGatewayListing } from "../../src/gateways/index.js";

/** Give legacy tests an explicit provider listing instead of relying on a static offer. */
export function mockReferenceModelsAsListed() {
  setGatewayListing("openrouter", {
    models: models.map(({ openRouter, label, thinking }) => ({
      id: openRouter,
      label,
      ...(thinking ? { thinking } : {}),
    })),
    rates: new Map(),
  });
}
export function clearMockModels() {
  for (const gateway of gatewayIds) setGatewayListing(gateway, { models: [], rates: new Map() });
}
