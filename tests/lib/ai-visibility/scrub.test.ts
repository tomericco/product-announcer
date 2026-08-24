import { describe, it, expect } from "vitest";
import { REDACTED, scrubSecrets, scrubSecretsOrNull } from "../../../src/lib/ai-visibility/scrub";

/**
 * The scrubber, on its own.
 *
 * Every assertion here is about an ABSENCE, because that is the security
 * property: "the code came out right" is satisfied by a function that returns
 * the input untouched. What matters is that the fragment is gone.
 */

describe("scrubSecrets", () => {
  it("redacts an OpenAI 401 body — prefix AND the exposed last four", () => {
    // Verbatim shape from OpenAI's own 401. It masks the middle with asterisks
    // and leaves the last four characters readable, so a scrubber that stopped
    // at the first asterisk would drop `sk-Eyftb` and leave `99vW` behind —
    // which is exactly half of what an attacker needs to confirm a stolen key.
    const body =
      'Incorrect API key provided: sk-Eyftb****************************99vW. You can find your API key at https://platform.openai.com/account/api-keys.';

    const scrubbed = scrubSecrets(body);

    expect(scrubbed).not.toContain("sk-Eyftb");
    expect(scrubbed).not.toContain("99vW");
    expect(scrubbed).toContain(REDACTED);
    // The prose around it survives — this is redaction, not deletion.
    expect(scrubbed).toContain("Incorrect API key provided:");
  });

  it("redacts the organization variant, which leaks the tenant rather than the key", () => {
    const scrubbed = scrubSecrets("No such organization: org-8Xk2mQpL9v.");
    expect(scrubbed).not.toContain("org-8Xk2mQpL9v");
    expect(scrubbed).toBe(`No such organization: ${REDACTED}.`);
  });

  it("redacts a whole Anthropic key without leaving the `ant-` half behind", () => {
    // The `sk-` rule must not eat only `sk-` and leave `ant-abc123…` readable.
    const scrubbed = scrubSecrets("invalid x-api-key: sk-ant-api03-AbCdEf123456-XyZ");
    expect(scrubbed).not.toMatch(/ant-/);
    expect(scrubbed).not.toContain("AbCdEf123456");
    expect(scrubbed).toBe(`invalid x-api-key: ${REDACTED}`);
  });

  it("redacts a Google AI Studio key", () => {
    const scrubbed = scrubSecrets(
      "API key not valid. Please pass a valid API key: AIzaSyD-4nT9xQ_examplekey"
    );
    expect(scrubbed).not.toContain("AIzaSyD");
    expect(scrubbed).not.toContain("examplekey");
  });

  it("redacts a project id and a Bearer header, the two shapes with no key prefix", () => {
    expect(scrubSecrets("project proj_9aFkQ2 is disabled")).not.toContain("proj_9aFkQ2");
    expect(scrubSecrets("authorization: Bearer abc123def456ghi")).not.toContain("abc123def456ghi");
  });

  it("redacts EVERY occurrence, not just the first", () => {
    const scrubbed = scrubSecrets("sk-aaa111 then sk-bbb222 then sk-ccc333");
    expect(scrubbed).toBe(`${REDACTED} then ${REDACTED} then ${REDACTED}`);
  });

  it("is stable across repeated calls — the module-level /g regexes are reset", () => {
    // The bug this guards: a module-scoped /g RegExp used with `test`/`exec`
    // carries `lastIndex` between calls and matches every other time. Three
    // identical calls must give three identical answers.
    const input = "key sk-repeatable123";
    expect(scrubSecrets(input)).toBe(scrubSecrets(input));
    expect(scrubSecrets(input)).toBe(`key ${REDACTED}`);
  });

  it("leaves ordinary text — including our own copy — untouched", () => {
    const ours = "ChatGPT rejected the API key. Check it was copied whole.";
    expect(scrubSecrets(ours)).toBe(ours);
    expect(scrubSecrets("")).toBe("");
  });

  it("keeps null distinguishable from a redacted-to-nothing string", () => {
    // `sources.lastError` and `ai_visibility_samples.error` are both nullable
    // and "no error" must not become "an error we cannot show you".
    expect(scrubSecretsOrNull(null)).toBeNull();
    expect(scrubSecretsOrNull(undefined)).toBeNull();
    expect(scrubSecretsOrNull("sk-abc123")).toBe(REDACTED);
  });
});
