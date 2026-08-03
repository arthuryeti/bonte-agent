import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { callCrmApi } from "../src/client/crm-client.js";

const originalFetch = globalThis.fetch;
const originalBaseUrl = process.env.CRM_BASE_URL;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalBaseUrl === undefined) {
    delete process.env.CRM_BASE_URL;
  } else {
    process.env.CRM_BASE_URL = originalBaseUrl;
  }
});

describe("CRM client resilience", () => {
  it("uses the configured CRM base URL", async () => {
    let requestedUrl = "";
    process.env.CRM_BASE_URL = "https://crm.example.test/base/";
    globalThis.fetch = async (input) => {
      requestedUrl = String(input);
      return new Response(JSON.stringify({ Opportunities: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    await callCrmApi({
      endpoint: "/api/Leads/List",
      method: "POST",
      body: { Language: "en" },
    });

    assert.equal(requestedUrl, "https://crm.example.test/api/Leads/List");
  });

  it("turns a Cloudflare HTML block into a concise actionable error", async () => {
    globalThis.fetch = async () =>
      new Response(
        "<!doctype html><title>Attention Required! | Cloudflare</title><p>Sorry, you have been blocked</p>",
        {
          status: 403,
          statusText: "Forbidden",
          headers: { "Content-Type": "text/html" },
        }
      );

    await assert.rejects(
      () =>
        callCrmApi({
          endpoint: "/api/Leads/List",
          method: "POST",
          body: { Language: "en" },
        }),
      /CRM API error: 403 Forbidden - request blocked by the CRM security service/
    );
  });
});
