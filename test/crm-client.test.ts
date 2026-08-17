import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { callCrmApi } from "../src/client/crm-client.js";

const originalFetch = globalThis.fetch;
const originalBaseUrl = process.env.CRM_BASE_URL;
const originalBearerToken = process.env.CRM_BEARER_TOKEN;
const originalUserAgent = process.env.CRM_USER_AGENT;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalBaseUrl === undefined) {
    delete process.env.CRM_BASE_URL;
  } else {
    process.env.CRM_BASE_URL = originalBaseUrl;
  }
  if (originalBearerToken === undefined) {
    delete process.env.CRM_BEARER_TOKEN;
  } else {
    process.env.CRM_BEARER_TOKEN = originalBearerToken;
  }
  if (originalUserAgent === undefined) {
    delete process.env.CRM_USER_AGENT;
  } else {
    process.env.CRM_USER_AGENT = originalUserAgent;
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

  it("sends the legacy raw CRM token with Basic auth and an application user agent", async () => {
    let authorization = "";
    let userAgent = "";
    process.env.CRM_BEARER_TOKEN = "crm-token";
    globalThis.fetch = async (_input, init) => {
      const headers = new Headers(init?.headers);
      authorization = headers.get("authorization") ?? "";
      userAgent = headers.get("user-agent") ?? "";
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

    assert.equal(authorization, "Basic crm-token");
    assert.equal(userAgent, "crm-deepagent/0.1.0");
  });

  it("preserves an explicitly prefixed Bearer token", async () => {
    let authorization = "";
    process.env.CRM_BEARER_TOKEN = "Bearer crm-token";
    globalThis.fetch = async (_input, init) => {
      authorization = new Headers(init?.headers).get("authorization") ?? "";
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

    assert.equal(authorization, "Bearer crm-token");
  });
});
