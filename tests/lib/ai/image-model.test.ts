import { describe, it, expect } from "vitest";
import { IMAGE_MODEL_DEFAULT, imageModelId, resolveImageModel } from "../../../src/lib/ai/image-model";

describe("imageModelId", () => {
  it("strips a leading openai/ prefix and leaves bare ids alone", () => {
    expect(imageModelId("openai/gpt-image-2")).toBe("gpt-image-2");
    expect(imageModelId("gpt-image-2")).toBe("gpt-image-2");
    expect(IMAGE_MODEL_DEFAULT).toBe("openai/gpt-image-2");
  });
});

describe("resolveImageModel", () => {
  it("returns an OpenAI image model with the bare id", () => {
    process.env.OPENAI_API_KEY ??= "test-key";
    const model = resolveImageModel("openai/gpt-image-2");
    expect(model.modelId).toBe("gpt-image-2");
    expect(model.provider).toContain("openai");
  });
});
