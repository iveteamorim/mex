import { defineWikiPortContract } from "./contracts/wiki-port.contract.js";
import { openRealWikiHarness } from "./wiki-port-real-fixture.js";

defineWikiPortContract("repository Wiki adapter", {
  open: openRealWikiHarness,
});
