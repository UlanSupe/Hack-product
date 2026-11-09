// Test-only preload for the smoke-script test: replaces the global fetch with the in-process fake PayPal, so the
// REAL script (and the real client and provider it uses) can be run end to end without any network.
import { createHttpPayPal } from "./http-paypal.ts";

const fake = createHttpPayPal();
globalThis.fetch = fake.fetch;
