import { expect, it } from "vitest";

import { renderCatalog } from "./catalog";

// `npm run adversarial:catalog` rewrites the file (vitest -u); a normal run fails if it is out of date.
it("docs/ADVERSARIAL_CATALOG.md lists exactly the scenarios that run", async () => {
  await expect(renderCatalog()).toMatchFileSnapshot("../../docs/ADVERSARIAL_CATALOG.md");
});
