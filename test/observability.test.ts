import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyAiFailure,
  serializeError,
} from "../src/observability.js";

describe("AI observability", () => {
  it("classifies nested provider empty-content errors", () => {
    const error = new Error("agent invocation failed", {
      cause: new Error('400 {"message":"text content is empty"}'),
    });
    const serialized = serializeError(error);

    assert.equal(classifyAiFailure(serialized), "provider_empty_content");
    assert.match(serialized.cause?.message ?? "", /text content is empty/);
  });

  it("classifies timeouts and authentication failures", () => {
    assert.equal(
      classifyAiFailure(serializeError(new Error("gateway turn timed out"))),
      "timeout",
    );
    assert.equal(
      classifyAiFailure(serializeError(new Error("401 Unauthorized"))),
      "provider_authentication",
    );
  });
});
