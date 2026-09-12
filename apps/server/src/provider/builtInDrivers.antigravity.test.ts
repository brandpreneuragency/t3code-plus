import { assert, describe, it } from "@effect/vitest";
import { ProviderDriverKind } from "@t3tools/contracts";

import { AntigravityDriver } from "./Drivers/AntigravityDriver.ts";
import { BUILT_IN_DRIVERS } from "./builtInDrivers.ts";

describe("Antigravity built-in driver", () => {
  it("is registered once and disabled by default", () => {
    const driverKind = ProviderDriverKind.make("antigravity");
    const matches = BUILT_IN_DRIVERS.filter((driver) => driver.driverKind === driverKind);

    assert.lengthOf(matches, 1);
    assert.strictEqual(matches[0], AntigravityDriver);
    assert.deepInclude(AntigravityDriver.metadata, {
      displayName: "Antigravity",
      supportsMultipleInstances: false,
    });
    assert.deepInclude(AntigravityDriver.defaultConfig(), {
      enabled: false,
      binaryPath: "agy",
      customModels: [],
    });
  });
});
